import { stat } from "node:fs/promises";
import { EnvironmentInspectionInputSchema, EnvironmentInspectionSchema, type EnvironmentInspection, type EnvironmentInspectionInput, type ProofkitConfig, type TargetBinding } from "@proofkit/contracts";
import { resolveElectronCdpUrl } from "@proofkit/adapters";
import { inspectTargetBinding } from "@proofkit/project";
import { probeHttpEndpoint } from "@proofkit/runtime";
import { sourceBindingTarget } from "./source-binding-target.js";

type Check = EnvironmentInspection["checks"][number];
type Context = { root: string; workspaceRoot: string; config: ProofkitConfig; restrictWebOrigins: boolean };

/** Observations only: never start an app, attach a browser, or invoke integration hooks. */
export async function inspectEnvironment(context: Context, input: EnvironmentInspectionInput, inspectionId: string, signal?: AbortSignal): Promise<EnvironmentInspection> {
  const { surface, url, timeoutMs } = EnvironmentInspectionInputSchema.parse(input);
  if (url && surface !== "web") throw new Error("Only Web environment inspection accepts a URL override");
  if (url) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Web environment inspection requires an HTTP URL without credentials");
    }
    const configured = context.config.surfaces.web?.baseUrl;
    if (context.restrictWebOrigins && !isLoopback(parsed.hostname)
      && (!configured || new URL(configured).origin !== parsed.origin)) {
      throw new Error("MCP Web environment inspection is restricted to loopback or the configured Web origin");
    }
  }
  signal?.throwIfAborted();
  const started = performance.now();
  const observedAt = new Date().toISOString();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Environment inspection deadline")); }, timeoutMs);
  const config = context.config;
  const checks: Check[] = [];
  const tasks: Array<Promise<Check>> = [];
  const bindings = new Map<string, Promise<TargetBinding>>();
  const bindingFor = (target?: string): Promise<TargetBinding> => {
    if (!target || !/^https?:\/\//i.test(target)) return inspectTargetBinding(context.root, target, controller.signal);
    const origin = new URL(target).origin;
    let pending = bindings.get(origin);
    if (!pending) {
      pending = inspectTargetBinding(context.root, target, controller.signal);
      bindings.set(origin, pending);
    }
    return pending;
  };
  const omittedHealthChecks = Math.max(0, config.project.health.length - 8);
  const bounded = (id: string, kind: Check["kind"], work: () => Promise<Check>) => {
    const unavailable = (): Check => ({ id, kind, status: "unverified", message: "The check could not complete; no raw error was retained." });
    tasks.push(new Promise<Check>((resolve) => {
      const finish = (result: Check) => { controller.signal.removeEventListener("abort", interrupted); resolve(result); };
      const interrupted = () => finish(unavailable());
      if (controller.signal.aborted) { interrupted(); return; }
      controller.signal.addEventListener("abort", interrupted, { once: true });
      // Late read-only results are handled and never mutate the returned snapshot.
      void work().then(finish, () => finish(unavailable()));
    }));
  };
  const probe = (id: string, url: string, expectedStatus: number, localOnly: boolean, bindLocalSource = false) => {
    bounded(id, "http", async () => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return { id, kind: "http", status: "blocked", message: "Configure a valid HTTP endpoint." }; }
      if (localOnly && !isLoopback(parsed.hostname)) return { id, kind: "http", status: "blocked", message: "This MCP check requires a loopback endpoint." };
      const http = await probeHttpEndpoint(url, expectedStatus, timeoutMs, controller.signal);
      if (bindLocalSource && http.status === "reachable" && isLoopback(parsed.hostname)) {
        const targetBinding = await bindingFor(url);
        const status = targetBinding.status === "matching-process-path" ? "passed"
          : targetBinding.status === "different-project" && config.policies.targetBinding === "block-different" ? "blocked" : "unverified";
        return { id, kind: "http", status, message: status === "passed"
          ? "Expected HTTP status observed and the local listener is associated with the selected checkout; served bytes are not attested."
          : targetBinding.reason, http, targetBinding };
      }
      return { id, kind: "http", status: http.status === "reachable" ? "passed" : "blocked", message: http.status === "reachable" ? "Expected HTTP status observed; no body or protocol session was checked." : "The configured endpoint did not return its expected HTTP status.", http };
    });
  };
  try {
    const targetUrl = surface === "web" ? url ?? config.surfaces.web?.baseUrl : config.surfaces.electron?.targetUrlPrefix;
    const web = config.surfaces.web;
    const electron = config.surfaces.electron;
    const hasConnection = surface === "web" ? Boolean(url || web?.baseUrl || web?.cdpUrl) : Boolean(electron?.cdpUrl || electron?.devtoolsActivePort || process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT);
    checks.push({ id: "surface-configuration", kind: "configuration", status: hasConnection ? "passed" : "blocked", message: hasConnection ? url ? "A one-time Web endpoint was supplied; browser attachment is checked separately by inspect_surface." : "A surface connection is configured; attachment is checked separately by inspect_surface." : "Configure a Web baseUrl/CDP endpoint or an Electron CDP endpoint/DevToolsActivePort file." });
    if (surface === "web" && !web?.cdpUrl && web?.executablePath) {
      bounded("browser-executable", "configuration", async () => {
        const exists = await stat(web.executablePath!).then((info) => info.isFile()).catch(() => false);
        return { id: "browser-executable", kind: "configuration", status: exists ? "passed" : "blocked", message: exists ? "Configured executable file exists; browser launch was not attempted." : "The configured browser executable is not an accessible regular file." };
      });
    }
    if (targetUrl && /^https?:\/\//i.test(targetUrl)) probe("surface-http", targetUrl, 200, false);
    else if (targetUrl) checks.push({ id: "surface-http", kind: "configuration", status: "unverified", message: "This surface selector has no HTTP endpoint; use inspect_surface for the actual page." });
    bounded("source-binding", "source-binding", async () => {
      const bindingUrl = await sourceBindingTarget(surface, targetUrl,
        surface === "electron" ? electron?.cdpUrl : web?.cdpUrl,
        surface === "electron" ? electron?.devtoolsActivePort ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT : undefined,
        controller.signal);
      const targetBinding = await bindingFor(bindingUrl);
      return { id: "source-binding", kind: "source-binding", status: targetBinding.status === "matching-process-path" ? "passed" : targetBinding.status === "different-project" && config.policies.targetBinding === "block-different" ? "blocked" : "unverified", message: targetBinding.reason, targetBinding };
    });
    const cdpConfigured = surface === "electron" ? hasConnection : Boolean(web?.cdpUrl);
    if (cdpConfigured) {
      bounded("cdp-http", "http", async () => {
        let cdpUrl: string | undefined;
        try { cdpUrl = surface === "electron" ? await resolveElectronCdpUrl({ cdpUrl: electron?.cdpUrl, devtoolsActivePortPath: electron?.devtoolsActivePort }, controller.signal) : web?.cdpUrl; }
        catch { controller.signal.throwIfAborted(); return { id: "cdp-http", kind: "http", status: "blocked", message: "The Electron CDP endpoint or DevToolsActivePort file could not be resolved." }; }
        if (!cdpUrl) return { id: "cdp-http", kind: "http", status: "blocked", message: "The configured CDP endpoint could not be resolved." };
        let parsed: URL;
        try { parsed = new URL(cdpUrl); } catch { return { id: "cdp-http", kind: "http", status: "blocked", message: "Configure a valid CDP endpoint." }; }
        if (context.restrictWebOrigins && !isLoopback(parsed.hostname)) return { id: "cdp-http", kind: "http", status: "blocked", message: "MCP CDP endpoints must use loopback." };
        if (["ws:", "wss:"].includes(parsed.protocol)) return { id: "cdp-http", kind: "http", status: "unverified", message: "WebSocket CDP requires inspect_surface; this check opens no protocol session." };
        // Preserve credentials for rejection, but never persist them or the query.
        parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/json/version`;
        const http = await probeHttpEndpoint(parsed.href, 200, timeoutMs, controller.signal);
        return { id: "cdp-http", kind: "http", status: http.status === "reachable" ? "passed" : "blocked", message: "CDP discovery HTTP status only; protocol, page selection and login are not verified.", http };
      });
    }
    for (const [index, check] of config.project.health.slice(0, 8).entries()) {
      probe(`health-${index + 1}`, typeof check === "string" ? check : check.url, typeof check === "string" ? 200 : check.expectedStatus, context.restrictWebOrigins, true);
    }
    if (!config.project.health.length) checks.push({ id: "health-configuration", kind: "configuration", status: "unverified", message: "No backend health endpoints are declared; surface reachability cannot establish backend readiness." });
    if (omittedHealthChecks) checks.push({ id: "health-limit", kind: "configuration", status: "unverified", message: "Only the first eight declared health endpoints were checked." });
    checks.push(...await Promise.all(tasks));
    signal?.throwIfAborted();
    if (timedOut) checks.push({ id: "inspection-deadline", kind: "configuration", status: "unverified", message: "The total observation deadline expired; incomplete checks remain unverified." });
    return EnvironmentInspectionSchema.parse({
      inspectionId, projectRoot: context.root, workspaceRoot: context.workspaceRoot, surface, observedAt,
      durationMs: performance.now() - started,
      status: checks.some((check) => check.status === "blocked") ? "blocked" : checks.some((check) => check.status === "unverified") ? "incomplete" : "checks-passed",
      testVerdict: "not-asserted", checks, omittedHealthChecks,
      notChecked: ["browser-session", "authentication", "fixtures", "integration-preflight", "business-terminal", "project-coverage"],
      next: recommendNext(checks),
    });
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function recommendNext(checks: Check[]): EnvironmentInspection["next"] {
  const next: EnvironmentInspection["next"] = [];
  const check = (id: string) => checks.find((item) => item.id === id);
  const add = (action: EnvironmentInspection["next"][number]["action"], basedOn: string[], guidance: string) => {
    next.push({ action, basedOn, guidance });
  };
  if (check("surface-configuration")?.status === "blocked") {
    add("configure-surface", ["surface-configuration"], "Configure the Web URL or Electron CDP connection in the external test workspace, then repeat inspection.");
  }
  if (check("surface-http")?.status === "blocked") {
    add("check-surface-endpoint", ["surface-http"], "Use the project's documented local start flow and confirm the configured page endpoint, then repeat inspection.");
  }
  if (check("browser-executable")?.status === "blocked") {
    add("configure-browser", ["browser-executable"], "Correct the configured browser executable in the external test workspace, then repeat inspection.");
  }
  if (check("cdp-http")?.status === "blocked") {
    add("check-cdp", ["cdp-http"], "Confirm the local CDP listener or Electron DevToolsActivePort file belongs to the intended app, then repeat inspection.");
  }
  const blockedHealth = checks.filter((item) => /^health-\d+$/.test(item.id) && item.status === "blocked" && item.http?.status !== "reachable").map((item) => item.id);
  if (blockedHealth.length) {
    add("check-health", blockedHealth, "Check the declared backend health endpoints in the isolated test environment, then repeat inspection.");
  }
  if (check("health-configuration")?.status === "unverified") {
    add("declare-health", ["health-configuration"], "Declare relevant backend health endpoints in the external test workspace before claiming backend readiness.");
  }
  const source = check("source-binding");
  const healthSources = checks.filter((item) => /^health-\d+$/.test(item.id) && item.targetBinding && item.status !== "passed");
  const sourceIssues = [...(source?.status !== "passed" && source ? [source] : []), ...healthSources];
  if (sourceIssues.length) {
    add("confirm-source", sourceIssues.map((item) => item.id), sourceIssues.some((item) => item.targetBinding?.status === "different-project")
      ? "The observed listener is associated with another checkout; select the intended local app before testing."
      : "Confirm that the observed listener belongs to the intended source checkout before attributing test results to this project.");
  }
  if (check("inspection-deadline")) {
    add("retry-inspection", ["inspection-deadline"], "The observation deadline expired; retry after the local services settle or increase the bounded timeout.");
  }
  if (!checks.some((item) => item.status === "blocked") && !check("inspection-deadline")
    && !sourceIssues.some((item) => item.targetBinding?.status === "different-project")) {
    add("inspect-surface", ["surface-configuration"], "Inspect the live Web/Electron surface next; this environment result is not a product test verdict.");
  }
  return next;
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "::1", "[::1]"].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
