import { relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MissionExecutionAuditSchema, TargetBindingSchema, TestCharterSchema, suiteChecks, type MissionExecutionAudit, type Observation, type RunSummary, type TargetBinding, type TestCharter, type TestMission } from "@proofkit/contracts";
import { sameProjectPath } from "@proofkit/project";

type Surface = "web" | "electron" | "mobile" | "api";
type Slot = { charterId?: string; surface: Surface; kind: "primary" | "replay" | "negative"; negativeCaseId?: string; expectedVerdict?: string };
const RUN_ID = /^[a-zA-Z0-9_-]+$/;
const TOOL: Record<Slot["kind"], string> = {
  primary: "surface.run-charter", replay: "surface.replay-charter", negative: "surface.run-negative-charter",
};

/** Audit every declared execution slot, including entries omitted from the compact report. */
export function auditMissionExecution(mission: TestMission, evidenceDir: string, requirePass = true): MissionExecutionAudit {
  const issues: string[] = [];
  let omittedIssues = 0;
  const issue = (message: string) => {
    if (issues.length < 20) issues.push(message);
    else omittedIssues++;
  };
  const profile = mission.plan.executionProfile;
  if (mission.plan.level !== mission.level || mission.policy.level !== mission.level
    || mission.charter && mission.charter.level !== mission.level
    || mission.suite && mission.suite.level !== mission.level) issue("Saved Mission, plan, policy and Charter levels disagree.");
  if (requirePass && mission.status !== "completed") issue("A passing Mission must have completed its task graph.");
  if (requirePass) {
    for (const terminalId of mission.plan.graph.terminalTaskIds) {
      if (mission.plan.graph.tasks.find((task) => task.taskId === terminalId)?.status !== "passed") {
        issue(`Terminal task ${terminalId} did not pass.`);
      }
    }
  }
  const checks = mission.suite
    ? suiteChecks(mission.suite)
    : mission.charter ? expectedSingleSurfaces(mission).map((surface) => ({
      charterId: typeof mission.charter!.metadata.catalogId === "string" ? mission.charter!.metadata.catalogId : undefined,
      charter: mission.charter!, surface,
    })) : [];
  if (checks.length === 0) issue("No declared Charter and surface checks are available.");
  const declaredSurfaces = [...new Set(checks.map((check) => check.surface))];
  if (!sameSet(profile.surfaceMatrix, declaredSurfaces)) issue("The saved execution surface matrix differs from the declared Charter scope.");
  if (profile.requireReplay !== (mission.level === "release")) issue("The saved replay policy differs from the test level.");
  if (profile.requireBusinessOracle !== (mission.level !== "quick")) issue("The saved business proof policy differs from the test level.");
  const slots: Slot[] = checks.flatMap(({ charterId, charter, surface }) => [
    { charterId, surface, kind: "primary" as const },
    ...(mission.level === "release" ? [{ charterId, surface, kind: "replay" as const }] : []),
    ...(charter.negativeCases ?? []).map((negative) => ({ charterId, surface, kind: "negative" as const,
      negativeCaseId: negative.caseId, expectedVerdict: negative.expectedVerdict ?? "passed" })),
  ]);
  if (profile.requireNegativeCases !== slots.some((slot) => slot.kind === "negative")) {
    issue("The saved negative-case policy differs from the declared Charter cases.");
  }
  const observations = mission.observations.filter((item) => item.kind === "surface.run");
  const observationIds = new Set<string>();
  for (const observation of observations) {
    if (observationIds.has(observation.observationId)) issue("Run observation IDs are duplicated.");
    observationIds.add(observation.observationId);
  }
  const usedObservations = new Set<Observation>();
  const usedTasks = new Set<string>();
  const runOwners = new Map<string, string>();
  const primaryRuns = new Map<string, string>();
  const replayRuns: Array<{ slot: Slot; observation: Observation }> = [];
  let matchedSlots = 0;
  for (const slot of slots) {
    const label = slotLabel(slot);
    const tasks = mission.plan.graph.tasks.filter((task) => task.tool === TOOL[slot.kind]
      && task.input.adapter === slot.surface
      && (!mission.suite || task.charterId === slot.charterId && task.input.charterId === slot.charterId)
      && (slot.kind !== "negative" || caseId(task.input.negativeCase) === slot.negativeCaseId));
    if (tasks.length !== 1) issue(`${label}: expected one execution task, found ${tasks.length}.`);
    const task = tasks.length === 1 ? tasks[0] : undefined;
    if (task) {
      usedTasks.add(task.taskId);
      if (requirePass && task.status !== "passed") issue(`${label}: execution task did not pass.`);
    }
    const matching = observations.filter((item) => item.data.surface === slot.surface
      && (item.data.runKind ?? "primary") === slot.kind
      && item.charterId === slot.charterId
      && (slot.kind !== "negative" || item.data.negativeCaseId === slot.negativeCaseId));
    if (matching.length !== 1) {
      issue(`${label}: expected one Run observation, found ${matching.length}.`);
      continue;
    }
    const observation = matching[0]!;
    usedObservations.add(observation);
    matchedSlots++;
    const runId = observation.data.runId;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) {
      issue(`${label}: Run ID is missing or invalid.`);
      continue;
    }
    const previous = runOwners.get(runId);
    if (previous) issue(`${label}: Run ID is already used by ${previous}.`);
    else runOwners.set(runId, label);
    if (observation.evidence.length === 0) issue(`${label}: no Run evidence was saved.`);
    for (const ref of observation.evidence) {
      const path = relative(evidenceDir, ref.path).replaceAll("\\", "/");
      if (!path.startsWith(`${runId}/`) || ref.evidenceId !== `${runId}:${path}`) {
        issue(`${label}: cited evidence does not belong to its Run.`);
      }
    }
    if (observation.data.charterId !== slot.charterId) issue(`${label}: observation Charter identity differs from its slot.`);
    if (slot.kind !== "negative" && observation.data.negativeCaseId !== undefined) issue(`${label}: unexpected negative-case identity.`);
    if (task && task.output && typeof task.output === "object" && !Array.isArray(task.output)
      && "runId" in task.output && task.output.runId !== runId) issue(`${label}: task receipt refers to another Run.`);
    if (slot.kind === "primary") primaryRuns.set(pairKey(slot), runId);
    if (slot.kind === "replay") replayRuns.push({ slot, observation });
    if (slot.kind === "negative") {
      if (observation.data.expectedVerdict !== slot.expectedVerdict || observation.data.outcomeMatched !== true
        || observation.data.verdict !== slot.expectedVerdict) issue(`${label}: negative outcome does not match its declared expectation.`);
    } else if (requirePass && observation.data.verdict !== "passed") {
      issue(`${label}: saved Run verdict is not passed.`);
    }
  }
  for (const { slot, observation } of replayRuns) {
    const primary = primaryRuns.get(pairKey(slot));
    if (!primary || observation.data.sourceRunId !== primary || observation.data.runId === primary) {
      issue(`${slotLabel(slot)}: replay source does not match its primary Run.`);
    }
  }
  const unexpectedObservations = observations.length - usedObservations.size;
  if (unexpectedObservations > 0) issue(`${unexpectedObservations} Run observation(s) are duplicated or outside the declared execution slots.`);
  const extraTasks = mission.plan.graph.tasks.filter((task) => Object.values(TOOL).includes(task.tool) && !usedTasks.has(task.taskId)).length;
  if (extraTasks > 0) issue(`${extraTasks} surface task(s) are outside the declared execution slots.`);
  return MissionExecutionAuditSchema.parse({
    status: issues.length || omittedIssues ? "incomplete" : "complete",
    expectedSlots: slots.length, matchedSlots, unexpectedObservations, issues, omittedIssues,
  });
}

