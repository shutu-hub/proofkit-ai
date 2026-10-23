import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { ProofkitConfigSchema, TestCharterSchema, type SurfaceSnapshot, type TestCharter } from "@proofkit/contracts";
import { LocalRunnerService, PlanningObservationError } from "./index.js";

const roots: string[] = [];
const snapshot: SurfaceSnapshot = { capturedAt: "2026-10-19T00:00:00.000Z", url: "http://127.0.0.1:1/__redacted__", text: "Ready", metadata: {},
  controls: [{ tag: "button", role: "button", selector: "#save", name: "Save", disabled: false }] };
beforeEach(() => {
  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "discover").mockResolvedValue(snapshot);
  vi.spyOn(WebAdapter.prototype, "act").mockImplementation(async (action) => ({ actionId: action.kind, kind: action.kind, startedAt: snapshot.capturedAt, endedAt: snapshot.capturedAt, durationMs: 0, metadata: {} }));
  vi.spyOn(WebAdapter.prototype, "capture").mockResolvedValue(undefined);
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function draft(changed: Partial<TestCharter> = {}): TestCharter {
  return TestCharterSchema.parse({ intent: "Host draft", level: "quick", mode: "deterministic", sideEffectPolicy: "allow",
    actions: [{ kind: "click", selector: "#save" }], assertions: [{ kind: "text-visible", text: "Ready" }], ...changed });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-submitted-plan-")); roots.push(root);
  const provider = { name: "unavailable-model", plan: vi.fn(async () => { throw new Error("The secondary provider must not be used"); }) };
  const runner = new LocalRunnerService({ root, workspaceRoot: root, restrictWebOrigins: true, plannerProvider: provider,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "http://127.0.0.1:1" } }, policies: { sideEffects: "allow" } }) });
  return { root, runner, provider };
}

