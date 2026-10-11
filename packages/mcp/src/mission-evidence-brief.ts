import type { EvidenceRef, MissionResult } from "@proofkit/contracts";
import type { LocalRunnerService } from "@proofkit/local-runner";

type MissionEvidence = Awaited<ReturnType<LocalRunnerService["missionEvidence"]>>;

const MAX_BRIEF_REFS = 12;
const MAX_BRIEF_FINDINGS = 8;
const MAX_BRIEF_REPAIRS = 3;
const MAX_CLAIM_REFS = 3;
const MAX_BRIEF_TEXT = 500;

function text(value: string, limit = MAX_BRIEF_TEXT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function briefRef(ref: EvidenceRef): EvidenceRef {
  return { evidenceId: ref.evidenceId, kind: ref.kind, path: ref.path,
    ...(ref.sha256 ? { sha256: ref.sha256 } : {}), capturedAt: ref.capturedAt };
}

function briefClaimRefs(refs: EvidenceRef[]) {
  return { evidence: refs.slice(0, MAX_CLAIM_REFS).map(briefRef), omittedEvidence: Math.max(0, refs.length - MAX_CLAIM_REFS) };
}

/** Keep the audited verdict and its most relevant links in the agent's first response. */
export function briefMissionResult(summary: MissionResult) {
  return {
    schemaVersion: summary.schemaVersion,
    missionId: summary.missionId,
    status: summary.status,
    verdict: summary.verdict,
    testVerdict: summary.testVerdict,
    testVerdictReason: summary.testVerdictReason,
    level: summary.level,
    scope: summary.scope,
    tasks: summary.tasks,
    expectedRuns: summary.expectedRuns,
    observedRuns: summary.observedRuns,
    omittedRunResults: summary.omittedRunResults,
    confirmedProductFindings: summary.confirmedProductFindings,
    omittedFindings: summary.omittedFindings,
    evidenceIntegrity: summary.evidenceIntegrity,
    acceptanceEvidenceIntegrity: summary.acceptanceEvidenceIntegrity,
    proofClassification: summary.proofClassification,
    replayConsistency: summary.replayConsistency,
    executionAudit: summary.executionAudit,
    agentTraceAudit: summary.agentTraceAudit,
  };
}

export function briefMissionEvidence(evidence: MissionEvidence) {
  const cited = [
    ...(evidence.firstFailure?.evidence ?? []),
    ...(evidence.findings ?? []).flatMap((finding) => finding.evidence),
    ...(evidence.diagnosis?.evidence ?? []),
    ...(evidence.repairSuggestions ?? []).flatMap((suggestion) => suggestion.evidence),
  ];
  const allRefs = [...(evidence.evidence ?? []), ...cited];
  const prioritized = [
    ...cited.filter((ref) => ref.kind === "business"),
    ...allRefs.filter((ref) => ref.kind === "business"),
    ...cited.filter((ref) => ref.kind !== "business"),
    ...allRefs.filter((ref) => ref.kind === "screenshot" || ref.kind === "snapshot"),
    ...allRefs,
  ];
  const selected: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of prioritized) {
    const key = `${ref.path}\0${ref.sha256 ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(ref);
    if (selected.length === MAX_BRIEF_REFS) break;
  }
  return {
    detail: "brief" as const,
    missionId: evidence.missionId,
    status: evidence.status,
    running: evidence.running,
    verdict: evidence.verdict,
    testVerdict: evidence.testVerdict ?? "not-asserted",
    testVerdictReason: evidence.testVerdictReason,
    level: evidence.level,
    planning: evidence.planning,
    workflowReviewAudit: evidence.workflowReviewAudit,
    sourceStability: evidence.sourceStability,
    sourceFreshness: evidence.sourceFreshness,
    summary: briefMissionResult(evidence.summary),
    findings: (evidence.findings ?? []).slice(0, MAX_BRIEF_FINDINGS).map((finding) => ({
      findingId: finding.findingId, charterId: finding.charterId, surface: finding.surface,
      severity: finding.severity, category: finding.category, status: finding.status,
      title: text(finding.title, 200), message: text(finding.message), createdAt: finding.createdAt,
      ...briefClaimRefs(finding.evidence),
    })),
    omittedFindings: Math.max(0, (evidence.findings?.length ?? 0) - MAX_BRIEF_FINDINGS),
    firstFailure: evidence.firstFailure ? { ...evidence.firstFailure,
      message: text(evidence.firstFailure.message), ...briefClaimRefs(evidence.firstFailure.evidence) } : undefined,
    diagnosis: evidence.diagnosis ? briefDiagnosis(evidence.diagnosis) : undefined,
    diagnoses: (evidence.diagnoses ?? []).slice(0, MAX_BRIEF_FINDINGS).map(briefDiagnosis),
    omittedDiagnoses: Math.max(0, (evidence.diagnoses?.length ?? 0) - MAX_BRIEF_FINDINGS),
    diagnosticSupport: evidence.diagnosticSupport,
    repairSuggestions: (evidence.repairSuggestions ?? []).slice(0, MAX_BRIEF_REPAIRS).map((suggestion) => ({
      suggestionId: suggestion.suggestionId, findingId: suggestion.findingId,
      charterId: suggestion.charterId, surface: suggestion.surface, status: suggestion.status,
      title: text(suggestion.title, 200), rationale: text(suggestion.rationale),
      changes: suggestion.changes.slice(0, 5).map((change) => text(change)),
      omittedChanges: Math.max(0, suggestion.changes.length - 5), confidence: suggestion.confidence,
      ...briefClaimRefs(suggestion.evidence),
    })),
    omittedRepairSuggestions: Math.max(0, (evidence.repairSuggestions?.length ?? 0) - MAX_BRIEF_REPAIRS),
    evidence: selected.map(briefRef),
    omittedEvidence: Math.max(0, new Set(allRefs.map((ref) => `${ref.path}\0${ref.sha256 ?? ""}`)).size - selected.length),
    evidenceIntegrity: evidence.evidenceIntegrity,
    acceptanceEvidenceIntegrity: evidence.acceptanceEvidenceIntegrity,
    proofClassification: evidence.proofClassification,
    comparison: evidence.comparison ? {
      baselineMissionId: evidence.comparison.baselineMissionId,
      candidateMissionId: evidence.comparison.candidateMissionId,
      status: evidence.comparison.status,
      historicalStatus: evidence.comparison.historicalStatus,
      scopeMatched: evidence.comparison.scopeMatched,
      sourceChange: evidence.comparison.sourceChange,
      candidateSourceFreshness: evidence.comparison.candidateSourceFreshness,
      reason: text(evidence.comparison.reason),
      gaps: evidence.comparison.gaps.slice(0, 5).map((gap) => text(gap)),
      omittedGaps: Math.max(0, evidence.comparison.gaps.length - 5),
      runPairs: evidence.comparison.runs.length + evidence.comparison.omittedRuns,
      defects: evidence.comparison.defects.length + evidence.comparison.omittedDefects,
    } : undefined,
    comparisonUnavailable: evidence.comparisonUnavailable,
    report: evidence.report,
    reportUnavailable: evidence.reportUnavailable,
    fullDetail: { tool: "get_mission_evidence", arguments: { missionId: evidence.missionId, detail: "full" as const } },
  };
}

function briefDiagnosis(diagnosis: MissionEvidence["diagnoses"][number]) {
  return {
    diagnosisId: diagnosis.diagnosisId, findingId: diagnosis.findingId,
    charterId: diagnosis.charterId, surface: diagnosis.surface,
    summary: text(diagnosis.summary), confidence: diagnosis.confidence,
    likelyOwner: diagnosis.likelyOwner ? text(diagnosis.likelyOwner, 200) : undefined,
    sourceLocations: diagnosis.sourceLocations.slice(0, 5).map((location) => text(location, 300)),
    omittedSourceLocations: Math.max(0, diagnosis.sourceLocations.length - 5),
    createdAt: diagnosis.createdAt, ...briefClaimRefs(diagnosis.evidence),
  };
}