/** Reopen the saved Run facts; a Mission observation cannot substitute another adapter or Charter. */
export async function auditMissionRunFacts(
  mission: TestMission,
  previous: MissionExecutionAudit,
  loadRun: (runId: string) => Promise<RunSummary>,
): Promise<MissionExecutionAudit> {
  const issues = [...previous.issues];
  let omittedIssues = previous.omittedIssues;
  const issue = (message: string) => {
    if (issues.length < 20) issues.push(message);
    else omittedIssues++;
  };
  const observations = mission.observations.filter((item) => item.kind === "surface.run");
  const MAX_RUNS = 256;
  if (observations.length > MAX_RUNS) issue(`${observations.length - MAX_RUNS} Run observation(s) exceed the saved-fact audit limit.`);
  for (const observation of observations.slice(0, MAX_RUNS)) {
    const runId = observation.data.runId;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) continue;
    const surface = ["web", "electron", "mobile", "api"].includes(String(observation.data.surface)) ? observation.data.surface : "unknown";
    const kind = ["primary", "replay", "negative"].includes(String(observation.data.runKind)) ? observation.data.runKind : "unknown";
    const label = `${surface}/${kind}`;
    let run: RunSummary;
    try { run = await loadRun(runId); }
    catch { issue(`${label}: saved Run summary is unavailable or belongs to another project/workspace.`); continue; }
    if (run.runId !== runId || run.status !== "completed") issue(`${label}: saved Run identity or completion state does not match.`);
    if (!run.execution || run.execution.adapter !== observation.data.surface) issue(`${label}: saved Run adapter is missing or differs from the observed surface.`);
    if (run.execution?.replayOfRunId !== observation.data.sourceRunId) issue(`${label}: saved Run replay source differs from the Mission observation.`);
    if (run.verdict !== observation.data.verdict) issue(`${label}: saved Run verdict differs from the Mission observation.`);
    const expected = expectedRunCharter(mission, observation);
    if (!expected || !isDeepStrictEqual(charterExecutionShape(run.charter), charterExecutionShape(expected))) {
      issue(`${label}: saved Run Charter differs from the frozen Mission scenario.`);
    }
    if (run.steps.length !== observation.data.steps || run.assertions.length !== observation.data.assertions
      || run.assertions.filter((item) => item.passed).length !== observation.data.passedAssertions
      || run.oracles.length !== observation.data.oracles
      || run.oracles.filter((item) => item.verificationKind !== "http-contract" && item.passed === true).length !== observation.data.passedOracles) {
      issue(`${label}: saved Run action/assertion/Oracle counts differ from the Mission observation.`);
    }
    if (!isDeepStrictEqual(run.integrationCleanup, observation.data.integrationCleanup)) {
      issue(`${label}: saved Run cleanup differs from the Mission observation.`);
    }
    if (mission.workflowReviewAdmission && mission.level !== "quick") {
      if (surface !== "web" && surface !== "electron") {
        issue(`${label}: reviewed project acceptance cannot verify this surface's application source.`);
      } else {
        const before = TargetBindingSchema.safeParse(observation.data.targetBinding);
        const after = TargetBindingSchema.safeParse(observation.data.targetBindingAfterRun);
        if (!before.success || !reviewedBindingMatches(before.data, run.targetBinding, mission.projectRoot)) {
          issue(`${label}: listener process was not verified under the reviewed source checkout.`);
        }
        if (!after.success || !reviewedBindingMatches(after.data, run.targetBindingAfterRun, mission.projectRoot)
          || !before.success || !sameTargetProcess(before.data, after.data)
          || run.targetContinuity !== "stable" || observation.data.targetContinuity !== "stable") {
          issue(`${label}: listener process continuity was not verified through Run completion.`);
        }
      }
    }
  }
  return MissionExecutionAuditSchema.parse({ ...previous, status: issues.length || omittedIssues ? "incomplete" : "complete", issues, omittedIssues });
}

