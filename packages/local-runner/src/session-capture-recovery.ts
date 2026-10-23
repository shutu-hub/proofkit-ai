import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { RunSummarySchema, SessionCaptureSummarySchema, type SessionCaptureSummary } from "@proofkit/contracts";
import { EvidenceStore, LocalExecutionOwnership } from "@proofkit/evidence";
import { writeCaptureSeal } from "./session-capture-audit.js";

export type SessionCaptureRecovery = { runId: string; sessionId: string; status: "recovered" | "already-completed"; captureStatus: SessionCaptureSummary["status"]; recordingStatus?: NonNullable<SessionCaptureSummary["recording"]>["status"]; manifest: { path: string; sha256: string; files: number }; report: string };

function sameDirectPath(left: string, right: string): boolean {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function removeUnsealedRecording(store: EvidenceStore, runId: string): Promise<void> {
  const directory = resolve(store.rootDir, runId, "recording-tmp"); let entries;
  try {
    const direct = await lstat(directory);
    if (!direct.isDirectory() || !sameDirectPath(await realpath(directory), directory)) throw new Error("Recording temporary directory is redirected");
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.name.endsWith(".webm")) continue;
    if (!entry.isFile()) throw new Error("Recording temporary file is redirected");
    const target = resolve(directory, entry.name);
    const direct = await lstat(target);
    if (!direct.isFile() || !sameDirectPath(await realpath(target), target)) throw new Error("Recording temporary file is redirected");
    await unlink(target);
  }
}

async function readSealedCapture(store: EvidenceStore, runId: string, manifest: Awaited<ReturnType<EvidenceStore["verifyManifest"]>>): Promise<SessionCaptureSummary> {
  const path = `${runId}/artifacts/session-network-capture.json`;
  const expected = manifest.files.find((entry) => entry.path === path)?.expectedSha256;
  if (!expected) throw new Error("Completed capture has no sealed capture summary");
  const target = resolve(store.rootDir, path);
  if (!sameDirectPath(await realpath(target), target)) throw new Error("Completed capture summary is redirected");
  const bytes = await readFile(target);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Completed capture summary changed");
  return SessionCaptureSummarySchema.parse(JSON.parse(bytes.toString("utf8")));
}

async function countEvents(store: EvidenceStore, runId: string) {
  let events = 0, omitted = 0; const unresolved = new Set<string>();
  try { for await (const event of store.readEvents(runId)) { events++; const payload = event.payload as { eventType?: string; requestId?: string }; if (payload.eventType === "request" && payload.requestId) unresolved.add(payload.requestId); if ((payload.eventType === "response" || payload.eventType === "requestfailed") && payload.requestId) unresolved.delete(payload.requestId); } } catch { omitted = 1; }
  return { events, omitted, unresolved: unresolved.size };
}

export async function recoverInterruptedSessionCapture(options: { runId: string; sessionId: string; evidenceDir: string; workspaceRoot: string; projectRoot: string }): Promise<SessionCaptureRecovery> {
  if (!/^session-network-[a-f0-9-]{36}$/.test(options.runId) || !/^[a-f0-9-]{36}$/.test(options.sessionId)) throw new Error("Invalid session capture identity");
  const lease = await new LocalExecutionOwnership(options.evidenceDir, "run").acquire(options.runId); if (!lease) throw new Error("Session capture is active; recovery cannot finalize a live owner");
  const store = new EvidenceStore(options.evidenceDir);
  try {
    const preview = await store.readPreview(options.runId, "summary", 100_000); const summary = RunSummarySchema.parse(JSON.parse(preview.content));
    if (summary.execution?.kind !== "session-network-capture" || summary.execution.sessionId !== options.sessionId || summary.projectRoot !== options.projectRoot || summary.workspaceRoot !== options.workspaceRoot) throw new Error("Session capture belongs to another project, workspace or session");
    if (summary.status === "completed") {
      const manifest = await store.verifyManifest(options.runId);
      if (manifest.status !== "intact" || !manifest.manifestVerified) throw new Error("Completed capture has no intact manifest");
      const capture = await readSealedCapture(store, options.runId, manifest);
      if (capture.runId !== options.runId) throw new Error("Completed capture summary belongs to another run");
      return { runId: options.runId, sessionId: options.sessionId, status: "already-completed", captureStatus: capture.status,
        ...(capture.recording ? { recordingStatus: capture.recording.status } : {}), manifest: { path: resolve(store.rootDir, options.runId, "manifest.json"), sha256: manifest.manifestSha256!, files: manifest.files.length }, report: resolve(store.rootDir, options.runId, "report.html") };
    }
    if (summary.execution.sessionNetworkEnabled === undefined) throw new Error("Session capture network configuration was not persisted; recovery is refused");
    const counts = await countEvents(store, options.runId); await removeUnsealedRecording(store, options.runId);
    const capture = SessionCaptureSummarySchema.parse({ runId: options.runId, status: "partial", closed: true, events: counts.events, omittedEvents: counts.omitted, unresolvedRequests: counts.unresolved, networkEnabled: summary.execution.sessionNetworkEnabled, ...(summary.execution.sessionRecordingRequested === true ? { recording: { status: "unavailable" } } : {}) });
    const artifact = await store.writeJson(options.runId, "session-network-capture", capture); summary.artifacts.push(artifact); if (summary.execution.sessionRecordingRequested === true) summary.recording = { status: "unavailable" }; summary.status = "completed"; summary.verdict = "inconclusive"; summary.endedAt = new Date().toISOString();
    summary.findings = ["Capture recovered after its process owner disappeared; " + counts.events + " network event(s) remain in the original event log.", "The recovered session segment is context only and does not establish product correctness or action causality.", ...(summary.execution.sessionRecordingRequested === true ? ["Requested session recording was not sealed after process interruption; no playable video is claimed."] : [])];
    summary.eventLog = await store.pinEventLog(options.runId); await store.writeSummary(summary); const report = await store.writeReport(summary); const manifest = await store.writeManifest(options.runId); await writeCaptureSeal({ schemaVersion: 1, runId: options.runId, sessionId: options.sessionId, projectRoot: options.projectRoot, workspaceRoot: options.workspaceRoot, manifestSha256: manifest.sha256 });
    return { runId: options.runId, sessionId: options.sessionId, status: "recovered", captureStatus: "partial", ...(summary.execution.sessionRecordingRequested === true ? { recordingStatus: "unavailable" as const } : {}), manifest: { path: resolve(store.rootDir, manifest.path), sha256: manifest.sha256, files: manifest.files }, report };
  } finally { await lease.release(); }
}
