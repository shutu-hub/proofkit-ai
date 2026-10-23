import { describe, expect, it } from "vitest";
import { NegativeCaseSchema, TestCharterSchema, type SurfaceSnapshot } from "@proofkit/contracts";
import { assessPlanningQuality, StructuredPlanner } from "./core.js";
import { bindObservedSurfaceTargets } from "./surface-targets.js";

const observedAt = "2026-10-19T00:00:00.000Z";
const expected = { observedAt, tag: "button", role: "button", name: "Invented safe name", groupName: "" };
const snapshot: SurfaceSnapshot = { capturedAt: observedAt, url: "https://fixture.local/__redacted__", metadata: {}, controls: [
  { tag: "button", role: "button", name: "Save", selector: "#save", disabled: false },
  { tag: "input", role: "textbox", inputType: "email", name: "Account", groupName: "Contact", selector: "#account", disabled: false },
] };
const charter = () => TestCharterSchema.parse({ intent: "Save account", level: "quick", actions: [{ kind: "fill", selector: "#account", value: "reviewed" },
  { kind: "click", selector: "#save", expectedTarget: expected }], assertions: [{ kind: "text-visible", text: "Saved" }], sideEffectPolicy: "allow" });

describe("binding plans to observed control identities", () => {
  it("binds an independently verified alternate selector without dropping the original id", () => {
    const observed = { ...snapshot, controls: [{ ...snapshot.controls![0]!, alternateSelectors: ['role=button[name="Save"]'] }] };
    const source = charter(); source.actions = [{ kind: "click", selector: 'role=button[name="Save"]' }];
    const bound = bindObservedSurfaceTargets(source, observed);
    expect(bound.actions[0]).toHaveProperty("expectedTarget.name", "Save");
    expect(bindObservedSurfaceTargets(charter(), observed).actions[1]).toHaveProperty("expectedTarget.name", "Save");
    expect(assessPlanningQuality(source, { surfaceSnapshot: observed }).evidenceGaps).not.toContain("surface-selector");
    const duplicate = { ...observed, controls: [observed.controls![0]!, observed.controls![0]!] };
    expect(bindObservedSurfaceTargets(source, duplicate).actions[0]).not.toHaveProperty("expectedTarget");
  });

  it("binds the same selector to distinct independently observed states only when qualified", () => {
    const states = [{ observationId: "cart", snapshot }, { observationId: "checkout", snapshot: { ...snapshot, capturedAt: "2026-10-19T00:01:00.000Z",
      controls: [{ ...snapshot.controls![0]!, name: "Confirm" }] } }];
    const source = charter(); source.actions = [{ kind: "click", selector: "#save", observationId: "cart" }, { kind: "click", selector: "#save", observationId: "checkout" }];
    const bound = bindObservedSurfaceTargets(source, undefined, states);
    expect(bound.actions[0]).toHaveProperty("expectedTarget.name", "Save");
    expect(bound.actions[1]).toHaveProperty("expectedTarget.name", "Confirm");
    expect(bound.actions[1]).toHaveProperty("expectedTarget.observationId", "checkout");
    expect(assessPlanningQuality(source, { surfaceObservations: states }).evidenceGaps).not.toContain("surface-selector");
    source.actions = [{ kind: "click", selector: "#save" }];
    expect(bindObservedSurfaceTargets(source, undefined, states).actions[0]).not.toHaveProperty("expectedTarget");
    expect(assessPlanningQuality(source, { surfaceObservations: states }).evidenceGaps).toContain("surface-selector");
  });

  it("does not invent an observed state and keeps unique cross-state controls usable", () => {
    const states = [{ observationId: "cart", snapshot }, { observationId: "checkout", snapshot: { ...snapshot, controls: [] } }];
    const source = charter(); source.actions = [{ kind: "click", selector: "#save", observationId: "invented" }];
    expect(bindObservedSurfaceTargets(source, undefined, states).actions[0]).not.toHaveProperty("expectedTarget");
    expect(assessPlanningQuality(source, { surfaceObservations: states }).missingInputs.join(" ")).toContain("invented");
    source.actions = [{ kind: "click", selector: "#save" }];
    expect(bindObservedSurfaceTargets(source, undefined, states).actions[0]).toHaveProperty("expectedTarget.observationId", "cart");
  });

  it("recomputes the binding from the supplied observation instead of trusting provider-authored identity", () => {
    const bound = bindObservedSurfaceTargets(charter(), snapshot);
    expect(bound.surfaceObservation).toEqual({ capturedAt: observedAt, controlsTruncated: false });
    expect(bound.actions[0]).toMatchObject({ expectedTarget: { name: "Account", groupName: "Contact", inputType: "email", origin: "https://fixture.local" } });
    expect(bound.actions[1]).toMatchObject({ expectedTarget: { name: "Save", observedAt, origin: "https://fixture.local" } });
  });

  it("does not retain model-invented identity or observation provenance without an observation", () => {
    const unbound = bindObservedSurfaceTargets({ ...charter(), surfaceObservation: { capturedAt: observedAt, controlsTruncated: false } });
    expect(unbound.surfaceObservation).toBeUndefined();
    expect(unbound.actions[1]).not.toHaveProperty("expectedTarget");
  });

  it("leaves missing and duplicated observed selectors unbound with a planning gap", () => {
    const duplicated = { ...snapshot, controls: [snapshot.controls![0]!, snapshot.controls![0]!] };
    const bound = bindObservedSurfaceTargets(charter(), duplicated);
    expect(bound.actions.every((action) => !("expectedTarget" in action))).toBe(true);
    expect(assessPlanningQuality(bound, { surfaceSnapshot: duplicated }).evidenceGaps).toContain("surface-selector");
  });

  it("covers response triggers, optional follow-ups and declared negative branches", () => {
    const source = charter();
    source.actions = [{ kind: "captureResponse", name: "saved", trigger: { kind: "click", selector: "#save" },
      followUp: { kind: "clickIfVisible", selector: "#save", waitMs: 50 }, response: { url: "https://fixture.local/save", method: "POST", statuses: [200], fields: { id: { pointer: "/id", type: "id" } } },
      requestWindowMs: 50, timeoutMs: 1000 }];
    source.negativeCases = [NegativeCaseSchema.parse({ caseId: "reject", title: "Reject invalid input", actions: [{ kind: "click", selector: "#save" }] })];
    const bound = bindObservedSurfaceTargets(source, snapshot);
    expect(bound.actions[0]).toHaveProperty("trigger.expectedTarget.name", "Save");
    expect(bound.actions[0]).toHaveProperty("followUp.expectedTarget.name", "Save");
    expect(bound.negativeCases?.[0]?.actions[0]).toHaveProperty("expectedTarget.name", "Save");
    source.negativeCases![0]!.actions = [{ kind: "click", selector: "#unseen" }];
    expect(assessPlanningQuality(source, { surfaceSnapshot: snapshot }).evidenceGaps).toContain("surface-selector");
  });

  it("StructuredPlanner saves independent expectations and does not bind mutable native state", async () => {
    const planner = new StructuredPlanner({ name: "model-fixture", plan: async () => charter() });
    const projectMap = { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false },
      inventory: { filesScanned: 0, truncated: false, source: "filesystem" as const, sourceFiles: 0, testFiles: 0, configFiles: 0, testFrameworks: [], entryPoints: [], routeHints: [] }, generatedAt: observedAt };
    const bound = await planner.plan({ intent: "Save account", constraints: { level: "quick", sideEffectPolicy: "allow" }, projectMap,
      surfaceSnapshot: { ...snapshot, controlsTruncated: true } });
    expect(bound.surfaceObservation?.controlsTruncated).toBe(true);
    expect(bound.actions[1]).toHaveProperty("expectedTarget.name", "Save");
    expect(bound.actions[1]).not.toHaveProperty("expectedTarget.disabled");
    expect(bound.actions[1]).not.toHaveProperty("expectedTarget.value");
  });
});
