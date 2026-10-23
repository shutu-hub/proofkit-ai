import { describe, expect, it } from "vitest";
import { PlanningObservationRequestSchema, type ProjectMap, type SurfaceSnapshot } from "@proofkit/contracts";
import { PlanningObservationRequestError, StructuredPlanner, type PlannerInput } from "./core.js";

const snapshot: SurfaceSnapshot = { capturedAt: "2026-10-19T00:00:00.000Z", url: "http://fixture.local/cart", metadata: {},
  controls: [{ tag: "button", role: "button", name: "Open checkout", selector: "#next", disabled: false }] };
const projectMap: ProjectMap = { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false },
  inventory: { filesScanned: 0, truncated: false, source: "filesystem", sourceFiles: 0, testFiles: 0, configFiles: 0, testFrameworks: [], entryPoints: [], routeHints: [] }, generatedAt: snapshot.capturedAt };
const input: PlannerInput = { intent: "Place order", projectMap, surfaceObservations: [{ observationId: "cart", snapshot }],
  constraints: { url: "http://fixture.local/cart", requireAssertions: true, expect: ["Order submitted"], sideEffectPolicy: "allow", allowedActionKinds: ["click", "goto", "observe"] } };
const request = { status: "needs-observation", reason: "Checkout controls have not been observed", expectedObservation: "Observe checkout before planning confirmation",
  action: { kind: "click", selector: "#next", observationId: "cart" } };
const planner = (output: unknown) => new StructuredPlanner({ name: "model", plan: async () => output });

describe("incremental planning observations", () => {
  it("requires an observed eligible page for a proposed switch", async () => {
    const proposal = { ...request, action: { kind: "switchPage", title: "Review" } };
    await expect(planner(proposal).plan({ ...input, constraints: { ...input.constraints, allowedActionKinds: ["switchPage"] } })).rejects.toThrow("observed unique same-origin page");
    const observed = { ...input, surfaceObservations: [{ observationId: "cart", snapshot: { ...snapshot, pages: [
      { title: "Review", url: "http://fixture.local/__redacted__", active: false, eligibleForSwitch: true }] } }],
      constraints: { ...input.constraints, allowedActionKinds: ["switchPage"] } };
    const failure = await planner(proposal).plan(observed).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanningObservationRequestError);
  });

  it("returns an independently bound single-step proposal instead of an executable Charter", async () => {
    const forged = { observedAt: snapshot.capturedAt, tag: "button", role: "button", name: "Delete", groupName: "" };
    const error = await planner({ ...request, action: { ...request.action, expectedTarget: forged } }).plan(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PlanningObservationRequestError);
    expect((error as PlanningObservationRequestError).request.action).toMatchObject({ kind: "click", observationId: "cart", expectedTarget: { name: "Open checkout", observationId: "cart", origin: "http://fixture.local" } });
  });

  it.each([{ selector: "#invented" }, { observationId: "unknown" }])("rejects an unobserved proposal %j", async (changed) => {
    await expect(planner({ ...request, action: { ...request.action, ...changed } }).plan(input)).rejects.toThrow("uniquely observed");
  });

  it.each(["https://foreign.local/checkout", "http://user:password@fixture.local/checkout"])("rejects unapproved navigation %s", async (url) => {
    await expect(planner({ ...request, action: { kind: "goto", url } }).plan(input)).rejects.toThrow("approved origin");
  });

  it("honors the declared action allowlist and requires a source for selector proposals", async () => {
    await expect(planner(request).plan({ ...input, constraints: { ...input.constraints, allowedActionKinds: ["observe"] } })).rejects.toThrow("allowed action kinds");
    await expect(planner(request).plan({ ...input, surfaceObservations: undefined })).rejects.toThrow("uniquely observed");
  });

  it("bounds request prose, action size and the proposal to existing exploratory operations", () => {
    expect(PlanningObservationRequestSchema.safeParse(request).success).toBe(true);
    for (const changed of [{ reason: "x".repeat(1001) }, { actions: [request.action, request.action] },
      { action: { kind: "capability", name: "shell", input: {} } }, { action: { kind: "fill", selector: "#name", value: "x".repeat(8192) } },
      { action: { kind: "fill", selector: "#password", value: { env: "PRIVATE_KEY" } } }, { action: { kind: "waitForText", text: "Ready", timeoutMs: 30_001 } }]) {
      expect(PlanningObservationRequestSchema.safeParse({ ...request, ...changed }).success).toBe(false);
    }
  });

  it("does not let the final plan substitute a weaker or absence-only expected outcome", async () => {
    for (const assertion of [{ kind: "text-visible", text: "Checkout ready" }, { kind: "text-not-visible", text: "Order submitted" }]) {
      await expect(planner({ intent: input.intent, actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }, assertion] }).plan(input)).rejects.toThrow("requested visible outcome");
    }
    const charter = await planner({ intent: input.intent, sideEffectPolicy: "allow", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Order submitted" }] }).plan(input);
    expect(charter.assertions).toContainEqual({ kind: "text-visible", text: "Order submitted" });
  });
});
