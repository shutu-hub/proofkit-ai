import { FailureBoundarySchema, FindingSchema, hasPositiveSurfaceAssertion, ProjectMapSchema, RouteCoverageTargetSchema, suiteChecks, type Observation, type RouteCoverageTarget, type TestMission, type Verdict } from "@proofkit/contracts";
import type { MissionToolResult } from "@proofkit/agent";
import { reconcileRouteDeclarations } from "@proofkit/project";
import { hasCompleteCleanupEvidence } from "./cleanup-evidence.js";

type RunKind = "primary" | "replay" | "negative";
type RunFact = { runId: string; verdict: Verdict; evidenceCount: number; matchedRoutePaths: string[]; matchedApiTargets: Extract<RouteCoverageTarget, { kind: "api" }>[]; networkLogAvailable: boolean; sourceRunId?: string; negativeCaseId?: string; outcomeMatched?: boolean };

export type RouteCoverageSummary = {
  inventorySource: "git" | "filesystem";
  inventoryTruncated: boolean;
  routeDiagnostics?: NonNullable<import("@proofkit/contracts").ProjectMap["inventory"]["routeDiagnostics"]>;
  candidateRoutes: number;
  declaredTargets: number;
  mappedCandidates: number;
  observedCandidates: number;
  /** Bounded gap details keep the agent-facing result short; counts include all candidates. */
  gaps: Array<{ kind: "web" | "api"; path: string; source: string; line: number; method?: string; status: "unmapped" | "mapped-unobserved"; charterIds: string[]; reason?: string }>;
  omittedGaps: number;
  unresolvedTargets: Array<{ charterId: string; kind: "web" | "api"; path: string; source?: string; method?: string; origin?: string; reason: "absent" | "ambiguous" }>;
  omittedUnresolvedTargets: number;
};

export type SuiteSurfaceResult = {
  charterId: string;
  surface: "web" | "electron" | "mobile";
  verdict: Verdict;
  primary?: RunFact;
  replay?: RunFact;
  negativeCases: RunFact[];
  missing: string[];
};

export type SuiteScopeSummary = {
  suiteId: string;
  includedCharterIds: string[];
  uncoveredCharterIds: string[];
  results: SuiteSurfaceResult[];
  routeCoverage?: RouteCoverageSummary;
};

