import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { workflowChecks, WorkflowInventoryInspectionSchema, WorkflowInventorySchema, type ProjectMap, type ProofkitConfig, type SourceState, type WorkflowInventory, type WorkflowInventoryInspection } from "@proofkit/contracts";
import { resolveWithinWorkspace } from "./context.js";
import { captureSourceState } from "./source-state.js";
import { auditWorkflowCandidates } from "./workflow-candidate-audit.js";
import { authenticateWorkflowReview, collectWorkflowReviewMaterials } from "./workflow-review.js";

const INVENTORY_PATH = ".proofkit/workflows.yaml" as const;
const REVIEW_PATH = ".proofkit/workflow-review.json";
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_REVIEW_BYTES = 16 * 1024;
const MAX_TRUST_BYTES = 64 * 1024;

/** Inspect a workspace-owned workflow claim without running a test or connector. */
export async function inspectWorkflowInventory(projectRoot: string, workspaceRoot: string, config: ProofkitConfig, sourceState?: SourceState, project?: ProjectMap,
  trustedPublicKeys?: Readonly<Record<string, string>>): Promise<{
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
  const candidateAudit = project ? auditWorkflowCandidates(project, inventory, config) : undefined;
  const reviewFile = await readWorkflowReviewFile(workspaceRoot);
  const reviewMaterials = reviewFile.status === "loaded" && project
    ? await collectWorkflowReviewMaterials(inventory, config, project, workspaceRoot).catch(() => undefined)
    : undefined;
  const reviewAuthentication = reviewFile.status === "loaded" && candidateAudit && reviewMaterials
    ? authenticateWorkflowReview(inventory, candidateAudit, reviewMaterials, reviewFile.data,
      trustedPublicKeys ?? await loadWorkflowReviewTrust(projectRoot, workspaceRoot))
    : { status: reviewFile.status === "missing" ? "missing" : "invalid" } as const;
  const issues = [
    ...(sourceMatch === "changed" ? ["workflow-inventory-source-changed"] : sourceMatch === "unverified" ? ["workflow-inventory-source-unverified"] : []),
    ...(!inventory.review ? ["workflow-inventory-review-missing"] : []),
    ...(linkedWorkflowCount < inventory.workflows.length ? ["workflow-inventory-charter-mapping-incomplete"] : []),
    ...(missingSourcePaths.size ? ["workflow-inventory-source-path-missing"] : []),
    ...(inventory.exclusions.length ? ["workflow-inventory-has-exclusions"] : []),
    ...(candidateAudit?.unclaimed ? ["workflow-inventory-candidates-unclaimed"] : []),
    ...(candidateAudit?.unlinkedRoutes ? ["workflow-inventory-routes-unlinked"] : []),
    ...(candidateAudit?.overlappingExclusions ? ["workflow-inventory-exclusion-overlap"] : []),
    ...(candidateAudit?.status === "partial" ? ["workflow-inventory-candidate-scan-partial"] : []),
    ...(candidateAudit?.unresolvedRouteDeclarations ? ["workflow-inventory-route-targets-unresolved"] : []),
    ...(reviewAuthentication.status === "invalid" ? ["workflow-review-attestation-invalid"]
      : reviewAuthentication.status === "untrusted" ? ["workflow-review-key-untrusted"] : []),
    // Authentication does not establish semantic completeness or execution proof.
    "workflow-inventory-completeness-unverified",
  ];
  const missingCharters = [...missingCharterIds].sort();
  const missingPaths = [...missingSourcePaths].sort();
  return {
    inventory,
    inspection: WorkflowInventoryInspectionSchema.parse({
      status: "loaded", path: INVENTORY_PATH, sourceMatch, reviewDeclared: Boolean(inventory.review), reviewAuthentication,
      workflowCount: inventory.workflows.length, linkedWorkflowCount, exclusionCount: inventory.exclusions.length,
      missingCharterIds: missingCharters.slice(0, 20), omittedMissingCharterIds: Math.max(0, missingCharters.length - 20),
      uncoveredSurfaces: uncoveredSurfaces.slice(0, 20), omittedUncoveredSurfaces: Math.max(0, uncoveredSurfaces.length - 20),
      missingSourcePaths: missingPaths.slice(0, 20), omittedMissingSourcePaths: Math.max(0, missingPaths.length - 20),
      candidateAudit,
      issues: issues.slice(0, 20), omittedIssues: Math.max(0, issues.length - 20),
    }),
  };
}

async function readWorkflowReviewFile(workspaceRoot: string): Promise<{ status: "missing" | "invalid" | "loaded"; data?: unknown }> {
  try {
    const path = resolveWithinWorkspace(workspaceRoot, REVIEW_PATH);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_REVIEW_BYTES) return { status: "invalid" };
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_BYTES) return { status: "invalid" };
    return { status: "loaded", data: JSON.parse(content) };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  }
}

/** Trust is selected by the operator, outside the project and test workspace. */
async function loadWorkflowReviewTrust(projectRoot: string, workspaceRoot: string): Promise<Readonly<Record<string, string>>> {
  const configured = process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
  if (!configured || !isAbsolute(configured)) return {};
  try {
    const path = await realpath(configured);
    const project = await realpath(projectRoot);
    const workspace = await realpath(workspaceRoot);
    if (inside(path, project) || inside(path, workspace)) return {};
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_TRUST_BYTES) return {};
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_TRUST_BYTES) return {};
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const keys = Object.entries(parsed);
    if (keys.length > 32 || keys.some(([id, value]) => !/^[a-zA-Z0-9._-]+$/.test(id)
      || typeof value !== "string" || value.length > 4096)) return {};
    return Object.fromEntries(keys) as Record<string, string>;
  } catch {
    return {};
  }
}

function inside(path: string, directory: string): boolean {
  const within = relative(directory, path);
  return within === "" || within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
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
