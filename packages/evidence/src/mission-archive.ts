import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EvidenceRefSchema, MissionResultSchema, RunEventSchema, RunSummarySchema, type EvidenceRef, type MissionResult } from "@proofkit/contracts";
import { verifyRunManifest } from "./manifest.js";

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;
const MAX_RUNS = 128;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
type ArchiveFile = { path: string; bytes: number; sha256: string };
type EventAnchor = { summarySha256: string; eventLogSha256: string; reportSha256: string };
type ArchiveRun = { runId: string; seal: "manifest"; manifestSha256: string; snapshotAnchor?: EventAnchor }
  | { runId: string; seal: "event-log"; summarySha256: string; eventLogSha256: string; reportSha256: string };
export type SavedEvidenceScope = {
  acceptance: "declared" | "project" | "unverified";
  workflowCoverage: "unmeasured" | "unverified";
  sessionCaptures: Array<{ runId: string; status: "sealed" | "partial" | "unavailable" | "unverified"; integrity: "intact" | "changed" | "missing" | "unverified" | "not-sealed" }>;
  omittedSessionCaptures: number;
  omittedContextRuns: number;
};
function parseSavedScope(value: unknown): SavedEvidenceScope {
  if (!value || typeof value !== "object") throw new Error("Invalid saved evidence scope"); const scope = value as SavedEvidenceScope;
  if (!["declared", "project", "unverified"].includes(scope.acceptance) || !["unmeasured", "unverified"].includes(scope.workflowCoverage)
    || !Number.isSafeInteger(scope.omittedContextRuns) || scope.omittedContextRuns < 0 || !Number.isSafeInteger(scope.omittedSessionCaptures) || scope.omittedSessionCaptures < 0
    || !Array.isArray(scope.sessionCaptures) || scope.sessionCaptures.length > 10 || scope.sessionCaptures.some((capture) => !capture || !ID.test(capture.runId)
      || !["sealed", "partial", "unavailable", "unverified"].includes(capture.status) || !["intact", "changed", "missing", "unverified", "not-sealed"].includes(capture.integrity))) throw new Error("Invalid saved evidence scope");
  return { acceptance: scope.acceptance, workflowCoverage: scope.workflowCoverage, sessionCaptures: scope.sessionCaptures.map(({ runId, status, integrity }) => ({ runId, status, integrity })),
    omittedSessionCaptures: scope.omittedSessionCaptures, omittedContextRuns: scope.omittedContextRuns };
}
function savedScope(summary: MissionResult): SavedEvidenceScope {
  return parseSavedScope({ acceptance: summary.planning?.coverage?.requested ?? "unverified",
    workflowCoverage: summary.planning?.coverage?.workflowCoverage ?? "unverified",
    sessionCaptures: (summary.sessionCaptures?.segments ?? []).map((segment) => ({ runId: segment.runId, status: segment.capture?.status ?? "unverified", integrity: segment.integrity })),
    omittedSessionCaptures: summary.sessionCaptures?.omittedSegments ?? 0, omittedContextRuns: summary.sessionContext?.omittedRuns ?? 0 });
}
export type MissionArchive = {
  schemaVersion: 1;
  missionId: string;
  createdAt: string;
  source: { summarySha256: string; reportSha256: string };
  savedTestVerdict: string;
  savedScope: SavedEvidenceScope;
  runs: ArchiveRun[];
  files: ArchiveFile[];
};
export type ArchiveVerification = {
  status: "intact" | "changed" | "missing" | "unverified";
  testVerdict: "not-asserted";
  archiveSha256?: string;
  anchor: "pinned" | "self-described";
  missionId?: string;
  savedTestVerdict?: string;
  savedScope?: SavedEvidenceScope;
  files: number;
  bytes: number;
  issues: string[];
};
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
function within(root: string, target: string): boolean {
  const child = relative(root, target); return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep);
}
function safePath(value: string): boolean {
  return value.length <= 1024 && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\\:*?"<>|\u0000-\u001f]/.test(part)
    && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}
