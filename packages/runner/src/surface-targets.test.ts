import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NegativeCaseSchema, TestCharterSchema, type SurfaceTargetCheck, type SurfaceTargetExpectation } from "@proofkit/contracts";
import { ExecutionRunner, type SurfaceAdapter } from "./index.js";
import { EvidenceStore } from "@proofkit/evidence";

const roots: string[] = [];
const observedAt = "2026-10-19T00:00:00.000Z";
const expected: SurfaceTargetExpectation = { observedAt, tag: "button", role: "button", name: "Save", groupName: "" };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-run-target-check-")); roots.push(root);
  const snapshot = async () => ({ capturedAt: new Date().toISOString(), text: "Saved", metadata: {} });
  const check: SurfaceTargetCheck = { selector: "#save", observedAt, expected, actual: { tag: "button", role: "button", name: "Save", groupName: "" }, status: "matched", changedFields: [] };
  const adapter: SurfaceAdapter = { name: "fixture", supportsTargetExpectations: true, connect: vi.fn(async () => {}), snapshot, discover: snapshot,
    act: vi.fn(async (action, context) => {
      await context?.recordTargetCheck?.(check);
      return { actionId: "save", kind: action.kind, startedAt: observedAt, endedAt: observedAt, durationMs: 0, metadata: {} };
    }), assert: async (assertion) => ({ assertion, passed: true, message: "Saved", evidence: [] }), capture: async () => undefined,
    subscribeEvents: async () => () => {}, close: async () => {} };
  const charter = TestCharterSchema.parse({ intent: "Save draft", level: "quick", mode: "deterministic", sideEffectPolicy: "allow", actions: [
    { kind: "click", selector: "#save", expectedTarget: expected }], assertions: [{ kind: "text-visible", text: "Saved" }], surfaceObservation: { capturedAt: observedAt, controlsTruncated: false } });
  return { root, adapter, charter, check, runner: new ExecutionRunner(adapter, { evidenceDir: root }) };
}

describe("execution of observed target bindings", () => {
  it("does not replace the session used to observe a plan with a fresh browser", async () => {
    const state = await fixture();
    state.charter.surfaceObservation!.sessionId = "00000000-0000-4000-8000-000000000001";
    const summary = await state.runner.run(state.charter);
    expect(summary).toMatchObject({ verdict: "inconclusive", steps: [] });
    expect(state.adapter.connect).not.toHaveBeenCalled(); expect(state.adapter.act).not.toHaveBeenCalled();
  });

  it("saves a matched pre-action identity check with the same step as its result", async () => {
    const state = await fixture();
    const summary = await state.runner.run(state.charter);
    expect(summary.verdict).toBe("passed");
    expect(summary.steps[0]?.targetChecks).toEqual([state.check]);
    const artifact = summary.steps[0]!.artifacts.find((path) => path.endsWith("target-check.json"))!;
    expect(JSON.parse(await readFile(join(state.root, artifact), "utf8"))).toEqual(state.check);
    const markup = await readFile(join(state.root, summary.runId, "report.html"), "utf8");
    expect(markup).toContain("Target identity: matched");
    expect(markup).toContain("Checked before action");
    const store = new EvidenceStore(state.root);
    summary.steps[0]!.targetChecks![0]!.expected.name = "Changed summary name";
    const changedSummaryReport = await readFile(await store.writeReport(summary), "utf8");
    expect(changedSummaryReport).toContain("Target identity check unavailable or changed");
    expect(changedSummaryReport).not.toContain("Target identity: matched");
    summary.steps[0]!.targetChecks![0]!.expected.name = "Save";
    await writeFile(join(state.root, artifact), "changed target check");
    const changedArtifactReport = await readFile(await store.writeReport(summary), "utf8");
    expect(changedArtifactReport).toContain("Target identity check unavailable or changed");
    expect(changedArtifactReport).not.toContain("Target identity: matched");
  });

  it("stops an observed plan with unbound controls before setup or attachment", async () => {
    const state = await fixture();
    state.charter.actions = [{ kind: "click", selector: "#unseen" }];
    const setup = vi.fn(async () => undefined);
    const summary = await new ExecutionRunner(state.adapter, { evidenceDir: state.root, setup }).run(state.charter);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.steps).toEqual([]);
    expect(setup).not.toHaveBeenCalled();
    expect(state.adapter.connect).not.toHaveBeenCalled();
    expect(state.adapter.act).not.toHaveBeenCalled();
  });

  it("includes negative scenarios in the observation binding preflight", async () => {
    const state = await fixture();
    state.charter.negativeCases = [NegativeCaseSchema.parse({ caseId: "reject", title: "Reject invalid input", actions: [{ kind: "click", selector: "#unseen" }] })];
    const summary = await state.runner.run(state.charter);
    expect(summary.verdict).toBe("inconclusive");
    expect(state.adapter.connect).not.toHaveBeenCalled();
    expect(state.adapter.act).not.toHaveBeenCalled();
  });

  it("does not execute a guarded action on an adapter that lacks identity checking", async () => {
    const state = await fixture(); Object.assign(state.adapter, { supportsTargetExpectations: false });
    const summary = await state.runner.run(state.charter);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.steps[0]?.failureCode).toBe("surface-target-check-unsupported");
    expect(state.adapter.act).not.toHaveBeenCalled();
  });

  it.each(["omitted", "changed", "foreign", "forged-status"])("does not certify an adapter receipt with a %s check", async (mode) => {
    const state = await fixture();
    state.adapter.act = async (action, context) => {
      if (mode !== "omitted") {
        const check: SurfaceTargetCheck = mode === "foreign" ? { ...state.check, selector: "#other" }
          : { ...state.check, actual: { ...state.check.actual, name: "Delete" }, ...(mode === "changed" ? { status: "changed" as const, changedFields: ["name"] as const } : {}) };
        await context?.recordTargetCheck?.(check);
      }
      return { actionId: "save", kind: action.kind, startedAt: observedAt, endedAt: observedAt, durationMs: 0, metadata: {} };
    };
    const summary = await state.runner.run(state.charter);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.steps[0]?.status).toBe("failed");
    if (mode === "changed") expect(summary.steps[0]?.targetChecks?.[0]?.status).toBe("changed");
  });
});
