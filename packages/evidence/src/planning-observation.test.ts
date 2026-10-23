import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema, type Action, type PlanningSurfaceObservation, type RunSummary, type SurfaceSnapshot } from "@proofkit/contracts";
import { EvidenceStore, sha256 } from "./index.js";
import { auditPlanningObservation, loadPinnedPlanningObservation } from "./planning-observation.js";

const roots: string[] = [];
const observedAt = "2026-10-19T00:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(sessionId?: string, source: { root?: string; runId?: string; name?: string; alternateSelectors?: string[] } = {}) {
  const root = source.root ?? await mkdtemp(join(tmpdir(), "proofkit-planning-source-"));
  if (!source.root) roots.push(root);
  const store = new EvidenceStore(join(root, ".proofkit", "runs"));
  const snapshot: SurfaceSnapshot = { capturedAt: observedAt, url: "https://fixture.local/__redacted__", controls: [
    { tag: "button", role: "button", name: source.name ?? "Save", selector: "#save", ...(source.alternateSelectors ? { alternateSelectors: source.alternateSelectors } : {}), disabled: false }], metadata: {} };
  const summary: RunSummary = { runId: source.runId ?? "inspection", projectRoot: root, workspaceRoot: root,
    execution: { adapter: "web", ...(sessionId ? { sessionId } : {}) }, status: "completed", verdict: "inconclusive", startedAt: observedAt, endedAt: observedAt,
    charter: TestCharterSchema.parse({ intent: "Inspect surface", level: "quick", actions: [{ kind: "observe" }], sideEffectPolicy: "deny", metadata: { purpose: "surface-inspection" } }),
    steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
  await store.startRun(summary);
  const snapshotPath = await store.writeJson(summary.runId, "step-001-after", snapshot);
  summary.steps = [{ stepId: "step-001", action: { kind: "observe" }, status: "passed", afterSnapshot: snapshot, artifacts: [snapshotPath] }];
  summary.artifacts = [snapshotPath]; await store.writeSummary(summary); await store.writeReport(summary);
  const manifest = await store.writeManifest(summary.runId);
  const observation: PlanningSurfaceObservation = { capturedAt: observedAt, controlsTruncated: false, ...(sessionId ? { sessionId } : {}),
    source: { runId: summary.runId, manifestSha256: manifest.sha256, snapshotPath, snapshotSha256: sha256(await readFile(join(store.rootDir, snapshotPath))) } };
  const actions: Action[] = [{ kind: "click", selector: "#save", expectedTarget: { observedAt, tag: "button", role: "button", name: source.name ?? "Save", groupName: "", origin: "https://fixture.local" } }];
  const options = { projectRoot: root, workspaceRoot: root, adapter: "web", sessionId, actions };
  const audit = (input = observation) => auditPlanningObservation(store, input, options);
  return { root, store, summary, snapshot, observation, options, audit, actions };
}

