import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter, WebTaskSession } from "@proofkit/adapters";
import { ProofkitConfigSchema, TestCharterSchema, type SurfaceSnapshot } from "@proofkit/contracts";
import { EvidenceStore, loadPinnedPlanningObservation } from "@proofkit/evidence";
import { LocalRunnerService, PlanningObservationError } from "./index.js";
import type { IntegrationSetupContext, ProjectIntegration } from "@proofkit/runner";

const roots: string[] = [];
const runners: LocalRunnerService[] = [];
const snapshot: SurfaceSnapshot = { capturedAt: "2026-10-21T00:00:00.000Z", url: "http://127.0.0.1:1/__redacted__", text: "Ready", metadata: { adapter: "web" },
  controls: [{ tag: "button", role: "button", selector: "#next", name: "Next", disabled: false }] };
beforeEach(() => {
  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "discover").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "act").mockImplementation(async (action) => ({ actionId: "observe", kind: action.kind,
    startedAt: snapshot.capturedAt, endedAt: snapshot.capturedAt, durationMs: 0, metadata: {} }));
  vi.spyOn(WebAdapter.prototype, "capture").mockResolvedValue(undefined);
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "Observed fixture outcome", evidence: [] }));
  vi.spyOn(WebTaskSession.prototype, "reusable", "get").mockReturnValue(true);
});
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.closeAllSurfaceSessions()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(extra = {}, integration?: ProjectIntegration) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-inspection-session-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root, integration, allowCapabilityWrites: true, config: ProofkitConfigSchema.parse({
    surfaces: { web: { baseUrl: "http://127.0.0.1:1" } }, policies: { sideEffects: "deny" }, sessions: { recordNetwork: false }, ...extra }) });
  runners.push(runner); return { root, runner };
}

