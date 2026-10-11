import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RunSummarySchema } from "@proofkit/contracts";
import { LocalExecutionOwnership } from "@proofkit/evidence";
import { resolveProjectContext, sameProjectPath } from "@proofkit/project";

const MAX_RUNS = 5_000;
const MAX_REFERENCE_FILES = 10_000;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

export type EvidenceRetentionRow = {
  runId: string;
  bytes: number;
  endedAt?: string;
  disposition: "retain" | "review" | "unverified";
  reasons: string[];
};

export type EvidenceRetentionAudit = {
  status: "complete" | "incomplete";
  testVerdict: "not-asserted";
  workspaceRoot: string;
  olderThanDays: number;
  totalRuns: number;
  totalBytes: number;
  retainedRuns: number;
  reviewRuns: number;
  unverifiedRuns: number;
  issues: string[];
  runs: EvidenceRetentionRow[];
  /** This command never removes evidence. Review means only that no known reference was found. */
  deletionSupported: false;
};

/** Read-only capacity and reference audit. No row is authorization to delete a Run. */
export async function inspectEvidenceRetention(projectRoot: string, workspaceRoot: string, olderThanDays = 30): Promise<EvidenceRetentionAudit> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
    throw new Error("Evidence retention age must be 1–3650 whole days");
  }
  const context = resolveProjectContext(projectRoot, { workspaceRoot });
  const runsRoot = resolve(context.workspaceRoot, ".proofkit", "runs");
  const missionRoot = resolve(context.workspaceRoot, ".proofkit", "missions");
  const recoveryRoot = resolve(context.workspaceRoot, ".proofkit", "recoveries");
  const issues: string[] = [];
  try {
    if (!(await lstat(context.workspaceRoot)).isDirectory()) issues.push("Test workspace is not a directory.");
  } catch { issues.push("Test workspace is unavailable."); }
  const entries = await directoryEntries(runsRoot, issues, "Run store");
  if (entries.length > MAX_RUNS) issues.push(`Run store exceeds the ${MAX_RUNS} entry audit limit.`);
  const runEntries = entries.slice(0, MAX_RUNS);
  const ids = runEntries.filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name)).map((entry) => entry.name);
  const knownIds = new Set(ids);
  if (runEntries.some((entry) => !entry.isDirectory() || !RUN_ID.test(entry.name))) {
    issues.push("Run store contains an unexpected entry or redirected directory.");
  }
  const references = new Map(ids.map((id) => [id, new Set<string>()]));
  let referenceFiles = 0;
  let readBytes = 0;
  const scanReference = async (file: string, reason: string) => {
    referenceFiles += 1;
    if (referenceFiles > MAX_REFERENCE_FILES) {
      if (referenceFiles === MAX_REFERENCE_FILES + 1) issues.push("Reference inventory exceeds its file limit.");
      return;
    }
    let parsed: unknown;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) throw new Error("not a bounded regular file");
      readBytes += info.size;
      if (readBytes > MAX_AUDIT_FILE_BYTES) throw new Error("audit byte budget exceeded");
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      issues.push(`A ${reason} reference file is unreadable, redirected or invalid.`);
      return;
    }
    for (const id of mentionedRunIds(JSON.stringify(parsed), knownIds)) references.get(id)!.add(reason);
  };
  const missions = await directoryEntries(missionRoot, issues, "Mission store");
  for (const entry of missions) {
    const path = join(missionRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) await scanReference(path, "mission");
    else if (entry.isDirectory()) {
      const report = join(path, "summary.json");
      if (await exists(report)) await scanReference(report, "mission-report");
      else if (await exists(join(path, "report.html"))) issues.push("A Mission report has no readable summary reference file.");
    } else issues.push("Mission store contains an unexpected entry.");
  }
  const recoveries = await directoryEntries(recoveryRoot, issues, "Recovery store");
  for (const entry of recoveries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) {
      issues.push("Recovery store contains an unexpected entry or redirected directory.");
      continue;
    }
    references.get(entry.name)?.add("resource-recovery");
  }
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const ownership = new LocalExecutionOwnership(runsRoot, "run");
  const rows: EvidenceRetentionRow[] = [];
  for (const id of ids) {
    const dir = join(runsRoot, id);
    const reasons = references.get(id)!;
    const tree = await treeBytes(dir);
    if (tree.issue) reasons.add("unreadable-run-tree");
    const manifest = join(dir, "run.json");
    let endedAt: string | undefined;
    try {
      const info = await lstat(manifest);
      if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) throw new Error("not a bounded regular file");
      readBytes += info.size;
      if (readBytes > MAX_AUDIT_FILE_BYTES) throw new Error("audit byte budget exceeded");
      const parsed = JSON.parse(await readFile(manifest, "utf8"));
      const summary = RunSummarySchema.parse(parsed);
      if (summary.runId !== id) throw new Error("Run identity mismatch");
      if (!summary.projectRoot || !summary.workspaceRoot
        || !sameProjectPath(summary.projectRoot, context.projectRoot)
        || !sameProjectPath(summary.workspaceRoot, context.workspaceRoot)) reasons.add("unverifiable-run-binding");
      endedAt = summary.endedAt;
      if (summary.status !== "completed" || !summary.verdict || !endedAt || !Number.isFinite(Date.parse(endedAt))) reasons.add("incomplete-run");
      else if (Date.parse(endedAt) > cutoff) reasons.add("within-retention-window");
      if (summary.artifacts.some((path) => path.endsWith("/integration-setup.json")) || await exists(join(dir, "artifacts", "integration-setup.json"))) {
        reasons.add("integration-resource-history");
      }
      if (summary.integrationCleanup && (summary.integrationCleanup.declaredResources > 0
        || summary.integrationCleanup.status === "failed" || summary.integrationCleanup.status === "unverified")) {
        reasons.add("integration-resource-history");
      }
      for (const otherId of mentionedRunIds(JSON.stringify(parsed), knownIds)) {
        if (otherId !== id) references.get(otherId)!.add("run-replay-or-reference");
      }
    } catch {
      reasons.add("unverifiable-run-manifest");
      issues.push(`Run ${id} has an unreadable or invalid manifest; replay references cannot be excluded.`);
    }
    if (await ownership.isActive(id)) reasons.add("active-run-owner");
    rows.push({ runId: id, bytes: tree.bytes, ...(endedAt ? { endedAt } : {}), disposition: "unverified", reasons: [...reasons].sort() });
  }
  // A malformed reference inventory invalidates every apparent gap. Classify
  // only after all Run manifests have been inspected for replay references.
  for (const row of rows) {
    row.reasons = [...references.get(row.runId)!, ...row.reasons].filter((value, index, all) => all.indexOf(value) === index).sort();
    row.disposition = issues.length || row.reasons.some((reason) => reason.startsWith("unverifiable-") || reason === "unreadable-run-tree")
      ? "unverified" : row.reasons.length ? "retain" : "review";
  }
  return {
    status: issues.length ? "incomplete" : "complete", testVerdict: "not-asserted",
    workspaceRoot: context.workspaceRoot, olderThanDays, totalRuns: entries.length,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    retainedRuns: rows.filter((row) => row.disposition === "retain").length,
    reviewRuns: rows.filter((row) => row.disposition === "review").length,
    unverifiedRuns: rows.filter((row) => row.disposition === "unverified").length,
    issues, runs: rows, deletionSupported: false,
  };
}

function mentionedRunIds(raw: string, knownIds: Set<string>): Set<string> {
  const found = new Set<string>();
  // JSON string values may hold a plain ID, Run path, evidence ID or replay
  // reference. Whole ASCII tokens avoid prefix matches between Run IDs.
  for (const match of raw.matchAll(/[a-zA-Z0-9_-]+/g)) {
    if (knownIds.has(match[0])) found.add(match[0]);
  }
  return found;
}

async function directoryEntries(path: string, issues: string[], label: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error("not a direct directory");
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    issues.push(`${label} cannot be safely inspected.`);
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

async function treeBytes(root: string): Promise<{ bytes: number; issue: boolean }> {
  let bytes = 0;
  let visited = 0;
  const pending = [root];
  try {
    while (pending.length) {
      if (++visited > MAX_TREE_ENTRIES) return { bytes, issue: true };
      const path = pending.pop()!;
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { bytes, issue: true };
      if (info.isFile()) bytes += info.size;
      else if (info.isDirectory()) for (const entry of await readdir(path)) pending.push(join(path, entry));
      else return { bytes, issue: true };
    }
    return { bytes, issue: false };
  } catch { return { bytes, issue: true }; }
}
