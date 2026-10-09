import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunSummarySchema, TestCharterSchema, TestMissionSchema, type EvidenceRef, type RunSummary, type TestCharter, type TestMission, type Verdict } from "@proofkit/contracts";
import { compareMissionRecords } from "./mission-comparison.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Mission repair comparison", () => {
  it("verifies only the same replay scope with a failed and then passing independent business fact", async () => {
    const fixture = await createFixture();
    const result = await fixture.compare();
    expect(result).toMatchObject({ status: "verified-in-scope", scopeMatched: true, baselineVerdict: "failed", candidateVerdict: "passed" });
    expect(result.defects).toEqual([expect.objectContaining({ oracleName: "resume-binding", outcome: "not-reproduced", baselineRunId: "before-primary", candidateRunId: "after-primary" })]);
    expect(result.defects[0]?.baselineEvidence[0]?.kind).toBe("business");
    expect(result.defects[0]?.candidateEvidence[0]?.kind).toBe("business");
    expect(result.runs).toEqual([expect.objectContaining({ surface: "web", runKind: "primary", baselineBusinessFacts: 1, candidateBusinessFacts: 1 })]);
    expect(result.reason).toContain("does not establish which source change");
  });

  it("reports the same defect when the replay Oracle still fails with source facts", async () => {
    const fixture = await createFixture({ candidateVerdict: "failed" });
    const result = await fixture.compare();
    expect(result.status).toBe("defect-reproduced");
    expect(result.defects[0]?.outcome).toBe("reproduced");
  });

  it("does not verify a changed Charter scope or an unrelated Mission", async () => {
    const fixture = await createFixture();
    fixture.candidate.charter = { ...fixture.candidate.charter!, intent: "test another workflow" };
    expect((await fixture.compare()).status).toBe("inconclusive");
    expect((await fixture.compare()).scopeMatched).toBe(false);
    fixture.candidate.charter = fixture.baseline.charter;
    fixture.candidate.replayOfMissionId = undefined;
    expect((await fixture.compare()).gaps).toContain("Candidate is not a direct replay of the baseline Mission.");
  });

  it("rejects an Oracle report that has lost either source artifact", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.evidenceDir, "before-primary", "artifacts", "oracle-source.json"));
    expect((await fixture.compare()).status).toBe("inconclusive");
    expect((await fixture.compare()).defects).toHaveLength(0);

    await writeFile(join(fixture.evidenceDir, "before-primary", "artifacts", "oracle-source.json"), '{"bound":false}');
    await rm(join(fixture.evidenceDir, "after-primary", "artifacts", "oracle-source.json"));
    const result = await fixture.compare();
    expect(result.status).toBe("inconclusive");
    expect(result.defects[0]?.outcome).toBe("unverified");
  });

  it("requires every declared negative case and release replay slot before verifying", async () => {
    const fixture = await createFixture({ negativeCase: true });
    const missingNegative = await fixture.compare();
    expect(missingNegative.status).toBe("inconclusive");
    expect(missingNegative.gaps.some((gap) => gap.includes("negative/duplicate"))).toBe(true);

    const negative = await writeRun(fixture.evidenceDir, fixture.candidate.charter!, "after-negative", "passed", { negativeCaseId: "duplicate" });
    fixture.candidate.observations.push(runObservation("after-negative", "passed", negative.ref, "negative", "duplicate"));
    expect((await fixture.compare()).status).toBe("verified-in-scope");

    fixture.baseline.plan.executionProfile.requireReplay = true;
    fixture.candidate.plan.executionProfile.requireReplay = true;
    const missingReplay = await fixture.compare();
    expect(missingReplay.status).toBe("inconclusive");
    expect(missingReplay.gaps.some((gap) => gap.includes("web/replay"))).toBe(true);
  });

  it("does not compare a still-running candidate as a verified repair", async () => {
    const fixture = await createFixture();
    fixture.candidate.status = "running";
    fixture.candidate.verdict = undefined;
    expect((await fixture.compare()).status).toBe("inconclusive");
  });
});