/** A saved suite is the only execution scope; catalog entries outside it are reported, never run implicitly. */
export function summarizeSuiteScope(mission: TestMission, evidenceDir?: string): SuiteScopeSummary | undefined {
  const suite = mission.suite;
  if (!suite) return undefined;
  const includedCharterIds = suite.charters.map((item) => item.charterId);
  const observations = mission.observations.filter((item) => item.kind === "surface.run");
  const requireReplay = suite.level === "release";
  const requireBusinessOracle = suite.level !== "quick";
  const results = suiteChecks(suite).map(({ charterId, charter, surface }): SuiteSurfaceResult => {
    const missing: string[] = [];
    if (!hasPositiveSurfaceAssertion(charter.assertions)) missing.push("positive surface assertion");
    if (mission.plan.executionProfile.requireReplay !== requireReplay) missing.push("replay policy differs from suite level");
    if (mission.plan.executionProfile.requireBusinessOracle !== requireBusinessOracle) missing.push("business Oracle policy differs from suite level");
    const scheduledTask = (tool: string, negativeCaseId?: string) => mission.plan.graph.tasks.find((task) => task.tool === tool
      && task.charterId === charterId && task.input.charterId === charterId && task.input.adapter === surface
      && (negativeCaseId === undefined || (typeof task.input.negativeCase === "object" && task.input.negativeCase !== null
        && (task.input.negativeCase as { caseId?: unknown }).caseId === negativeCaseId)));
    const requireTask = (tool: string, label: string, negativeCaseId?: string) => {
      const task = scheduledTask(tool, negativeCaseId);
      if (!task) missing.push(`${label} task was not scheduled`);
      else if (task.status !== "passed") missing.push(`${label} task did not pass`);
    };
    requireTask("surface.run-charter", "primary");
    if (requireReplay) requireTask("surface.replay-charter", "replay");
    let failed = false;
    let blocked = false;
    let inconclusive = false;
    const matching = (kind: RunKind, negativeCaseId?: string) => observations.filter((item) => item.charterId === charterId
      && item.data.charterId === charterId
      && item.data.surface === surface
      && item.data.runKind === kind
      && (kind !== "negative" || item.data.negativeCaseId === negativeCaseId));
    const inspect = (kind: "primary" | "replay"): RunFact | undefined => {
      const matches = matching(kind);
      if (matches.length !== 1) {
        missing.push(`${kind} ${matches.length === 0 ? "run" : "has duplicate observations"}`);
        return undefined;
      }
      const item = matches[0]!;
      const fact = runFact(item);
      if (!fact) {
        missing.push(`${kind} run ID or verdict`);
        return undefined;
      }
      if (fact.evidenceCount < 1) missing.push(`${kind} evidence artifact`);
      if (!hasCompleteCleanupEvidence(item.data.integrationCleanup, fact.runId, item.evidence, evidenceDir)) {
        blocked = true;
        missing.push(`${kind} cleanup evidence`);
      }
      if (numberValue(item.data.passedAssertions) < 1) missing.push(`${kind} passed surface assertion`);
      if (requireBusinessOracle && numberValue(item.data.passedOracles) < 1) missing.push(`${kind} passed business Oracle`);
      if (requireBusinessOracle && numberValue(item.data.businessEvidence) < 1) missing.push(`${kind} independent business fact`);
      if (fact.verdict === "failed") failed = true;
      if (fact.verdict === "blocked" || fact.verdict === "cancelled") blocked = true;
      if (fact.verdict === "inconclusive") inconclusive = true;
      return fact;
    };
    const primary = inspect("primary");
    const replay = requireReplay ? inspect("replay") : undefined;
    if (primary && replay && replay.sourceRunId !== primary.runId) missing.push("replay source does not match primary run");
    const negativeCases: RunFact[] = [];
    for (const declared of charter.negativeCases ?? []) {
      requireTask("surface.run-negative-charter", `negative ${declared.caseId}`, declared.caseId);
      const matches = matching("negative", declared.caseId);
      if (matches.length !== 1) {
        missing.push(`negative ${declared.caseId} ${matches.length === 0 ? "run" : "has duplicate observations"}`);
        continue;
      }
      const item = matches[0]!;
      const fact = runFact(item);
      if (!fact) {
        missing.push(`negative ${declared.caseId} run ID or verdict`);
        continue;
      }
      negativeCases.push(fact);
      if (!hasCompleteCleanupEvidence(item.data.integrationCleanup, fact.runId, item.evidence, evidenceDir)) {
        blocked = true;
        missing.push(`negative ${declared.caseId} verified cleanup`);
      }
      if (fact.evidenceCount < 1) missing.push(`negative ${declared.caseId} evidence artifact`);
      if (fact.outcomeMatched !== true) failed = true;
    }
    const verdict: Verdict = failed ? "failed" : blocked ? "blocked" : missing.length > 0 || inconclusive ? "inconclusive" : "passed";
    return { charterId, surface, verdict, primary, replay, negativeCases, missing };
  });
  return {
    suiteId: suite.suiteId,
    includedCharterIds,
    uncoveredCharterIds: suite.uncoveredCharterIds,
    results,
    routeCoverage: summarizeRouteCoverage(mission, results),
  };
}

function summarizeRouteCoverage(mission: TestMission, results: SuiteSurfaceResult[]): RouteCoverageSummary | undefined {
  const discovery = [...mission.observations].reverse().find((item) => item.kind === "project.discovered");
  const parsed = ProjectMapSchema.safeParse(discovery?.data);
  if (!parsed.success || !mission.suite) return undefined;
  const inventory = parsed.data.inventory;
  const mapping = reconcileRouteDeclarations(inventory.routeHints, mission.suite.charters);
  const { routes, declaredTargets, unresolvedTargets: unresolved } = mapping;
  const gaps: RouteCoverageSummary["gaps"] = [];
  let mappedCandidates = 0;
  let observedCandidates = 0;
  for (const { candidate: route, charterIds, runtimeSourceAmbiguous: ambiguousRuntimePath } of routes) {
    if (charterIds.length > 0) mappedCandidates++;
    const observed = !ambiguousRuntimePath && !(mission.suite!.level === "quick" && route.kind === "api") && charterIds.some((charterId) => {
      const charter = mission.suite!.charters.find((item) => item.charterId === charterId);
      return (charter?.surfaces ?? mission.suite!.surfaces).every((surface) => {
        const result = results.find((item) => item.charterId === charterId && item.surface === surface);
        const matched = (fact: RunFact | undefined) => route.kind === "web"
          ? fact?.matchedRoutePaths.includes(route.path)
          : route.method !== undefined && fact?.matchedApiTargets.some((target) => target.path === route.path && target.method === route.method);
        return result?.verdict === "passed"
          && matched(result.primary)
          && (mission.suite!.level !== "release" || matched(result.replay));
      });
    });
    if (observed) {
      observedCandidates++;
    } else {
      gaps.push({
        ...route,
        status: charterIds.length > 0 ? "mapped-unobserved" : "unmapped",
        charterIds,
        ...(route.kind === "api" && charterIds.length > 0 ? { reason: mission.suite!.level === "quick"
          ? "Quick surface checks do not independently verify API business outcomes"
          : charterIds.some((charterId) => results.some((result) => result.charterId === charterId
            && (!result.primary?.networkLogAvailable || mission.suite!.level === "release" && !result.replay?.networkLogAvailable)))
            ? "Network event log is unavailable for a required run"
            : "No matching successful API response on every required run" } : {}),
        ...(route.kind === "web" && charterIds.length > 0 ? { reason: "No matching page visit on the configured HTTP origin or Electron file document in every required run" } : {}),
        ...(ambiguousRuntimePath && charterIds.length > 0 ? { reason: "Runtime URL cannot identify which source owns this route" } : {}),
      });
    }
  }
  const limit = 25;
  return {
    inventorySource: inventory.source,
    inventoryTruncated: inventory.truncated,
    ...(inventory.routeDiagnostics ? { routeDiagnostics: inventory.routeDiagnostics } : {}),
    candidateRoutes: routes.length,
    declaredTargets,
    mappedCandidates,
    observedCandidates,
    gaps: gaps.slice(0, limit),
    omittedGaps: Math.max(0, gaps.length - limit),
    unresolvedTargets: unresolved.slice(0, limit),
    omittedUnresolvedTargets: Math.max(0, unresolved.length - limit),
  };
}

