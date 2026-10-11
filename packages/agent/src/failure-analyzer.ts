import {
  FailureBoundarySchema,
  FindingSchema,
  type Diagnosis,
  type EvidenceRef,
  type FailureBoundary,
  type Finding,
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
  /** Repository-relative file hints checked against the selected source root by the caller. */
  verifiedSourceLocations?: string[];
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
  const runtimeFindings = summary.runtimeFindings ?? [];

  if (summary.verdict === "passed" && runtimeFindings.length === 0) return {};

  // An Oracle's facts may be real, but a changed or unverified listener means
  // they cannot be attributed to the tested source throughout this Run.
  const continuityGap = summary.verdict === "inconclusive" && (
    summary.targetContinuity === "changed" || summary.targetContinuity === "unverified"
    || summary.applicationContinuity === "changed" || summary.applicationContinuity === "unverified"
    || summary.integrationPostRunCheck?.passed === false);
  if (continuityGap) {
    const paths = summary.artifacts.filter((path) => /\/(?:post-run-check|target-binding-after-run|application-binding-after-run)\.json$/.test(path));
    const boundaryEvidence = evidenceForPaths(evidence, paths, summary.runId);
    const message = "The tested application or integration endpoint could not be associated with one stable process through Run completion.";
    const boundary = FailureBoundarySchema.parse({ kind: "environment", message,
      evidence: boundaryEvidence, observedAt: summary.endedAt ?? summary.startedAt });
    return { boundary, finding: FindingSchema.parse({
      findingId: `finding-${summary.runId}-endpoint-continuity`, severity: "high", category: "environment",
      status: "unverified", title: "Test endpoint continuity was not established", message,
      evidence: boundaryEvidence, createdAt: boundary.observedAt,
    }) };
  }

  const environmentBlocker = summary.verdict === "blocked"
    ? runtimeFindings.find((finding) => finding.category === "environment" && finding.status === "confirmed" && finding.affectsVerdict)
    : undefined;
  if (environmentBlocker) {
    const blockerEvidence = evidenceForPaths(evidence, environmentBlocker.evidence, summary.runId);
    const blockerMessage = `Configured environment blocker observed in a ${environmentBlocker.eventType} event. Inspect the linked run evidence for its bounded diagnostic.`;
    const boundary = FailureBoundarySchema.parse({
      kind: "environment",
      message: blockerMessage,
      evidence: blockerEvidence,
      observedAt: environmentBlocker.observedAt,
    });
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-environment-blocker`,
        severity: "high",
        category: "environment",
        status: "confirmed",
        title: "Configured test environment blocker observed",
        message: blockerMessage,
        evidence: blockerEvidence,
        createdAt: boundary.observedAt,
      }),
    };
  }

  // The first observed mismatch and the first supported product Finding
  // serve different purposes. Runner execution order is steps -> assertions
  // -> Oracles; an earlier UI failure must not be relabelled as a later Oracle.
  const firstObservedFailure = earliestRunFailure(summary, evidence);
  const failedOracle = selectEvidencedBusinessFailure(summary, evidence)
    ?? summary.oracles.find((oracle) => oracle.verificationKind !== "http-contract" && oracle.passed === false);
  if (failedOracle) {
    const oracleEvidence = businessSourceEvidence(summary, evidence, failedOracle);
    const boundary = FailureBoundarySchema.parse({
      kind: "business-oracle",
      oracleName: failedOracle.name,
      message: failedOracle.message,
      evidence: oracleEvidence,
      observedAt: failedOracle.recordedAt ?? failedOracle.observedAt ?? summary.endedAt ?? summary.startedAt,
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
      const diagnosis = createDiagnosis(summary, boundary, finding, input.verifiedSourceLocations);
      return { boundary: firstObservedFailure ?? boundary, finding, diagnosis,
        repairSuggestion: createRepairSuggestion(summary, boundary, diagnosis) };
    }
    return {
      boundary: firstObservedFailure ?? boundary,
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

  const failedHttpContract = summary.oracles.find((oracle) => oracle.verificationKind === "http-contract" && oracle.passed === false);
  if (failedHttpContract) {
    const contractEvidence = evidenceForPaths(evidence, failedHttpContract.sourceEvidenceArtifacts ?? [], summary.runId);
    const observedAt = failedHttpContract.recordedAt ?? failedHttpContract.observedAt ?? summary.endedAt ?? summary.startedAt;
    const boundary = FailureBoundarySchema.parse({
      kind: "evidence",
      message: failedHttpContract.message,
      evidence: contractEvidence,
      observedAt,
    });
    return {
      boundary: firstObservedFailure ?? boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-http-contract-${safeId(failedHttpContract.name)}`,
        severity: "medium",
        category: "unknown",
        status: contractEvidence.length > 0 ? "confirmed" : "unverified",
        title: "HTTP contract mismatch observed",
        message: failedHttpContract.message,
        evidence: contractEvidence,
        createdAt: observedAt,
      }),
    };
  }

  const failedAssertionIndex = summary.assertions.findIndex((assertion) => !assertion.passed);
  const failedAssertion = summary.assertions[failedAssertionIndex];
  if (failedAssertion) {
    const assertionEvidence = evidenceForAssertion(summary, evidence, failedAssertion.evidence, failedAssertionIndex);
    const boundary = firstObservedFailure ?? FailureBoundarySchema.parse({
      kind: "assertion", message: failedAssertion.message, evidence: assertionEvidence,
      observedAt: failedAssertion.recordedAt ?? summary.endedAt ?? summary.startedAt,
    });
    const confirmed = assertionEvidence.length > 0;
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-assertion`,
        severity: confirmed ? "high" : "medium",
        // The observation proves a Charter mismatch, not whether product code,
        // authentication, environment setup, or the test expectation caused it.
        category: "unknown",
        status: confirmed ? "confirmed" : "unverified",
        title: confirmed ? "Surface assertion mismatch observed" : "Assertion failed without evidence",
        message: failedAssertion.message,
        evidence: assertionEvidence,
        createdAt: boundary.observedAt,
      }),
      ...(confirmed
        ? (() => {
            const diagnosis = createDiagnosis(summary, boundary, undefined, input.verifiedSourceLocations);
            return { diagnosis, repairSuggestion: createRepairSuggestion(summary, boundary, diagnosis) };
          })()
        : {}),
    };
  }

  const failedStep = summary.steps.find((step) => step.status !== "passed");
  if (failedStep) {
    const stepEvidence = evidenceForPaths(evidence, failedStep.artifacts, summary.runId);
    const environmentLike = isEnvironmentFailure(failedStep.error);
    const observationGap = summary.verdict === "inconclusive" && failedStep.action.kind === "captureResponse";
    const boundary = FailureBoundarySchema.parse({
      kind: observationGap ? "evidence" : environmentLike ? "environment" : "surface-action",
      stepId: failedStep.stepId,
      message: failedStep.error ?? `Step ${failedStep.stepId} did not pass.`,
      evidence: stepEvidence,
      observedAt: summary.endedAt ?? summary.startedAt,
    });
    return {
      boundary,
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-step-${failedStep.stepId}`,
        severity: observationGap ? "low" : environmentLike ? "medium" : "low",
        category: observationGap ? "test" : environmentLike ? "environment" : "test",
        status: observationGap ? "unverified" : "suspected",
        title: observationGap ? "Action response evidence is incomplete" : environmentLike ? "Test environment prevented execution" : "Surface step did not complete",
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

  if (runtimeFindings.length > 0) {
    const runtimeEvidence = uniqueEvidence(runtimeFindings.flatMap((finding) =>
      evidenceForPaths(evidence, finding.evidence, summary.runId)));
    const messages = runtimeFindings.slice(0, 5).map((finding) => finding.message);
    const omitted = runtimeFindings.length - messages.length;
    const message = `Runtime signals were observed${messages.length > 0 ? `: ${messages.join("; ")}` : "."}${omitted > 0 ? ` (${omitted} more finding(s) omitted).` : ""}`;
    const observedAt = runtimeFindings.at(-1)?.observedAt ?? summary.endedAt ?? summary.startedAt;
    const boundary = FailureBoundarySchema.parse({
      kind: "environment",
      message,
      evidence: runtimeEvidence,
      observedAt,
    });
    return {
      ...(summary.verdict === "passed" ? {} : { boundary }),
      finding: FindingSchema.parse({
        findingId: `finding-${summary.runId}-runtime`,
        severity: runtimeFindings.some((item) => item.severity === "critical" || item.severity === "high") ? "high" : "medium",
        category: "environment",
        status: "suspected",
        title: "Runtime health signal observed",
        message,
        evidence: runtimeEvidence,
        createdAt: observedAt,
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

/** Select the first failed business Oracle whose own source facts survived evidence capture. */
export function selectEvidencedBusinessFailure(summary: RunSummary, evidence: EvidenceRef[]): RunSummary["oracles"][number] | undefined {
  return summary.oracles.find((oracle) => oracle.verificationKind !== "http-contract" && oracle.passed === false
    && businessSourceEvidence(summary, evidence, oracle).length > 0);
}

function businessSourceEvidence(summary: RunSummary, evidence: EvidenceRef[], oracle: RunSummary["oracles"][number]): EvidenceRef[] {
  return oracle.sourceEvidenceCount && oracle.sourceEvidenceArtifacts?.length
    ? evidenceForPaths(evidence.filter((item) => item.kind === "business"), oracle.sourceEvidenceArtifacts, summary.runId)
    : [];
}

/** Execution order is authoritative; connector-supplied observedAt is not. */
function earliestRunFailure(summary: RunSummary, evidence: EvidenceRef[]): FailureBoundary | undefined {
  const index = summary.assertions.findIndex((assertion) => !assertion.passed);
  const assertion = summary.assertions[index];
  if (assertion) return FailureBoundarySchema.parse({
    kind: "assertion", message: assertion.message,
    evidence: evidenceForAssertion(summary, evidence, assertion.evidence, index),
    observedAt: assertion.recordedAt ?? summary.endedAt ?? summary.startedAt,
  });
  const oracle = summary.oracles.find((item) => item.passed === false);
  if (!oracle) return undefined;
  const contract = oracle.verificationKind === "http-contract";
  return FailureBoundarySchema.parse({
    kind: contract ? "evidence" : "business-oracle",
    ...(contract ? {} : { oracleName: oracle.name }),
    message: oracle.message,
    evidence: contract
      ? evidenceForPaths(evidence, oracle.sourceEvidenceArtifacts ?? [], summary.runId)
      : businessSourceEvidence(summary, evidence, oracle),
    observedAt: oracle.recordedAt ?? oracle.observedAt ?? summary.endedAt ?? summary.startedAt,
  });
}

function createDiagnosis(summary: RunSummary, boundary: FailureBoundary, finding: Finding | undefined, verifiedSourceLocations: string[] = []): Diagnosis {
  const sourceLocations = [...new Set(verifiedSourceLocations)];
  const surfaceMismatch = boundary.kind === "assertion";
  return {
    diagnosisId: `diagnosis-${summary.runId}`,
    summary: finding
      ? `${finding.title}: ${boundary.message}`
      : `A surface assertion failed: ${boundary.message}`,
    // This scores the observed failure boundary, not a source-level root cause.
    confidence: surfaceMismatch ? 0.75 : 0.82,
    likelyOwner: surfaceMismatch ? "undetermined: test setup, environment, or product UI" : "business workflow",
    sourceLocations,
    evidence: boundary.evidence,
    createdAt: boundary.observedAt,
  };
}

function createRepairSuggestion(summary: RunSummary, boundary: FailureBoundary, diagnosis: Diagnosis): RepairSuggestion {
  if (boundary.kind === "assertion") return {
    suggestionId: `repair-${summary.runId}`,
    title: "Investigate the observed UI mismatch",
    rationale: "The linked page observation confirms the assertion mismatch, but does not identify a product defect or its cause. Check authentication, test configuration, and expected UI state before changing product code.",
    changes: [
      "Check the test environment, authentication state, and Charter expectation against the linked page observation.",
      "If product behavior is wrong, identify the responsible implementation and add a regression assertion.",
      "Replay the same mission after the cause is addressed.",
    ],
    confidence: 0.35,
    evidence: boundary.evidence,
    status: "proposed",
  };
  const owner = diagnosis.sourceLocations.length > 0
    ? `Trace the failing boundary and inspect ${diagnosis.sourceLocations.join(", ")} as source hints; file existence does not establish cause.`
    : "Trace the implementation boundary named by the linked business or surface evidence; the source-level cause is unverified.";
  return {
    suggestionId: `repair-${summary.runId}`,
    title: "Repair the failing product boundary and add a regression check",
    rationale: `${owner} The linked evidence establishes the observed failure, not the code change needed to fix it. Replay the mission after any repair.`,
    changes: [
      owner,
      "Identify and correct the cause of the observed state or response mismatch.",
      "Add a deterministic regression assertion for the same boundary and replay the mission.",
    ],
    confidence: 0.45,
    evidence: boundary.evidence,
    status: "proposed",
  };
}

function evidenceForAssertion(summary: RunSummary, evidence: EvidenceRef[], assertionEvidence: string[], index: number): EvidenceRef[] {
  const label = `assertion-${String(index + 1).padStart(3, "0")}`;
  const allowed = new Set([`${summary.runId}/artifacts/${label}-snapshot.json`, `${summary.runId}/artifacts/${label}.png`]);
  return evidenceForPaths(evidence, assertionEvidence.filter((path) => allowed.has(path.replaceAll("\\", "/"))), summary.runId);
}

function evidenceForPaths(evidence: EvidenceRef[], paths: string[], runId: string): EvidenceRef[] {
  const matched = new Map<string, EvidenceRef>();
  for (const path of paths) {
    const requested = path.replaceAll("\\", "/");
    if (requested.split("/").some((segment) => segment === "." || segment === "..")) continue;
    const runRelative = requested.startsWith(`${runId}/`);
    const absolute = requested.startsWith("/") || /^[A-Za-z]:\//.test(requested);
    if (!runRelative && !absolute) continue;
    const candidates = evidence.filter((item) => {
      const actual = item.path.replaceAll("\\", "/");
      return actual === requested || (runRelative && actual.endsWith(`/${requested}`));
    });
    // A basename or ambiguous suffix is not sufficient to confirm a bug.
    if (candidates.length === 1) matched.set(candidates[0]!.evidenceId, candidates[0]!);
  }
  return [...matched.values()];
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
