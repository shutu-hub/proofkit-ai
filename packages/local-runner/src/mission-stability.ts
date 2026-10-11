import { MissionStabilityAnalysisSchema, type MissionResult, type MissionRunResult, type MissionStabilityAnalysis, type RunSummary, type SourceState, type TargetBinding, type TargetContinuity, type TestMission } from "@proofkit/contracts";
import { sameProjectPath } from "@proofkit/project";
import { sameInputFileFacts } from "@proofkit/runner";
import { missionScopeHash } from "./mission-comparison.js";

type Sample = {
  mission: TestMission;
  result: MissionResult;
  sourceState?: SourceState;
  finalSourceState?: SourceState;
};

/** Re-audit an explicitly selected replay chain; do not infer flakiness or repair causality from a verdict change. */
export async function analyzeMissionStability(samples: Sample[], loadRun: (runId: string) => Promise<RunSummary>): Promise<MissionStabilityAnalysis> {
  if (samples.length < 3 || samples.length > 5) throw new Error("Stability analysis requires 3 to 5 ordered Missions");
  const ids = samples.map(({ mission }) => mission.missionId);
  if (new Set(ids).size !== ids.length) throw new Error("Stability analysis requires distinct Missions");
  const firstScope = missionScopeHash(samples[0]!.mission);
  const firstSource = samples[0]!.sourceState;
  const gaps: string[] = [];
  const targetOrigins = new Map<string, string>();
  const fileInputs = new Map<string, NonNullable<RunSummary["steps"][number]["inputFiles"]>>();
  const seenRunIds = new Set<string>();
  let expectedRuns: number | undefined;
  let expectedSlots: string[] | undefined;

  for (const [index, { mission, result, sourceState, finalSourceState }] of samples.entries()) {
    const label = mission.missionId;
    if (index > 0 && mission.replayOfMissionId !== ids[index - 1]) gaps.push(`${label}: not a direct replay of the preceding Mission`);
    if (missionScopeHash(mission) !== firstScope) gaps.push(`${label}: saved test scope differs`);
    if (result.missionId !== label) gaps.push(`${label}: result belongs to another Mission`);
    if (mission.verdict !== result.testVerdict) gaps.push(`${label}: saved and current verdicts differ`);
    if (mission.level === "quick") gaps.push(`${label}: quick level has no required independent business proof`);
    if (result.testVerdict !== "passed" && result.testVerdict !== "failed") gaps.push(`${label}: current test verdict is not evidenced as pass or failure`);
    if (result.executionAudit?.status !== "complete" || result.agentTraceAudit?.status !== "complete"
      || result.acceptanceEvidenceIntegrity?.status !== "intact") gaps.push(`${label}: execution, trace or evidence audit is incomplete`);
    if (result.expectedRuns === 0 || result.omittedRunResults || result.observedRuns !== result.expectedRuns || result.runs.length !== result.expectedRuns
      || result.runs.some((run) => !run.runId || run.issue && !expectedProductRunFailure(run)
        || !run.evidence.some((ref) => ref.sha256 && ref.evidenceId.startsWith(`${run.runId}:`)))) {
      gaps.push(`${label}: the complete declared Run matrix lacks owned hashed evidence`);
    }
    if (expectedRuns !== undefined && result.expectedRuns !== expectedRuns) gaps.push(`${label}: declared Run count differs`);
    expectedRuns = result.expectedRuns;
    const slots = result.runs.map((run) => JSON.stringify([run.charterId ?? null, run.surface ?? null, run.runKind, run.negativeCaseId ?? null])).sort();
    if (new Set(slots).size !== slots.length) gaps.push(`${label}: duplicate Run slot in the sample`);
    if (expectedSlots && JSON.stringify(slots) !== JSON.stringify(expectedSlots)) gaps.push(`${label}: observed Run matrix differs`);
    expectedSlots ??= slots;
    const proof = result.proofClassification;
    if (result.testVerdict === "passed" && (proof?.status !== "explicit" || !proof.requiredBusinessRuns
      || proof.requiredRunsWithPassingBusiness !== proof.requiredBusinessRuns)) gaps.push(`${label}: passing business proof is incomplete`);
    if (result.testVerdict === "failed" && (proof?.status !== "explicit" || !result.confirmedProductFindings
      || proof.findingsLinkedToFailingBusiness !== result.confirmedProductFindings)) gaps.push(`${label}: failure lacks a confirmed business fact`);
    if (result.scope.sourceStability !== "stable" || result.scope.sourceFreshness !== "matching"
      || !completeGitSource(sourceState) || !completeGitSource(finalSourceState)
      || sourceState.headSha !== finalSourceState.headSha || sourceState.worktreeSha256 !== finalSourceState.worktreeSha256
      || !completeGitSource(firstSource) || sourceState.headSha !== firstSource.headSha
      || sourceState.worktreeSha256 !== firstSource.worktreeSha256) gaps.push(`${label}: a matching, stable Git source was not established`);

    for (const run of result.runs) {
      if (!run.runId) continue;
      if (seenRunIds.has(run.runId)) gaps.push(`${label}: Run ${run.runId} was reused across samples`);
      seenRunIds.add(run.runId);
      const slot = JSON.stringify([run.charterId ?? null, run.surface ?? null, run.runKind, run.negativeCaseId ?? null]);
      if (!hasStableOwnedBinding(run.targetBinding, run.targetBindingAfterRun, run.targetContinuity)
        || run.surface === "electron" && !hasStableOwnedBinding(run.applicationBinding, run.applicationBindingAfterRun, run.applicationContinuity)
        || run.surface !== "electron" && (run.applicationContinuity === "changed" || run.applicationContinuity === "unverified")
        || run.integrationPostRunCheck?.passed === false
        || run.integrationCleanup && !["verified", "not-required"].includes(run.integrationCleanup.status)) {
        gaps.push(`${label}: ${slot} has an environment or cleanup continuity gap`);
      }
      const origin = run.targetBinding?.targetOrigin;
      if (!origin || !run.targetBinding?.processId || run.targetBinding.status !== "matching-process-path") gaps.push(`${label}: ${slot} target ownership is unverified`);
      else if (targetOrigins.has(slot) && targetOrigins.get(slot) !== origin) gaps.push(`${label}: ${slot} target origin changed`);
      else targetOrigins.set(slot, origin);
      if (run.surface === "electron" && (run.applicationBinding?.status !== "matching-process-path" || !run.applicationBinding.processId)) {
        gaps.push(`${label}: ${slot} Electron application ownership is unverified`);
      }
      const charter = mission.suite?.charters.find((item) => item.charterId === run.charterId)?.charter ?? mission.charter;
      const scenarioActions = run.runKind === "negative"
        ? charter?.negativeCases?.find((item) => item.caseId === run.negativeCaseId)?.actions : charter?.actions;
      if (!scenarioActions?.some((action) => action.kind === "setInputFiles")) continue;
      let saved: RunSummary;
      try { saved = await loadRun(run.runId); }
      catch { gaps.push(`${label}: ${slot} input file Run is unavailable`); continue; }
      if (saved.runId !== run.runId) { gaps.push(`${label}: ${slot} input file Run identity differs`); continue; }
      for (const [step, action] of scenarioActions.entries()) {
        if (action.kind !== "setInputFiles") continue;
        const facts = saved.steps.find((item) => item.stepId === `step-${String(step + 1).padStart(3, "0")}`)?.inputFiles;
        const key = `${slot}\0${step}`;
        if (!facts?.length) gaps.push(`${label}: ${slot} input file facts are missing`);
        else if (fileInputs.has(key) && !sameInputFileFacts(fileInputs.get(key)!, facts)) gaps.push(`${label}: ${slot} input file bytes differ`);
        else fileInputs.set(key, facts);
      }
    }
  }
  const passes = samples.filter(({ result }) => result.testVerdict === "passed").length;
  const failures = samples.filter(({ result }) => result.testVerdict === "failed").length;
  const status: MissionStabilityAnalysis["status"] = gaps.length ? "inconclusive"
    : passes && failures ? "variable-outcome" : passes ? "uniform-pass" : "uniform-failure";
  return MissionStabilityAnalysisSchema.parse({
    status, missionIds: ids, scopeHash: firstScope,
    ...(completeGitSource(firstSource) ? { sourceHeadSha: firstSource.headSha, sourceWorktreeSha256: firstSource.worktreeSha256 } : {}),
    passes, failures,
    samples: samples.map(({ mission, result }) => ({
      missionId: mission.missionId, replayOfMissionId: mission.replayOfMissionId,
      testVerdict: result.testVerdict ?? "not-asserted", expectedRuns: result.expectedRuns, observedRuns: result.observedRuns,
      evidence: (result.testVerdict === "failed" ? result.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed")
        .flatMap((finding) => finding.evidence.filter((ref) => ref.kind === "business"))
        : result.runs.flatMap((run) => run.evidence.filter((ref) => ref.kind === "business"))).slice(0, 4),
    })),
    gaps: [...new Set(gaps)].slice(0, 20), omittedGaps: Math.max(0, new Set(gaps).size - 20), checkedAt: new Date().toISOString(),
  });
}

