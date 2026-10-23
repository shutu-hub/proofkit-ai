import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestCharterSchema, type RunSummary } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { recoverInterruptedSessionCapture } from "./session-capture-recovery.js";
import { SessionNetworkEvidence } from "./session-network-evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("interrupted retained-session capture recovery", () => {
  it("seals network context as partial and explicitly withdraws an interrupted recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capture-recovery-")); roots.push(root);
    const evidenceDir = join(root, "runs"), workspaceRoot = root, projectRoot = join(root, "source");
    const sessionId = "00000000-0000-4000-8000-000000000001", runId = "session-network-00000000-0000-4000-8000-000000000002";
    const store = new EvidenceStore(evidenceDir);
    const summary: RunSummary = { runId, projectRoot, workspaceRoot, startedAt: new Date().toISOString(), status: "running",
      execution: { adapter: "web", kind: "session-network-capture", sessionId, visibility: "headful", sessionNetworkEnabled: true, sessionRecordingRequested: true },
      charter: TestCharterSchema.parse({ intent: "Retained Web context", level: "quick", actions: [], assertions: [], sideEffectPolicy: "deny" }),
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
    await store.startRun(summary);
    await store.appendEvent({ runId, timestamp: summary.startedAt, type: "adapter.event", payload: { adapter: "web", eventType: "request", requestId: "r1", method: "GET", url: "http://127.0.0.1:1/" } });
    await store.appendEvent({ runId, timestamp: new Date().toISOString(), type: "adapter.event", payload: { adapter: "web", eventType: "response", requestId: "r1", method: "GET", url: "http://127.0.0.1:1/", status: 200 } });
    await mkdir(join(evidenceDir, runId, "recording-tmp"), { recursive: true }); await writeFile(join(evidenceDir, runId, "recording-tmp", "partial.webm"), "unsealed bytes");
    const recovered = await recoverInterruptedSessionCapture({ runId, sessionId, evidenceDir, workspaceRoot, projectRoot });
    expect(recovered).toMatchObject({ status: "recovered", captureStatus: "partial", recordingStatus: "unavailable" });
    expect((await store.verifyManifest(runId, recovered.manifest.sha256)).status).toBe("intact");
    const saved = JSON.parse(await readFile(join(evidenceDir, runId, "run.json"), "utf8"));
    expect(saved).toMatchObject({ status: "completed", verdict: "inconclusive", recording: { status: "unavailable" } });
    expect(saved.findings.join(" ")).toContain("not sealed");
    expect(await readFile(recovered.report, "utf8")).not.toContain("<video");
  });

  it("refuses an active capture owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capture-active-")); roots.push(root);
    const evidenceDir = join(root, "runs"), sessionId = "00000000-0000-4000-8000-000000000003", runId = "session-network-00000000-0000-4000-8000-000000000004";
    const store = new EvidenceStore(evidenceDir); const startedAt = new Date().toISOString();
    await store.startRun({ runId, projectRoot: root, workspaceRoot: root, startedAt, status: "running", execution: { adapter: "web", kind: "session-network-capture", sessionId },
      charter: TestCharterSchema.parse({ intent: "Active capture", level: "quick", actions: [], assertions: [], sideEffectPolicy: "deny" }), steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const { LocalExecutionOwnership } = await import("@proofkit/evidence"); const lease = await new LocalExecutionOwnership(evidenceDir, "run").acquire(runId);
    try { await expect(recoverInterruptedSessionCapture({ runId, sessionId, evidenceDir, workspaceRoot: root, projectRoot: root })).rejects.toThrow("active"); }
    finally { await lease?.release(); }
  });

  it("returns the original sealed recording status on idempotent recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capture-complete-")); roots.push(root);
    const evidenceDir = join(root, "runs"), workspaceRoot = root, projectRoot = join(root, "source");
    const sessionId = "00000000-0000-4000-8000-000000000005";
    const capture = new SessionNetworkEvidence({ evidenceDir, workspaceRoot, projectRoot, sessionId, headful: true, networkEnabled: true, recordVideo: true });
    const options = capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "sealed recording");
    capture.record({ type: "request", requestId: "r1", method: "GET", url: "http://127.0.0.1/", observedAt: new Date().toISOString() });
    capture.record({ type: "response", requestId: "r1", method: "GET", url: "http://127.0.0.1/", status: 200, observedAt: new Date().toISOString() });
    const finished = await capture.finish(false, "recorded");
    const recovered = await recoverInterruptedSessionCapture({ runId: capture.runId, sessionId, evidenceDir, workspaceRoot, projectRoot });
    expect(finished).toMatchObject({ status: "sealed", recording: { status: "recorded" } });
    expect(recovered).toMatchObject({ status: "already-completed", captureStatus: "sealed", recordingStatus: "recorded" });
  });

  it("preserves a disabled network setting during interruption recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capture-network-off-")); roots.push(root);
    const evidenceDir = join(root, "runs"), workspaceRoot = root, projectRoot = join(root, "source");
    const sessionId = "00000000-0000-4000-8000-000000000006", runId = "session-network-00000000-0000-4000-8000-000000000007";
    const store = new EvidenceStore(evidenceDir);
    await store.startRun({ runId, projectRoot, workspaceRoot, startedAt: new Date().toISOString(), status: "running",
      execution: { adapter: "web", kind: "session-network-capture", sessionId, sessionNetworkEnabled: false, sessionRecordingRequested: false },
      charter: TestCharterSchema.parse({ intent: "Disabled network context", level: "quick", actions: [], assertions: [], sideEffectPolicy: "deny" }),
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const recovered = await recoverInterruptedSessionCapture({ runId, sessionId, evidenceDir, workspaceRoot, projectRoot });
    const saved = JSON.parse(await readFile(join(evidenceDir, runId, "artifacts", "session-network-capture.json"), "utf8"));
    expect(recovered.captureStatus).toBe("partial");
    expect(saved.networkEnabled).toBe(false);
  });

  it("refuses a redirected temporary recording directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capture-redirect-")); roots.push(root);
    const evidenceDir = join(root, "runs"), workspaceRoot = root, projectRoot = join(root, "source");
    const sessionId = "00000000-0000-4000-8000-000000000008", runId = "session-network-00000000-0000-4000-8000-000000000009";
    const store = new EvidenceStore(evidenceDir);
    await store.startRun({ runId, projectRoot, workspaceRoot, startedAt: new Date().toISOString(), status: "running",
      execution: { adapter: "web", kind: "session-network-capture", sessionId, sessionNetworkEnabled: true, sessionRecordingRequested: true },
      charter: TestCharterSchema.parse({ intent: "Redirected capture", level: "quick", actions: [], assertions: [], sideEffectPolicy: "deny" }),
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const target = join(root, "outside"); await mkdir(target, { recursive: true });
    const temporary = join(evidenceDir, runId, "recording-tmp"); await mkdir(dirname(temporary), { recursive: true });
    try { const { symlink } = await import("node:fs/promises"); await symlink(target, temporary, "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    await expect(recoverInterruptedSessionCapture({ runId, sessionId, evidenceDir, workspaceRoot, projectRoot })).rejects.toThrow("redirected");
  });
});
