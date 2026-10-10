import { IntegrationCleanupSchema, MissionResultSchema, MissionSurfaceSchema, SourceStateSchema, TargetBindingSchema, VerdictSchema, type EvidenceRef, type MissionComparison, type MissionProofClassification, type MissionResult, type MissionRunResult, type Observation, type TaskNode, type TestMission, type WorkflowExecutionCoverage } from "@proofkit/contracts";
import type { SuiteScopeSummary } from "./suite-verifier.js";

type RunKind = MissionRunResult["runKind"];
const RUN_TOOLS: Record<string, RunKind> = {
  "surface.run-charter": "primary",
  "surface.replay-charter": "replay",
  "surface.run-negative-charter": "negative",
};
const EVIDENCE_PRIORITY = ["report", "business", "screenshot", "network", "runtime", "snapshot", "process", "console", "api", "log", "other"];

/** Project stored facts for presentation. Acceptance remains owned by Mission verification. */
export function projectMissionResult(mission: TestMission, options: {
  workspaceRoot: string;
  running: boolean;
  suiteScope?: SuiteScopeSummary;
  workflowExecution?: WorkflowExecutionCoverage;
  comparison?: MissionComparison;
  comparisonUnavailable?: string;
  proofClassification?: MissionProofClassification;
}): MissionResult {
  const observations = mission.observations.filter((item) => item.kind === "surface.run");
  const indexed = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = runKey(observation.charterId ?? stringValue(observation.data.charterId),
      stringValue(observation.data.surface), stringValue(observation.data.runKind) ?? "primary", stringValue(observation.data.negativeCaseId));
    indexed.set(key, [...(indexed.get(key) ?? []), observation]);
  }
  const used = new Set<Observation>();
  const surfaceTasks = mission.plan.graph.tasks.filter((task) => RUN_TOOLS[task.tool] !== undefined);
  const rows: MissionRunResult[] = [];
  for (const task of surfaceTasks) {
    const surface = MissionSurfaceSchema.safeParse(task.input.adapter ?? mission.surface);
    const runKind = RUN_TOOLS[task.tool]!;
    const negative = objectValue(task.input.negativeCase);
    const negativeCaseId = stringValue(negative?.caseId);
    const charterId = task.charterId ?? stringValue(task.input.charterId) ?? singleCharterId(mission);
    const matches = indexed.get(runKey(charterId, surface.success ? surface.data : undefined, runKind, negativeCaseId)) ?? [];
    if (matches.length === 0) {
      rows.push(projectRun(mission, task, undefined, runKind, negativeCaseId));
    } else {
      for (const observation of matches) {
        used.add(observation);
        rows.push(projectRun(mission, task, observation, runKind, negativeCaseId,
          matches.length > 1 ? "Multiple saved run observations exist for this task; review the audit trail." : undefined));
      }
    }
  }
  for (const observation of observations) {
    if (used.has(observation)) continue;
    const kind = stringValue(observation.data.runKind) ?? "primary";
    rows.push(projectRun(mission, undefined, observation,
      kind === "primary" || kind === "replay" || kind === "negative" ? kind : "unknown",
      stringValue(observation.data.negativeCaseId), "Saved run is not associated with a declared execution task."));
  }
  const tasks = mission.plan.graph.tasks;
  const routeCoverage = options.suiteScope?.routeCoverage;
  const findings = [...mission.findings].sort((left, right) => findingPriority(left) - findingPriority(right));
  return MissionResultSchema.parse({
    schemaVersion: "1",
    missionId: mission.missionId,
    replayOfMissionId: mission.replayOfMissionId,
    projectRoot: mission.projectRoot,
    workspaceRoot: options.workspaceRoot,
    intent: mission.intent,
    status: mission.status,
    running: options.running,
    verdict: mission.verdict,
    level: mission.level,
    levelSelection: mission.levelSelection,
    revision: mission.revision,
    updatedAt: mission.updatedAt,
    generatedAt: new Date().toISOString(),
    planning: mission.plan.planning,
    scope: {
      surfaces: mission.plan.executionProfile.surfaceMatrix,
      charterCount: mission.suite?.charters.length ?? (mission.charter ? 1 : 0),
      sourceStability: missionSourceStability(mission),
      suiteId: mission.suite?.suiteId,
      uncoveredCharterIds: options.suiteScope?.uncoveredCharterIds ?? [],
      workflowInventory: mission.workflowInventoryInspection,
      workflowExecution: options.workflowExecution,
      ...(routeCoverage ? { routeCoverage: {
        inventoryTruncated: routeCoverage.inventoryTruncated,
        candidateRoutes: routeCoverage.candidateRoutes,
        mappedCandidates: routeCoverage.mappedCandidates,
        observedCandidates: routeCoverage.observedCandidates,
        gapCount: routeCoverage.gaps.length + routeCoverage.omittedGaps,
        unresolvedTargetCount: routeCoverage.unresolvedTargets.length + routeCoverage.omittedUnresolvedTargets,
      } } : {}),
    },
    tasks: {
      total: tasks.length,
      settled: tasks.filter((task) => ["passed", "failed", "blocked", "skipped"].includes(task.status)).length,
      failed: tasks.filter((task) => task.status === "failed").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      skipped: tasks.filter((task) => task.status === "skipped").length,
    },
    expectedRuns: surfaceTasks.length,
    observedRuns: observations.length,
    runs: rows.slice(0, 200),
    omittedRunResults: Math.max(0, rows.length - 200),
    findings: findings.slice(0, 20),
    omittedFindings: Math.max(0, findings.length - 20),
    confirmedProductFindings: mission.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed").length,
    proofClassification: options.proofClassification,
    firstFailure: mission.firstFailure,
    diagnosis: mission.diagnosis,
    repairSuggestions: mission.repairSuggestions.slice(0, 10),
    omittedRepairSuggestions: Math.max(0, mission.repairSuggestions.length - 10),
    comparison: options.comparison,
    comparisonUnavailable: options.comparisonUnavailable,
  });
}

