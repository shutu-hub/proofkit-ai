import { describe, expect, it } from "vitest";
import { ObservationSchema, type RunSummary } from "@proofkit/contracts";
import { auditMissionProofClassification } from "./mission-proof-classification.js";

const observedAt = "2026-10-10T00:00:00.000Z";
const observation = (runId: string) => ObservationSchema.parse({
  observationId: `observation-${runId}`, source: "surface", kind: "surface.run",
  data: { runId, surface: "web", runKind: "primary", verdict: "passed" }, observedAt,
});
const run = (runId: string, verificationKind?: "business" | "http-contract"): RunSummary => ({
  runId, startedAt: observedAt, status: "completed", verdict: "passed",
  charter: {} as RunSummary["charter"], steps: [], assertions: [],
  oracles: [{ name: "check", passed: true, message: "observed", evidence: [], ...(verificationKind ? { verificationKind } : {}) }],
  artifacts: [], findings: [],
});

describe("saved Mission proof classification", () => {
  it("distinguishes explicitly classified Runs from historical Oracle results", async () => {
    const mission = { observations: [observation("current-business"), observation("current-status"), observation("legacy")] };
    const runs = new Map([run("current-business", "business"), run("current-status", "http-contract"), run("legacy")]
      .map((value) => [value.runId, value]));
    const audit = await auditMissionProofClassification(mission, async (id) => runs.get(id)!);
    expect(audit).toMatchObject({ status: "unverified", checkedRuns: 3, classifiedOracles: 2,
      legacyOracles: 1, unavailableRuns: 0, legacyRunIds: ["legacy"] });
    const current = await auditMissionProofClassification({ observations: mission.observations.slice(0, 2) }, async (id) => runs.get(id)!);
    expect(current).toMatchObject({ status: "explicit", checkedRuns: 2, classifiedOracles: 2, legacyOracles: 0 });
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