function completeGitSource(state: SourceState | undefined): state is SourceState & { method: "git"; headSha: string; worktreeSha256: string } {
  return state?.complete === true && state.method === "git" && Boolean(state.headSha && state.worktreeSha256);
}

/** Mission task errors also carry the expected failure message for an Oracle-proven product defect. */
export function expectedProductRunFailure(run: MissionRunResult): boolean {
  return run.issue === "Tool returned verdict failed" && run.verdict === "failed"
    && (run.businessFacts ?? 0) > 0 && (run.oracles?.total ?? 0) > (run.oracles?.passed ?? 0)
    && run.evidence.some((ref) => ref.kind === "business" && Boolean(ref.sha256));
}

/** A saved "stable" label alone cannot replace the two matching process observations. */
export function hasStableOwnedBinding(before: TargetBinding | undefined, after: TargetBinding | undefined,
  continuity: TargetContinuity | undefined): boolean {
  return continuity === "stable" && before?.status === "matching-process-path" && after?.status === "matching-process-path"
    && Boolean(before.processId && after.processId && before.targetOrigin && after.targetOrigin
      && before.observedProjectRoot && after.observedProjectRoot)
    && before.processId === after.processId && before.targetOrigin === after.targetOrigin
    && sameProjectPath(before.expectedProjectRoot, after.expectedProjectRoot)
    && sameProjectPath(before.observedProjectRoot!, after.observedProjectRoot!)
    && sameProjectPath(before.expectedProjectRoot, before.observedProjectRoot!);
}
