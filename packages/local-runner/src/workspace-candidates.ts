import { lstat, opendir, open } from "node:fs/promises";
import { join } from "node:path";
import { hasPositiveSurfaceAssertion, type ProofkitConfig, type TestScope } from "@proofkit/contracts";
import { IntentPlanner } from "@proofkit/planner";
import { resolveWithinWorkspace } from "@proofkit/project";

type Candidates = NonNullable<TestScope["workspaceCandidates"]>;
type Candidate = Candidates["items"][number];
type CandidateContext = {
  workspaceRoot: string;
  config: ProofkitConfig;
  capabilities: readonly { name: string }[];
  oracles: readonly { name: string }[];
};

const DIRECTORIES = [[".proofkit", "charters"], ["charters"]] as const;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_CANDIDATES = 100;
const MAX_FILE_BYTES = 128 * 1024;

/** Read-only, bounded hints. Discovery never registers or executes a Charter. */
export async function inspectWorkspaceCandidates(context: CandidateContext, focus: string | undefined, limit: number): Promise<Candidates> {
  const registered = new Set(context.config.charters.flatMap((entry) => {
    try { return [resolveWithinWorkspace(context.workspaceRoot, entry.path)]; }
    catch { return []; }
  }).map(pathIdentity));
  const knownCapabilities = new Set(context.capabilities.map((item) => item.name));
  const knownOracles = new Set([...context.oracles.map((item) => item.name), ...context.config.oracles.map((item) => item.name)]);
  const planner = new IntentPlanner();
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
        const info = await lstat(absolute);
        if (!info.isFile()) continue;
        if (info.size > MAX_FILE_BYTES) {
          item.parseStatus = "oversized";
          item.issues = ["file-too-large"];
          partial = true;
        } else {
          const file = await open(absolute, "r");
          let source: string;
          try {
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
              if (!read.bytesRead) break;
              bytesRead += read.bytesRead;
            }
            if (bytesRead > MAX_FILE_BYTES) {
              item.parseStatus = "oversized";
              item.issues = ["file-too-large"];
              partial = true;
              found.push({ item, searchable });
              continue;
            }
            source = buffer.subarray(0, bytesRead).toString("utf8");
          } finally { await file.close(); }
          try {
            const charter = planner.fromYaml(source);
            item.parseStatus = "valid";
            item.level = charter.level;
            item.sideEffectPolicy = charter.sideEffectPolicy;
            item.actionCount = charter.actions.length;
            item.assertionCount = charter.assertions.length;
            item.oracleCount = (charter.oracles?.length ?? 0) + (charter.httpOracles?.length ?? 0);
            if (!hasPositiveSurfaceAssertion(charter.assertions)) item.issues.push("missing-positive-assertion");
            if (charter.level !== "quick" && !item.oracleCount) item.issues.push("missing-business-oracle");
            const actions = [...charter.actions, ...(charter.negativeCases ?? []).flatMap((negative) => negative.actions)];
            if (actions.some((action) => action.kind === "capability" && !knownCapabilities.has(action.name))) item.issues.push("unregistered-capability");
            const oracleNames = [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((negative) => negative.oracles)];
            if (oracleNames.some((oracle) => !knownOracles.has(oracle))) item.issues.push("unregistered-oracle");
            searchable = [relativePath, charter.intent, ...actions.filter((action) => action.kind === "capability").map((action) => action.name), ...oracleNames].join(" ");
          } catch {
            item.parseStatus = "invalid";
            item.issues = ["invalid-charter"];
            partial = true;
          }
        }
      } catch {
        item.issues = ["file-unavailable"];
        partial = true;
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
