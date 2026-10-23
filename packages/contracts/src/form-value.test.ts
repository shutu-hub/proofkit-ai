import { describe, expect, it } from "vitest";
import { ActionSchema, FieldValueObservationSchema, PlanningObservationRequestSchema, actionSurfaceTargets } from "./index.js";

describe("bounded observed field-value checks", () => {
  it("keeps a field checkpoint target-bound and supports runtime-only environment values", () => {
    const action = ActionSchema.parse({ kind: "waitForValue", selector: "#street", value: { env: "PROOFKIT_EXPECTED_STREET" } });
    expect(action).toMatchObject({ stableForMs: 750, timeoutMs: 5000 });
    expect(actionSurfaceTargets(action)).toHaveLength(1);
  });
  it.each([{ timeoutMs: 30_001 }, { stableForMs: 5001 }, { stableForMs: 0 }, { selector: "x".repeat(513) }, { value: "x".repeat(4097) }])("rejects oversized checks %j", (override) => {
    expect(ActionSchema.safeParse({ kind: "waitForValue", selector: "#street", value: "expected", ...override }).success).toBe(false);
  });
  it("keeps exploratory value proposals literal rather than requesting environment secrets", () => {
    const request = { status: "needs-observation", reason: "Wait for address initialization", expectedObservation: "Expected field value is stable", action: {
      kind: "waitForValue", selector: "#street", value: "Reviewed synthetic street", stableForMs: 250, timeoutMs: 2000 } };
    expect(PlanningObservationRequestSchema.safeParse(request).success).toBe(true);
    expect(PlanningObservationRequestSchema.safeParse({ ...request, action: { ...request.action, value: { env: "SECRET" } } }).success).toBe(false);
  });
  it("accepts only bounded, value-free sampled observations", () => {
    const observed = { matched: true, stableForMs: 400, polls: 9, observedForMs: 500, actualValueRetained: false,
      scope: "sampled-native-control-value", businessAcceptance: false };
    expect(FieldValueObservationSchema.safeParse(observed).success).toBe(true);
    for (const override of [{ polls: 1 }, { polls: 2 }, { actualValueRetained: true }, { businessAcceptance: true }, { actualValue: "secret" }, { stableForMs: 700 }]) {
      expect(FieldValueObservationSchema.safeParse({ ...observed, ...override }).success).toBe(false);
    }
  });
});
