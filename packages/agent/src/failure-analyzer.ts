import {
  FailureBoundarySchema,
  FindingSchema,
  type Diagnosis,
  type EvidenceRef,
  type FailureBoundary,
  type Finding,
  type Observation,
  type RepairSuggestion,
  type RunSummary,
} from "@proofkit/contracts";

export type FailureAnalysis = {
  boundary?: FailureBoundary;
  finding?: Finding;
  diagnosis?: Diagnosis;
  repairSuggestion?: RepairSuggestion;
};

export type FailureAnalyzerInput = {
  summary: RunSummary;
  evidence: EvidenceRef[];
  observations?: Observation[];
};

/**
 * Reduces a completed surface run into an auditable failure boundary.
 *
 * This module deliberately has no model, filesystem or source-code access.
 * A product diagnosis is created only when an independent business oracle or
 * an assertion with captured evidence proves an incorrect outcome. Adapter
 * errors and missing evidence stay suspected or unverified.
 */
export function analyzeRun(input: FailureAnalyzerInput): FailureAnalysis {
  const { summary } = input;
  const evidence = uniqueEvidence(input.evidence);

  if (summary.verdict === "passed") return {};

  const failedOracle = summary.oracles.find((oracle) => oracle.passed === false);
  if (failedOracle) {
    const oracleEvidence = evidenceForPaths(evidence, failedOracle.evidence);
    const boundary = FailureBoundarySchema.parse({
      kind: "business-oracle",
      oracleName: failedOracle.name,
      message: failedOracle.message,
      evidence: oracleEvidence,
      observedAt: failedOracle.observedAt ?? summary.endedAt ?? summary.startedAt,
    });
    if (oracleEvidence.length > 0) {
      const finding = FindingSchema.parse({
        findingId: `finding-${summary.runId}-oracle-${safeId(failedOracle.name)}`,
        severity: "high",
        category: "product",
        status: "confirmed",
        title: `Business oracle failed: ${failedOracle.name}`,
        message: failedOracle.message,
        evidence: oracleEvidence,
        createdAt: boundary.observedAt,
      });
      const diagnosis = createDiagnosis(summary, boundary, finding, input.observations);
      return { boundary, finding, diagnosis, repairSuggestion: createRepairSuggestion(summary, boundary, diagnosis) };
    }
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-oracle-${safeId(failedOracle.name)}`,
        severity: "medium",
        category: "unknown",
        status: "unverified",
        title: `Business oracle failed without linked evidence: ${failedOracle.name}`,
        message: "The oracle reported a failure, but the run did not retain a traceable evidence reference.",
        evidence: [],
        createdAt: boundary.observedAt,
      }),
    };
  }

  const failedAssertion = summary.assertions.find((assertion) => !assertion.passed);
  if (failedAssertion) {
    const assertionEvidence = evidenceForAssertion(summary, evidence, failedAssertion.evidence);
    const boundary = FailureBoundarySchema.parse({
      kind: "assertion",
      message: failedAssertion.message,
      evidence: assertionEvidence,
      observedAt: summary.endedAt ?? summary.startedAt,
    });
    const confirmed = assertionEvidence.length > 0;
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-assertion`,
        severity: confirmed ? "high" : "medium",
        category: confirmed ? "product" : "unknown",
        status: confirmed ? "confirmed" : "unverified",
        title: confirmed ? "Surface assertion failed" : "Assertion failed without evidence",
        message: failedAssertion.message,
        evidence: assertionEvidence,
        createdAt: boundary.observedAt,
      }),
      ...(confirmed
        ? (() => {
            const diagnosis = createDiagnosis(summary, boundary, undefined, input.observations);
            return { diagnosis, repairSuggestion: createRepairSuggestion(summary, boundary, diagnosis) };
          })()
        : {}),
    };
  }

  const failedStep = summary.steps.find((step) => step.status !== "passed");
  if (failedStep) {
    const stepEvidence = evidenceForPaths(evidence, failedStep.artifacts);
    const environmentLike = isEnvironmentFailure(failedStep.error);
    const boundary = FailureBoundarySchema.parse({
      kind: environmentLike ? "environment" : "surface-action",
      stepId: failedStep.stepId,
      message: failedStep.error ?? `Step ${failedStep.stepId} did not pass.`,
      evidence: stepEvidence,
      observedAt: summary.endedAt ?? summary.startedAt,
    });
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-step-${failedStep.stepId}`,
        severity: environmentLike ? "medium" : "low",
        category: environmentLike ? "environment" : "test",
        status: "suspected",
        title: environmentLike ? "Test environment prevented execution" : "Surface step did not complete",
        message: boundary.message,
        evidence: stepEvidence,
        createdAt: boundary.observedAt,
      }),
    };
  }

  if (summary.verdict === "blocked" || summary.verdict === "cancelled") {
    const boundary = FailureBoundarySchema.parse({
      kind: "environment",
      message: summary.findings.join("; ") || `Run ended with verdict ${summary.verdict}.`,
      evidence: evidence.slice(0, 4),
      observedAt: summary.endedAt ?? summary.startedAt,
    });
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-${summary.verdict}`,
        severity: "medium",
        category: "environment",
        status: "confirmed",
        title: `Run ${summary.verdict}`,
        message: boundary.message,
        evidence: boundary.evidence,
        createdAt: boundary.observedAt,
      }),
    };
  }

  const boundary = FailureBoundarySchema.parse({
    kind: "evidence",
    message: "The run did not produce enough independent evidence to classify its outcome.",
    evidence: evidence.slice(0, 4),
    observedAt: summary.endedAt ?? summary.startedAt,
  });
  return {
    boundary,
    finding: FindingSchema.parse({
      findingId: `finding-${summary.runId}-inconclusive`,
      severity: "low",
      category: "test",
      status: "unverified",
      title: "Run outcome is inconclusive",
      message: boundary.message,
      evidence: boundary.evidence,
      createdAt: boundary.observedAt,
    }),
  };
}

