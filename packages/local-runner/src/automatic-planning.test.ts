import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { ProofkitConfigSchema, type SurfaceSnapshot } from "@proofkit/contracts";
import { LocalRunnerService, PlanningObservationError } from "./index.js";
import type { PlannerInput, PlannerProvider } from "@proofkit/planner";

const roots: string[] = [];
const snapshot: SurfaceSnapshot = { capturedAt: "2026-10-19T00:00:00.000Z", url: "http://127.0.0.1:1/__redacted__", text: "Ready", metadata: { adapter: "web" },
  controls: [{ tag: "button", role: "button", selector: "#save", name: "Save", disabled: false }] };
beforeEach(() => {
  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "discover").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "act").mockImplementation(async (action) => ({ actionId: "observe", kind: action.kind,
    startedAt: snapshot.capturedAt, endedAt: snapshot.capturedAt, durationMs: 0, metadata: {} }));
  vi.spyOn(WebAdapter.prototype, "capture").mockResolvedValue(undefined);
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(withUrl = true) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-auto-plan-test-")); roots.push(root);
  const provider = { name: "model-fixture", plan: vi.fn<PlannerProvider["plan"]>(async (_input: PlannerInput) => ({ intent: "Save draft", level: "quick", sideEffectPolicy: "allow",
    actions: [{ kind: "click", selector: "#save" }], assertions: [{ kind: "text-visible", text: "Ready" }] })) };
  const runner = new LocalRunnerService({ root, workspaceRoot: root, plannerProvider: provider,
    config: ProofkitConfigSchema.parse({ surfaces: withUrl ? { web: { baseUrl: "http://127.0.0.1:1" } } : {}, policies: { sideEffects: "allow" } }) });
  return { root, runner, provider, options: { level: "quick" as const, sideEffectPolicy: "allow" as const } };
}

