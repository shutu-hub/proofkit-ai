import { describe, expect, it } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { IntentPlanner } from "./core.js";
import { summarizePlanReview } from "./plan-review.js";

const reviewed = (changed: Record<string, unknown> = {}) => TestCharterSchema.parse({ intent: "Verify saved note", level: "core", actions: [{ kind: "observe" }],
  assertions: [{ kind: "text-visible", text: "Saved" }], oracles: ["current-note"], planning: { source: "submitted", evidenceGaps: [], missingInputs: [] }, ...changed });

describe("plan review summary", () => {
  it("returns the retained observation session as a continuation hint without asserting runtime readiness", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const review = summarizePlanReview(reviewed({ surfaceObservation: { capturedAt: "2026-10-21T00:00:00.000Z", controlsTruncated: false, sessionId } }));
    expect(review).toMatchObject({ sessionId, testVerdict: "not-asserted", executionStarted: false });
    expect(review.notEstablished).toContain("authentication");
  });
  it("labels a default navigation scaffold as missing input instead of executable or tested", () => {
    const charter = new IntentPlanner().plan("Create a note and verify persistence", { url: "http://127.0.0.1:3000" });
    const review = summarizePlanReview(charter);
    expect(review).toMatchObject({ scope: "plan-structure", status: "needs-input", testVerdict: "not-asserted", executionStarted: false,
      counts: { actions: 2, surfaceChecks: 0, independentChecks: 0 } });
    expect(review.next.map((item) => item.action)).toEqual(["author-workflow", "define-surface-outcome", "connect-business-check", "review-missing-inputs"]);
    expect(review.gaps).toEqual(expect.arrayContaining(["surface-assertion", "business-oracle"]));
  });

  it("keeps a structurally complete plan ready only for review, with runtime facts unchecked", () => {
    const charter = reviewed(); const before = structuredClone(charter);
    const review = summarizePlanReview(charter);
    expect(review).toMatchObject({ status: "ready-for-review", testVerdict: "not-asserted", executionStarted: false, gaps: [], missingInputs: [], next: [{ action: "review-plan" }] });
    expect(review.notEstablished).toEqual(["environment", "authentication", "test-data", "business-outcome", "requested-evidence", "intent-completeness"]);
    expect(charter).toEqual(before); expect(review).not.toHaveProperty("confidence");
  });

  it.each(["core", "release"])("does not trust claimed empty gaps over missing %s business checks", (level) => {
    const review = summarizePlanReview(reviewed({ level, oracles: [] }));
    expect(review.status).toBe("needs-input"); expect(review.gaps).toContain("business-oracle");
    if (level === "release") expect(review.gaps).toContain("negative-case");
  });

  it("allows an assessed positive UI-only quick plan without requiring business acceptance", () => {
    const review = summarizePlanReview(reviewed({ level: "quick", oracles: [] }));
    expect(review.status).toBe("ready-for-review"); expect(review.notEstablished).toContain("business-outcome");
    expect(review.counts.independentChecks).toBe(0);
  });

  it("does not accept an absence-only assertion as a positive page outcome", () => {
    const review = summarizePlanReview(reviewed({ assertions: [{ kind: "text-not-visible", text: "Error" }] }));
    expect(review.status).toBe("needs-input"); expect(review.gaps).toContain("surface-assertion");
  });

  it("keeps legacy unassessed plans and unknown planning gaps explicit", () => {
    expect(summarizePlanReview(reviewed({ planning: undefined }))).toMatchObject({ status: "needs-input", plannerSource: "unassessed", gaps: ["planning-unassessed"] });
    const review = summarizePlanReview(reviewed({ planning: { source: "model", confidence: 1, evidenceGaps: ["new-gap"], missingInputs: [] } }));
    expect(review.status).toBe("needs-input"); expect(review.gaps).toContain("new-gap");
    expect(review.next).toContainEqual(expect.objectContaining({ action: "review-missing-inputs" }));
  });

  it("preserves missing-input-only blockers and whole-project requirements", () => {
    const review = summarizePlanReview(reviewed({ planning: { source: "submitted", missingInputs: ["Approved target origin"], evidenceGaps: ["project-workflow-coverage"] } }));
    expect(review.status).toBe("needs-input"); expect(review.missingInputs).toContain("Approved target origin");
    expect(review.next.map((item) => item.action)).toContain("review-project-scope");
  });

  it("requires an unbound observed interaction to be reobserved", () => {
    const review = summarizePlanReview(reviewed({ actions: [{ kind: "click", selector: "#save" }],
      surfaceObservation: { capturedAt: "2026-10-21T00:00:00.000Z", controlsTruncated: false } }));
    expect(review.gaps).toContain("surface-selector"); expect(review.next.map((item) => item.action)).toContain("observe-target");
  });
});
