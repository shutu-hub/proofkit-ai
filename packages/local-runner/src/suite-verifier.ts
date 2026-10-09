import { FailureBoundarySchema, FindingSchema, type Observation, type TestMission, type Verdict } from "@proofkit/contracts";
import type { MissionToolResult } from "@proofkit/agent";

type RunKind = "primary" | "replay" | "negative";
type RunFact = { runId: string; verdict: Verdict; evidenceCount: number; sourceRunId?: string; negativeCaseId?: string; outcomeMatched?: boolean };

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
