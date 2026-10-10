import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { workflowChecks, WorkflowInventoryInspectionSchema, WorkflowInventorySchema, type ProofkitConfig, type SourceState, type WorkflowInventory, type WorkflowInventoryInspection } from "@proofkit/contracts";
import { resolveWithinWorkspace } from "./context.js";
import { captureSourceState } from "./source-state.js";

const INVENTORY_PATH = ".proofkit/workflows.yaml" as const;
const MAX_INVENTORY_BYTES = 1024 * 1024;

/** Inspect a workspace-owned workflow claim without running a test or connector. */
export async function inspectWorkflowInventory(projectRoot: string, workspaceRoot: string, config: ProofkitConfig, sourceState?: SourceState): Promise<{
  inventory?: WorkflowInventory;
  inspection: WorkflowInventoryInspection;
}> {
  const base = { path: INVENTORY_PATH, reviewDeclared: false, workflowCount: 0, linkedWorkflowCount: 0, exclusionCount: 0,
    missingCharterIds: [], omittedMissingCharterIds: 0, uncoveredSurfaces: [], omittedUncoveredSurfaces: 0,
    missingSourcePaths: [], omittedMissingSourcePaths: 0,
    issues: [], omittedIssues: 0 };
  let path: string;
  try {
    path = resolveWithinWorkspace(workspaceRoot, INVENTORY_PATH);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_INVENTORY_BYTES) throw new Error("invalid inventory file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { inspection: WorkflowInventoryInspectionSchema.parse({ ...base, status: "missing", sourceMatch: "not-checked", issues: ["workflow-inventory-missing"] }) };
    }
    return { inspection: WorkflowInventoryInspectionSchema.parse({ ...base, status: "invalid", sourceMatch: "not-checked", issues: ["workflow-inventory-invalid"] }) };
  }
  let inventory: WorkflowInventory;
  try {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_INVENTORY_BYTES) throw new Error("inventory file changed during read");
    inventory = WorkflowInventorySchema.parse(parse(content));
  } catch {
    // Parser diagnostics may contain fixture paths, credentials or source text.
    return { inspection: WorkflowInventoryInspectionSchema.parse({ ...base, status: "invalid", sourceMatch: "not-checked", issues: ["workflow-inventory-invalid"] }) };
  }

  const current = sourceState ?? await captureSourceState(projectRoot);
  const sourceMatch = !current.complete || current.method !== "git" || !current.worktreeSha256
    ? "unverified"
    : current.headSha === inventory.source.headSha && current.worktreeSha256 === inventory.source.worktreeSha256
      ? "matching" : "changed";
  const catalog = new Map(config.charters.map((entry) => [entry.id, entry]));
  const missingCharterIds = new Set<string>();
  const uncoveredSurfaces: Array<{ workflowId: string; surface: "web" | "electron" | "mobile" }> = [];
  const missingSourcePaths = new Set<string>();
  let linkedWorkflowCount = 0;
  for (const workflow of inventory.workflows) {
    let linked = true;
    for (const check of workflowChecks(workflow)) {
      const entry = catalog.get(check.charterId);
      if (!entry) {
        missingCharterIds.add(check.charterId);
        linked = false;
      }
      for (const surface of check.surfaces) {
        if (!entry?.surfaces.includes(surface)) {
          linked = false;
          uncoveredSurfaces.push({ workflowId: workflow.id, surface });
        }
      }
    }
    if (linked) linkedWorkflowCount++;
  }
  const checkedPaths = new Map<string, boolean>();
  const canonicalProjectRoot = await realpath(projectRoot).catch(() => undefined);
  for (const path of [...inventory.workflows.flatMap((item) => item.sourcePaths), ...inventory.exclusions.flatMap((item) => item.sourcePaths)]) {
    if (!checkedPaths.has(path)) checkedPaths.set(path, canonicalProjectRoot ? await sourcePathExists(canonicalProjectRoot, path) : false);
    if (!checkedPaths.get(path)) missingSourcePaths.add(path);
  }
  const issues = [
    ...(sourceMatch === "changed" ? ["workflow-inventory-source-changed"] : sourceMatch === "unverified" ? ["workflow-inventory-source-unverified"] : []),
    ...(!inventory.review ? ["workflow-inventory-review-missing"] : []),
    ...(linkedWorkflowCount < inventory.workflows.length ? ["workflow-inventory-charter-mapping-incomplete"] : []),
    ...(missingSourcePaths.size ? ["workflow-inventory-source-path-missing"] : []),
    ...(inventory.exclusions.length ? ["workflow-inventory-has-exclusions"] : []),
    // A declared reviewer is metadata, not an authenticated approval or execution proof.
    "workflow-inventory-completeness-unverified",
  ];
  const missingCharters = [...missingCharterIds].sort();
  const missingPaths = [...missingSourcePaths].sort();
  return {
    inventory,
    inspection: WorkflowInventoryInspectionSchema.parse({
      status: "loaded", path: INVENTORY_PATH, sourceMatch, reviewDeclared: Boolean(inventory.review),
      workflowCount: inventory.workflows.length, linkedWorkflowCount, exclusionCount: inventory.exclusions.length,
      missingCharterIds: missingCharters.slice(0, 20), omittedMissingCharterIds: Math.max(0, missingCharters.length - 20),
      uncoveredSurfaces: uncoveredSurfaces.slice(0, 20), omittedUncoveredSurfaces: Math.max(0, uncoveredSurfaces.length - 20),
      missingSourcePaths: missingPaths.slice(0, 20), omittedMissingSourcePaths: Math.max(0, missingPaths.length - 20),
      issues: issues.slice(0, 20), omittedIssues: Math.max(0, issues.length - 20),
    }),
  };
}

async function sourcePathExists(canonicalProjectRoot: string, sourcePath: string): Promise<boolean> {
  try {
    const actual = await realpath(resolve(canonicalProjectRoot, sourcePath));
    const within = relative(canonicalProjectRoot, actual);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
    const info = await stat(actual);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}
