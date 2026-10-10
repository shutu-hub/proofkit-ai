import { SourceStateSchema, WorkflowExecutionCoverageSchema, workflowChecks, type SourceState, type TestMission, type WorkflowExecutionCoverage } from "@proofkit/contracts";
import type { SuiteScopeSummary, SuiteSurfaceResult } from "./suite-verifier.js";

/** Count only verified suite slots for the exact saved Charter × surface obligations. */
export function summarizeWorkflowExecution(mission: TestMission, suiteScope?: SuiteScopeSummary): WorkflowExecutionCoverage | undefined {
  if (mission.plan.planning?.coverage?.requested !== "project" && !mission.workflowInventoryInspection) return undefined;
  const inventory = mission.workflowInventory;
  const inspection = mission.workflowInventoryInspection;
  const gaps: WorkflowExecutionCoverage["gaps"] = [];
  let requiredChecks = 0;
  let evidencedChecks = 0;
  let evidencedWorkflowCount = 0;
  for (const workflow of inventory?.workflows ?? []) {
    let workflowEvidenced = true;
    for (const check of workflowChecks(workflow)) {
      for (const surface of check.surfaces) {
        requiredChecks++;
        const result = suiteScope?.results.find((item) => item.charterId === check.charterId && item.surface === surface);
        if (result?.verdict === "passed") {
          evidencedChecks++;
          continue;
        }
        workflowEvidenced = false;
        gaps.push({
          workflowId: workflow.id,
          charterId: check.charterId,
          surface,
          reason: !suiteScope ? "no-suite" : !result || (!result.primary && !result.replay) ? "not-scheduled" : gapReason(result),
          ...(result?.primary?.runId ? { primaryRunId: result.primary.runId } : {}),
          ...(result?.replay?.runId ? { replayRunId: result.replay.runId } : {}),
        });
      }
    }
    if (workflowEvidenced) evidencedWorkflowCount++;
  }
  const sourceBinding = compareSourceBinding(mission);
  const limitations = [
    "The inventory's completeness and reviewer identity are not independently verified.",
    ...(!inventory ? ["No valid frozen workflow inventory is available for this Mission."] : []),
    ...(!suiteScope ? ["No verified multi-Charter suite result is available; single-Charter Runs cannot establish the declared project matrix."] : []),
    ...(sourceBinding !== "matching" ? ["The source fingerprint did not match at both the start and end of the Mission."] : []),
    ...(inspection?.exclusionCount ? ["The inventory has explicitly excluded workflows."] : []),
    ...(inspection?.issues.filter((item) => item !== "workflow-inventory-completeness-unverified") ?? []),
  ];
  return WorkflowExecutionCoverageSchema.parse({
    status: !inventory || !suiteScope ? "not-measured" : evidencedChecks === requiredChecks ? "all-declared-evidenced" : "partial",
    workflowCount: inventory?.workflows.length ?? 0,
    evidencedWorkflowCount,
    requiredChecks,
    evidencedChecks,
    sourceBinding,
    reviewDeclared: Boolean(inventory?.review),
    exclusionCount: inventory?.exclusions.length ?? 0,
    suiteId: suiteScope?.suiteId,
    gaps: gaps.slice(0, 40),
    omittedGaps: Math.max(0, gaps.length - 40),
    limitations: [...new Set(limitations)].slice(0, 8),
  });
}

function gapReason(result: SuiteSurfaceResult): WorkflowExecutionCoverage["gaps"][number]["reason"] {
  return result.verdict === "failed" ? "failed"
    : result.verdict === "blocked" ? "blocked"
      : result.verdict === "cancelled" ? "cancelled" : "inconclusive";
}

function compareSourceBinding(mission: TestMission): WorkflowExecutionCoverage["sourceBinding"] {
  const expected = mission.workflowInventory?.source;
  if (!expected) return "unverified";
  const source = sourceFor(mission, "project.source-state");
  const final = sourceFor(mission, "project.source-state-final");
  const matches = (value?: SourceState) => value?.complete && value.method === "git" && value.headSha === expected.headSha && value.worktreeSha256 === expected.worktreeSha256;
  if ((source?.complete && source.method === "git" && !matches(source))
    || (final?.complete && final.method === "git" && !matches(final))) return "changed";
  return matches(source) && matches(final) ? "matching" : "unverified";
}

function sourceFor(mission: TestMission, kind: string): SourceState | undefined {
  const observed = [...mission.observations].reverse().find((item) => item.kind === kind);
  const parsed = SourceStateSchema.safeParse(observed?.data);
  return parsed.success ? parsed.data : undefined;
}
