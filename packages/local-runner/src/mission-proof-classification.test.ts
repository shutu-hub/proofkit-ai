import { describe, expect, it } from "vitest";
import { FindingSchema, ObservationSchema, type EvidenceRef, type RunSummary } from "@proofkit/contracts";
import { auditMissionProofClassification } from "./mission-proof-classification.js";

const observedAt = "2026-10-10T00:00:00.000Z";
const observation = (runId: string, evidence: EvidenceRef[] = [], runKind = "primary") => ObservationSchema.parse({
  observationId: `observation-${runId}`, source: "surface", kind: "surface.run",
  data: { runId, surface: "web", runKind, verdict: "passed" }, evidence, observedAt,
});
const ref = (runId: string, artifact = "source.json"): EvidenceRef => ({
  evidenceId: `${runId}:${runId}/artifacts/${artifact}`, kind: "business",
  path: `/runs/${runId}/artifacts/${artifact}`, sha256: "a".repeat(64), capturedAt: observedAt,
});
const run = (runId: string, verificationKind?: "business" | "http-contract", passed = true): RunSummary => ({
  runId, startedAt: observedAt, status: "completed", verdict: "passed",
  charter: {} as RunSummary["charter"], steps: [], assertions: [],
  oracles: [{ name: "check", passed, message: "observed", evidence: [],
    ...(verificationKind ? { verificationKind } : {}),
    ...(verificationKind === "business" ? { sourceEvidenceCount: 1, sourceEvidenceArtifacts: [`${runId}/artifacts/source.json`] } : {}) }],
  artifacts: [], findings: [],
});

describe("saved Mission proof classification", () => {
  it("distinguishes explicitly classified Runs from historical Oracle results", async () => {
    const mission = { observations: [observation("current-business"), observation("current-status"), observation("legacy")] };
    const runs = new Map([run("current-business", "business"), run("current-status", "http-contract"), run("legacy")]
      .map((value) => [value.runId, value]));
    const audit = await auditMissionProofClassification(mission, async (id) => runs.get(id)!);
    expect(audit).toMatchObject({ status: "unverified", checkedRuns: 3, classifiedOracles: 2,
      businessOracles: 1, passedBusinessOracles: 1, failedBusinessOracles: 0, httpContractOracles: 1,
      legacyOracles: 1, unavailableRuns: 0, legacyRunIds: ["legacy"] });
    const current = await auditMissionProofClassification({ observations: mission.observations.slice(0, 2) }, async (id) => runs.get(id)!);
    expect(current).toMatchObject({ status: "explicit", checkedRuns: 2, classifiedOracles: 2,
      businessOracles: 1, passedBusinessOracles: 1, failedBusinessOracles: 0, httpContractOracles: 1,
      requiredBusinessRuns: 2, requiredRunsWithPassingBusiness: 1, legacyOracles: 0 });
  });

  it("links each confirmed finding to a failing business Oracle in the same Run", async () => {
    const businessRef = ref("business-run");
    const statusRef = ref("status-run");
    const observations = [observation("business-run", [businessRef]), observation("status-run", [statusRef])];
    const runs = new Map([run("business-run", "business", false), run("status-run", "http-contract", false)]
      .map((value) => [value.runId, value]));
    const finding = (evidence: EvidenceRef[]) => FindingSchema.parse({ findingId: "binding-defect", category: "product",
      status: "confirmed", severity: "high", title: "Wrong binding", message: "Observed mismatch", evidence, createdAt: observedAt });
    const load = async (id: string) => runs.get(id)!;
    const borrowed = await auditMissionProofClassification({ observations, findings: [finding([statusRef])] }, load);
    expect(borrowed).toMatchObject({ status: "explicit", confirmedProductFindings: 1,
      findingsLinkedToFailingBusiness: 0, unlinkedFindingIds: ["binding-defect"] });
    const linked = await auditMissionProofClassification({ observations, findings: [finding([businessRef])] }, load);
    expect(linked).toMatchObject({ status: "explicit", confirmedProductFindings: 1,
      findingsLinkedToFailingBusiness: 1, unlinkedFindingIds: [] });
    const unrelated = ref("business-run", "unrelated.json");
    const sameRunUnrelated = await auditMissionProofClassification({
      observations: [observation("business-run", [businessRef, unrelated]), observation("status-run", [statusRef])],
      findings: [finding([unrelated])],
    }, load);
    expect(sameRunUnrelated).toMatchObject({ findingsLinkedToFailingBusiness: 0, unlinkedFindingIds: ["binding-defect"] });
  });

  it("separates failed business checks from passing business and HTTP-contract checks", async () => {
    const runs = new Map([run("failed-business", "business", false), run("passed-status", "http-contract")]
      .map((value) => [value.runId, value]));
    const audit = await auditMissionProofClassification({ observations: [observation("failed-business"), observation("passed-status")] },
      async (id) => runs.get(id)!);
    expect(audit).toMatchObject({ status: "explicit", businessOracles: 1, passedBusinessOracles: 0,
      failedBusinessOracles: 1, httpContractOracles: 1 });
  });

  it("keeps missing or mismatched Run summaries unverified without re-running them", async () => {
    const requested: string[] = [];
    const audit = await auditMissionProofClassification({ observations: [observation("available"), observation("missing"), observation("wrong")] }, async (id) => {
      requested.push(id);
      if (id === "missing") throw new Error("not found");
      return run(id === "wrong" ? "foreign" : id, "business");
    });
    expect(requested).toEqual(["available", "missing", "wrong"]);
    expect(audit).toMatchObject({ status: "unverified", checkedRuns: 1, classifiedOracles: 1,
      unavailableRuns: 2, unavailableRunIds: ["missing", "wrong"] });
    expect(await auditMissionProofClassification({ observations: [] }, async () => { throw new Error("unexpected"); }))
      .toMatchObject({ status: "not-applicable", checkedRuns: 0 });
  });

  it("bounds the audit and refuses an explicit-proof claim for omitted Runs", async () => {
    const observations = Array.from({ length: 258 }, (_, index) => observation(`run-${index}`));
    let reads = 0;
    const audit = await auditMissionProofClassification({ observations }, async (id) => {
      reads++;
      return run(id, "business");
    });
    expect(reads).toBe(256);
    expect(audit).toMatchObject({ status: "unverified", checkedRuns: 256, classifiedOracles: 256,
      omittedRuns: 2, legacyOracles: 0, unavailableRuns: 0 });
  });
});