describe("automatic observation for model planning", () => {
  it("returns a source-pinned continuation without executing its proposed action", async () => {
    const state = await fixture();
    state.provider.plan.mockResolvedValue({ status: "needs-observation", reason: "Need next page", expectedObservation: "Inspect the next form", action: { kind: "click", selector: "#save" } } as never);
    const error = await state.runner.plan("Save draft", state.options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PlanningObservationError);
    const receipt = (error as PlanningObservationError).receipt();
    expect(receipt).toMatchObject({ status: "needs-observation", testVerdict: "not-asserted", observationRequest: { requiresApproval: true,
      action: { kind: "click", expectedTarget: { name: "Save" } }, inspections: [{ runId: receipt.inspection!.inspectionId }] } });
    const pin = receipt.observationRequest!.inspections[0]!;
    expect((await state.runner.verifyEvidenceManifest(pin.runId, pin.manifestSha256)).status).toBe("intact");
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("resumes original requirements and earlier observed states after recreating the Runner", async () => {
    const state = await fixture(); const intent = "Save the private draft, reload it and verify exact content. Do not share it.";
    state.provider.plan.mockResolvedValue({ status: "needs-observation", reason: "Need the next state", expectedObservation: "Next form", action: { kind: "click", selector: "#save" } });
    const failed = await state.runner.plan(intent, { ...state.options, mode: "deterministic", expect: ["Ready"], oracleNames: [], headful: true }).catch((error: unknown) => error);
    const saved = (failed as PlanningObservationError).receipt().observationRequest!.continuation!;
    const second = await state.runner.inspectSurface();
    state.provider.plan.mockResolvedValue({ intent: "Narrow model text", mode: "deterministic", sideEffectPolicy: "allow", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], oracles: [] });
    const fresh = new LocalRunnerService({ root: state.root, workspaceRoot: state.root, config: state.runner.config, plannerProvider: state.provider });
    vi.mocked(WebAdapter.prototype.connect).mockClear();
    const charter = await fresh.plan(undefined, { continuation: saved, inspections: [{ runId: second.inspectionId, manifestSha256: second.manifest!.sha256 }] });
    expect(charter).toMatchObject({ intent, level: "quick", mode: "deterministic", sideEffectPolicy: "allow" });
    expect(charter.surfaceObservation?.sources).toHaveLength(2); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    expect(state.provider.plan.mock.calls.at(-1)![0]).toMatchObject({ intent, constraints: { expect: ["Ready"], oracleNames: [], mode: "deterministic" }, surfaceObservations: expect.any(Array) });
  });

  it("refuses narrowed resume requirements before observing or calling the model", async () => {
    const state = await fixture();
    state.provider.plan.mockResolvedValue({ status: "needs-observation", reason: "Need next page", expectedObservation: "Next page" });
    const error = await state.runner.plan("Save draft and verify persistence", { ...state.options, expect: ["Ready"] }).catch((error: unknown) => error);
    const saved = (error as PlanningObservationError).receipt().observationRequest!.continuation!;
    state.provider.plan.mockClear(); vi.mocked(WebAdapter.prototype.connect).mockClear();
    await expect(state.runner.plan("Save draft only", { continuation: saved })).rejects.toThrow("saved intent");
    await expect(state.runner.plan("Save draft and verify persistence", { continuation: saved, expect: [] })).rejects.toThrow("saved expect");
    expect(state.provider.plan).not.toHaveBeenCalled(); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("retains the original observation integrity checks when resuming a saved plan", async () => {
    const state = await fixture();
    state.provider.plan.mockResolvedValue({ status: "needs-observation", reason: "Need next page", expectedObservation: "Next page" });
    const error = await state.runner.plan("Save draft", state.options).catch((error: unknown) => error);
    const receipt = (error as PlanningObservationError).receipt();
    const original = receipt.observationRequest!.inspections[0]!;
    await writeFile(join(state.runner.evidenceDir, original.runId, "artifacts/step-001-after.json"), "Changed original state");
    state.provider.plan.mockClear();
    await expect(state.runner.plan("Save draft", { continuation: receipt.observationRequest!.continuation! })).rejects.toBeInstanceOf(PlanningObservationError);
    expect(state.provider.plan).not.toHaveBeenCalled();
  });

  it("stops repeated missing-observation requests at the saved ten-round budget", async () => {
    const state = await fixture();
    state.provider.plan.mockResolvedValue({ status: "needs-observation", reason: "Need another state", expectedObservation: "Next state" });
    let error = await state.runner.plan("Save draft", state.options).catch((error: unknown) => error);
    for (let round = 1; round < 10; round++) {
      const pin = (error as PlanningObservationError).receipt().observationRequest!.continuation!;
      error = await state.runner.plan("Save draft", { continuation: pin }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PlanningObservationError);
    }
    const pin = (error as PlanningObservationError).receipt().observationRequest!.continuation!;
    await expect(state.runner.plan("Save draft", { continuation: pin })).rejects.toThrow("ten-round observation budget");
    expect(state.provider.plan).toHaveBeenCalledTimes(11);
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("withdraws a continuation if its original observation changed during the provider call", async () => {
    const state = await fixture();
    state.provider.plan.mockImplementation(async () => {
      const [runId] = await readdir(state.runner.evidenceDir);
      await writeFile(join(state.runner.evidenceDir, runId!, "artifacts", "step-001-after.json"), "changed observation");
      return { status: "needs-observation", reason: "Need next page", expectedObservation: "Inspect next page", action: { kind: "click", selector: "#save" } } as never;
    });
    const error = await state.runner.plan("Save draft", state.options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PlanningObservationError);
    expect((error as PlanningObservationError).continuation).toBeUndefined();
  });

  it("loads original pinned states and forwards both snapshots without opening another browser", async () => {
    const state = await fixture();
    const first = await state.runner.inspectSurface();
    vi.mocked(WebAdapter.prototype.discover).mockResolvedValue({ ...snapshot, capturedAt: "2026-10-19T00:01:00.000Z",
      controls: [{ tag: "button", role: "button", selector: "#save", name: "Confirm", disabled: false }] });
    const second = await state.runner.inspectSurface();
    const inspections = [first, second].map((inspection) => ({ runId: inspection.inspectionId, manifestSha256: inspection.manifest!.sha256 }));
    vi.mocked(WebAdapter.prototype.connect).mockClear();
    state.provider.plan.mockImplementation(async ({ surfaceObservations }) => ({ intent: "Save draft", level: "quick", sideEffectPolicy: "allow",
      actions: surfaceObservations!.map((observed) => ({ kind: "click", selector: "#save", observationId: observed.observationId })), assertions: [{ kind: "text-visible", text: "Ready" }] }));
    const charter = await state.runner.plan("Save draft", { ...state.options, inspections });
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    expect(charter.surfaceObservation?.sources).toHaveLength(2);
    expect(charter.actions[0]).toHaveProperty("expectedTarget.name", "Save");
    expect(charter.actions[1]).toHaveProperty("expectedTarget.name", "Confirm");
    expect(state.provider.plan).toHaveBeenCalledWith(expect.objectContaining({ surfaceObservations: expect.arrayContaining([
      expect.objectContaining({ observationId: first.inspectionId }), expect.objectContaining({ observationId: second.inspectionId })]) }));
  });

  it("refuses a changed original pin and duplicate states before invoking the provider", async () => {
    const state = await fixture(); const inspection = await state.runner.inspectSurface();
    const pin = { runId: inspection.inspectionId, manifestSha256: inspection.manifest!.sha256 };
    await expect(state.runner.plan("Save draft", { ...state.options, inspections: [pin, pin] })).rejects.toThrow("distinct");
    await expect(state.runner.plan("Save draft", { ...state.options, inspections: [{ ...pin, manifestSha256: "0".repeat(64) }] })).rejects.toBeInstanceOf(PlanningObservationError);
    expect(state.provider.plan).not.toHaveBeenCalled();
    await expect(state.runner.plan("Save draft", { ...state.options, surfaceSnapshot: snapshot, inspections: [pin] })).rejects.toThrow("not both");
  });

  it("saves a pinned read-only inspection before calling the provider and attaches its source", async () => {
    const state = await fixture();
    const charter = await state.runner.plan("Save draft", state.options);
    expect(state.provider.plan).toHaveBeenCalledWith(expect.objectContaining({ surfaceSnapshot: snapshot }));
    expect(WebAdapter.prototype.discover).toHaveBeenCalled();
    expect(charter.surfaceObservation?.source).toBeDefined();
    expect(charter.actions[0]).toHaveProperty("expectedTarget.name", "Save");
    const source = charter.surfaceObservation!.source!;
    const summary = await state.runner.wait(source.runId);
    expect(summary.charter).toMatchObject({ sideEffectPolicy: "deny", metadata: { purpose: "surface-inspection" } });
    expect(summary.charter.actions).toEqual([{ kind: "observe" }]);
    expect((await state.runner.verifyEvidenceManifest(source.runId, source.manifestSha256)).status).toBe("intact");
  });

  it("keeps an explicitly supplied snapshot separate and does not silently open another browser", async () => {
    const state = await fixture();
    const charter = await state.runner.plan("Save draft", { ...state.options, surfaceSnapshot: snapshot });
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    expect(charter.surfaceObservation?.source).toBeUndefined();
    expect(state.provider.plan).toHaveBeenCalledOnce();
  });

  it("does not invoke the provider when observation fails and retains a bounded inspection receipt", async () => {
    const state = await fixture(); vi.mocked(WebAdapter.prototype.discover).mockRejectedValue(new Error("private observation diagnostic"));
    const failure = await state.runner.plan("Save draft", state.options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanningObservationError);
    expect((failure as PlanningObservationError).inspection).toMatchObject({ status: "failed", testVerdict: "not-asserted" });
    expect((failure as PlanningObservationError).inspection?.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(failure)).not.toContain("private observation diagnostic");
    expect(state.provider.plan).not.toHaveBeenCalled();
  });

  it("requires an intent for a new plan before observing or invoking a provider", async () => {
    const state = await fixture();
    await expect(state.runner.plan(undefined)).rejects.toThrow("intent or a saved continuation");
    expect(state.provider.plan).not.toHaveBeenCalled(); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("requires an observation target before any provider request", async () => {
    const state = await fixture(false);
    await expect(state.runner.plan("Save draft", state.options)).rejects.toBeInstanceOf(PlanningObservationError);
    expect(state.provider.plan).not.toHaveBeenCalled();
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("does not return an executable plan after its source changes during model generation", async () => {
    const state = await fixture();
    state.provider.plan.mockImplementation(async () => {
      const [runId] = await readdir(state.runner.evidenceDir);
      await writeFile(join(state.runner.evidenceDir, runId!, "artifacts", "step-001-after.json"), "changed while planning");
      return { intent: "Save draft", level: "quick", sideEffectPolicy: "allow", actions: [{ kind: "click", selector: "#save" }], assertions: [{ kind: "text-visible", text: "Ready" }] };
    });
    await expect(state.runner.plan("Save draft", state.options)).rejects.toBeInstanceOf(PlanningObservationError);
    expect(state.provider.plan).toHaveBeenCalledOnce();
  });

  it("rejects a changed or missing source before connecting a test browser", async () => {
    const state = await fixture(); const charter = await state.runner.plan("Save draft", state.options);
    const source = charter.surfaceObservation!.source!;
    const original = await readFile(join(state.runner.evidenceDir, source.snapshotPath));
    await writeFile(join(state.runner.evidenceDir, source.snapshotPath), "changed source");
    vi.mocked(WebAdapter.prototype.connect).mockClear(); vi.mocked(WebAdapter.prototype.act).mockClear();
    const run = await state.runner.start({ charter, adapter: "web", start: false });
    expect(await state.runner.wait(run.runId)).toMatchObject({ verdict: "inconclusive", steps: [] });
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled(); expect(WebAdapter.prototype.act).not.toHaveBeenCalled();
    await writeFile(join(state.runner.evidenceDir, source.snapshotPath), original);
  });

  it("retains the original request in the generated and persisted Mission Charter", async () => {
    const state = await fixture();
    const intent = "Save the draft, reload it and verify its content. Do not share or delete any record.";
    state.provider.plan.mockResolvedValue({ intent: "Only check the page", level: "quick", mode: "deterministic", sideEffectPolicy: "allow",
      actions: [{ kind: "click", selector: "#save" }], assertions: [{ kind: "text-visible", text: "Ready" }] });
    const mission = await state.runner.createMission({ intent, surface: "web", level: "quick", mode: "deterministic", sideEffectPolicy: "allow" });
    expect(mission.intent).toBe(intent); expect(mission.charter?.intent).toBe(intent);
    const bytes = await readFile(join(state.root, ".proofkit/missions", mission.missionId + ".json"), "utf8");
    expect(JSON.parse(bytes)).toMatchObject({ intent, charter: { intent, mode: "deterministic" } });
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("refuses a changed model mode before creating or executing a formal Mission", async () => {
    const state = await fixture();
    state.provider.plan.mockResolvedValue({ intent: "Save draft", level: "quick", mode: "explore", sideEffectPolicy: "allow",
      actions: [{ kind: "click", selector: "#save" }], assertions: [{ kind: "text-visible", text: "Ready" }] });
    const missions = () => readdir(join(state.root, ".proofkit/missions")).catch(() => []);
    const before = await missions();
    await expect(state.runner.createMission({ intent: "Save draft", surface: "web", level: "quick", mode: "deterministic", sideEffectPolicy: "allow" })).rejects.toThrow("requested execution mode");
    expect(await missions()).toEqual(before);
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("propagates an already cancelled request before observing or calling the provider", async () => {
    const state = await fixture(); const controller = new AbortController(); controller.abort(new Error("Cancelled planning"));
    await expect(state.runner.plan("Save draft", { ...state.options, signal: controller.signal })).rejects.toThrow("Cancelled planning");
    expect(state.provider.plan).not.toHaveBeenCalled(); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });
});
