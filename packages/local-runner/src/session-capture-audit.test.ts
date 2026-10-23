import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestMission } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { auditSessionCaptures, writeCaptureSeal } from "./session-capture-audit.js";
import { SessionNetworkEvidence } from "./session-network-evidence.js";

const roots: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000001";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(recordVideo = false) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-capture-audit-")); roots.push(root);
  const evidenceDir = join(root, ".proofkit", "runs");
  const capture = new SessionNetworkEvidence({ evidenceDir, projectRoot: root, workspaceRoot: root, sessionId, headful: false, networkEnabled: false, recordVideo });
  const store = new EvidenceStore(evidenceDir);
  const mission = { surfaceSessionId: sessionId, sessionContext: { sessionId, captureRunId: capture.runId }, observations: [] } as unknown as TestMission;
  const sealFile = join(root, ".proofkit", "sessions", "capture-seals", `${capture.runId}.json`);
  const audit = (input = mission) => auditSessionCaptures({ mission: input, workspaceRoot: root, projectRoot: root, store: new EvidenceStore(evidenceDir), loadRun: (runId) => store.loadSummary(runId) });
  const reseal = async () => {
    const manifest = await store.writeManifest(capture.runId);
    await writeCaptureSeal({ schemaVersion: 1, runId: capture.runId, sessionId, projectRoot: root, workspaceRoot: root, manifestSha256: manifest.sha256 });
  };
  return { root, evidenceDir, capture, store, mission, sealFile, audit, reseal };
}