function createDiagnosis(summary: RunSummary, boundary: FailureBoundary, finding: Finding | undefined, observations: Observation[] | undefined): Diagnosis {
  const sourceLocations = observations?.flatMap((observation) => {
    const values = observation.data.sourceLocations;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  }) ?? [];
  return {
    diagnosisId: `diagnosis-${summary.runId}`,
    summary: finding
      ? `${finding.title}: ${boundary.message}`
      : `A surface assertion failed: ${boundary.message}`,
    confidence: sourceLocations.length > 0 ? 0.92 : 0.82,
    likelyOwner: sourceLocations.length > 0 ? "project implementation" : "surface or business workflow",
    sourceLocations: [...new Set(sourceLocations)],
    evidence: boundary.evidence,
    createdAt: boundary.observedAt,
  };
}

function createRepairSuggestion(summary: RunSummary, boundary: FailureBoundary, diagnosis: Diagnosis): RepairSuggestion {
  const owner = diagnosis.sourceLocations.length > 0
    ? `Inspect ${diagnosis.sourceLocations.join(", ")} first.`
    : "Trace the implementation boundary named by the linked business or surface evidence.";
  return {
    suggestionId: `repair-${summary.runId}`,
    title: "Repair the failing product boundary and add a regression check",
    rationale: `${owner} The proposed change is based on the confirmed evidence attached to the diagnosis; it must be replayed before being marked verified.`,
    changes: [
      owner,
      "Correct the state transition or response that violates the observed success criterion.",
      "Add a deterministic regression assertion for the same boundary and replay the mission.",
    ],
    confidence: diagnosis.confidence,
    evidence: boundary.evidence,
    status: "proposed",
  };
}

function evidenceForAssertion(summary: RunSummary, evidence: EvidenceRef[], assertionEvidence: string[]): EvidenceRef[] {
  const direct = evidenceForPaths(evidence, assertionEvidence);
  if (direct.length > 0) return direct;
  const lastStep = [...summary.steps].reverse().find((step) => step.status === "passed" && step.artifacts.length > 0);
  return lastStep ? evidenceForPaths(evidence, lastStep.artifacts).slice(0, 4) : [];
}

function evidenceForPaths(evidence: EvidenceRef[], paths: string[]): EvidenceRef[] {
  if (paths.length === 0) return [];
  return evidence.filter((item) => paths.some((path) => item.path === path || item.path.endsWith(path) || path.endsWith(item.path)));
}

function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(evidence.map((item) => [item.evidenceId, item])).values()];
}

function isEnvironmentFailure(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return ["blocked", "not registered", "requires ", "timed out", "timeout", "connection refused", "unavailable", "outside the configured", "cancelled"].some((marker) => value.includes(marker));
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "oracle";
}