function missionSourceStability(mission: TestMission): "stable" | "changed" | "unverified" {
  const source = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state")?.data);
  const final = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state-final")?.data);
  if (!source.success || !final.success || !source.data.complete || !final.data.complete
    || source.data.method !== "git" || final.data.method !== "git"
    || !source.data.headSha || !final.data.headSha || !source.data.worktreeSha256 || !final.data.worktreeSha256) return "unverified";
  return source.data.headSha === final.data.headSha && source.data.worktreeSha256 === final.data.worktreeSha256 ? "stable" : "changed";
}

function projectRun(mission: TestMission, task: TaskNode | undefined, observation: Observation | undefined,
  runKind: RunKind, negativeCaseId?: string, issue?: string): MissionRunResult {
  const data = observation?.data ?? {};
  const surface = MissionSurfaceSchema.safeParse(observation ? data.surface : task?.input.adapter ?? mission.surface);
  const charterId = observation?.charterId ?? task?.charterId ?? stringValue(data.charterId) ?? stringValue(task?.input.charterId) ?? singleCharterId(mission);
  const savedCharter = mission.suite?.charters.find((item) => item.charterId === charterId)?.charter ?? mission.charter;
  const negative = savedCharter?.negativeCases?.find((item) => item.caseId === negativeCaseId);
  const title = negative?.title ?? savedCharter?.intent ?? task?.title ?? mission.intent;
  const evidence = selectEvidence(observation?.evidence ?? []);
  const binding = TargetBindingSchema.safeParse(data.targetBinding);
  const finalBinding = TargetBindingSchema.safeParse(data.targetBindingAfterRun);
  const cleanup = IntegrationCleanupSchema.safeParse(data.integrationCleanup);
  const runId = stringValue(data.runId);
  const verdict = VerdictSchema.safeParse(data.verdict);
  const expected = VerdictSchema.safeParse(data.expectedVerdict ?? (runKind === "negative" ? negative?.expectedVerdict ?? "passed" : undefined));
  const issues = [issue, task?.error];
  if (!surface.success) issues.push("Saved run has invalid surface metadata.");
  if (runKind === "unknown") issues.push("Saved run has invalid execution-kind metadata.");
  if (observation && (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId) || !verdict.success)) issues.push("Saved run identity or verdict is unavailable.");
  if (!observation && task && (["passed", "failed", "blocked", "skipped"].includes(task.status)
    || ["completed", "failed", "blocked", "cancelled"].includes(mission.status))) issues.push("No saved run observation for this task.");
  return {
    taskId: task?.taskId,
    charterId,
    title,
    surface: surface.success ? surface.data : undefined,
    runKind,
    negativeCaseId,
    taskStatus: task?.status,
    runId: runId && /^[a-zA-Z0-9_-]+$/.test(runId) ? runId : undefined,
    verdict: verdict.success ? verdict.data : undefined,
    expectedVerdict: expected.success ? expected.data : undefined,
    outcomeMatched: typeof data.outcomeMatched === "boolean" ? data.outcomeMatched : undefined,
    assertions: counts(data.passedAssertions, data.assertions),
    oracles: counts(data.passedOracles, data.oracles),
    businessFacts: numberValue(data.businessEvidence),
    targetBinding: binding.success ? binding.data : undefined,
    targetBindingAfterRun: finalBinding.success ? finalBinding.data : undefined,
    targetContinuity: data.targetContinuity === "stable" || data.targetContinuity === "changed" || data.targetContinuity === "unverified" ? data.targetContinuity : undefined,
    integrationCleanup: cleanup.success ? cleanup.data : undefined,
    evidence: evidence.items,
    omittedEvidence: evidence.omitted,
    issue: issues.filter((item): item is string => Boolean(item)).join(" ") || undefined,
  };
}

function runKey(charterId: string | undefined, surface: string | undefined, kind: string, negativeCaseId: string | undefined): string {
  return JSON.stringify([charterId ?? null, surface ?? null, kind, negativeCaseId ?? null]);
}

function singleCharterId(mission: TestMission): string | undefined {
  return mission.suite ? undefined : stringValue(mission.charter?.metadata.catalogId);
}

function counts(passed: unknown, total: unknown): MissionRunResult["assertions"] {
  const passedCount = numberValue(passed);
  const totalCount = numberValue(total);
  return passedCount === undefined || totalCount === undefined ? undefined : { passed: passedCount, total: totalCount };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function selectEvidence(evidence: EvidenceRef[]): { items: EvidenceRef[]; omitted: number } {
  const unique = [...new Map(evidence.map((item) => [item.evidenceId, item])).values()];
  unique.sort((left, right) => EVIDENCE_PRIORITY.indexOf(left.kind) - EVIDENCE_PRIORITY.indexOf(right.kind));
  return { items: unique.slice(0, 6), omitted: Math.max(0, unique.length - 6) };
}

function findingPriority(finding: TestMission["findings"][number]): number {
  return (finding.category === "product" && finding.status === "confirmed" ? 0 : finding.status === "confirmed" ? 10 : 20)
    + ["critical", "high", "medium", "low", "info"].indexOf(finding.severity);
}
