import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { hasPositiveSurfaceAssertion, type ProofkitConfig, type TestScope } from "@proofkit/contracts";
import { resolveWithinWorkspace } from "@proofkit/project";
import { firstInlineOracleIssue, isAllowedMcpWebUrl, isLoopbackHost } from "./inline-oracle-validation.js";
import { candidateFocusText, readWorkspaceCharterFile, WorkspaceCharterFileError } from "./workspace-charter-file.js";

type Candidates = NonNullable<TestScope["workspaceCandidates"]>;
type Candidate = Candidates["items"][number];
type CandidateContext = {
  workspaceRoot: string;
  config: ProofkitConfig;
  capabilities: readonly { name: string; sideEffect: "none" | "read" | "write"; environments: readonly ("test" | "staging" | "local")[] }[];
  oracles: readonly { name: string }[];
  allowCapabilityWrites: boolean;
  restrictWebOrigins: boolean;
};

const DIRECTORIES = [[".proofkit", "charters"], ["charters"]] as const;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_CANDIDATES = 100;

/** Read-only, bounded hints. Discovery never registers or executes a Charter. */
export async function inspectWorkspaceCandidates(context: CandidateContext, focus: string | undefined, limit: number,
  requiredSurfaces: readonly ("web" | "electron" | "mobile")[]): Promise<Candidates> {
  const registered = new Set(context.config.charters.flatMap((entry) => {
    try { return [resolveWithinWorkspace(context.workspaceRoot, entry.path)]; }
    catch { return []; }
  }).map(pathIdentity));
  const knownCapabilities = new Map(context.capabilities.map((item) => [item.name, item]));
  const knownOracles = new Set([...context.oracles.map((item) => item.name), ...context.config.oracles.map((item) => item.name)]);
  const found: Array<{ item: Candidate; searchable: string }> = [];
  let partial = false;
  let truncated = false;

  for (const parts of DIRECTORIES) {
    const directory = join(context.workspaceRoot, ...parts);
    try {
      // Check every component: even an in-workspace symlink is not a candidate directory.
      for (let depth = 1; depth <= parts.length; depth++) {
        const component = join(context.workspaceRoot, ...parts.slice(0, depth));
        if (!(await lstat(component)).isDirectory()) throw new Error("not-directory");
      }
      resolveWithinWorkspace(context.workspaceRoot, parts.join("/"));
    } catch (error) {
      if (!isMissing(error) && !(error instanceof Error && error.message === "not-directory")) partial = true;
      continue;
    }

    const names: string[] = [];
    try {
      const handle = await opendir(directory);
      let scannedEntries = 0;
      for await (const entry of handle) {
        if (scannedEntries++ === MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) names.push(entry.name);
      }
    } catch { partial = true; continue; }

    for (const name of names.sort()) {
      const relativePath = [...parts, name].join("/");
      if (relativePath.length > 512) { partial = true; continue; }
      let absolute: string;
      try { absolute = resolveWithinWorkspace(context.workspaceRoot, relativePath); }
      catch { partial = true; continue; }
      if (registered.has(pathIdentity(absolute))) continue;
      if (found.length === MAX_CANDIDATES) { truncated = true; break; }
      const item: Candidate = { path: relativePath, focusMatched: false, parseStatus: "unreadable", issues: [] };
      let searchable = relativePath;
      try {
        const { charter, sha256 } = await readWorkspaceCharterFile(context.workspaceRoot, relativePath);
        item.parseStatus = "valid";
        item.sha256 = sha256;
        item.level = charter.level;
        item.surfaces = charter.surfaces;
        item.sideEffectPolicy = charter.sideEffectPolicy;
        item.actionCount = charter.actions.length;
        item.assertionCount = charter.assertions.length;
        item.oracleCount = charter.oracles?.length ?? 0;
        if (!hasPositiveSurfaceAssertion(charter.assertions)) item.issues.push("missing-positive-assertion");
        if (charter.level !== "quick" && !item.oracleCount) item.issues.push("missing-business-oracle");
        if (!charter.surfaces) item.issues.push("surface-unspecified");
        else if (!requiredSurfaces.every((surface) => charter.surfaces?.includes(surface))) item.issues.push("surface-mismatch");
        const actions = [...charter.actions, ...(charter.negativeCases ?? []).flatMap((negative) => negative.actions)];
        if (actions.some((action) => action.kind === "capability" && !knownCapabilities.has(action.name))) item.issues.push("unregistered-capability");
        const usedCapabilities = actions.flatMap((action) => action.kind === "capability" ? [knownCapabilities.get(action.name)] : []).filter((item) => item !== undefined);
        if (usedCapabilities.some((capability) => !capability.environments.includes(context.config.policies.environment))) item.issues.push("capability-environment-mismatch");
        if (!context.allowCapabilityWrites && usedCapabilities.some((capability) => capability.sideEffect === "write")) item.issues.push("write-opt-in-required");
        const scenarios = [{ actions: charter.actions, sideEffectPolicy: charter.sideEffectPolicy }, ...(charter.negativeCases ?? [])];
        if (scenarios.some((scenario) => scenario.actions.some((action) => action.kind === "capability" && knownCapabilities.get(action.name)?.sideEffect === "write" && scenario.sideEffectPolicy !== "allow"
          || (action.kind === "setInputFiles" || action.kind === "captureResponse" || action.kind === "selectOption" || action.kind === "setChecked"
            || context.restrictWebOrigins && (action.kind === "click" || action.kind === "fill" || action.kind === "press")) && scenario.sideEffectPolicy !== "allow"))) {
          item.issues.push("scenario-side-effect-policy-conflict");
        }
        if (context.restrictWebOrigins && context.config.policies.sideEffects !== "allow" && scenarios.some((scenario) => scenario.sideEffectPolicy === "allow")) {
          item.issues.push("mcp-workspace-policy-conflict");
        }
        const oracleNames = [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((negative) => negative.oracles)];
        const availableOracles = new Set([...knownOracles, ...(charter.httpOracles ?? []).map((oracle) => oracle.name)]);
        if (oracleNames.some((oracle) => !availableOracles.has(oracle))) item.issues.push("unregistered-oracle");
        const inlineIssue = firstInlineOracleIssue(charter, knownOracles, context.restrictWebOrigins);
        if (inlineIssue?.code === "duplicate-name" || inlineIssue?.code === "registered-name-conflict") item.issues.push("inline-oracle-name-conflict");
        if (inlineIssue?.code === "binding-invalid") item.issues.push("inline-oracle-binding-invalid");
        if (inlineIssue?.code === "current-id-missing") item.issues.push("inline-oracle-current-id-missing");
        if (inlineIssue?.code === "origin-disallowed" || context.restrictWebOrigins && context.config.oracles.some((oracle) =>
          oracleNames.includes(oracle.name) && !isLoopbackHost(new URL(oracle.url).hostname))) item.issues.push("oracle-origin-disallowed");
        if (context.restrictWebOrigins && actions.some((action) =>
          (action.kind === "goto" && !isAllowedMcpWebUrl(action.url, context.config.surfaces.web?.baseUrl))
          || (action.kind === "captureResponse" && !isAllowedMcpWebUrl(action.response.url, context.config.surfaces.web?.baseUrl)))) {
          item.issues.push("web-origin-disallowed");
        }
        searchable = [relativePath, candidateFocusText(charter), ...actions.filter((action) => action.kind === "capability").map((action) => action.name), ...oracleNames].join(" ");
      } catch (error) {
        if (error instanceof WorkspaceCharterFileError && error.focusText) searchable = `${relativePath} ${error.focusText}`;
        if (error instanceof WorkspaceCharterFileError && error.issue === "invalid-charter") {
          item.parseStatus = "invalid";
          item.issues = ["invalid-charter"];
        } else if (error instanceof WorkspaceCharterFileError && error.issue === "endpoint-binding-unavailable") {
          item.parseStatus = "invalid";
          item.issues = ["endpoint-binding-unavailable"];
        } else if (error instanceof WorkspaceCharterFileError && error.issue === "oversized") {
          item.parseStatus = "oversized";
          item.issues = ["file-too-large"];
        } else item.issues = ["file-unavailable"];
        // The file and its focus hints were discovered. An unresolved URL
        // binding limits execution readiness, not candidate enumeration.
        if (!(error instanceof WorkspaceCharterFileError && error.issue === "endpoint-binding-unavailable")) partial = true;
      }
      found.push({ item, searchable });
    }
  }

  const normalizedFocus = focus?.normalize("NFKC").toLowerCase();
  for (const candidate of found) candidate.item.focusMatched = Boolean(normalizedFocus && candidate.searchable.normalize("NFKC").toLowerCase().includes(normalizedFocus));
  const matched = found.filter((candidate) => candidate.item.focusMatched);
  const selection: Candidates["selection"] = !normalizedFocus ? "all" : matched.length ? "focused" : "fallback-unmatched";
  const selected = selection === "focused" ? matched : found;
  return {
    scanStatus: partial || truncated ? "partial" : "complete", scanTruncated: truncated,
    total: found.length, matched: matched.length, selection,
    items: selected.slice(0, limit).map((candidate) => candidate.item),
    omitted: Math.max(0, selected.length - limit),
  };
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
