import { createServer, type RequestListener, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema } from "@proofkit/contracts";
import { ElectronAdapter, WebAdapter } from "@proofkit/adapters";
import * as project from "@proofkit/project";
import { ProjectRuntime } from "@proofkit/runtime";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-environment-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"observed-source"}');
  const binding = vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (_root, url) => ({
    status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: root, observedProjectRoot: root,
    targetOrigin: url ? new URL(url).origin : undefined, reason: "Process association only; served bytes not attested", observedAt: new Date().toISOString(),
  }));
  return { root, workspaceRoot, binding };
}
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

describe("environment inspection", () => {
  it("stores a bounded snapshot without executing startup, browser or connector hooks", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const url = await serve((_req, res) => { res.writeHead(200, { "Set-Cookie": "private" }); res.end("private body"); });
    const hooks = { preflight: vi.fn(), setup: vi.fn(), check: vi.fn() };
    const start = vi.spyOn(ProjectRuntime.prototype, "start");
    const connect = vi.spyOn(WebAdapter.prototype, "connect");
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root, start: "must-not-start", health: [`${url}/health?secret=private`] }, surfaces: { web: { baseUrl: url } },
    }), integration: { name: "no-execution", preflight: hooks.preflight, setup: hooks.setup, oracles: [{ name: "terminal", check: hooks.check }] } });
    const result = await service.inspectEnvironment();
    expect(result).toMatchObject({ status: "checks-passed", testVerdict: "not-asserted", omittedHealthChecks: 0 });
    expect(result.next).toEqual([expect.objectContaining({ action: "inspect-surface", basedOn: ["surface-configuration"] })]);
    expect(result.notChecked).toContain("authentication");
    expect(result.notChecked).toContain("business-terminal");
    const content = await readFile(result.artifact.path, "utf8");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(content).not.toContain("private");
    expect(JSON.parse(content).inspectionId).toBe(result.inspectionId);
    expect(result.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readdir(join(workspaceRoot, ".proofkit"))).toEqual(["inspections"]);
    for (const hook of [start, connect, ...Object.values(hooks)]) expect(hook).not.toHaveBeenCalled();
  });
  it("blocks a different checkout even when its page returns 200", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const url = await serve((_req, res) => res.end("ok"));
    binding.mockResolvedValue({ status: "different-project", method: "windows-listener-process", expectedProjectRoot: root, observedProjectRoot: join(root, "other"), reason: "Different checkout", observedAt: new Date().toISOString() });
    const config = ProofkitConfigSchema.parse({ project: { root, health: [url] }, surfaces: { web: { baseUrl: url } } });
    const service = new LocalRunnerService({ root, workspaceRoot, config });
    const blocked = await service.inspectEnvironment();
    expect(blocked).toMatchObject({ status: "blocked", checks: expect.arrayContaining([expect.objectContaining({ id: "source-binding", status: "blocked" }), expect.objectContaining({ id: "surface-http", status: "passed" })]) });
    expect(blocked.next).toContainEqual(expect.objectContaining({ action: "confirm-source", basedOn: expect.arrayContaining(["source-binding", "health-1"]) }));
    expect(blocked.next.some((item) => item.action === "inspect-surface")).toBe(false);
    config.policies.targetBinding = "record";
    const recorded = await new LocalRunnerService({ root, workspaceRoot, config }).inspectEnvironment();
    expect(recorded.status).toBe("incomplete");
    expect(recorded.next.some((item) => item.action === "inspect-surface")).toBe(false);
  });
  it("blocks a local health endpoint from another checkout even when the selected page matches", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const page = await serve((_req, res) => res.end("page"));
    const backend = await serve((_req, res) => res.end("healthy"));
    binding.mockImplementation(async (_root, url) => ({
      status: url && new URL(url).origin === backend ? "different-project" : "matching-process-path",
      method: "windows-listener-process", expectedProjectRoot: root,
      observedProjectRoot: url && new URL(url).origin === backend ? join(root, "other") : root,
      targetOrigin: url ? new URL(url).origin : undefined,
      reason: "Listener source association", observedAt: new Date().toISOString(),
    }));
    const config = ProofkitConfigSchema.parse({ project: { root, health: [`${backend}/health?token=private`] },
      surfaces: { web: { baseUrl: page } } });
    const blocked = await new LocalRunnerService({ root, workspaceRoot, config }).inspectEnvironment();
    expect(blocked).toMatchObject({ status: "blocked", checks: expect.arrayContaining([
      expect.objectContaining({ id: "surface-http", status: "passed" }),
      expect.objectContaining({ id: "source-binding", status: "passed" }),
      expect.objectContaining({ id: "health-1", status: "blocked", http: expect.objectContaining({ status: "reachable" }),
        targetBinding: expect.objectContaining({ status: "different-project", targetOrigin: backend }) }),
    ]) });
    expect(blocked.next).toContainEqual(expect.objectContaining({ action: "confirm-source", basedOn: ["health-1"] }));
    expect(blocked.next.some((item) => item.action === "inspect-surface")).toBe(false);
    expect(JSON.stringify(blocked)).not.toContain("private");
    config.policies.targetBinding = "record";
    const recorded = await new LocalRunnerService({ root, workspaceRoot, config }).inspectEnvironment();
    expect(recorded).toMatchObject({ status: "incomplete", checks: expect.arrayContaining([
      expect.objectContaining({ id: "health-1", status: "unverified", targetBinding: expect.objectContaining({ status: "different-project" }) }),
    ]) });
  });
  it("blocks a Run before browser or connector actions when a declared local health listener is foreign", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const page = await serve((_req, res) => res.end("page"));
    const backend = await serve((_req, res) => res.end("healthy"));
    binding.mockImplementation(async (_root, url) => ({
      status: url && new URL(url).origin === backend ? "different-project" : "matching-process-path",
      method: "windows-listener-process", expectedProjectRoot: root,
      observedProjectRoot: url && new URL(url).origin === backend ? join(root, "other") : root,
      targetOrigin: url ? new URL(url).origin : undefined,
      reason: "Listener source association", observedAt: new Date().toISOString(),
    }));
    const connect = vi.spyOn(WebAdapter.prototype, "connect");
    const connectorPreflight = vi.fn(async () => ({ passed: true, message: "connector ready" }));
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root, health: [`${backend}/health?token=private`] }, surfaces: { web: { baseUrl: page } },
    }), integration: { name: "fixture", preflight: connectorPreflight } });
    const started = await service.start({ start: false, charter: {
      intent: "Check page and backend", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "page" }],
      sideEffectPolicy: "deny", metadata: {},
    } });
    const result = await service.wait(started.runId);
    expect(result.verdict).toBe("blocked");
    expect(connect).not.toHaveBeenCalled();
    expect(connectorPreflight).not.toHaveBeenCalled();
    const preflightPath = result.artifacts.find((path) => path.endsWith("preflight.json"));
    expect(preflightPath).toBeDefined();
    const evidence = await readFile(join(service.evidenceDir, preflightPath!), "utf8");
    expect(JSON.parse(evidence)).toMatchObject({ passed: false, evidence: {
      healthOrigin: backend, expectedProjectRoot: root, observedProjectRoot: join(root, "other"),
    } });
    expect(evidence).not.toContain("private");
    const recordConfig = ProofkitConfigSchema.parse({
      project: { root, health: [`${backend}/health?token=private`] }, surfaces: { web: { baseUrl: page } },
      policies: { targetBinding: "record" },
    });
    connect.mockRejectedValue(new Error("browser fixture stopped"));
    const recordedService = new LocalRunnerService({ root, workspaceRoot, config: recordConfig,
      integration: { name: "fixture", preflight: connectorPreflight } });
    const recordedStart = await recordedService.start({ start: false, charter: {
      intent: "Record backend ownership", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "page" }],
      sideEffectPolicy: "deny", metadata: {},
    } });
    const recordedRun = await recordedService.wait(recordedStart.runId);
    const recordedPath = recordedRun.artifacts.find((path) => path.endsWith("preflight.json"));
    expect(recordedPath).toBeDefined();
    expect(JSON.parse(await readFile(join(recordedService.evidenceDir, recordedPath!), "utf8"))).toMatchObject({
      passed: true, evidence: { healthOrigin: backend, observedProjectRoot: join(root, "other") },
    });
    expect(connectorPreflight).toHaveBeenCalledOnce();
  });
  it("rechecks declared backend ownership after the project startup hook", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const page = await serve((_req, res) => res.end("page"));
    const backend = await serve((_req, res) => res.end("healthy"));
    let backendInspections = 0;
    binding.mockImplementation(async (_root, url) => {
      const isBackend = url && new URL(url).origin === backend;
      if (isBackend) backendInspections++;
      const status = isBackend ? backendInspections === 1 ? "unverified" : "different-project" : "matching-process-path";
      return { status, method: status === "unverified" ? "unavailable" : "windows-listener-process",
        expectedProjectRoot: root, ...(status === "unverified" ? {} : { observedProjectRoot: status === "different-project" ? join(root, "other") : root }),
        targetOrigin: url ? new URL(url).origin : undefined, reason: "Listener source association", observedAt: new Date().toISOString() };
    });
    const startup = vi.spyOn(ProjectRuntime.prototype, "start").mockResolvedValue();
    const stop = vi.spyOn(ProjectRuntime.prototype, "stop").mockResolvedValue();
    const connect = vi.spyOn(WebAdapter.prototype, "connect");
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root, start: "fixture-start", health: [`${backend}/health?token=private`] },
      surfaces: { web: { baseUrl: page } },
    }) });
    const started = await service.start({ charter: {
      intent: "Check startup backend", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "page" }],
      sideEffectPolicy: "deny", metadata: {},
    } });
    const result = await service.wait(started.runId);
    expect(result.verdict).toBe("blocked");
    expect(backendInspections).toBe(2);
    expect(startup).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    const checkPath = result.artifacts.find((path) => path.endsWith("post-setup-check.json"));
    expect(checkPath).toBeDefined();
    const check = await readFile(join(service.evidenceDir, checkPath!), "utf8");
    expect(JSON.parse(check)).toMatchObject({ passed: false, evidence: {
      healthOrigin: backend, observedProjectRoot: join(root, "other"),
    } });
    const events = await readFile(join(service.evidenceDir, result.runId, "events.jsonl"), "utf8");
    expect(events).toContain("post-setup-check");
    expect(check).not.toContain("private");
    expect(events).not.toContain("private");
  });
  it("inspects a one-time Web URL and binds the source check to that listener without changing configuration", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const candidate = await serve((_req, res) => res.end("candidate response"));
    const configured = "http://127.0.0.1:1/old";
    const config = ProofkitConfigSchema.parse({ project: { root }, surfaces: { web: { baseUrl: configured } } });
    const service = new LocalRunnerService({ root, workspaceRoot, config });
    const result = await service.inspectEnvironment({ url: `${candidate}/preview?token=secret#fragment` });
    expect(result).toMatchObject({ status: "incomplete", testVerdict: "not-asserted" });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "surface-http", status: "passed", http: expect.objectContaining({ endpoint: `${candidate}/preview` }) }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "source-binding", status: "passed", targetBinding: expect.objectContaining({ targetOrigin: candidate }) }));
    expect(binding).toHaveBeenCalledWith(root, `${candidate}/preview?token=secret#fragment`, expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await readFile(result.artifact.path, "utf8")).not.toContain("secret");
    expect(config.surfaces.web?.baseUrl).toBe(configured);

    binding.mockResolvedValue({ status: "different-project", method: "windows-listener-process",
      expectedProjectRoot: root, observedProjectRoot: join(root, "other"), targetOrigin: candidate,
      reason: "Different checkout", observedAt: new Date().toISOString() });
    expect(await service.inspectEnvironment({ url: candidate })).toMatchObject({ status: "blocked", checks: expect.arrayContaining([
      expect.objectContaining({ id: "surface-http", status: "passed" }),
      expect.objectContaining({ id: "source-binding", status: "blocked" }),
    ]) });
  });
  it("validates Web overrides before any request or snapshot", async () => {
    const { root, workspaceRoot } = await fixture();
    const service = new LocalRunnerService({ root, workspaceRoot, restrictWebOrigins: true });
    for (const input of [
      { surface: "electron" as const, url: "http://127.0.0.1:1" },
      { url: "file:///tmp/page.html" },
      { url: "http://user:pass@127.0.0.1:1/" },
      { url: "https://example.com/" },
    ]) await expect(service.inspectEnvironment(input)).rejects.toThrow();
    await expect(readdir(workspaceRoot)).rejects.toThrow();
  });
  it("keeps missing health, source association and browser prerequisites visible", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    binding.mockResolvedValue({ status: "unverified", method: "unavailable", expectedProjectRoot: root, reason: "Unsupported platform", observedAt: new Date().toISOString() });
    const missing = new LocalRunnerService({ root, workspaceRoot });
    const missingResult = await missing.inspectEnvironment();
    expect(missingResult).toMatchObject({ status: "blocked", checks: expect.arrayContaining([expect.objectContaining({ id: "surface-configuration", status: "blocked" }), expect.objectContaining({ id: "health-configuration", status: "unverified" })]) });
    expect(missingResult.next.map((item) => item.action)).toEqual(expect.arrayContaining(["configure-surface", "declare-health", "confirm-source"]));
    const url = await serve((_req, res) => res.end());
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root, health: [url] }, surfaces: { web: { baseUrl: url, executablePath: join(root, "missing-browser") } } }) });
    const result = await service.inspectEnvironment();
    expect(result).toMatchObject({ status: "blocked", checks: expect.arrayContaining([expect.objectContaining({ id: "browser-executable", status: "blocked" }), expect.objectContaining({ id: "source-binding", status: "unverified" })]) });
    expect(result.next).toContainEqual(expect.objectContaining({ action: "configure-browser", basedOn: ["browser-executable"] }));
  });
  it("grounds blocked endpoint and health advice in observed checks without copying URL secrets", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    binding.mockResolvedValue({ status: "unverified", method: "unavailable", expectedProjectRoot: root,
      reason: "No listener association", observedAt: new Date().toISOString() });
    const url = await serve((_req, res) => { res.writeHead(503); res.end("private body"); });
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root, health: [`${url}/health?token=secret`] }, surfaces: { web: { baseUrl: url } },
    }) });
    const result = await service.inspectEnvironment();
    expect(result.status).toBe("blocked");
    expect(result.next).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "check-surface-endpoint", basedOn: ["surface-http"] }),
      expect.objectContaining({ action: "check-health", basedOn: ["health-1"] }),
      expect.objectContaining({ action: "confirm-source", basedOn: ["source-binding"] }),
    ]));
    expect(result.next.some((item) => item.action === "inspect-surface")).toBe(false);
    expect(JSON.stringify(result.next)).not.toMatch(/secret|private|token=/);
  });
  it("caps parallel health observations and respects one total deadline even with a late source check", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    binding.mockImplementation(() => new Promise(() => {}));
    let requests = 0;
    const url = await serve(() => { requests++; });
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root, health: Array.from({ length: 12 }, (_, i) => `${url}/health-${i}`) }, surfaces: { web: { baseUrl: url } } }) });
    const result = await service.inspectEnvironment({ timeoutMs: 120 });
    expect(result).toMatchObject({ status: "incomplete", omittedHealthChecks: 4 });
    expect(result.durationMs).toBeLessThan(1000);
    expect(requests).toBe(9);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "inspection-deadline", status: "unverified" }));
    expect(result.next).toContainEqual(expect.objectContaining({ action: "retry-inspection", basedOn: ["inspection-deadline"] }));
    expect(result.next.some((item) => item.action === "inspect-surface")).toBe(false);
  });
  it("propagates cancellation and writes no partial artifact", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    binding.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error("cancel this observation");
    const service = new LocalRunnerService({ root, workspaceRoot });
    const result = service.inspectEnvironment({}, controller.signal);
    const rejected = expect(result).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    await expect(readdir(workspaceRoot)).rejects.toThrow();
  });
  it("shares bounded Electron port-file resolution and retains only CDP HTTP status", async () => {
    const { root, workspaceRoot } = await fixture();
    const paths: string[] = [];
    const url = await serve((req, res) => { paths.push(req.url!); res.end("private CDP metadata"); });
    await mkdir(workspaceRoot);
    const file = join(workspaceRoot, "DevToolsActivePort");
    await writeFile(file, `${new URL(url).port}\n/devtools/browser/private\n`);
    const config = ProofkitConfigSchema.parse({ project: { root, health: [url] }, surfaces: { electron: { devtoolsActivePort: file, targetUrlPrefix: url } } });
    const service = new LocalRunnerService({ root, workspaceRoot, config });
    const result = await service.inspectEnvironment({ surface: "electron" });
    expect(result.status).toBe("checks-passed");
    expect(paths).toContain("/json/version");
    expect(JSON.stringify(result)).not.toContain("private");
    await writeFile(file, "70000\n");
    const invalidPort = await service.inspectEnvironment({ surface: "electron" });
    expect(invalidPort).toMatchObject({ status: "blocked", checks: expect.arrayContaining([expect.objectContaining({ id: "cdp-http", status: "blocked" })]) });
    expect(invalidPort.next).toContainEqual(expect.objectContaining({ action: "check-cdp", basedOn: ["cdp-http"] }));
    await writeFile(file, "9".repeat(5000));
    expect((await service.inspectEnvironment({ surface: "electron" })).status).toBe("blocked");
  });
  it("checks the CDP listener's source when an Electron page has a file URL", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const url = await serve((_req, res) => res.end("CDP ready"));
    await mkdir(workspaceRoot);
    const file = join(workspaceRoot, "DevToolsActivePort");
    await writeFile(file, `${new URL(url).port}\n/devtools/browser/private\n`);
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root, health: [url] }, surfaces: { electron: { devtoolsActivePort: file, targetUrlPrefix: "file:///app/index.html" } },
    }) });
    const result = await service.inspectEnvironment({ surface: "electron" });
    expect(binding).toHaveBeenCalledWith(root, url, expect.any(AbortSignal));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "source-binding", status: "passed",
      targetBinding: expect.objectContaining({ targetOrigin: url }) }));
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("blocks a file-page Electron Run when its CDP listener belongs to another checkout", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    const cdpUrl = "http://127.0.0.1:9222";
    binding.mockResolvedValue({ status: "different-project", method: "windows-listener-process",
      expectedProjectRoot: root, observedProjectRoot: join(root, "other"), targetOrigin: cdpUrl,
      reason: "Different checkout", observedAt: new Date().toISOString() });
    const connect = vi.spyOn(ElectronAdapter.prototype, "connect");
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root }, surfaces: { electron: { cdpUrl, targetUrlPrefix: "file:///app/index.html" } },
    }) });
    const started = await service.start({ adapter: "electron", charter: {
      intent: "Check Electron page", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "ready" }],
      sideEffectPolicy: "deny", metadata: {},
    } });
    const result = await service.wait(started.runId);
    expect(binding).toHaveBeenCalledWith(root, cdpUrl, expect.any(AbortSignal));
    expect(result).toMatchObject({ verdict: "blocked", targetBinding: { status: "different-project", targetOrigin: cdpUrl } });
    expect(connect).not.toHaveBeenCalled();
  });
  it("rechecks a connector-created Electron port before attachment and cleans up on mismatch", async () => {
    const { root, workspaceRoot, binding } = await fixture();
    await mkdir(workspaceRoot);
    const file = join(workspaceRoot, "DevToolsActivePort");
    const cdpUrl = "http://127.0.0.1:9224";
    binding.mockImplementation(async (_root, url) => ({
      status: url ? "different-project" : "unverified", method: url ? "windows-listener-process" : "unavailable",
      expectedProjectRoot: root, ...(url ? { observedProjectRoot: join(root, "other"), targetOrigin: url } : {}),
      reason: url ? "Different checkout" : "No running target", observedAt: new Date().toISOString(),
    }));
    const cleanup = vi.fn();
    const connect = vi.spyOn(ElectronAdapter.prototype, "connect");
    const service = new LocalRunnerService({ root, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root }, surfaces: { electron: { devtoolsActivePort: file, targetUrlPrefix: "file:///app/index.html" } },
    }), integration: { name: "electron-launch-fixture", setup: async () => {
      await writeFile(file, "9224\n");
      return cleanup;
    } } });
    const started = await service.start({ adapter: "electron", start: false, charter: {
      intent: "Check connector-started Electron", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "ready" }],
      sideEffectPolicy: "deny", metadata: {},
    } });
    const result = await service.wait(started.runId);
    expect(binding.mock.calls.map((call) => call[1])).toEqual([undefined, undefined, cdpUrl]);
    expect(result).toMatchObject({ verdict: "blocked", targetBinding: { status: "different-project", targetOrigin: cdpUrl },
      applicationBinding: { status: "unverified" } });
    expect(connect).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("rejects remote MCP health/CDP probes before sending them and validates input limits", async () => {
    const { root, workspaceRoot } = await fixture();
    const service = new LocalRunnerService({ root, workspaceRoot, restrictWebOrigins: true, config: ProofkitConfigSchema.parse({ project: { root, health: ["https://example.com/health"] }, surfaces: { electron: { cdpUrl: "https://example.com" } } }) });
    expect(await service.inspectEnvironment({ surface: "electron" })).toMatchObject({ status: "blocked", checks: expect.arrayContaining([expect.objectContaining({ id: "health-1", status: "blocked" }), expect.objectContaining({ id: "cdp-http", status: "blocked" })]) });
    for (const timeoutMs of [0, NaN, 15_001]) await expect(service.inspectEnvironment({ timeoutMs })).rejects.toThrow();
  });
});
