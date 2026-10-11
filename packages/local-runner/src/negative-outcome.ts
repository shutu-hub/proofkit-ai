import type { RunSummary, Verdict } from "@proofkit/contracts";

/** A negative scenario can certify an observed product outcome, never an observation gap. */
export function negativeOutcomeProofGap(
  expected: Verdict,
  run: Pick<RunSummary, "targetContinuity" | "applicationContinuity" | "integrationPostRunCheck">,
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
}