async function createFixture(options: { candidateVerdict?: Verdict; negativeCase?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-compare-"));
  roots.push(root);
  const evidenceDir = join(root, ".proofkit", "runs");
  const charter = TestCharterSchema.parse({
    intent: "verify resume binding", level: "core", mode: "deterministic", preconditions: [],
    actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Resume ready" }],
    oracles: ["resume-binding"], sideEffectPolicy: "deny", metadata: {},
    ...(options.negativeCase ? { negativeCases: [{ caseId: "duplicate", title: "Duplicate resume", actions: [{ kind: "observe" }], assertions: [], oracles: ["resume-binding"], sideEffectPolicy: "deny", metadata: {} }] } : {}),
  });
  const before = await writeRun(evidenceDir, charter, "before-primary", "failed");
  const after = await writeRun(evidenceDir, charter, "after-primary", options.candidateVerdict ?? "passed");
  const baseline = mission(root, "mission-before", charter, "failed", "failed", [runObservation("before-primary", "failed", before.ref)]);
  baseline.findings.push({ findingId: "binding-defect", severity: "high", category: "product", status: "confirmed", title: "Wrong candidate binding", message: "The saved relation points at another candidate.", evidence: [before.ref], createdAt: new Date().toISOString() });
  const candidateVerdict = options.candidateVerdict ?? "passed";
  const candidate = mission(root, "mission-after", charter, candidateVerdict === "passed" ? "completed" : "failed", candidateVerdict, [runObservation("after-primary", candidateVerdict, after.ref)]);
  candidate.replayOfMissionId = baseline.missionId;
  const compare = () => compareMissionRecords(baseline, candidate, evidenceDir, async (runId) => RunSummarySchema.parse(JSON.parse(await readFile(join(evidenceDir, runId, "run.json"), "utf8"))));
  return { root, evidenceDir, baseline, candidate, compare };
}

async function writeRun(evidenceDir: string, charter: TestCharter, runId: string, verdict: Verdict, options: { negativeCaseId?: string } = {}): Promise<{ ref: EvidenceRef }> {
  const runDir = join(evidenceDir, runId);
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const path = `${runId}/artifacts/oracle-source.json`;
  await writeFile(join(runDir, "artifacts", "oracle-source.json"), JSON.stringify({ bound: verdict === "passed" }));
  const now = new Date().toISOString();
  const summary: RunSummary = {
    runId, startedAt: now, endedAt: now, status: "completed", verdict,
    charter: options.negativeCaseId ? { ...charter, metadata: { ...charter.metadata, negativeCaseId: options.negativeCaseId }, assertions: [] } : charter,
    steps: [], assertions: options.negativeCaseId ? [] : [{ assertion: charter.assertions[0]!, passed: true, message: "visible", evidence: [] }],
    oracles: [{ name: "resume-binding", passed: verdict === "passed", message: verdict === "passed" ? "correct candidate" : "wrong candidate", evidence: [path], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [path], observedAt: now }],
    artifacts: [path], findings: [],
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(summary));
  const ref: EvidenceRef = { evidenceId: `${runId}:${path}`, kind: "business", path: resolve(evidenceDir, path), capturedAt: now };
  return { ref };
}

function runObservation(runId: string, verdict: Verdict, ref: EvidenceRef, runKind: "primary" | "negative" = "primary", negativeCaseId?: string) {
  return {
    observationId: `observation-${runId}`, source: "surface" as const, kind: "surface.run", observedAt: new Date().toISOString(),
    data: { runId, surface: "web", runKind, negativeCaseId, verdict, ...(runKind === "negative" ? { expectedVerdict: "passed", outcomeMatched: true } : {}) },
    evidence: [ref],
  };
}

function mission(root: string, missionId: string, charter: TestCharter, status: TestMission["status"], verdict: Verdict, observations: ReturnType<typeof runObservation>[]): TestMission {
  const now = new Date().toISOString();
  return TestMissionSchema.parse({
    missionId, intent: charter.intent, projectRoot: root, workspaceRoot: root, surface: "web", level: "core",
    policy: { level: "core", environment: "test", sideEffectPolicy: "deny", requireApproval: false, requireEvidence: true },
    status, verdict, charter,
    plan: {
      planId: `plan-${missionId}`, version: "1", generatedBy: "test", level: "core", createdAt: now,
      graph: { tasks: [{ taskId: "verify-result", title: "verify", objective: "verify", tool: "mission.verify", status: status === "completed" ? "passed" : "failed" }], terminalTaskIds: ["verify-result"] },
      executionProfile: { surfaceMatrix: ["web"], negativeCases: [], declaredNegativeCases: [], requireBusinessOracle: true, requireReplay: false, requireNegativeCases: Boolean(charter.negativeCases?.length), minimumEvidence: 2 },
    },
    observations, evidence: observations.flatMap((item) => item.evidence), findings: [], createdAt: now, updatedAt: now,
  });
}