describe("Mission session capture audit", () => {
  it("keeps active or missing original seals explicit and restores original digests with a fresh store", async () => {
    const state = await fixture();
    expect((await state.audit())?.segments[0]).toMatchObject({ integrity: "not-sealed", evidence: [] });
    const closed = await state.capture.finish();
    const seal = JSON.parse(await readFile(state.sealFile, "utf8"));
    expect(seal.manifestSha256).toBe(closed.manifest?.sha256);
    const segment = (await state.audit())!.segments[0]!;
    expect(segment).toMatchObject({ integrity: "intact", capture: { status: "sealed", events: 0, networkEnabled: false } });
    expect(segment.evidence).toHaveLength(5);
    expect(segment.evidence.find((ref) => ref.path.endsWith("manifest.json"))?.sha256).toBe(closed.manifest?.sha256);
  });

  it.each(["report.html", "events.jsonl", "manifest.json", "artifacts/session-network-capture.json"])("withdraws all capture links after %s changes", async (path) => {
    const state = await fixture(); await state.capture.finish();
    await writeFile(join(state.evidenceDir, state.capture.runId, path), "changed");
    expect((await state.audit())?.segments[0]).toMatchObject({ evidence: [] });
    expect((await state.audit())?.segments[0]?.integrity).not.toBe("intact");
  });

  it("keeps partial capture separate from intact file integrity", async () => {
    const state = await fixture(); await state.capture.finish(true);
    expect((await state.audit())?.segments[0]).toMatchObject({ integrity: "intact", capture: { status: "partial" } });
  });

  it("requires the pinned original manifest even after a changed bundle is rehashed", async () => {
    const state = await fixture(); await state.capture.finish();
    await writeFile(join(state.evidenceDir, state.capture.runId, "report.html"), "replaced report");
    await state.store.writeManifest(state.capture.runId);
    expect((await state.audit())?.segments[0]).toMatchObject({ integrity: "changed", evidence: [] });
  });

  it.each(["sessionId", "projectRoot", "workspaceRoot", "runId", "manifestSha256"])("refuses a seal with a different %s", async (field) => {
    const state = await fixture(); await state.capture.finish();
    const seal = JSON.parse(await readFile(state.sealFile, "utf8"));
    seal[field] = field === "sessionId" ? "00000000-0000-4000-8000-000000000002" : field === "runId" ? `session-network-00000000-0000-4000-8000-000000000002` : field === "manifestSha256" ? "0".repeat(64) : join(state.root, "foreign");
    await writeFile(state.sealFile, JSON.stringify(seal));
    expect((await state.audit())?.segments[0]?.integrity).not.toBe("intact");
    expect((await state.audit())?.segments[0]?.evidence).toEqual([]);
  });

  it("bounds malformed seals and refuses redirected seal files", async () => {
    const state = await fixture(); await state.capture.finish();
    const saved = await readFile(state.sealFile);
    await writeFile(state.sealFile, " ".repeat(17 * 1024));
    expect((await state.audit())?.segments[0]?.integrity).toBe("unverified");
    const other = join(state.root, "redirected.json"); await writeFile(other, saved);
    await rm(state.sealFile);
    try { await symlink(other, state.sealFile); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    expect((await state.audit())?.segments[0]?.integrity).toBe("unverified");
  });

  it("checks capture ownership and the original recording summary even for a locally resealed bundle", async () => {
    const state = await fixture(); await state.capture.finish();
    const path = join(state.evidenceDir, state.capture.runId, "run.json");
    const summary = JSON.parse(await readFile(path, "utf8"));
    summary.execution.kind = "test";
    await writeFile(path, JSON.stringify(summary)); await state.reseal();
    expect((await state.audit())?.segments[0]?.integrity).toBe("unverified");
    summary.execution.kind = "session-network-capture"; summary.recording = { status: "unavailable" };
    await writeFile(path, JSON.stringify(summary)); await state.reseal();
    expect((await state.audit())?.segments[0]?.integrity).toBe("unverified");
  });

  it("rejects directory redirects within the workspace and withdraws seals that cannot be persisted", async () => {
    const state = await fixture(); await state.capture.finish();
    const directory = dirname(state.sealFile);
    const redirected = join(state.root, "redirected-seals");
    await rename(directory, redirected);
    await symlink(redirected, directory, process.platform === "win32" ? "junction" : "dir");
    expect((await state.audit())?.segments[0]?.integrity).toBe("unverified");
    await expect(state.reseal()).rejects.toThrow("redirected");
    const second = new SessionNetworkEvidence({ evidenceDir: state.evidenceDir, projectRoot: state.root, workspaceRoot: state.root, sessionId, headful: false, networkEnabled: false });
    const closed = await second.finish();
    expect(closed).toMatchObject({ status: "unavailable" });
    expect(closed.manifest).toBeUndefined();
    expect(await readFile(closed.report!, "utf8")).toContain("Capture status: unavailable");
  });

  it.each(["recorded", "partial"] as const)("withdraws a missing %s recording without promoting it to sealed", async (status) => {
    const state = await fixture(true);
    const recording = state.capture.recordingOptions()!;
    await mkdir(dirname(recording.path), { recursive: true }); await writeFile(recording.path, "recorded bytes");
    await state.capture.finish(status === "partial", status, status === "partial" ? "duration-limit" : undefined);
    if (status === "partial") expect((await state.audit())?.segments[0]).toMatchObject({ integrity: "intact", capture: { status: "partial", recording: { status: "partial" } } });
    expect((await state.audit())?.segments[0]?.evidence.some((ref) => ref.kind === "video")).toBe(true);
    await rm(recording.path);
    expect((await state.audit())?.segments[0]).toMatchObject({ integrity: "missing", evidence: [] });
  });

  it("audits the saved selected-window video against the original capture seal", async () => {
    const state = await fixture(true);
    const options = state.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "primary footage");
    const selectedPath = join(dirname(options.path), "selected-page-001.webm");
    await writeFile(selectedPath, "selected popup footage");
    const capture = await state.capture.finish(false, "recorded", undefined, { observed: 1, saved: [1] });
    expect(capture.status).toBe("sealed");
    const intact = (await state.audit())!.segments[0]!;
    expect(intact).toMatchObject({ integrity: "intact", capture: { recording: { selectedPages: { observed: 1, omitted: 0 } } } });
    expect(intact.evidence).toHaveLength(7);
    expect(intact.evidence.filter((ref) => ref.kind === "video")).toHaveLength(2);
    await writeFile(selectedPath, "modified popup footage");
    expect((await state.audit())!.segments[0]).toMatchObject({ evidence: [] });
    expect((await state.audit())!.segments[0]!.integrity).not.toBe("intact");
    await state.store.writeManifest(capture.runId);
    expect((await state.audit())!.segments[0]).toMatchObject({ evidence: [] });
  });

  it("associates only frozen or original Mission Run capture IDs", async () => {
    const state = await fixture(); await state.capture.finish();
    const summary = await state.store.loadSummary(state.capture.runId);
    const runId = "mission-run";
    summary.runId = runId;
    summary.execution = { adapter: "web", sessionId, sessionCaptureRunId: state.capture.runId };
    await state.store.writeSummary(summary);
    const path = join(state.evidenceDir, runId, "run.json");
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    const mission = { ...state.mission, sessionContext: undefined, observations: [{ kind: "surface.run", data: { runId, executionSessionId: sessionId },
      evidence: [{ evidenceId: "original-run", kind: "snapshot", path, sha256: digest.toUpperCase(), capturedAt: summary.startedAt }] }] } as unknown as TestMission;
    expect((await state.audit(mission))?.segments[0]?.integrity).toBe("intact");
    summary.execution.sessionCaptureRunId = "session-network-00000000-0000-4000-8000-000000000002";
    await state.store.writeSummary(summary);
    expect(await state.audit(mission)).toBeUndefined();
    expect(await state.audit({ ...state.mission, surfaceSessionId: "00000000-0000-4000-8000-000000000002" })).toBeUndefined();
  });
});
