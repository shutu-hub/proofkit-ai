import { FailureBoundarySchema, FindingSchema, ProjectMapSchema, type Observation, type TestMission, type Verdict } from "@proofkit/contracts";
import type { MissionToolResult } from "@proofkit/agent";

type RunKind = "primary" | "replay" | "negative";
type RunFact = { runId: string; verdict: Verdict; evidenceCount: number; matchedRoutePaths: string[]; sourceRunId?: string; negativeCaseId?: string; outcomeMatched?: boolean };

export type RouteCoverageSummary = {
  inventorySource: "git" | "filesystem";
  inventoryTruncated: boolean;
  candidateRoutes: number;
  declaredTargets: number;
  mappedCandidates: number;
  observedCandidates: number;
  /** Bounded gap details keep the agent-facing result short; counts include all candidates. */
  gaps: Array<{ kind: "web" | "api"; path: string; source: string; line: number; status: "unmapped" | "mapped-unobserved"; charterIds: string[]; reason?: string }>;
  omittedGaps: number;
  unresolvedTargets: Array<{ charterId: string; kind: "web" | "api"; path: string; source?: string; reason: "absent" | "ambiguous" }>;
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
export function summarizeSuiteScope(mission: TestMission): SuiteScopeSummary | undefined {
  const suite = mission.suite;
  if (!suite) return undefined;
  const includedCharterIds = suite.charters.map((item) => item.charterId);
  const observations = mission.observations.filter((item) => item.kind === "surface.run");
  const results = suite.charters.flatMap(({ charterId, charter }) => suite.surfaces.map((surface): SuiteSurfaceResult => {
    const missing: string[] = [];
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
      if (numberValue(item.data.passedAssertions) < 1) missing.push(`${kind} passed surface assertion`);
      if (numberValue(item.data.passedOracles) < 1) missing.push(`${kind} passed business Oracle`);
      if (numberValue(item.data.businessEvidence) < 1) missing.push(`${kind} independent business fact`);
      if (fact.verdict === "failed") failed = true;
      if (fact.verdict === "blocked" || fact.verdict === "cancelled") blocked = true;
      if (fact.verdict === "inconclusive") inconclusive = true;
      return fact;
    };
    const primary = inspect("primary");
    const replay = inspect("replay");
    if (primary && replay && replay.sourceRunId !== primary.runId) missing.push("replay source does not match primary run");
    const negativeCases: RunFact[] = [];
    for (const declared of charter.negativeCases ?? []) {
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
      if (fact.evidenceCount < 1) missing.push(`negative ${declared.caseId} evidence artifact`);
      if (fact.outcomeMatched !== true) failed = true;
    }
    const verdict: Verdict = failed ? "failed" : blocked ? "blocked" : missing.length > 0 || inconclusive ? "inconclusive" : "passed";
    return { charterId, surface, verdict, primary, replay, negativeCases, missing };
  }));
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
  const routeBySource = new Map<string, typeof inventory.routeHints[number]>();
  for (const route of inventory.routeHints) routeBySource.set(`${route.kind}\0${route.path}\0${route.source}`, route);
  const routes = [...routeBySource.values()];
  const sourcesByPath = new Map<string, Set<string>>();
  for (const route of routes) {
    const key = `${route.kind}\0${route.path}`;
    const sources = sourcesByPath.get(key) ?? new Set<string>();
    sources.add(route.source);
    sourcesByPath.set(key, sources);
  }
  const mapped = new Map<string, Set<string>>();
  const unresolved: RouteCoverageSummary["unresolvedTargets"] = [];
  let declaredTargets = 0;
  for (const { charterId, routeTargets } of mission.suite.charters) {
    for (const target of routeTargets ?? []) {
      declaredTargets++;
      const matches = routes.filter((route) => route.kind === target.kind && route.path === target.path && (!target.source || route.source === target.source));
      if (matches.length !== 1) {
        unresolved.push({ charterId, ...target, reason: matches.length === 0 ? "absent" : "ambiguous" });
        continue;
      }
      const route = matches[0]!;
      const key = `${route.kind}\0${route.path}\0${route.source}`;
      const charterIds = mapped.get(key) ?? new Set<string>();
      charterIds.add(charterId);
      mapped.set(key, charterIds);
    }
  }
  const gaps: RouteCoverageSummary["gaps"] = [];
  let mappedCandidates = 0;
  let observedCandidates = 0;
  for (const route of routes) {
    const key = `${route.kind}\0${route.path}\0${route.source}`;
    const charterIds = [...(mapped.get(key) ?? [])];
    if (charterIds.length > 0) mappedCandidates++;
    const ambiguousRuntimePath = (sourcesByPath.get(`${route.kind}\0${route.path}`)?.size ?? 0) > 1;
    const observed = route.kind === "web" && !ambiguousRuntimePath && charterIds.some((charterId) =>
      mission.suite!.surfaces.every((surface) => {
        const result = results.find((item) => item.charterId === charterId && item.surface === surface);
        return result?.verdict === "passed"
          && result.primary?.matchedRoutePaths.includes(route.path)
          && result.replay?.matchedRoutePaths.includes(route.path);
      }));
    if (observed) {
      observedCandidates++;
    } else {
      gaps.push({
        ...route,
        status: charterIds.length > 0 ? "mapped-unobserved" : "unmapped",
        charterIds,
        ...(route.kind === "api" && charterIds.length > 0 ? { reason: "API traffic is not yet correlated with route hints" } : {}),
        ...(ambiguousRuntimePath && charterIds.length > 0 ? { reason: "Runtime URL cannot identify which source owns this route" } : {}),
      });
    }
  }
  const limit = 25;
  return {
    inventorySource: inventory.source,
    inventoryTruncated: inventory.truncated,
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

export function verifySuiteMission(mission: TestMission): MissionToolResult {
  const scope = summarizeSuiteScope(mission);
  if (!scope) throw new Error("Mission has no suite to verify");
  const failed = scope.results.some((item) => item.verdict === "failed");
  const blocked = scope.results.some((item) => item.verdict === "blocked");
  const incomplete = scope.results.some((item) => item.verdict === "inconclusive");
  const verdict: Verdict = failed ? "failed" : blocked ? "blocked" : incomplete ? "inconclusive" : "passed";
  const missing = scope.results.filter((item) => item.missing.length > 0);
  const message = missing.map((item) => `${item.charterId}/${item.surface}: ${item.missing.join(", ")}`).join("; ");
  const observedAt = new Date().toISOString();
  return {
    output: { ...scope, verified: verdict === "passed", verdict },
    verdict,
    ...(missing.length > 0 ? {
      firstFailure: FailureBoundarySchema.parse({ kind: "evidence", message, evidence: mission.evidence.slice(0, 4), observedAt }),
      findings: [FindingSchema.parse({
        findingId: `suite-evidence-${mission.missionId}`,
        severity: "high",
        category: "test",
        status: "confirmed",
        title: "Release suite evidence is incomplete",
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
  return {
    runId,
    verdict,
    evidenceCount: item.evidence.length,
    matchedRoutePaths: Array.isArray(item.data.matchedRoutePaths) ? item.data.matchedRoutePaths.filter((path): path is string => typeof path === "string" && path.startsWith("/")) : [],
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
