import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { MissionSessionCapturesSchema, RunSummarySchema, SessionCaptureSealSchema, SessionCaptureSummarySchema, type EvidenceRef, type MissionResult, type RunSummary, type TestMission } from "@proofkit/contracts";
import { atomicWriteJson, type EvidenceStore } from "@proofkit/evidence";
import { resolveWithinWorkspace, sameProjectPath } from "@proofkit/project";

type CaptureSeal = ReturnType<typeof SessionCaptureSealSchema.parse>;
type Segment = NonNullable<MissionResult["sessionCaptures"]>["segments"][number];

function sameDirectPath(left: string, right: string): boolean {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sealPath(workspaceRoot: string, runId: string): string {
  if (!/^session-network-[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid capture ID");
  return resolve(workspaceRoot, ".proofkit", "sessions", "capture-seals", `${runId}.json`);
}

export async function writeCaptureSeal(input: CaptureSeal): Promise<void> {
  const seal = SessionCaptureSealSchema.parse(input);
  const target = sealPath(seal.workspaceRoot, seal.runId);
  if (!sameDirectPath(resolveWithinWorkspace(seal.workspaceRoot, target), target)) throw new Error("Capture seal path is redirected");
  await mkdir(dirname(target), { recursive: true });
  if (!sameDirectPath(await realpath(dirname(target)), dirname(target))) throw new Error("Capture seal directory is redirected");
  await atomicWriteJson(target, seal);
}

async function readCaptureJson(workspaceRoot: string, target: string, limit: number, expectedSha256?: string): Promise<unknown> {
  const owned = resolveWithinWorkspace(workspaceRoot, target);
  if (!sameDirectPath(owned, target) || !sameDirectPath(await realpath(target), target)) throw new Error("Capture file is redirected");
  const direct = await lstat(target);
  if (!direct.isFile() || direct.size <= 0 || direct.size > limit) throw new Error("Capture file exceeds its read budget");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size > limit) throw new Error("Capture file changed while opening");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(target);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error("Capture file changed while reading");
    const content = bytes.subarray(0, offset);
    if (expectedSha256 && createHash("sha256").update(content).digest("hex") !== expectedSha256.toLowerCase()) throw new Error("Capture digest mismatch");
    return JSON.parse(content.toString("utf8"));
  } finally { await file.close(); }
}

async function auditSegment(options: { workspaceRoot: string; projectRoot: string; store: EvidenceStore }, runId: string, sessionId: string): Promise<Segment> {
  const base: Segment = { runId, sessionId, integrity: "unverified", reason: "The original capture seal or its bound summary cannot be verified.", evidence: [] };
  try {
    let seal: CaptureSeal;
    try { seal = SessionCaptureSealSchema.parse(await readCaptureJson(options.workspaceRoot, sealPath(options.workspaceRoot, runId), 16 * 1024)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, integrity: "not-sealed", reason: "No durable original seal is available. The segment may still be active or its seal is missing." };
      return base;
    }
    if (seal.runId !== runId || seal.sessionId !== sessionId || !sameProjectPath(seal.projectRoot, options.projectRoot)
      || !sameProjectPath(seal.workspaceRoot, options.workspaceRoot)) return base;
    const verified = await options.store.verifyManifest(runId, seal.manifestSha256);
    if (verified.status !== "intact" || !verified.manifestVerified) return { ...base, integrity: verified.status === "intact" ? "unverified" : verified.status,
      reason: "The capture bundle no longer verifies against its original sealed manifest. Playback and evidence links have been withdrawn." };
    const expected = new Map(verified.files.map((entry) => [entry.path, entry.expectedSha256]));
    const readOriginal = async (path: string, limit: number) => {
      const digest = expected.get(path);
      if (!digest) throw new Error("Required capture file is absent from the original manifest");
      return readCaptureJson(options.workspaceRoot, resolve(options.store.rootDir, path), limit, digest);
    };
    const summary = RunSummarySchema.parse(await readOriginal(`${runId}/run.json`, 1024 * 1024));
    const capture = SessionCaptureSummarySchema.parse(await readOriginal(`${runId}/artifacts/session-network-capture.json`, 16 * 1024));
    if (summary.runId !== runId || capture.runId !== runId || summary.status !== "completed" || summary.verdict !== "inconclusive"
      || summary.execution?.kind !== "session-network-capture" || summary.execution.adapter !== "web" || summary.execution.sessionId !== sessionId
      || !summary.projectRoot || !sameProjectPath(summary.projectRoot, options.projectRoot)
      || !summary.workspaceRoot || !sameProjectPath(summary.workspaceRoot, options.workspaceRoot)
      || summary.recording?.status !== capture.recording?.status || summary.recording?.artifact !== capture.recording?.artifact
      || summary.recording?.stopReason !== capture.recording?.stopReason || JSON.stringify(summary.recording?.budget) !== JSON.stringify(capture.recording?.budget)
      || JSON.stringify(summary.recording?.selectedPages) !== JSON.stringify(capture.recording?.selectedPages)) return base;
    const selected = capture.recording?.selectedPages;
    if (selected && (selected.artifacts.some((path) => !path.startsWith(`${runId}/artifacts/selected-page-`))
      || selected.artifacts.some((path) => !summary.artifacts.includes(path))
      || (selected.omitted > 0 && capture.status === "sealed"))) return base;
    const paths = [`${runId}/run.json`, `${runId}/artifacts/session-network-capture.json`, `${runId}/report.html`, `${runId}/events.jsonl`,
      ...((capture.recording?.status === "recorded" || capture.recording?.status === "partial") && capture.recording.artifact === `${runId}/artifacts/recording.webm` ? [capture.recording.artifact] : []),
      ...(selected?.artifacts ?? [])];
    if (paths.some((path) => !expected.has(path)) || ((capture.recording?.status === "recorded" || capture.recording?.status === "partial") && paths.length !== 5 + (selected?.artifacts.length ?? 0))) return base;
    const evidence: EvidenceRef[] = paths.map((path) => ({ evidenceId: `session-capture:${path}`, path: resolve(options.store.rootDir, path), sha256: expected.get(path)!,
      capturedAt: summary.endedAt ?? summary.startedAt, kind: path.endsWith(".webm") ? "video" : path.endsWith("events.jsonl") ? "network" : path.endsWith(".html") ? "report" : "snapshot",
      description: "Sealed session context; not independent business acceptance evidence" }));
    evidence.push({ evidenceId: `session-capture:${runId}:manifest`, path: resolve(options.store.rootDir, runId, "manifest.json"), sha256: seal.manifestSha256,
      capturedAt: summary.endedAt ?? summary.startedAt, kind: "other", description: "Original locally pinned manifest; not an external signature" });
    return { ...base, integrity: "intact", capture, evidence, reason: "The saved capture verifies against its original local seal. Completeness is reported separately; context may include time outside this Mission." };
  } catch { return base; }
}

export async function auditSessionCaptures(options: {
  mission: TestMission; workspaceRoot: string; projectRoot: string; store: EvidenceStore; loadRun: (runId: string) => Promise<RunSummary>;
}): Promise<MissionResult["sessionCaptures"]> {
  const sessionId = options.mission.surfaceSessionId;
  if (!sessionId) return;
  const ids = new Set<string>();
  const context = options.mission.sessionContext;
  if (context?.sessionId === sessionId && context.captureRunId) ids.add(context.captureRunId);
  for (const observation of options.mission.observations) {
    if (observation.kind !== "surface.run" || typeof observation.data.runId !== "string") continue;
    try {
      const summary = await options.loadRun(observation.data.runId);
      const captureId = summary.execution?.sessionCaptureRunId;
      if (!captureId || summary.execution?.sessionId !== sessionId || summary.execution.adapter !== "web" || summary.execution.kind === "session-network-capture") continue;
      const target = resolve(options.store.rootDir, summary.runId, "run.json");
      const ref = observation.evidence.find((item) => item.sha256 && sameProjectPath(item.path, target));
      if (!ref?.sha256) continue;
      const original = RunSummarySchema.parse(await readCaptureJson(options.workspaceRoot, target, 16 * 1024 * 1024, ref.sha256));
      if (original.runId === summary.runId && original.execution?.sessionId === sessionId && original.execution.sessionCaptureRunId === captureId) ids.add(captureId);
    } catch {}
  }
  if (!ids.size) return;
  const selected = [...ids].slice(0, 10);
  const segments: Segment[] = [];
  for (const id of selected) segments.push(await auditSegment(options, id, sessionId));
  return MissionSessionCapturesSchema.parse({ segments, omittedSegments: ids.size - segments.length });
}
