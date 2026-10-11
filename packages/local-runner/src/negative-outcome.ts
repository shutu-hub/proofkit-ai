import { isDeepStrictEqual } from "node:util";
import { selectEvidencedBusinessFailure } from "@proofkit/agent";
import type { EvidenceRef, RunSummary, Verdict } from "@proofkit/contracts";

/** A negative scenario can certify an observed product outcome, never an observation gap. */
export function negativeOutcomeProofGap(
  expected: Verdict,
  run: RunSummary,
  evidence: EvidenceRef[],
): string | undefined {
  if (expected !== "passed" && expected !== "failed") {
    return `Expected ${expected} is an environment or evidence state, not a certifiable negative outcome.`;
  }
  if (run.targetContinuity === "changed" || run.targetContinuity === "unverified") {
    return "The target listener changed or its continuity was unverified during the negative Run.";
  }
  if (run.applicationContinuity === "changed" || run.applicationContinuity === "unverified") {
    return "The Electron application listener changed or its continuity was unverified during the negative Run.";
  }
  if (run.integrationPostRunCheck?.passed === false) {
    return "The integration endpoint continuity check failed after the negative Run.";
  }
  if (expected !== "failed") return;
  if (run.steps.length !== run.charter.actions.length || run.steps.some((step, index) =>
    step.status !== "passed" || step.stepId !== `step-${String(index + 1).padStart(3, "0")}`
    || !isDeepStrictEqual(step.action, run.charter.actions[index]))) {
    return "The negative Run did not complete its declared actions in order; an action error is not a business rejection.";
  }
  if (run.assertions.length !== run.charter.assertions.length
    || run.assertions.some((assertion, index) => !assertion.passed || !assertion.evidence.some((path) => evidence.some((item) =>
      item.evidenceId === `${run.runId}:${path}` && Boolean(item.sha256)
      && (item.kind === "snapshot" || item.kind === "screenshot")))
      || !isDeepStrictEqual(assertion.assertion, run.charter.assertions[index]))) {
    return "A declared negative-case surface assertion failed or lacks contemporaneous evidence.";
  }
  const declaredOracles = run.charter.oracles ?? [];
  if (run.oracles.length !== declaredOracles.length
    || run.oracles.some((oracle, index) => oracle.name !== declaredOracles[index] || oracle.passed === null)) {
    return "The negative Run did not complete its declared business Oracles.";
  }
  const failure = selectEvidencedBusinessFailure(run, evidence);
  if (!failure || failure.verificationKind !== "business") {
    return "Expected failure needs a declared failing business Oracle with preserved independent source evidence.";
  }
}