export function verifySuiteMission(mission: TestMission, evidenceDir?: string): MissionToolResult {
  const scope = summarizeSuiteScope(mission, evidenceDir);
  if (!scope) throw new Error("Mission has no suite to verify");
  const failed = scope.results.some((item) => item.verdict === "failed");
  const blocked = scope.results.some((item) => item.verdict === "blocked");
  const planningGaps = mission.plan.planning?.evidenceGaps ?? [];
  const incomplete = scope.results.some((item) => item.verdict === "inconclusive") || planningGaps.length > 0;
  const verdict: Verdict = failed ? "failed" : blocked ? "blocked" : incomplete ? "inconclusive" : "passed";
  const missing = scope.results.filter((item) => item.missing.length > 0);
  const message = [
    ...missing.map((item) => `${item.charterId}/${item.surface}: ${item.missing.join(", ")}`),
    ...(planningGaps.length > 0 ? [`Planning evidence gaps: ${planningGaps.join(", ")}`] : []),
  ].join("; ");
  const observedAt = new Date().toISOString();
  return {
    output: { ...scope, planningGaps, verified: verdict === "passed", verdict },
    verdict,
    ...(message ? {
      firstFailure: FailureBoundarySchema.parse({ kind: "evidence", message, evidence: mission.evidence.slice(0, 4), observedAt }),
      findings: [FindingSchema.parse({
        findingId: `suite-evidence-${mission.missionId}`,
        severity: "high",
        category: "test",
        status: "confirmed",
        title: "Mission scenario evidence is incomplete",
        message,
        evidence: mission.evidence.slice(0, 4),
        createdAt: observedAt,
      })],
    } : {}),
  };
}

function runFact(item: Observation): RunFact | undefined {
  const runId = item.data.runId;
  const verdict = item.data.verdict;
  if (typeof runId !== "string" || !isVerdict(verdict)) return undefined;
  const matchedApiTargets: Extract<RouteCoverageTarget, { kind: "api" }>[] = [];
  if (Array.isArray(item.data.matchedApiTargets)) {
    for (const value of item.data.matchedApiTargets) {
      const parsed = RouteCoverageTargetSchema.safeParse(value);
      if (parsed.success && parsed.data.kind === "api") matchedApiTargets.push(parsed.data);
    }
  }
  return {
    runId,
    verdict,
    evidenceCount: item.evidence.length,
    matchedRoutePaths: Array.isArray(item.data.matchedRoutePaths) ? item.data.matchedRoutePaths.filter((path): path is string => typeof path === "string" && path.startsWith("/")) : [],
    matchedApiTargets,
    networkLogAvailable: item.data.networkLogAvailable === true,
    ...(typeof item.data.sourceRunId === "string" ? { sourceRunId: item.data.sourceRunId } : {}),
    ...(typeof item.data.negativeCaseId === "string" ? { negativeCaseId: item.data.negativeCaseId } : {}),
    ...(typeof item.data.outcomeMatched === "boolean" ? { outcomeMatched: item.data.outcomeMatched } : {}),
  };
}

function isVerdict(value: unknown): value is Verdict {
  return value === "passed" || value === "failed" || value === "blocked" || value === "cancelled" || value === "inconclusive";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