function ownedRunPath(value: string, ids: Set<string>): boolean {
  const parts = value.split("/");
  return parts[0] === ".proofkit" && parts[1] === "runs" && ids.has(parts[2] ?? "")
    && (parts.length === 4 && ["run.json", "report.html", "events.jsonl", "manifest.json"].includes(parts[3]!) || parts.length >= 5 && parts[3] === "artifacts");
}
async function directory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || !samePath(await realpath(path), resolve(path))) throw new Error("Archive directory is redirected or unavailable");
}
async function readBounded(root: string, path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted(); if (!safePath(path)) throw new Error("Unsafe archive path");
  const parts = path.split("/"); let parent = root;
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); await directory(parent); }
  const target = resolve(root, ...parts); const direct = await lstat(target);
  if (!direct.isFile() || direct.size > limit || !samePath(await realpath(target), target)) throw new Error("Archive file is redirected or exceeds its byte bound");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat(); if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size > limit) throw new Error("Archive file changed during opening");
    const chunks: Buffer[] = []; const chunk = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    while (bytes <= limit) {
      signal?.throwIfAborted(); const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, limit - bytes + 1), bytes);
      if (!bytesRead) break; bytes += bytesRead; if (bytes > limit) throw new Error("Archive file exceeds its byte bound");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await file.stat(); const current = await lstat(target);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || !samePath(await realpath(target), target)) throw new Error("Archive file changed during reading");
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}
function dependencies(value: unknown): { ids: Set<string>; refs: EvidenceRef[] } {
  const ids = new Set<string>(); const refs: EvidenceRef[] = []; let visited = 0;
  const visit = (item: unknown, depth: number) => {
    if (++visited > 100_000 || depth > 40) throw new Error("Mission archive dependency graph exceeds its bound");
    if (!item || typeof item !== "object") return;
    const object = item as Record<string, unknown>;
    if (typeof object.runId === "string") { if (!ID.test(object.runId)) throw new Error("Invalid archive Run identity"); ids.add(object.runId); }
    if (Object.hasOwn(object, "evidenceId") && Object.hasOwn(object, "path")) refs.push(EvidenceRefSchema.parse(object));
    for (const child of Object.values(object)) if (child && typeof child === "object") visit(child, depth + 1);
  };
  visit(value, 0); return { ids, refs };
}
function referencePath(workspace: string, value: string): string {
  if (value.replaceAll("\\", "/").split("/").some((part) => part === "." || part === "..")) throw new Error("Unsafe evidence reference");
  const normalized = value.replaceAll("\\", "/"); const source = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  let path: string;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    const windows = /^[A-Za-z]:\//.test(source);
    if (!(windows ? normalized.toLowerCase() : normalized).startsWith((windows ? source.toLowerCase() : source) + "/")) throw new Error("Evidence reference belongs to another workspace");
    path = normalized.slice(source.length + 1);
  } else path = normalized.startsWith(".proofkit/") ? normalized : ".proofkit/runs/" + normalized;
  if (!safePath(path)) throw new Error("Unsafe evidence reference"); return path;
}
function sourceIdentity(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, ""); return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
async function eventSealedFiles(root: string, run: { runId: string } & EventAnchor, signal?: AbortSignal, allowManifest = false): Promise<ArchiveFile[]> {
  const prefix = ".proofkit/runs/" + run.runId; const summaryBytes = await readBounded(root, prefix + "/run.json", MAX_FILE_BYTES, signal);
  if (hash(summaryBytes) !== run.summarySha256) throw new Error("Original event-sealed summary changed");
  const summary = RunSummarySchema.parse(JSON.parse(summaryBytes.toString("utf8")));
  const events = await readBounded(root, prefix + "/events.jsonl", MAX_FILE_BYTES, signal);
  if (summary.runId !== run.runId || summary.status !== "completed" || summary.eventLog?.status !== "sealed" || summary.eventLog.bytes !== events.length
    || summary.eventLog.sha256 !== run.eventLogSha256 || hash(events) !== run.eventLogSha256) throw new Error("Original event-log seal did not verify");
  const artifacts = new Map<string, ArchiveFile>(); const unhashed = new Set<string>(); const lines = events.toString("utf8").trim().split("\n"); if (lines.length > 100_000) throw new Error("Event log exceeds its archive bound");
  for (const line of lines) {
    if (!line) continue; const event = RunEventSchema.parse(JSON.parse(line)); if (event.runId !== run.runId) throw new Error("Event log belongs to another Run");
    if (event.type !== "artifact.created") continue; const payload = event.payload as { path?: unknown; bytes?: unknown; sha256?: unknown };
    if (typeof payload.path !== "string" || !payload.path.startsWith(run.runId + "/artifacts/") || !safePath(payload.path)) throw new Error("An original artifact hash is unavailable");
    if (payload.sha256 === undefined && payload.bytes === undefined) { if (!artifacts.has(payload.path)) unhashed.add(payload.path); continue; }
    if (!Number.isSafeInteger(payload.bytes) || (payload.bytes as number) < 0 || (payload.bytes as number) > MAX_FILE_BYTES) throw new Error("An original artifact hash is unavailable");
    if (payload.sha256 === undefined) { artifacts.delete(payload.path); unhashed.add(payload.path); continue; }
    if (typeof payload.sha256 !== "string" || !SHA.test(payload.sha256)) throw new Error("An original artifact hash is unavailable");
    unhashed.delete(payload.path);
    artifacts.set(payload.path, { path: ".proofkit/runs/" + payload.path, bytes: payload.bytes as number, sha256: payload.sha256 });
  }
  if (unhashed.size || new Set(summary.artifacts).size !== artifacts.size || summary.artifacts.some((path) => !artifacts.has(path))) throw new Error("Event seal does not cover all declared artifacts");
  if (artifacts.size > MAX_FILES - 3 || [...artifacts.values()].reduce((total, file) => total + file.bytes, events.length + summaryBytes.length) > MAX_BYTES) throw new Error("Event-sealed evidence exceeds its archive bound");
  const report = await readBounded(root, prefix + "/report.html", MAX_FILE_BYTES, signal); if (hash(report) !== run.reportSha256) throw new Error("Original event-sealed report changed");
  const files = [{ path: prefix + "/run.json", bytes: summaryBytes.length, sha256: run.summarySha256 }, { path: prefix + "/events.jsonl", bytes: events.length, sha256: run.eventLogSha256 },
    { path: prefix + "/report.html", bytes: report.length, sha256: run.reportSha256 }, ...artifacts.values()];
  for (const file of artifacts.values()) { const bytes = await readBounded(root, file.path, file.bytes, signal); if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error("Original event-sealed artifact changed"); }
  const actual = (await inventory(join(root, ".proofkit/runs", run.runId))).filter((path) => !allowManifest || path !== "manifest.json").map((path) => prefix + "/" + path);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(files.map((file) => file.path).sort())) throw new Error("Event-sealed Run inventory changed"); return files;
}
async function inventory(root: string): Promise<string[]> {
  const files: string[] = []; let entries = 0;
  const walk = async (parent: string, depth: number) => {
    if (depth > 16) throw new Error("Archive directory depth exceeds its bound"); await directory(parent);
    for (const item of await readdir(parent, { withFileTypes: true })) {
      if (++entries > MAX_FILES * 2) throw new Error("Archive inventory exceeds its bound");
      const target = join(parent, item.name); if (item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) throw new Error("Archive inventory contains redirected or special files");
      if (item.isDirectory()) await walk(target, depth + 1); else { const path = relative(root, target).split(sep).join("/"); if (!safePath(path) || files.length >= MAX_FILES + 1) throw new Error("Archive inventory exceeds its bound"); files.push(path); }
    }
  };
  await walk(root, 0); return files.sort();
}
function parseArchive(value: unknown): MissionArchive {
  if (!value || typeof value !== "object") throw new Error("Invalid archive descriptor"); const archive = value as MissionArchive;
  if (archive.schemaVersion !== 1 || !ID.test(archive.missionId) || !Number.isFinite(Date.parse(archive.createdAt))
    || !SHA.test(archive.source?.summarySha256) || !SHA.test(archive.source?.reportSha256)
    || !["passed", "failed", "inconclusive", "blocked", "cancelled", "not-asserted"].includes(archive.savedTestVerdict)
    || !Array.isArray(archive.runs) || archive.runs.length < 1 || archive.runs.length > MAX_RUNS
    || !Array.isArray(archive.files) || archive.files.length < 4 || archive.files.length > MAX_FILES) throw new Error("Invalid archive descriptor");
  const ids = new Set<string>(); for (const run of archive.runs) {
    if (!ID.test(run.runId) || ids.has(run.runId) || (run.seal === "manifest" ? !SHA.test(run.manifestSha256)
      : run.seal !== "event-log" || !SHA.test(run.summarySha256) || !SHA.test(run.eventLogSha256) || !SHA.test(run.reportSha256))) throw new Error("Invalid archive Run list"); ids.add(run.runId);
    if (run.seal === "manifest" && run.snapshotAnchor && (!SHA.test(run.snapshotAnchor.summarySha256) || !SHA.test(run.snapshotAnchor.eventLogSha256) || !SHA.test(run.snapshotAnchor.reportSha256))) throw new Error("Invalid original manifest source anchor");
  }
  parseSavedScope(archive.savedScope);
  const paths = new Set<string>(); let total = 0;
  for (const file of archive.files) {
    const key = process.platform === "win32" ? file.path?.toLowerCase() : file.path;
    if (typeof file.path !== "string" || !safePath(file.path) || paths.has(key) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !SHA.test(file.sha256)
      || file.path !== "index.html" && file.path !== ".proofkit/missions/" + archive.missionId + "/summary.json" && file.path !== ".proofkit/missions/" + archive.missionId + "/report.html" && !ownedRunPath(file.path, ids)) throw new Error("Invalid archive file inventory");
    paths.add(key); total += file.bytes;
  }
  const missionPath = ".proofkit/missions/" + archive.missionId;
  const required = ["index.html", missionPath + "/summary.json", missionPath + "/report.html", ...archive.runs.flatMap((run) => [".proofkit/runs/" + run.runId + "/run.json",
    ...run.seal === "manifest" ? [".proofkit/runs/" + run.runId + "/manifest.json"] : [".proofkit/runs/" + run.runId + "/events.jsonl", ".proofkit/runs/" + run.runId + "/report.html"]])];
  if (total > MAX_BYTES || required.some((path) => !paths.has(process.platform === "win32" ? path.toLowerCase() : path))) throw new Error("Archive dependencies are incomplete or over budget");
  return archive;
}
export async function verifyMissionArchive(archiveRoot: string, expectedArchiveSha256?: string): Promise<ArchiveVerification> {
  if (expectedArchiveSha256 !== undefined && !SHA.test(expectedArchiveSha256)) throw new Error("Invalid expected archive SHA-256");
  const result: ArchiveVerification = { status: "unverified", testVerdict: "not-asserted", anchor: expectedArchiveSha256 ? "pinned" : "self-described", files: 0, bytes: 0, issues: [] };
  try {
    const root = resolve(archiveRoot); await directory(root); const bytes = await readBounded(root, "archive.json", MAX_DESCRIPTOR_BYTES);
    result.archiveSha256 = hash(bytes); if (expectedArchiveSha256 && result.archiveSha256 !== expectedArchiveSha256) { result.status = "changed"; result.issues.push("Archive descriptor does not match the supplied original digest"); return result; }
    const archive = parseArchive(JSON.parse(bytes.toString("utf8"))); result.missionId = archive.missionId; result.savedTestVerdict = archive.savedTestVerdict; result.savedScope = archive.savedScope;
    result.status = "intact";
    for (const file of archive.files) {
      try {
        const content = await readBounded(root, file.path, Math.min(MAX_FILE_BYTES, MAX_BYTES - result.bytes)); result.files++; result.bytes += content.length;
        if (content.length !== file.bytes || hash(content) !== file.sha256) { result.status = "changed"; result.issues.push("Changed archive file: " + file.path); }
      } catch (error) {
        if (result.status !== "changed") result.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified";
        result.issues.push("Unavailable archive file: " + file.path);
      }
    }
    const expected = archive.files.map((file) => file.path).concat("archive.json").sort(); const actual = await inventory(root);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) { if (result.status === "intact") result.status = "changed"; result.issues.push("Archive inventory has missing or unexpected files"); }
    for (const run of archive.runs) {
      if (run.seal === "manifest") {
        const audit = await verifyRunManifest(join(root, ".proofkit/runs"), run.runId, run.manifestSha256);
        if (audit.status !== "intact") { if (result.status === "intact") result.status = audit.status; result.issues.push("Original Run manifest did not verify: " + run.runId); }
        if (run.snapshotAnchor) {
          const original = await eventSealedFiles(root, { runId: run.runId, ...run.snapshotAnchor }, undefined, true);
          const copied = new Map(archive.files.map((file) => [file.path, file]));
          if (original.some((file) => copied.get(file.path)?.sha256 !== file.sha256 || copied.get(file.path)?.bytes !== file.bytes)) throw new Error("Manifest disagrees with its snapshot-pinned original event chain");
        }
      } else {
        const original = await eventSealedFiles(root, run); const copied = new Map(archive.files.map((file) => [file.path, file]));
        if (original.some((file) => copied.get(file.path)?.sha256 !== file.sha256 || copied.get(file.path)?.bytes !== file.bytes)) throw new Error("Event-sealed archive inventory disagrees with original hashes");
      }
    }
    const summaryFile = archive.files.find((file) => file.path.endsWith("/missions/" + archive.missionId + "/summary.json"))!;
    const reportFile = archive.files.find((file) => file.path.endsWith("/missions/" + archive.missionId + "/report.html"))!;
    if (summaryFile.sha256 !== archive.source.summarySha256 || reportFile.sha256 !== archive.source.reportSha256) { result.status = "changed"; result.issues.push("Mission source anchors disagree"); }
    const summary = MissionResultSchema.parse(JSON.parse((await readBounded(root, summaryFile.path, MAX_DESCRIPTOR_BYTES)).toString("utf8")));
    const required = dependencies(summary); const expectedFiles = new Map(archive.files.map((file) => [file.path, file.sha256]));
    for (const ref of required.refs) {
      const path = referencePath(summary.workspaceRoot, ref.path); const id = path.split("/")[2]; if (id) required.ids.add(id);
      if (!ref.sha256 || expectedFiles.get(path) !== ref.sha256) throw new Error("Archive does not retain a referenced source digest");
    }
    if (summary.missionId !== archive.missionId || summary.running || !["completed", "failed", "blocked", "cancelled"].includes(summary.status) || summary.omittedRunResults > 0
      || archive.savedTestVerdict !== (summary.testVerdict ?? summary.verdict ?? "inconclusive")
      || JSON.stringify(parseSavedScope(archive.savedScope)) !== JSON.stringify(savedScope(summary))
      || required.ids.size !== archive.runs.length || archive.runs.some((run) => !required.ids.has(run.runId))) throw new Error("Archive dependency closure does not match the saved Mission");
    for (const run of archive.runs) {
      if (run.seal === "manifest") {
        const prefix = ".proofkit/runs/" + run.runId;
        const hasRef = (path: string, digest: string) => required.refs.some((ref) => referencePath(summary.workspaceRoot, ref.path) === prefix + path && ref.sha256 === digest);
        if (run.snapshotAnchor ? !hasRef("/run.json", run.snapshotAnchor.summarySha256) || !hasRef("/report.html", run.snapshotAnchor.reportSha256)
          : !hasRef("/manifest.json", run.manifestSha256)) throw new Error("Run manifest is not anchored to the saved snapshot");
      }
      if (run.seal === "event-log" && (summary.runs.some((item) => item.runId === run.runId)
        || expectedFiles.get(".proofkit/runs/" + run.runId + "/run.json") !== run.summarySha256
        || !required.refs.some((ref) => referencePath(summary.workspaceRoot, ref.path) === ".proofkit/runs/" + run.runId + "/run.json" && ref.sha256 === run.summarySha256)
        || !required.refs.some((ref) => referencePath(summary.workspaceRoot, ref.path) === ".proofkit/runs/" + run.runId + "/report.html" && ref.sha256 === run.reportSha256))) throw new Error("An event-only seal cannot replace an execution manifest or its original snapshot anchors");
      const source = RunSummarySchema.parse(JSON.parse((await readBounded(root, ".proofkit/runs/" + run.runId + "/run.json", MAX_FILE_BYTES)).toString("utf8")));
      if (source.runId !== run.runId || source.status !== "completed" || source.workspaceRoot && sourceIdentity(source.workspaceRoot) !== sourceIdentity(summary.workspaceRoot)) throw new Error("Archive contains an active or foreign Run");
    }
    result.issues = result.issues.slice(0, 100); return result;
  } catch (error) {
    if (result.status !== "changed" && result.status !== "missing") result.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified";
    result.issues.push("Archive could not be fully inspected"); return result;
  }
}
function indexHtml(summary: MissionResult, runs: ArchiveRun[]): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const scope = savedScope(summary);
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'"><title>ProofKit evidence archive</title><style>body{font:16px/1.8 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;overflow-wrap:anywhere}a{color:#1762aa}</style><h1>Saved Mission evidence</h1><p>'
    + escape(summary.missionId) + '</p><p>Saved test verdict: <strong>' + escape(summary.testVerdict ?? summary.verdict ?? 'inconclusive') + '</strong>. Archive integrity is a separate check; this page does not rerun business acceptance.</p><p><a href=".proofkit/missions/'
    + escape(summary.missionId) + '/report.html">Open original Mission report</a> · <a href="archive.json">Archive descriptor</a></p><p>Original-manifest Runs: ' + runs.filter((run) => run.seal === "manifest").length
    + '. Historical context Runs verified through their snapshot-pinned summaries, reports and sealed artifact event logs: ' + runs.filter((run) => run.seal === "event-log").length
    + '. No missing original manifest is invented.</p><p>Saved acceptance scope: <strong>' + escape(scope.acceptance) + '</strong>; workflow coverage: ' + escape(scope.workflowCoverage)
    + '. Earlier context Runs omitted by the saved snapshot: ' + scope.omittedContextRuns + '; session segments omitted: ' + scope.omittedSessionCaptures + '.</p><ul>'
    + scope.sessionCaptures.map((capture) => '<li>Session ' + escape(capture.runId) + ': capture completeness <strong>' + escape(capture.status) + '</strong>, saved integrity ' + escape(capture.integrity) + '.</li>').join('')
    + '</ul><p>Original evidence bytes, manifests and saved provenance remain unchanged. Session completeness and coverage limits remain those of the saved report. Referenced values and videos may contain sensitive data; no additional redaction is applied during export.</p><p>Verify with proofkit verify-archive and the separately retained archive SHA-256. Local hashes are not an external authenticity or completeness certification.</p></html>\n';
}
export async function exportMissionArchive(options: { workspaceRoot: string; missionId: string; destination: string; expectedSummarySha256?: string; signal?: AbortSignal }): Promise<{
  directory: string; index: string; archiveSha256: string; missionId: string; savedTestVerdict: string; savedScope: SavedEvidenceScope; runs: number; files: number; bytes: number; testVerdict: "not-asserted";
}> {
  const { missionId, signal } = options; signal?.throwIfAborted(); if (!ID.test(missionId)) throw new Error("Invalid Mission identity");
  if (options.expectedSummarySha256 !== undefined && !SHA.test(options.expectedSummarySha256)) throw new Error("Invalid expected Mission summary SHA-256");
  const workspace = resolve(options.workspaceRoot); await directory(workspace); const destination = resolve(options.destination); const parent = dirname(destination); await directory(parent);
  if (within(workspace, destination) || within(destination, workspace)) throw new Error("Archive output must be separate from its source workspace");
  try { await lstat(destination); throw new Error("Archive destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const missionPath = ".proofkit/missions/" + missionId;
  const summaryBytes = await readBounded(workspace, missionPath + "/summary.json", MAX_DESCRIPTOR_BYTES, signal);
  const summary = MissionResultSchema.parse(JSON.parse(summaryBytes.toString("utf8")));
  if (summary.missionId !== missionId || !samePath(resolve(summary.workspaceRoot), workspace) || summary.running || !["completed", "failed", "blocked", "cancelled"].includes(summary.status)
    || summary.omittedRunResults > 0) throw new Error("Mission snapshot is foreign, active or omits execution Runs");
  if (options.expectedSummarySha256 && hash(summaryBytes) !== options.expectedSummarySha256) throw new Error("Mission snapshot does not match its original digest");
  const reportBytes = await readBounded(workspace, missionPath + "/report.html", MAX_FILE_BYTES, signal);
  const { ids, refs } = dependencies(summary); const referenceDigests = new Map<string, string>();
  for (const ref of refs) {
    if (!ref.sha256 || !SHA.test(ref.sha256)) throw new Error("Mission contains an unpinned evidence reference");
    const path = referencePath(workspace, ref.path); const parts = path.split("/");
    if (parts[0] !== ".proofkit" || parts[1] !== "runs" || !ID.test(parts[2] ?? "")) throw new Error("Mission evidence is outside the Run store"); ids.add(parts[2]!);
    const previous = referenceDigests.get(path); if (previous && previous !== ref.sha256) throw new Error("Mission contains conflicting evidence digests"); referenceDigests.set(path, ref.sha256);
  }
  if (!ids.size || ids.size > MAX_RUNS) throw new Error("Mission Run dependencies exceed the archive bound");
  const runs: ArchiveRun[] = []; const planned = new Map<string, ArchiveFile>(); let totalBytes = 0;
  const plan = (path: string, bytes: number, sha256: string) => {
    if (!safePath(path) || planned.has(path) || planned.size >= MAX_FILES || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_BYTES || !SHA.test(sha256)) throw new Error("Archive plan exceeds bounds or contains conflicting paths");
    planned.set(path, { path, bytes, sha256 }); totalBytes += bytes;
  };
  plan(missionPath + "/summary.json", summaryBytes.length, hash(summaryBytes)); plan(missionPath + "/report.html", reportBytes.length, hash(reportBytes));
  for (const runId of [...ids].sort()) {
    signal?.throwIfAborted(); const manifestPath = ".proofkit/runs/" + runId + "/manifest.json";
    let bytes: Buffer;
    try { bytes = await readBounded(workspace, manifestPath, MAX_DESCRIPTOR_BYTES, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || referenceDigests.has(manifestPath) || summary.runs.some((run) => run.runId === runId)) throw error;
      const summarySha256 = referenceDigests.get(".proofkit/runs/" + runId + "/run.json"), reportSha256 = referenceDigests.get(".proofkit/runs/" + runId + "/report.html");
      if (!summarySha256 || !reportSha256) throw new Error("Unsealed context lacks original snapshot anchors");
      const body = RunSummarySchema.parse(JSON.parse((await readBounded(workspace, ".proofkit/runs/" + runId + "/run.json", MAX_FILE_BYTES, signal)).toString("utf8")));
      if (!body.eventLog?.sha256) throw new Error("Unsealed context lacks an original event-log seal");
      const run: ArchiveRun = { runId, seal: "event-log", summarySha256, reportSha256, eventLogSha256: body.eventLog.sha256 };
      for (const file of await eventSealedFiles(workspace, run, signal)) plan(file.path, file.bytes, file.sha256); runs.push(run); continue;
    }
    const manifestSha256 = hash(bytes);
    if (referenceDigests.has(manifestPath) && referenceDigests.get(manifestPath) !== manifestSha256) throw new Error("Referenced original Run manifest changed");
    const audit = await verifyRunManifest(join(workspace, ".proofkit/runs"), runId, manifestSha256); if (audit.status !== "intact") throw new Error("Run evidence is incomplete or changed: " + runId);
    const run = RunSummarySchema.parse(JSON.parse((await readBounded(workspace, ".proofkit/runs/" + runId + "/run.json", MAX_FILE_BYTES, signal)).toString("utf8")));
    if (run.runId !== runId || run.status !== "completed" || run.workspaceRoot && sourceIdentity(run.workspaceRoot) !== sourceIdentity(workspace)) throw new Error("Run snapshot is active or belongs to another workspace");
    let snapshotAnchor: EventAnchor | undefined;
    if (!referenceDigests.has(manifestPath)) {
      const summarySha256 = referenceDigests.get(".proofkit/runs/" + runId + "/run.json"), reportSha256 = referenceDigests.get(".proofkit/runs/" + runId + "/report.html");
      if (!summarySha256 || !reportSha256 || !run.eventLog?.sha256) throw new Error("Run manifest lacks an original snapshot anchor");
      snapshotAnchor = { summarySha256, reportSha256, eventLogSha256: run.eventLog.sha256 };
      const original = await eventSealedFiles(workspace, { runId, ...snapshotAnchor }, signal, true);
      if (original.length !== audit.files.length || original.some((file) => !audit.files.some((sealed) => ".proofkit/runs/" + sealed.path === file.path
        && sealed.expectedBytes === file.bytes && sealed.expectedSha256 === file.sha256))) throw new Error("Run manifest differs from its original snapshot event chain");
    }
    runs.push({ runId, seal: "manifest", manifestSha256, ...(snapshotAnchor ? { snapshotAnchor } : {}) }); plan(manifestPath, bytes.length, manifestSha256);
    for (const file of audit.files) { const path = ".proofkit/runs/" + file.path; if (!ownedRunPath(path, ids)) throw new Error("Run manifest includes files outside the evidence allowlist"); plan(path, file.expectedBytes, file.expectedSha256); }
  }
  for (const [path, digest] of referenceDigests) if (planned.get(path)?.sha256 !== digest) throw new Error("Referenced evidence changed or is absent from its original manifest");
  const index = Buffer.from(indexHtml(summary, runs)); plan("index.html", index.length, hash(index));
  let owned: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    signal?.throwIfAborted(); await mkdir(destination); owned = await lstat(destination); await directory(destination);
    for (const file of planned.values()) {
      signal?.throwIfAborted(); const content = file.path === "index.html" ? index : await readBounded(workspace, file.path, Math.min(MAX_FILE_BYTES, file.bytes), signal);
      if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error("Source evidence changed during export");
      const target = join(destination, ...file.path.split("/")); await mkdir(dirname(target), { recursive: true }); await directory(dirname(target)); await writeFile(target, content, { flag: "wx" });
      const copied = await readBounded(destination, file.path, file.bytes, signal); if (hash(copied) !== file.sha256) throw new Error("Copied evidence failed verification");
    }
    for (const run of runs) {
      signal?.throwIfAborted(); if (run.seal === "event-log") await eventSealedFiles(workspace, run, signal);
      else if ((await verifyRunManifest(join(workspace, ".proofkit/runs"), run.runId, run.manifestSha256)).status !== "intact") throw new Error("Source evidence changed during export");
    }
    if (hash(await readBounded(workspace, missionPath + "/summary.json", MAX_DESCRIPTOR_BYTES, signal)) !== hash(summaryBytes)
      || hash(await readBounded(workspace, missionPath + "/report.html", MAX_FILE_BYTES, signal)) !== hash(reportBytes)) throw new Error("Mission snapshot changed during export");
    const archive: MissionArchive = { schemaVersion: 1, missionId, createdAt: new Date().toISOString(), source: { summarySha256: hash(summaryBytes), reportSha256: hash(reportBytes) },
      savedTestVerdict: summary.testVerdict ?? summary.verdict ?? "inconclusive", savedScope: savedScope(summary), runs, files: [...planned.values()] };
    parseArchive(archive); const descriptor = Buffer.from(JSON.stringify(archive, null, 2) + "\n"); if (descriptor.length > MAX_DESCRIPTOR_BYTES) throw new Error("Archive descriptor exceeds its bound");
    signal?.throwIfAborted(); await writeFile(join(destination, ".archive.pending"), descriptor, { flag: "wx" }); await rename(join(destination, ".archive.pending"), join(destination, "archive.json"));
    const archiveSha256 = hash(descriptor); const verification = await verifyMissionArchive(destination, archiveSha256);
    if (verification.status !== "intact") throw new Error("Completed archive failed verification"); signal?.throwIfAborted();
    return { directory: destination, index: join(destination, "index.html"), archiveSha256, missionId, savedTestVerdict: archive.savedTestVerdict, savedScope: archive.savedScope, runs: runs.length, files: planned.size, bytes: totalBytes, testVerdict: "not-asserted" };
  } catch (error) {
    if (owned) {
      const current = await lstat(destination).catch(() => undefined);
      if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino && samePath(await realpath(destination), destination)) await rm(destination, { recursive: true });
    }
    throw error;
  }
}