function reviewedBindingMatches(observed: TargetBinding, saved: TargetBinding | undefined, projectRoot: string): boolean {
  return isDeepStrictEqual(observed, saved) && observed.status === "matching-process-path"
    && observed.processId !== undefined && observed.targetOrigin !== undefined
    && observed.observedProjectRoot !== undefined
    && sameProjectPath(observed.expectedProjectRoot, projectRoot)
    && sameProjectPath(observed.observedProjectRoot, projectRoot);
}

function sameTargetProcess(before: TargetBinding, after: TargetBinding): boolean {
  return before.status === "matching-process-path" && after.status === "matching-process-path"
    && before.processId !== undefined && before.processId === after.processId
    && before.targetOrigin !== undefined && before.targetOrigin === after.targetOrigin
    && before.observedProjectRoot !== undefined && after.observedProjectRoot !== undefined
    && sameProjectPath(before.observedProjectRoot, after.observedProjectRoot);
}

function expectedRunCharter(mission: TestMission, observation: Observation): TestCharter | undefined {
  const base = mission.suite
    ? mission.suite.charters.find((item) => item.charterId === observation.charterId)?.charter
    : mission.charter;
  if (!base) return;
  if (observation.data.runKind !== "negative") return base;
  const negative = base.negativeCases?.find((item) => item.caseId === observation.data.negativeCaseId);
  if (!negative) return;
  return TestCharterSchema.parse({ ...base, intent: `${mission.intent}: ${negative.title}`,
    actions: negative.actions, assertions: negative.assertions, oracles: negative.oracles,
    sideEffectPolicy: negative.sideEffectPolicy,
    metadata: { ...base.metadata, negativeCaseId: negative.caseId } });
}

function charterExecutionShape(charter: TestCharter): unknown {
  const { intent, level, mode, preconditions, actions, assertions, oracles, httpOracles, negativeCases, sideEffectPolicy, metadata } = charter;
  return { intent, level, mode, preconditions, actions, assertions, oracles, httpOracles, negativeCases, sideEffectPolicy, metadata };
}

function expectedSingleSurfaces(mission: TestMission): Surface[] {
  if (mission.level === "release" && (mission.surface === "web" || mission.surface === "electron")) {
    return [mission.surface, mission.surface === "web" ? "electron" : "web"];
  }
  return [mission.surface];
}

function slotLabel(slot: Slot): string {
  return `${slot.charterId ? `${slot.charterId}/` : ""}${slot.surface}/${slot.kind}${slot.negativeCaseId ? `/${slot.negativeCaseId}` : ""}`;
}

function pairKey(slot: Slot): string { return JSON.stringify([slot.charterId ?? null, slot.surface]); }
function caseId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && "caseId" in value && typeof value.caseId === "string" ? value.caseId : undefined;
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}