describe("original planning observation audit", () => {
  it("verifies a pinned alternate selector only when its original snapshot declares that same target", async () => {
    const state = await fixture(undefined, { alternateSelectors: ['role=button[name="Save"]'] });
    if (state.actions[0]?.kind === "click") state.actions[0].selector = 'role=button[name="Save"]';
    expect(await state.audit()).toMatchObject({ status: "verified" });
    if (state.actions[0]?.kind === "click") state.actions[0].selector = 'role=button[name="Delete"]';
    expect(await state.audit()).toMatchObject({ status: "unverified" });
  });

  it("verifies the original pin and returns only separate planning evidence", async () => {
    const state = await fixture();
    const audit = await state.audit();
    expect(audit.status).toBe("verified"); expect(audit.evidence).toHaveLength(3);
    expect(audit.evidence.every((ref) => ref.sha256 && ref.kind !== "business")).toBe(true);
    expect(audit.evidence.find((ref) => ref.path.endsWith("manifest.json"))?.sha256).toBe(state.observation.source!.manifestSha256);
  });

  it.each(["run.json", "report.html", "artifacts/step-001-after.json"])("withdraws context after %s changes without repinning current bytes", async (name) => {
    const state = await fixture();
    await writeFile(join(state.store.rootDir, "inspection", name), name === "run.json" ? JSON.stringify({ ...state.summary, findings: ["changed source"] }) : "changed source");
    expect(await state.audit()).toMatchObject({ status: "unverified", evidence: [] });
    await state.store.writeManifest("inspection");
    expect(await state.audit()).toMatchObject({ status: "unverified", evidence: [] });
  });

  it("keeps caller supplied snapshots explicit without inventing saved inspection provenance", async () => {
    const state = await fixture();
    expect(await state.audit({ capturedAt: observedAt, controlsTruncated: false })).toMatchObject({ status: "caller-supplied", evidence: [] });
  });

  it("refuses another session, surface, project and workspace", async () => {
    const state = await fixture("00000000-0000-4000-8000-000000000001");
    for (const changed of [{ sessionId: undefined }, { sessionId: "00000000-0000-4000-8000-000000000002" },
      { adapter: "electron" }, { projectRoot: join(state.root, "other") }, { workspaceRoot: join(state.root, "other") }]) {
      expect(await auditPlanningObservation(state.store, state.observation, { ...state.options, ...changed })).toMatchObject({ status: "unverified", evidence: [] });
    }
  });

  it("requires the original observation time, digest and Run-owned snapshot path", async () => {
    const state = await fixture();
    for (const observation of [{ ...state.observation, capturedAt: "2026-10-18T00:00:00.000Z" }, { ...state.observation, controlsTruncated: true },
      { ...state.observation, source: { ...state.observation.source!, snapshotSha256: "0".repeat(64) } },
      { ...state.observation, source: { ...state.observation.source!, snapshotPath: "another/artifacts/step-001-after.json" } }]) {
      expect(await state.audit(observation)).toMatchObject({ status: "unverified", evidence: [] });
    }
  });

  it("refuses a changed plan identity even if its selector still exists", async () => {
    const state = await fixture();
    if (state.actions[0]!.kind === "click") state.actions[0]!.expectedTarget!.name = "Delete";
    expect(await state.audit()).toMatchObject({ status: "unverified", evidence: [] });
  });

  it("does not accept an ordinary test Run as an independently observed planning source", async () => {
    const state = await fixture(); state.summary.charter.metadata.purpose = "ordinary-test";
    await state.store.writeSummary(state.summary); const manifest = await state.store.writeManifest("inspection");
    state.observation.source!.manifestSha256 = manifest.sha256;
    expect(await state.audit()).toMatchObject({ status: "unverified", evidence: [] });
  });

  it("loads a summary only when its retained bytes match an explicitly supplied pin", async () => {
    const state = await fixture();
    const pin = sha256(await readFile(join(state.store.rootDir, "inspection", "run.json")));
    expect((await state.store.loadSummary("inspection", pin.toUpperCase())).runId).toBe("inspection");
    await expect(state.store.loadSummary("inspection", "")).rejects.toThrow("pinned digest");
    await expect(state.store.loadSummary("inspection", "0".repeat(64))).rejects.toThrow("pinned digest");
  });

  it("loads only original inspection pins in the exact retained-session scope", async () => {
    for (const sessionId of [undefined, "00000000-0000-4000-8000-000000000001"]) {
      const state = await fixture(sessionId);
      const pin = { runId: state.summary.runId, manifestSha256: state.observation.source!.manifestSha256 };
      expect(await loadPinnedPlanningObservation(state.store, pin, state.options)).toMatchObject({ observation: state.observation, snapshot: state.snapshot });
      for (const other of [undefined, "00000000-0000-4000-8000-000000000002"].filter((other) => other !== sessionId)) {
        await expect(loadPinnedPlanningObservation(state.store, pin, { ...state.options, sessionId: other })).rejects.toThrow("session");
      }
      await expect(loadPinnedPlanningObservation(state.store, { ...pin, manifestSha256: "0".repeat(64) }, state.options)).rejects.toThrow("original manifest pin");
      state.summary.charter.metadata.purpose = "ordinary-test";
      await state.store.writeSummary(state.summary);
      const replacement = await state.store.writeManifest(state.summary.runId);
      await expect(loadPinnedPlanningObservation(state.store, { ...pin, manifestSha256: replacement.sha256 }, state.options)).rejects.toThrow("cannot be verified");
    }
  });

  it("verifies all state sources and withdraws every context link if the second source changes", async () => {
    const first = await fixture();
    const second = await fixture(undefined, { root: first.root, runId: "checkout", name: "Confirm order" });
    const states = [first, second];
    const observation: PlanningSurfaceObservation = { capturedAt: observedAt, controlsTruncated: false,
      sources: states.map((state) => ({ capturedAt: observedAt, controlsTruncated: false, source: state.observation.source! })) };
    const actions = states.flatMap((state) => state.actions.map((action) => action.kind === "click" ? { ...action, observationId: state.summary.runId,
      expectedTarget: { ...action.expectedTarget!, observationId: state.summary.runId } } : action));
    const audit = () => auditPlanningObservation(first.store, observation, { ...first.options, actions });
    const intact = await audit();
    expect(intact.status).toBe("verified"); expect(intact.evidence).toHaveLength(6);
    expect(new Set(intact.evidence.map((entry) => entry.path)).size).toBe(6);
    await writeFile(join(first.store.rootDir, second.observation.source!.snapshotPath), "changed second observation");
    expect(await audit()).toMatchObject({ status: "unverified", evidence: [] });
    await first.store.writeManifest(second.summary.runId);
    expect(await audit()).toMatchObject({ status: "unverified", evidence: [] });
  });

  it("rejects state identity swaps, missing IDs and unknown IDs before exposing context", async () => {
    const first = await fixture();
    const second = await fixture(undefined, { root: first.root, runId: "checkout", name: "Confirm order" });
    const observation: PlanningSurfaceObservation = { capturedAt: observedAt, controlsTruncated: false,
      sources: [first, second].map((state) => ({ capturedAt: observedAt, controlsTruncated: false, source: state.observation.source! })) };
    const original = first.actions[0]!;
    if (original.kind !== "click") throw new Error("Expected click fixture");
    for (const [actionId, expectedId] of [[undefined, undefined], ["unknown", "unknown"], ["inspection", "checkout"], ["checkout", "checkout"]]) {
      const action: Action = { ...original, observationId: actionId, expectedTarget: { ...original.expectedTarget!, observationId: expectedId } };
      expect(await auditPlanningObservation(first.store, observation, { ...first.options, actions: [action] })).toMatchObject({ status: "unverified", evidence: [] });
    }
  });
});
