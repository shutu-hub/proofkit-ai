import {
  ProjectMapSchema, ProofkitConfigSchema, WorkflowReviewAuditSchema, workflowChecks, suiteChecks,
  type TestMission, type WorkflowExecutionCoverage, type WorkflowReviewAudit, type WorkflowReviewAuthentication,
} from "@proofkit/contracts";
import {
  authenticateWorkflowReview, auditWorkflowCandidates, loadWorkflowReviewTrust,
  workflowCandidateSetSha256, workflowCharterExecutionSha256, workflowReviewDigests,
} from "@proofkit/project";

const unverified = (reason: NonNullable<WorkflowReviewAudit["reason"]>): WorkflowReviewAudit =>
  WorkflowReviewAuditSchema.parse({ status: "unverified", reason });

/** Recheck the frozen, source-bound review against this Mission's saved project map and suite. */
export async function auditWorkflowReview(mission: TestMission, execution?: WorkflowExecutionCoverage,
  trustedPublicKeys?: Readonly<Record<string, string>>): Promise<WorkflowReviewAudit> {
  if (mission.plan.planning?.coverage?.requested !== "project") return { status: "not-applicable" };
  if (mission.level === "quick") return unverified("surface-only");
  const inventory = mission.workflowInventory;
  const inspection = mission.workflowInventoryInspection;
  const snapshot = mission.workflowReview;
  if (!inventory || !inspection?.candidateAudit || !snapshot) return unverified("missing-frozen-review");
  const candidate = inspection.candidateAudit;
  if (inspection.status !== "loaded" || inspection.sourceMatch !== "matching" || !inspection.reviewDeclared
    || inspection.workflowCount !== inventory.workflows.length || inspection.linkedWorkflowCount !== inventory.workflows.length
    || inventory.exclusions.length || inspection.exclusionCount || inspection.missingCharterIds.length
    || inspection.uncoveredSurfaces.length || inspection.missingSourcePaths.length || inspection.omittedIssues
    || inspection.omittedMissingCharterIds || inspection.omittedUncoveredSurfaces || inspection.omittedMissingSourcePaths
    || inspection.issues.some((issue) => issue !== "workflow-inventory-completeness-unverified")
    || candidate.status !== "scanned" || candidate.routeCandidates + candidate.entryCandidates === 0
    || candidate.excluded || candidate.unclaimed || candidate.unlinkedRoutes || candidate.overlappingExclusions
    || candidate.unresolvedRouteDeclarations || candidate.skippedCandidates || candidate.gaps.length || candidate.omittedGaps) {
    return unverified("inventory-gaps");
  }
  if (!["completed", "failed", "blocked", "cancelled"].includes(mission.status)
    && !mission.observations.some((item) => item.kind === "project.discovered")) {
    return unverified("execution-incomplete");
  }
  const mapObservations = mission.observations.filter((item) => item.kind === "project.discovered" && item.source === "planner");
  const map = mapObservations.length === 1 ? ProjectMapSchema.safeParse(mapObservations[0]!.data) : undefined;
  if (!map?.success || workflowCandidateSetSha256(map.data) !== snapshot.materials.candidateSetSha256) {
    return unverified("candidate-mismatch");
  }
  const manifest = snapshot.materials.charterManifest;
  try {
    const catalog = ProofkitConfigSchema.parse({ charters: manifest.map((item) => item.catalog) });
    const measured = auditWorkflowCandidates(map.data, inventory, catalog);
    if (workflowReviewDigests(inventory, measured, snapshot.materials).candidateSha256 !== snapshot.attestation.candidateSha256) {
      return unverified("candidate-mismatch");
    }
  } catch { return unverified("review-invalid"); }
  const suite = mission.suite;
  if (!suite || suite.origin !== "workflow-inventory" || suite.uncoveredCharterIds.length) return unverified("suite-mismatch");
  const expectedPairs = inventory.workflows.flatMap((workflow) => workflowChecks(workflow)
    .flatMap((check) => check.surfaces.map((surface) => `${check.charterId}/${surface}`))).sort();
  const actualPairs = suiteChecks(suite).map((check) => `${check.charterId}/${check.surface}`).sort();
  if (expectedPairs.length !== actualPairs.length || expectedPairs.some((pair, index) => pair !== actualPairs[index])) {
    return unverified("suite-mismatch");
  }
  const signedIds = manifest.map((item) => item.id).sort();
  const suiteIds = suite.charters.map((item) => item.charterId).sort();
  if (signedIds.length !== suiteIds.length || signedIds.some((id, index) => id !== suiteIds[index])) {
    return unverified("suite-mismatch");
  }
  for (const item of suite.charters) {
    const signed = manifest.find((entry) => entry.id === item.charterId);
    if (!signed || workflowCharterExecutionSha256(item.charter) !== signed.executionSha256
      || JSON.stringify(item.routeTargets ?? []) !== JSON.stringify(signed.catalog.routeTargets ?? [])) {
      return unverified("charter-mismatch");
    }
  }
  const keys = trustedPublicKeys ?? await loadWorkflowReviewTrust(mission.projectRoot, mission.workspaceRoot ?? mission.projectRoot);
  let auth: WorkflowReviewAuthentication;
  try { auth = authenticateWorkflowReview(inventory, candidate, snapshot.materials, snapshot.attestation, keys); }
  catch { return unverified("review-invalid"); }
  if (auth.status === "untrusted") return unverified("review-untrusted");
  if (auth.status !== "verified") return unverified("review-invalid");
  if (!execution) return unverified("execution-incomplete");
  if (execution.sourceBinding !== "matching") return unverified("source-mismatch");
  if (execution.status !== "all-declared-evidenced" || execution.requiredProof !== "business"
    || execution.requiredChecks !== expectedPairs.length || execution.evidencedChecks !== expectedPairs.length
    || execution.gaps.length || execution.omittedGaps || execution.suiteId !== suite.suiteId) {
    return unverified("execution-incomplete");
  }
  return WorkflowReviewAuditSchema.parse({ status: "verified", keyId: auth.keyId, scope: "reviewed-source-workflows" });
}
