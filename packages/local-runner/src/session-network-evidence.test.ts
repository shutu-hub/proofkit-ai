import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "@proofkit/evidence";
import { SessionNetworkEvidence } from "./session-network-evidence.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { maxEvents?: number; recordVideo?: boolean; networkEnabled?: boolean; videoBudget?: { maxBytes?: number; maxDurationMs?: number } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-session-network-")); roots.push(root);
  const capture = new SessionNetworkEvidence({ evidenceDir: root, projectRoot: root, workspaceRoot: root,
    sessionId: "00000000-0000-4000-8000-000000000001", headful: false, ...options });
  return { root, capture, store: new EvidenceStore(root) };
}

const event = { type: "request" as const, requestId: "request-1", method: "POST",
  url: "https://user:private-password@fixture.local/private-person?token=private-token#private-fragment",
  observedAt: "2026-10-19T00:00:00.000Z", initiatingRunId: "first-run", observedDuringRunId: "first-run" };

describe("Session network evidence", () => {
  it("seals scrubbed context with cross-Run request identity and no product verdict", async () => {
    const fixtureState = await fixture();
    const input = { ...event, headers: { authorization: "private-authorization" }, body: "private-body" };
    fixtureState.capture.record(input);
    fixtureState.capture.record({ ...event, type: "response", status: 202, observedDuringRunId: "second-run" });
    const closing = fixtureState.capture.finish();
    expect(fixtureState.capture.finish()).toBe(closing);
    const result = await closing;
    expect(result).toMatchObject({ status: "sealed", closed: true, events: 2, omittedEvents: 0 });
    const summary = await fixtureState.store.loadSummary(result.runId);
    expect(summary.verdict).toBe("inconclusive");
    const saved = await readFile(join(fixtureState.root, result.runId, "events.jsonl"), "utf8");
    expect(saved).toContain("https://fixture.local/__redacted__");
    expect(saved).toContain('"initiatingRunId":"first-run"');
    expect(saved).toContain('"observedDuringRunId":"second-run"');
    for (const secret of ["private-password", "private-token", "private-person", "private-fragment", "private-authorization", "private-body"]) expect(saved).not.toContain(secret);
    const report = await readFile(result.report!, "utf8");
    expect(report).toContain("Session network timeline");
    expect(report).toContain("Context only · no product verdict");
    expect(report).toContain("first-run");
    expect(report).toContain("second-run");
    expect((await fixtureState.store.verifyManifest(result.runId, result.manifest!.sha256)).status).toBe("intact");
    fixtureState.capture.record({ ...event, requestId: "after-close" });
    expect(await fixtureState.capture.finish()).toEqual(result);
    expect(await readFile(join(fixtureState.root, result.runId, "events.jsonl"), "utf8")).toBe(saved);
  });

  it("marks exhausted event limits as partial and retains exact omission counts", async () => {
    const fixtureState = await fixture({ maxEvents: 2 });
    for (let index = 0; index < 5; index++) fixtureState.capture.record({ ...event, requestId: `request-${index}` });
    expect(await fixtureState.capture.finish()).toMatchObject({ status: "partial", events: 2, omittedEvents: 3 });
  });

  it("bounds pending writes without reporting dropped traffic as sealed", async () => {
    const fixtureState = await fixture();
    for (let index = 0; index < 300; index++) fixtureState.capture.record({ ...event, requestId: `request-${index}` });
    expect(await fixtureState.capture.finish()).toMatchObject({ status: "partial", events: 256, omittedEvents: 44 });
  });

  it("keeps empty and interrupted capture segments explicitly partial", async () => {
    const empty = await fixture();
    expect(await empty.capture.finish()).toMatchObject({ status: "partial", events: 0 });
    const interrupted = await fixture();
    interrupted.capture.record(event);
    expect(await interrupted.capture.finish(true)).toMatchObject({ status: "partial", events: 1 });
    const unresolved = await fixture();
    unresolved.capture.record(event);
    expect(await unresolved.capture.finish()).toMatchObject({ status: "partial", unresolvedRequests: 1 });
  });

  it("does not certify a capture when event persistence fails", async () => {
    vi.spyOn(EvidenceStore.prototype, "appendEvent").mockRejectedValue(new Error("private diagnostic"));
    const fixtureState = await fixture();
    fixtureState.capture.record(event);
    expect(await fixtureState.capture.finish()).toMatchObject({ status: "unavailable" });
    expect(fixtureState.capture.state().status).toBe("unavailable");
  });

  it("withdraws its timeline when the pinned session event log changes", async () => {
    const state = await fixture();
    state.capture.record(event);
    state.capture.record({ ...event, type: "response", status: 200 });
    const result = await state.capture.finish();
    const summary = await state.store.loadSummary(result.runId);
    expect(summary.eventLog?.status).toBe("sealed");
    expect(await readFile(result.report!, "utf8")).toContain("Event log: verified");
    await writeFile(join(state.root, result.runId, "events.jsonl"), "changed timeline");
    const changed = await readFile(await state.store.writeReport(summary), "utf8");
    expect(changed).toContain("Event log: changed");
    expect(changed).toContain("Saved timeline withdrawn");
    expect(changed).not.toContain("<td>request-1</td>");
  });

  it("withdraws a sealed label when manifest finalization fails", async () => {
    vi.spyOn(EvidenceStore.prototype, "writeManifest").mockRejectedValue(new Error("private manifest error"));
    const fixtureState = await fixture();
    fixtureState.capture.record(event);
    fixtureState.capture.record({ ...event, type: "response", status: 200 });
    const result = await fixtureState.capture.finish();
    expect(result.status).toBe("unavailable");
    expect(result.manifest).toBeUndefined();
    expect(await readFile(result.report!, "utf8")).toContain("Capture status: unavailable");
    const saved = JSON.parse(await readFile(join(fixtureState.root, result.runId, "artifacts", "session-network-capture.json"), "utf8"));
    expect(saved.status).toBe("unavailable");
  });

  it.each(["recorded", "partial"] as const)("seals %s video independently of network collection and withdraws playback after tampering", async (status) => {
    const fixtureState = await fixture({ recordVideo: true, networkEnabled: false });
    const options = fixtureState.capture.recordingOptions()!;
    expect(fixtureState.capture.state().recording?.status).toBe("recording");
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "synthetic recording bytes");
    fixtureState.capture.record(event);
    const result = await fixtureState.capture.finish(status === "partial", status, status === "partial" ? "duration-limit" : undefined);
    expect(result).toMatchObject({ status: status === "partial" ? "partial" : "sealed", networkEnabled: false, events: 0,
      recording: { status, artifact: `${result.runId}/artifacts/recording.webm` } });
    expect((await fixtureState.store.verifyManifest(result.runId, result.manifest!.sha256)).status).toBe("intact");
    expect(await readFile(result.report!, "utf8")).toContain('src="artifacts/recording.webm"');
    await writeFile(options.path, "modified recording bytes");
    const refreshed = await fixtureState.store.writeReport(await fixtureState.store.loadSummary(result.runId));
    const report = await readFile(refreshed, "utf8");
    expect(report).toContain("Requested recording unavailable or changed");
    expect(report).not.toContain("<video");
  });

  it("seals one selected popup clip and keeps omitted windows as incomplete context", async () => {
    const state = await fixture({ recordVideo: true, networkEnabled: false, videoBudget: { maxBytes: 1024 * 1024 } });
    const options = state.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "primary footage");
    await writeFile(join(dirname(options.path), "selected-page-001.webm"), "popup footage");
    const result = await state.capture.finish(false, "recorded", undefined, { observed: 2, saved: [1] });
    expect(result).toMatchObject({ status: "partial", recording: { status: "recorded", selectedPages: { observed: 2, omitted: 1,
      artifacts: [`${result.runId}/artifacts/selected-page-001.webm`] } } });
    expect((await state.store.verifyManifest(result.runId, result.manifest!.sha256)).status).toBe("intact");
    const html = await readFile(result.report!, "utf8");
    expect(html).toContain('aria-label="Selected-page recording selected-page-001.webm"');
    await writeFile(join(dirname(options.path), "selected-page-001.webm"), "changed popup footage");
    expect(await readFile(await state.store.writeReport(await state.store.loadSummary(result.runId)), "utf8")).toContain("selected-page-001.webm unavailable or changed");
  });

  it("seals two selected clips within a shared final byte budget", async () => {
    const state = await fixture({ recordVideo: true, networkEnabled: false, videoBudget: { maxBytes: 1024 * 1024 } });
    const options = state.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "primary footage");
    await writeFile(join(dirname(options.path), "selected-page-001.webm"), "first popup");
    await writeFile(join(dirname(options.path), "selected-page-002.webm"), "second popup");
    const result = await state.capture.finish(false, "recorded", undefined, { observed: 2, saved: [1, 2] });
    expect(result).toMatchObject({ status: "sealed", recording: { selectedPages: { observed: 2, omitted: 0,
      artifacts: [`${result.runId}/artifacts/selected-page-001.webm`, `${result.runId}/artifacts/selected-page-002.webm`] } } });
    expect((await state.store.verifyManifest(result.runId, result.manifest!.sha256)).status).toBe("intact");
    expect((await readFile(result.report!, "utf8")).match(/<video /g)).toHaveLength(3);
  });

  it.each(["missing", "oversized", "interrupted"])("retains an explicit %s video gap and discards unsealed bytes", async (mode) => {
    const fixtureState = await fixture({ recordVideo: true });
    const options = fixtureState.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    if (mode !== "missing") await writeFile(options.path, "unsealed recording");
    if (mode === "oversized") await truncate(options.path, 64 * 1024 * 1024 + 1);
    fixtureState.capture.record(event);
    fixtureState.capture.record({ ...event, type: "response", status: 200 });
    const result = await fixtureState.capture.finish(mode === "interrupted", mode === "missing" ? "unavailable" : "recorded");
    expect(result).toMatchObject({ status: "partial", recording: { status: "unavailable" } });
    await expect(stat(options.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(result.report!, "utf8")).not.toContain("<video");
  });

  it("does not publish a manifest containing leftover temporary recordings", async () => {
    const fixtureState = await fixture({ recordVideo: true, networkEnabled: false });
    const options = fixtureState.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await mkdir(options.directory, { recursive: true });
    await writeFile(options.path, "primary recording");
    await writeFile(join(options.directory, "popup.webm"), "unclaimed popup recording");
    const result = await fixtureState.capture.finish(false, "recorded");
    expect(result.status).toBe("unavailable");
    expect(result.manifest).toBeUndefined();
    expect((await fixtureState.store.verifyManifest(result.runId)).status).toBe("missing");
  });

  it("seals explicit budget interruptions as incomplete context with their configured limits", async () => {
    const state = await fixture({ recordVideo: true, networkEnabled: false, videoBudget: { maxDurationMs: 1000, maxBytes: 1024 * 1024 } });
    const result = await state.capture.finish(true, "unavailable", "duration-limit");
    expect(result).toMatchObject({ status: "partial", recording: { status: "unavailable", stopReason: "duration-limit", budget: { maxDurationMs: 1000, maxBytes: 1024 * 1024 } } });
    expect((await state.store.verifyManifest(result.runId, result.manifest!.sha256)).status).toBe("intact");
    expect(await readFile(result.report!, "utf8")).toContain("Recording stopped: duration-limit");
  });

  it("rejects recorded bytes above a configured budget smaller than the sealing ceiling", async () => {
    const state = await fixture({ recordVideo: true, networkEnabled: false, videoBudget: { maxBytes: 1024 * 1024 } });
    const options = state.capture.recordingOptions()!;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(options.path, "unsealed"); await truncate(options.path, 1024 * 1024 + 1);
    const result = await state.capture.finish(false, "recorded");
    expect(result).toMatchObject({ status: "partial", recording: { status: "unavailable" } });
    await expect(stat(options.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
