import { MissionProofClassificationSchema, type MissionProofClassification, type RunSummary, type TestMission } from "@proofkit/contracts";

const MAX_AUDIT_RUNS = 256;
const MAX_VISIBLE_RUN_IDS = 10;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

/** Recheck saved Run classification without changing its Mission's historical verdict. */
export async function auditMissionProofClassification(
  mission: Pick<TestMission, "observations">,
  loadRun: (runId: string) => Promise<RunSummary>,
): Promise<MissionProofClassification> {
  const identifiers = mission.observations.filter((item) => item.kind === "surface.run")
    .map((item) => item.data.runId);
  const validIds = [...new Set(identifiers.filter((value): value is string => typeof value === "string" && RUN_ID.test(value)))];
  const invalidRuns = identifiers.length - identifiers.filter((value) => typeof value === "string" && RUN_ID.test(value)).length;
  const inspected = validIds.slice(0, MAX_AUDIT_RUNS);
  const omittedRuns = Math.max(0, validIds.length - inspected.length);
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
  for (const id of inspected) {
    try {
      const run = await loadRun(id);
      if (run.runId !== id) throw new Error("Run identity mismatch");
      checkedRuns++;
      for (const oracle of run.oracles) {
        if (oracle.verificationKind === "business" || oracle.verificationKind === "http-contract") {
          classifiedOracles++;
          if (oracle.verificationKind === "business") {
            businessOracles++;
            if (oracle.passed) passedBusinessOracles++;
            else failedBusinessOracles++;
          } else {
            httpContractOracles++;
          }
        } else {
          legacyOracles++;
          if (legacyRunIds.length < MAX_VISIBLE_RUN_IDS && !legacyRunIds.includes(id)) legacyRunIds.push(id);
        }
      }
    } catch {
      unavailableRuns++;
      if (unavailableRunIds.length < MAX_VISIBLE_RUN_IDS) unavailableRunIds.push(id);
    }
  }
  return MissionProofClassificationSchema.parse({
    status: legacyOracles || unavailableRuns || omittedRuns ? "unverified"
      : classifiedOracles ? "explicit" : "not-applicable",
    checkedRuns,
    classifiedOracles,
    businessOracles,
    passedBusinessOracles,
    failedBusinessOracles,
    httpContractOracles,
    legacyOracles,
    unavailableRuns,
    omittedRuns,
    legacyRunIds,
    unavailableRunIds,
  });
}
