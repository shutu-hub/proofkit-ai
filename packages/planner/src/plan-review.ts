import { actionSurfaceTargets, hasPositiveSurfaceAssertion, PlanReviewSchema, TestCharterSchema, type PlanReview, type TestCharter } from "@proofkit/contracts";
import { getTestLevelProfile } from "./test-levels.js";

export function summarizePlanReview(input: TestCharter): PlanReview {
  const charter = TestCharterSchema.parse(input);
  const gaps = new Set(charter.planning?.evidenceGaps ?? []);
  const missing = new Set(charter.planning?.missingInputs ?? []);
  const profile = getTestLevelProfile(charter.level);
  if (!charter.planning) { gaps.add("planning-unassessed"); missing.add("Plan quality has not been assessed by the planning path."); }
  if (!hasPositiveSurfaceAssertion(charter.assertions)) { gaps.add("surface-assertion"); missing.add("Define at least one positive observable page outcome."); }
  if (profile.evidencePolicy.requireBusinessOracle && !charter.oracles?.length) { gaps.add("business-oracle"); missing.add("Connect an independent check for the requested business outcome."); }
  if (charter.level === "release" && !charter.negativeCases?.length) { gaps.add("negative-case"); missing.add("Define the required negative or recovery scenario."); }
  const actions = [...charter.actions, ...(charter.negativeCases ?? []).flatMap((item) => item.actions)];
  if (charter.surfaceObservation && actions.flatMap(actionSurfaceTargets).some((target) => !target.expectedTarget)) {
    gaps.add("surface-selector"); missing.add("Observe and uniquely bind each planned interaction target.");
  }
  const navigationOnly = charter.actions.every((action) => action.kind === "goto" || action.kind === "observe") && !charter.negativeCases?.length;
  const next: PlanReview["next"] = [];
  const add = (action: PlanReview["next"][number]["action"], reason: string) => { if (!next.some((item) => item.action === action)) next.push({ action, reason }); };
  if (charter.planning?.source === "deterministic" && navigationOnly && gaps.has("surface-assertion")) {
    add("author-workflow", "The default planner supplies a navigation/observation scaffold. Have the host author the actual workflow from observations, or explicitly configure a model planner.");
  }
  if (gaps.has("surface-assertion")) add("define-surface-outcome", "Specify what should be visible or otherwise observable after the requested flow, rather than only opening a page.");
  if (gaps.has("business-oracle")) add("connect-business-check", "Provide a reviewed independent reader for the required outcome. UI messages and successful requests alone do not verify stored business state.");
  if (gaps.has("surface-selector") || gaps.has("surface-page")) add("observe-target", "Collect the missing current page or window observation and bind controls before reviewing a replacement plan.");
  if (gaps.has("negative-case")) add("define-negative-scenario", "Declare the expected safe rejection or recovery result and the checks that will prove it.");
  if (gaps.has("project-workflow-coverage") || gaps.has("project-map-truncated")) add("review-project-scope", "Retain the original requested scope and review its workflow inventory and coverage gaps.");
  const needsInput = gaps.size > 0 || missing.size > 0;
  if (needsInput) add("review-missing-inputs", "Resolve the reported plan requirements and inspect the next draft. Planning has not started product execution.");
  else add("review-plan", "Review the declared steps, expected outcomes and allowed writes, then check the environment and connector prerequisites before execution.");
  return PlanReviewSchema.parse({ schemaVersion: "1", scope: "plan-structure", status: needsInput ? "needs-input" : "ready-for-review",
    ...(charter.surfaceObservation?.sessionId ? { sessionId: charter.surfaceObservation.sessionId } : {}),
    testVerdict: "not-asserted", executionStarted: false, level: charter.level, plannerSource: charter.planning?.source ?? "unassessed",
    reason: needsInput ? "A draft was generated, but required planning information is missing. No product result has been asserted."
      : "The declared plan has no reported structural gaps and is ready for review. Runtime readiness and business correctness are not established.",
    counts: { actions: charter.actions.length, surfaceChecks: charter.assertions.length, independentChecks: charter.oracles?.length ?? 0, negativeScenarios: charter.negativeCases?.length ?? 0 },
    gaps: [...gaps], missingInputs: [...missing], next,
    notEstablished: ["environment", "authentication", "test-data", "business-outcome", "requested-evidence", "intent-completeness"] });
}