describe("source-bound host planning", () => {
  it("retains a page-selection gap when the host draft names an unobserved window", async () => {
    const state = await fixture();
    const reviewed = await state.runner.plan("Inspect review window", { charter: draft({ actions: [{ kind: "switchPage", title: "Unseen review", timeoutMs: 1000 }] }) });
    expect(reviewed.planning?.evidenceGaps).toContain("surface-page");
    expect(state.provider.plan).not.toHaveBeenCalled();
  });

  it("revalidates and binds an existing draft without opening a browser or invoking another model", async () => {
    const state = await fixture();
    const inspected = await state.runner.inspectSurface();
    const pin = { runId: inspected.inspectionId, manifestSha256: inspected.manifest!.sha256 };
    vi.mocked(WebAdapter.prototype.connect).mockClear();
    const charter = draft({ metadata: { planner: "claimed-model" }, planning: { source: "model", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [] },
      actions: [{ kind: "click", selector: "#save", expectedTarget: { observedAt: snapshot.capturedAt, tag: "button", role: "button", name: "Delete", groupName: "" } }] });
    const reviewed = await state.runner.plan("Original user intent", { charter, inspections: [pin], expect: ["Ready"] });
    expect(reviewed).toMatchObject({ intent: "Original user intent", level: "quick", mode: "deterministic", planning: { source: "submitted", evidenceGaps: [] }, metadata: { planner: "submitted-charter" } });
    expect(reviewed.planning!.confidence).toBeLessThan(1);
    expect(reviewed.actions[0]).toMatchObject({ expectedTarget: { name: "Save", observationId: pin.runId } });
    expect(reviewed.surfaceObservation!.sources![0]!.source.manifestSha256).toBe(pin.manifestSha256);
    expect(charter.actions[0]).toHaveProperty("expectedTarget.name", "Delete");
    expect(state.provider.plan).not.toHaveBeenCalled(); expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("automatically observes the current page for a host draft without executing its actions", async () => {
    const state = await fixture();
    const reviewed = await state.runner.plan("Save draft", { charter: draft() });
    expect(reviewed.surfaceObservation?.source).toBeDefined();
    expect(state.provider.plan).not.toHaveBeenCalled();
    expect(vi.mocked(WebAdapter.prototype.act).mock.calls.every(([action]) => action.kind === "observe")).toBe(true);
  });

  it("keeps missing controls as execution gaps rather than trusting a draft binding", async () => {
    const state = await fixture();
    const reviewed = await state.runner.plan("Save draft", { charter: draft({ actions: [{ kind: "click", selector: "#invented" }] }) });
    expect(reviewed.planning!.evidenceGaps).toContain("surface-selector");
    const started = await state.runner.start({ adapter: "web", charter: reviewed, start: false });
    expect(await state.runner.wait(started.runId)).toMatchObject({ verdict: "inconclusive", steps: [] });
    expect(state.provider.plan).not.toHaveBeenCalled();
  });

  it("preserves requested outcomes and refuses mode or policy changes", async () => {
    const state = await fixture();
    await expect(state.runner.plan("Save draft", { charter: draft(), expect: ["Persisted"] })).rejects.toThrow("requested visible outcome");
    await expect(state.runner.plan("Save draft", { charter: draft(), mode: "guided" })).rejects.toThrow("mode conflicts");
    await expect(state.runner.plan("Save draft", { charter: draft(), sideEffectPolicy: "deny" })).rejects.toThrow("allowed action kinds");
  });

  it("rejects a contradictory whole-project scope before attempting an observation", async () => {
    const state = await fixture();
    await expect(state.runner.plan("测试整个项目", { charter: draft(), coverage: "declared" })).rejects.toThrow("Test coverage conflict");
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    expect(state.provider.plan).not.toHaveBeenCalled();
  });

  it("validates inline readers against current captured IDs and existing endpoint rules", async () => {
    const state = await fixture();
    const withReader = draft({ oracles: ["saved-record"], httpOracles: [{ name: "saved-record", url: "http://127.0.0.1:1/read",
      query: { id: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" } }, statusPointer: "/status", successValues: ["created"], failureValues: [], expectedStatus: 200, intervalMs: 100, deadlineMs: 1000 }] });
    await expect(state.runner.plan("Verify persistence", { charter: withReader })).rejects.toThrow("must bind a captured field");
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
    withReader.httpOracles![0]!.url = "https://foreign.local/read";
    await expect(state.runner.plan("Verify persistence", { charter: withReader })).rejects.toThrow("must use loopback");
  });

  it("rejects oversized drafts and unknown negative-case operations or Oracles", async () => {
    const state = await fixture();
    await expect(state.runner.plan("Save draft", { charter: draft({ metadata: { note: "x".repeat(128 * 1024) } }) })).rejects.toThrow("128 KiB");
    const negative = { caseId: "boundary", title: "Boundary", actions: [{ kind: "capability" as const, name: "unknown", input: {} }], assertions: [], oracles: [], sideEffectPolicy: "allow" as const, metadata: {} };
    await expect(state.runner.plan("Save draft", { charter: draft({ negativeCases: [negative] }) })).rejects.toThrow("allowed action kinds");
    await expect(state.runner.plan("Save draft", { charter: draft({ negativeCases: [{ ...negative, actions: [], oracles: ["unknown"] }] }) })).rejects.toThrow("unregistered oracle");
  });

  it("rejects changed source pins without falling back to the configured provider", async () => {
    const state = await fixture(); const inspected = await state.runner.inspectSurface();
    const pin = { runId: inspected.inspectionId, manifestSha256: "0".repeat(64) };
    await expect(state.runner.plan("Save draft", { charter: draft(), inspections: [pin] })).rejects.toBeInstanceOf(PlanningObservationError);
    expect(state.provider.plan).not.toHaveBeenCalled();
    expect(await readFile(inspected.manifest!.path, "utf8")).toContain(inspected.inspectionId);
  });
});