describe("read-only retained Web observations", () => {
  it("prepares a reviewed resource once for a retained session and verifies cleanup on close", async () => {
    const scopes = new Set(["foreign"]);
    const cleanup = vi.fn(async (scope: string) => {
      expect(scopes.delete(scope)).toBe(true);
      return [{ resourceId: "scope", status: "removed" as const, evidence: { owner: scope },
        readback: { reader: "fixture.scope-get", scope, exists: scopes.has(scope), observedAt: new Date().toISOString() } }];
    });
    const setup = vi.fn(async ({ runId, registerResources }: IntegrationSetupContext) => {
      const handle = { resources: [{ resourceId: "scope", kind: "owned", scope: runId, evidence: { owner: runId } }],
        cleanup: async () => cleanup(runId) };
      await registerResources!(handle);
      scopes.add(runId);
      return handle;
    });
    const { runner } = await fixture({ policies: { environment: "test", sideEffects: "allow" } }, {
      name: "prepared-session", version: "1", setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 },
      setup, recover: async ({ resources }) => cleanup(resources[0]!.scope),
    });
    const inspection = await runner.inspectSurface({ keepSession: true });
    expect(inspection.status).toBe("observed"); expect(setup).not.toHaveBeenCalled();
    const charter = TestCharterSchema.parse({ intent: "Prepare one isolated scope", level: "core", surfaces: ["web"],
      sideEffectPolicy: "allow", actions: [], assertions: [] });
    const prepared = await runner.prepareSurfaceSession({ sessionId: inspection.sessionId!, charter });
    expect(prepared).toMatchObject({ status: "prepared", testVerdict: "not-asserted", sessionId: inspection.sessionId });
    expect(scopes).toEqual(new Set(["foreign", prepared.runId]));
    expect(runner.listSurfaceSessions().sessions[0]?.preparationRunId).toBe(prepared.runId);
    expect(await runner.inspectRunResources(prepared.runId)).toMatchObject({ status: "active" });
    expect((await runner.interactSurface({ sessionId: inspection.sessionId, action: { kind: "waitForText", text: "Ready" } })).status).toBe("observed");
    expect((await runner.interactSurface({ sessionId: inspection.sessionId, action: { kind: "click", selector: "#next" } })).status).toBe("observed");
    expect((await runner.interactSurface({ sessionId: inspection.sessionId, action: { kind: "goto", url: "http://127.0.0.1:1/next" } })).status).toBe("observed");
    expect(setup).toHaveBeenCalledTimes(1);
    const closed = await runner.closeSurfaceSession(inspection.sessionId!);
    expect(closed.resourcePreparation).toMatchObject({ runId: prepared.runId, cleanup: { status: "verified", verifiedResources: 1 } });
    expect(await runner.inspectRunResources(prepared.runId)).toMatchObject({ status: "cleaned" });
    expect(scopes).toEqual(new Set(["foreign"]));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("skips product lifecycle for read-only observation and waits but retains it for formal execution", async () => {
    const preflight = vi.fn(async () => ({ passed: true, message: "Formal prerequisite" }));
    const postSetupCheck = vi.fn(async () => ({ passed: true, message: "Formal setup checked" }));
    const postRunCheck = vi.fn(async () => ({ passed: true, message: "Formal state checked" }));
    const cleanup = vi.fn(async () => [{ resourceId: "fixture", status: "removed" as const, evidence: {},
      readback: { reader: "test.fixture", scope: "fixture-scope", exists: false, observedAt: new Date().toISOString() } }]);
    const setup = vi.fn(async () => ({ resources: [{ resourceId: "fixture", kind: "synthetic", scope: "fixture-scope", evidence: {} }], cleanup }));
    const { runner } = await fixture({ policies: { sideEffects: "allow" } }, { name: "write-fixture", setup, preflight, postSetupCheck, postRunCheck,
      setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 } });
    expect((await runner.inspectSurface()).status).toBe("observed");
    const inspection = await runner.inspectSurface({ keepSession: true });
    expect(inspection.status).toBe("observed");
    expect((await runner.interactSurface({ sessionId: inspection.sessionId, action: { kind: "waitForText", text: "Ready" } })).status).toBe("observed");
    for (const hook of [preflight, setup, postSetupCheck, postRunCheck, cleanup]) expect(hook).not.toHaveBeenCalled();
    const formal = await runner.start({ sessionId: inspection.sessionId, start: false, charter: TestCharterSchema.parse({ intent: "Formal page check", level: "quick", mode: "deterministic",
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "allow" }) });
    expect((await runner.wait(formal.runId)).verdict).toBe("passed");
    for (const hook of [preflight, setup, postSetupCheck, postRunCheck, cleanup]) expect(hook).toHaveBeenCalledTimes(1);
  });

  it("does not bypass write setup for an exploratory click", async () => {
    const setup = vi.fn(async () => ({ resources: [], cleanup: async () => [] }));
    const { runner } = await fixture({ policies: { sideEffects: "allow" } }, { name: "write-fixture", setup,
      setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 } });
    const inspection = await runner.inspectSurface({ keepSession: true });
    await runner.interactSurface({ sessionId: inspection.sessionId, action: { kind: "click", selector: "#next" } });
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("does not let caller-authored observation metadata bypass a formal setup write policy", async () => {
    const setup = vi.fn(async () => {});
    const { runner } = await fixture({}, { name: "protected-fixture", setup, setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 } });
    const started = await runner.start({ start: false, charter: TestCharterSchema.parse({ intent: "Caller metadata", level: "quick", mode: "deterministic",
      actions: [{ kind: "observe" }], assertions: [], sideEffectPolicy: "deny", metadata: { purpose: "surface-inspection" } }) });
    expect((await runner.wait(started.runId)).verdict).toBe("blocked");
    expect(setup).not.toHaveBeenCalled(); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("creates a reusable source-pinned session without an exploratory navigation or control action", async () => {
    const { root, runner } = await fixture();
    const inspection = await runner.inspectSurface({ keepSession: true, sessionLabel: "Review workspace", headful: true });
    expect(inspection).toMatchObject({ status: "observed", testVerdict: "not-asserted", sessionId: expect.any(String), sessionLabel: "Review workspace" });
    const observed = await loadPinnedPlanningObservation(new EvidenceStore(runner.evidenceDir), { runId: inspection.inspectionId, manifestSha256: inspection.manifest!.sha256 },
      { projectRoot: root, workspaceRoot: root, adapter: "web", sessionId: inspection.sessionId });
    expect(observed.snapshot.controls).toEqual(snapshot.controls);
    const repeated = await runner.inspectSurface({ sessionId: inspection.sessionId });
    expect(repeated.sessionId).toBe(inspection.sessionId);
    expect(WebAdapter.prototype.act).toHaveBeenCalledTimes(2);
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
    expect(runner.listSurfaceSessions().sessions).toEqual([expect.objectContaining({ sessionId: inspection.sessionId, busy: false, headful: true })]);
  });

  it("opens a retained planning observation and restores it across a needs-observation continuation", async () => {
    const { runner } = await fixture();
    const provider = { name: "observed-fixture", plan: vi.fn().mockResolvedValueOnce({ status: "needs-observation", reason: "Need next form", expectedObservation: "Next form" })
      .mockResolvedValue({ intent: "Shorter model text", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny" }) };
    Object.assign(runner, { plannerProvider: provider });
    const intent = "Review the entire flow without submitting data";
    const failure = await runner.plan(intent, { keepSession: true, level: "quick", sideEffectPolicy: "deny" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanningObservationError);
    const request = (failure as PlanningObservationError).receipt().observationRequest!;
    expect(request.sessionId).toBe(runner.listSurfaceSessions().sessions[0]!.sessionId);
    const next = await runner.inspectSurface({ sessionId: request.sessionId });
    const charter = await runner.plan(undefined, { continuation: request.continuation, inspections: [{ runId: next.inspectionId, manifestSha256: next.manifest!.sha256 }] });
    expect(charter.intent).toBe(intent);
    expect(charter.surfaceObservation?.sessionId).toBe(request.sessionId);
    expect(charter.surfaceObservation?.sources).toHaveLength(2);
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("closes a newly created planning session when the planner fails before returning a usable draft", async () => {
    const { runner } = await fixture();
    Object.assign(runner, { plannerProvider: { name: "broken", plan: async () => { throw new Error("Planner unavailable"); } } });
    await expect(runner.plan("Review the form", { keepSession: true, level: "quick" })).rejects.toThrow("Planner unavailable");
    expect(runner.listSurfaceSessions().sessions).toEqual([]);
  });

  it("does not retire an existing caller session when planning fails", async () => {
    const { runner } = await fixture();
    const observed = await runner.inspectSurface({ keepSession: true });
    Object.assign(runner, { plannerProvider: { name: "broken", plan: async () => { throw new Error("Planner unavailable"); } } });
    await expect(runner.plan("Review", { sessionId: observed.sessionId, level: "quick" })).rejects.toThrow("Planner unavailable");
    expect(runner.listSurfaceSessions().sessions.map((session) => session.sessionId)).toEqual([observed.sessionId]);
  });

  it.each([
    { keepSession: true, sessionId: "00000000-0000-4000-8000-000000000001" },
    { keepSession: true, adapter: "electron" as const },
    { keepSession: true, cdp: "http://127.0.0.1:9222" },
    { sessionLabel: "Orphan label" },
  ])("rejects an incompatible session declaration before connecting: %j", async (input) => {
    const { runner } = await fixture();
    await expect(runner.inspectSurface(input)).rejects.toThrow();
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    expect(runner.listSurfaceSessions().sessions).toEqual([]);
  });

  it("rejects a caller snapshot combined with new retained planning before observing", async () => {
    const { runner } = await fixture();
    await expect(runner.plan("Review", { keepSession: true, surfaceSnapshot: snapshot })).rejects.toThrow();
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("honors cancellation before creating any session", async () => {
    const { runner } = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(runner.inspectSurface({ keepSession: true, signal: controller.signal })).rejects.toThrow();
    expect(runner.listSurfaceSessions().sessions).toEqual([]);
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });
});
