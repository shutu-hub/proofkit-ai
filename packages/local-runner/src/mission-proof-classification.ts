import { MissionProofClassificationSchema, type MissionProofClassification, type RunSummary, type TestMission } from "@proofkit/contracts";

const MAX_AUDIT_RUNS = 256;
const MAX_VISIBLE_RUN_IDS = 10;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

/** Recheck saved Run classification without changing its Mission's historical verdict. */
export async function auditMissionProofClassification(
  mission: Pick<TestMission, "observations"> & Partial<Pick<TestMission, "findings">>,
  loadRun: (runId: string) => Promise<RunSummary>,
): Promise<MissionProofClassification> {
  const runObservations = mission.observations.filter((item) => item.kind === "surface.run");
  const identifiers = runObservations.map((item) => item.data.runId);
  const validIds = [...new Set(identifiers.filter((value): value is string => typeof value === "string" && RUN_ID.test(value)))];
  const requiredRunIds = new Set(runObservations.filter((item) => item.data.runKind !== "negative")
    .map((item) => item.data.runId).filter((value): value is string => typeof value === "string" && RUN_ID.test(value)));
  const invalidRuns = identifiers.length - identifiers.filter((value) => typeof value === "string" && RUN_ID.test(value)).length;
  const inspected = validIds.slice(0, MAX_AUDIT_RUNS);
  const inspectedIds = new Set(inspected);
  const omittedRuns = Math.max(0, validIds.length - inspected.length);
  const runBusinessEvidenceIds = new Map<string, Set<string>>();
  for (const observation of runObservations) {
    const id = observation.data.runId;
    if (typeof id !== "string" || !inspectedIds.has(id)) continue;
    const ids = runBusinessEvidenceIds.get(id) ?? new Set<string>();
    for (const ref of observation.evidence) {
      if (ref.kind === "business" && ref.sha256) ids.add(ref.evidenceId);
    }
    runBusinessEvidenceIds.set(id, ids);
  }
  let checkedRuns = 0;
  let classifiedOracles = 0;
  let businessOracles = 0;
  let passedBusinessOracles = 0;
  let failedBusinessOracles = 0;
  let httpContractOracles = 0;
  let legacyOracles = 0;
  let unavailableRuns = invalidRuns;
  const legacyRunIds: string[] = [];
  const unavailableRunIds: string[] = [];
  const runBusinessProof = new Map<string, { passed: number; failedSourceEvidenceIds: Set<string> }>();
  for (const id of inspected) {
    try {
      const run = await loadRun(id);
      if (run.runId !== id) throw new Error("Run identity mismatch");
      checkedRuns++;
      let passedBusiness = 0;
      const failedSourceEvidenceIds = new Set<string>();
      for (const oracle of run.oracles) {
        if (oracle.verificationKind === "business" || oracle.verificationKind === "http-contract") {
          classifiedOracles++;
          if (oracle.verificationKind === "business") {
            businessOracles++;
            if (oracle.passed) {
              passedBusinessOracles++;
              if ((oracle.sourceEvidenceCount ?? 0) > 0
                && (oracle.sourceEvidenceArtifacts ?? []).some((artifact) => runBusinessEvidenceIds.get(id)?.has(`${id}:${artifact}`))) {
                passedBusiness++;
              }
            } else {
              failedBusinessOracles++;
              if ((oracle.sourceEvidenceCount ?? 0) > 0) {
                for (const artifact of oracle.sourceEvidenceArtifacts ?? []) failedSourceEvidenceIds.add(`${id}:${artifact}`);
              }
            }
          } else {
            httpContractOracles++;
          }
        } else {
          legacyOracles++;
          if (legacyRunIds.length < MAX_VISIBLE_RUN_IDS && !legacyRunIds.includes(id)) legacyRunIds.push(id);
        }
      }
      runBusinessProof.set(id, { passed: passedBusiness, failedSourceEvidenceIds });
    } catch {
      unavailableRuns++;
      if (unavailableRunIds.length < MAX_VISIBLE_RUN_IDS) unavailableRunIds.push(id);
    }
  }
  const evidenceRuns = new Map<string, Set<string>>();
  for (const observation of runObservations) {
    const id = observation.data.runId;
    if (typeof id !== "string" || !inspectedIds.has(id)) continue;
    for (const evidence of observation.evidence) {
      const key = evidenceIdentity(evidence);
      const owners = evidenceRuns.get(key) ?? new Set<string>();
      owners.add(id);
      evidenceRuns.set(key, owners);
    }
  }
  const confirmedFindings = (mission.findings ?? []).filter((finding) => finding.category === "product" && finding.status === "confirmed");
  const unlinkedFindingIds: string[] = [];
  let findingsLinkedToFailingBusiness = 0;
  for (const finding of confirmedFindings) {
    let owners: Set<string> | undefined;
    for (const evidence of finding.evidence) {
      const matching = evidenceRuns.get(evidenceIdentity(evidence)) ?? new Set<string>();
      owners = owners === undefined ? new Set(matching) : new Set([...owners].filter((id) => matching.has(id)));
    }
    const owner = owners?.size === 1 ? [...owners][0] : undefined;
    const failedSources = owner ? runBusinessProof.get(owner)?.failedSourceEvidenceIds : undefined;
    if (owner && failedSources && finding.evidence.some((item) => item.kind === "business" && failedSources.has(item.evidenceId))) {
      findingsLinkedToFailingBusiness++;
    } else if (unlinkedFindingIds.length < MAX_VISIBLE_RUN_IDS) {
      unlinkedFindingIds.push(finding.findingId);
    }
  }
  const requiredRunsWithPassingBusiness = [...requiredRunIds].filter((id) => (runBusinessProof.get(id)?.passed ?? 0) > 0).length;
  return MissionProofClassificationSchema.parse({
    status: legacyOracles || unavailableRuns || omittedRuns ? "unverified"
      : classifiedOracles ? "explicit" : "not-applicable",
    checkedRuns,
    classifiedOracles,
    businessOracles,
    passedBusinessOracles,
    failedBusinessOracles,
    httpContractOracles,
    requiredBusinessRuns: requiredRunIds.size,
    requiredRunsWithPassingBusiness,
    confirmedProductFindings: confirmedFindings.length,
    findingsLinkedToFailingBusiness,
    unlinkedFindingIds,
    omittedUnlinkedFindingIds: confirmedFindings.length - findingsLinkedToFailingBusiness - unlinkedFindingIds.length,
    legacyOracles,
    unavailableRuns,
    omittedRuns,
    legacyRunIds,
    unavailableRunIds,
  });
}

function evidenceIdentity(ref: TestMission["evidence"][number]): string {
  return JSON.stringify([ref.evidenceId, ref.path, ref.sha256 ?? null]);
}
