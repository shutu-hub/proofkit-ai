import { describe, expect, it } from "vitest";
import { DeterministicMissionPlanner } from "@proofkit/agent";
import { DiagnosisSchema, FindingSchema, MissionPolicySchema, ObservationSchema, TestCharterSchema, TestMissionSchema, type Observation, type TestMission } from "@proofkit/contracts";
import { compareCurrentSource, projectMissionResult } from "./mission-result.js";

const now = "2026-10-10T00:00:00.000Z";
const options = { workspaceRoot: "/tests", running: false };

async function fixture(level: "core" | "release" = "core", catalogId?: string): Promise<TestMission> {
  const charter = TestCharterSchema.parse({
    intent: "Verify resume acquisition", level, actions: [{ kind: "observe" }],
    assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["terminal"],
    metadata: catalogId ? { catalogId } : {},
    negativeCases: [{ caseId: "invalid", title: "Invalid input rejected", actions: [{ kind: "observe" }], expectedVerdict: "failed" }],
  });
  const policy = MissionPolicySchema.parse({ level });
  const plan = await new DeterministicMissionPlanner().plan({ intent: charter.intent, projectRoot: "/source", surface: "web", policy, charter });
  return TestMissionSchema.parse({ missionId: "mission-result", intent: charter.intent, projectRoot: "/source", surface: "web", level, policy, charter, plan, status: "completed", verdict: "inconclusive", createdAt: now, updatedAt: now });
}

function observed(data: Record<string, unknown> = {}, charterId?: string): Observation {
  return ObservationSchema.parse({ observationId: `observation-${String(data.runId ?? "primary")}`, source: "surface", kind: "surface.run", charterId,
    data: { surface: "web", runKind: "primary", runId: "primary", verdict: "passed", assertions: 1, passedAssertions: 1, oracles: 1, passedOracles: 1, businessEvidence: 1, ...data }, observedAt: now });
}

describe("Mission result projection", () => {
  it("distinguishes a changed checkout from a failed current-source recheck", () => {
    const final = { method: "git" as const, complete: true, headSha: "a".repeat(40), worktreeSha256: "b".repeat(64),
      trackedDiffBytes: 0, untrackedFiles: 0, capturedAt: now };
    expect(compareCurrentSource(final, final)).toBe("matching");
    expect(compareCurrentSource(final, { ...final, worktreeSha256: "c".repeat(64) })).toBe("changed");
    expect(compareCurrentSource(final, { method: "unavailable", complete: false, trackedDiffBytes: 0,
      untrackedFiles: 0, capturedAt: now })).toBe("unavailable");
    expect(compareCurrentSource(undefined, final)).toBe("unverified");
  });

  it("reports whether complete Git source fingerprints stayed stable during execution", async () => {
    const mission = await fixture();
    const source = (kind: string, digest: string) => ObservationSchema.parse({
      observationId: kind, source: "planner", kind,
      data: { method: "git", complete: true, headSha: "a".repeat(40), worktreeSha256: digest, capturedAt: now },
      observedAt: now,
    });
    expect(projectMissionResult(mission, options).scope.sourceStability).toBe("unverified");
    mission.observations = [source("project.source-state", "b".repeat(64)), source("project.source-state-final", "b".repeat(64))];
    expect(projectMissionResult(mission, options).scope.sourceStability).toBe("stable");
    mission.observations[1] = source("project.source-state-final", "c".repeat(64));
    expect(projectMissionResult(mission, options).scope.sourceStability).toBe("changed");
  });

  it("preserves the acceptance verdict even when every saved Run and task is green", async () => {
    const mission = await fixture();
    mission.plan.graph.tasks.forEach((task) => { task.status = "passed"; task.input.privateToken = "INPUT_SECRET"; task.output = "OUTPUT_SECRET"; });
    mission.observations = [observed({ privateToken: "OBSERVATION_SECRET" })];
    const result = projectMissionResult(mission, options);
    expect(result.verdict).toBe("inconclusive");
    expect(result.runs[0]?.verdict).toBe("passed");
    expect(result.runs[1]).toMatchObject({ runKind: "negative", issue: "No saved run observation for this task." });
    expect(JSON.stringify(result)).not.toMatch(/INPUT_SECRET|OUTPUT_SECRET|OBSERVATION_SECRET/);
    expect(mission.plan.graph.tasks[0]?.input.privateToken).toBe("INPUT_SECRET");
    mission.status = "planned";
    delete mission.verdict;
    expect(projectMissionResult(mission, options).verdict).toBeUndefined();
  });

  it("associates a single catalog Charter and preserves expected negative failure semantics", async () => {
    const mission = await fixture("core", "resume");
    mission.observations = [observed({}, "resume"), observed({ runId: "negative", runKind: "negative", negativeCaseId: "invalid", verdict: "failed", expectedVerdict: "failed", outcomeMatched: true }, "resume")];
    const result = projectMissionResult(mission, options);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({ taskId: "execute-charter", charterId: "resume", runId: "primary" });
    expect(result.runs[1]).toMatchObject({ taskId: "negative-invalid", title: "Invalid input rejected", verdict: "failed", expectedVerdict: "failed", outcomeMatched: true });
    expect(result.runs.every((run) => !run.issue)).toBe(true);
    expect(result.confirmedProductFindings).toBe(0);
  });

  it("projects post-run listener continuity without replacing the pre-action source binding", async () => {
    const mission = await fixture();
    const binding = (processId: number) => ({ status: "matching-process-path", method: "windows-listener-process",
      expectedProjectRoot: "/source", observedProjectRoot: "/source", targetOrigin: "http://localhost:5174",
      processId, reason: "Observed listener", observedAt: now });
    mission.observations = [observed({ targetBinding: binding(12), targetBindingAfterRun: binding(13), targetContinuity: "changed",
      integrationPostRunCheck: { passed: false, message: "Gateway changed.", evidence: { gatewayContinuity: "changed" } } })];
    expect(projectMissionResult(mission, options).runs[0]).toMatchObject({ targetBinding: { processId: 12 },
      targetBindingAfterRun: { processId: 13 }, targetContinuity: "changed",
      integrationPostRunCheck: { passed: false, evidence: { gatewayContinuity: "changed" } } });
  });

  it("keeps missing and skipped release slots instead of hiding them", async () => {
    const mission = await fixture("release");
    mission.observations = [observed()];
    mission.plan.graph.tasks.find((task) => task.taskId === "replay-charter-electron")!.status = "skipped";
    const result = projectMissionResult(mission, options);
    expect(result.expectedRuns).toBe(6);
    expect(result.observedRuns).toBe(1);
    expect(result.runs).toHaveLength(6);
    expect(result.runs.find((run) => run.taskId === "replay-charter-electron")).toMatchObject({ surface: "electron", runKind: "replay", taskStatus: "skipped", issue: "No saved run observation for this task." });
    expect(result.runs.filter((run) => !run.runId)).toHaveLength(5);
    expect(result.replayConsistency).toMatchObject({ status: "unverified", expectedPairs: 2, comparedPairs: 0 });
  });

  it("reports evidenced primary/replay verdict divergence without calling it flakiness", async () => {
    const mission = await fixture("release");
    const run = (surface: "web" | "electron", kind: "primary" | "replay", verdict: "passed" | "failed") => {
      const runId = `${surface}-${kind}`;
      return ObservationSchema.parse({ ...observed({ surface, runKind: kind, runId, verdict,
        ...(kind === "replay" ? { sourceRunId: `${surface}-primary` } : {}) }),
        evidence: [{ evidenceId: `${runId}:report`, kind: "report", path: `${runId}/report.html`, sha256: "a".repeat(64), capturedAt: now }] });
    };
    mission.observations = [run("electron", "replay", "passed"), run("web", "primary", "passed"),
      run("web", "replay", "failed"), run("electron", "primary", "passed")];
    const divergent = projectMissionResult(mission, options).replayConsistency;
    expect(divergent).toMatchObject({ status: "diverge", expectedPairs: 2, comparedPairs: 2, divergentPairs: 1, unverifiedPairs: 0 });
    expect(divergent?.pairs).toContainEqual(expect.objectContaining({ surface: "web", primaryRunId: "web-primary", replayRunId: "web-replay", agreement: "diverge" }));

    const webReplay = mission.observations.find((item) => item.data.runId === "web-replay")!;
    webReplay.evidence = [{ ...webReplay.evidence[0]!, evidenceId: "another-run:report" }];
    expect(projectMissionResult(mission, options).replayConsistency).toMatchObject({ status: "unverified", comparedPairs: 1, unverifiedPairs: 1 });
    webReplay.evidence = [];
    expect(projectMissionResult(mission, options).replayConsistency).toMatchObject({ status: "unverified", comparedPairs: 1, unverifiedPairs: 1 });
    mission.observations.push(run("electron", "replay", "passed"));
    expect(projectMissionResult(mission, options).replayConsistency).toMatchObject({ status: "unverified", comparedPairs: 0, unverifiedPairs: 2 });
  });

  it("explains unexecuted downstream slots after an earlier Run blocks the Mission", async () => {
    const mission = await fixture();
    mission.status = "blocked";
    mission.verdict = "blocked";
    mission.observations = [observed({ verdict: "blocked", integrationCleanup: { status: "failed", declaredResources: 1, verifiedResources: 0 } })];
    const result = projectMissionResult(mission, options);
    expect(result.runs[0]?.integrationCleanup?.status).toBe("failed");
    expect(result.runs[1]).toMatchObject({ taskStatus: "pending", issue: "No saved run observation for this task." });
    expect(result.runs[1]?.runId).toBeUndefined();
    expect(result.runs[1]?.integrationCleanup).toBeUndefined();
    expect(result.observedRuns).toBe(1);
  });

  it("pairs suite runs by Charter, surface and kind rather than observation order", async () => {
    const mission = await fixture("release");
    const suite = { suiteId: "critical", origin: "catalog" as const, level: "release" as const, surfaces: ["web", "electron"] as Array<"web" | "electron">, charters: ["resume", "login"].map((charterId) => ({ charterId, charter: { ...mission.charter!, intent: `Test ${charterId}`, negativeCases: [] } })), uncoveredCharterIds: [] };
    mission.suite = suite;
    delete mission.charter;
    mission.plan = await new DeterministicMissionPlanner().plan({ intent: mission.intent, projectRoot: "/source", surface: "web", policy: mission.policy, suite });
    mission.observations = ["login", "resume"].flatMap((charterId) => ["electron", "web"].flatMap((surface) => ["replay", "primary"].map((runKind) => observed({ surface, runKind, charterId, runId: `${charterId}-${surface}-${runKind}` }, charterId))));
    const result = projectMissionResult(mission, options);
    expect(result.runs).toHaveLength(8);
    expect(result.runs.every((run) => run.runId === `${run.charterId}-${run.surface}-${run.runKind}` && run.title === `Test ${run.charterId}` && !run.issue)).toBe(true);
  });

  it("exposes duplicate, unassociated and invalid observations without inventing metadata", async () => {
    const mission = await fixture();
    mission.observations = [observed(), observed({ runId: "duplicate" }), observed({ runId: "../bad", verdict: "fiction", surface: "fiction", runKind: "fiction" })];
    const result = projectMissionResult(mission, options);
    expect(result.runs.filter((run) => run.taskId === "execute-charter")).toHaveLength(2);
    expect(result.runs[0]?.issue).toContain("Multiple saved run observations");
    expect(result.runs.at(-1)).toMatchObject({ runKind: "unknown" });
    expect(result.runs.at(-1)?.surface).toBeUndefined();
    expect(result.runs.at(-1)?.runId).toBeUndefined();
    expect(result.runs.at(-1)?.verdict).toBeUndefined();
    expect(result.runs.at(-1)?.issue).toContain("invalid execution-kind");
  });

  it("bounds presentation while retaining omission counts and prioritizing product evidence", async () => {
    const mission = await fixture();
    const evidence = Array.from({ length: 10 }, (_, index) => ({ evidenceId: `e-${index}`, kind: index === 9 ? "report" as const : "snapshot" as const, path: `run/artifacts/${index}.json`, capturedAt: now }));
    mission.observations = Array.from({ length: 205 }, (_, index) => ({ ...observed({ runId: `run-${index}` }), evidence: [...evidence, evidence[0]!] }));
    mission.findings = Array.from({ length: 22 }, (_, index) => FindingSchema.parse({ findingId: `f-${index}`, title: `Finding ${index}`, message: "Observed", severity: "high", category: index === 21 ? "product" : "test", status: "confirmed", evidence: [], createdAt: now }));
    const result = projectMissionResult(mission, options);
    expect(result.runs).toHaveLength(200);
    expect(result.omittedRunResults).toBe(6); // 205 observations and the missing negative slot
    expect(result.runs[0]?.evidence[0]?.kind).toBe("report");
    expect(result.runs[0]?.omittedEvidence).toBe(4);
    expect(result.findings[0]?.category).toBe("product");
    expect(result.omittedFindings).toBe(2);
    expect(result.confirmedProductFindings).toBe(1);
  });

  it("retains each visible diagnosis's Finding while bounding the report", async () => {
    const mission = await fixture();
    mission.findings = Array.from({ length: 22 }, (_, index) => FindingSchema.parse({
      findingId: `f-${index}`, title: `Finding ${index}`, message: "Observed", severity: "high",
      category: index === 21 ? "product" : "unknown", status: "confirmed", evidence: [], createdAt: now,
    }));
    mission.diagnosis = DiagnosisSchema.parse({ diagnosisId: "headline", findingId: "f-21", summary: "Product defect",
      confidence: 0.8, sourceLocations: [], evidence: [], createdAt: now });
    mission.diagnoses = Array.from({ length: 12 }, (_, index) => DiagnosisSchema.parse({
      diagnosisId: `diagnosis-${index}`, findingId: `f-${index}`, summary: `Scenario ${index}`,
      confidence: 0.5, sourceLocations: [], evidence: [], createdAt: now,
    }));
    mission.repairSuggestions = Array.from({ length: 10 }, (_, index) => ({
      suggestionId: `repair-${index}`, findingId: `f-${index + 10}`, title: `Repair ${index}`,
      rationale: "Trace the observed mismatch", changes: ["Inspect flow"], confidence: 0.4,
      evidence: [], status: "proposed" as const,
    }));
    const result = projectMissionResult(mission, options);
    expect(result.diagnoses).toHaveLength(10);
    expect(result.omittedDiagnoses).toBe(3);
    expect(result.diagnoses[0]?.diagnosisId).toBe("headline");
    const visibleIds = [...result.diagnoses, ...result.repairSuggestions].map((item) => item.findingId);
    expect(visibleIds.every((id) => result.findings.some((finding) => finding.findingId === id))).toBe(true);
    expect(result.omittedFindings).toBe(2);
  });

  it("projects a historical Mission with only the singular diagnosis", async () => {
    const mission = await fixture();
    mission.diagnosis = DiagnosisSchema.parse({ diagnosisId: "historical", summary: "Inspect saved failure",
      confidence: 0.4, sourceLocations: [], evidence: [], createdAt: now });
    const restored = TestMissionSchema.parse({ ...mission, diagnoses: undefined });
    expect(restored.diagnoses).toEqual([]);
    expect(projectMissionResult(restored, options)).toMatchObject({
      diagnosis: { diagnosisId: "historical" }, diagnoses: [{ diagnosisId: "historical" }], omittedDiagnoses: 0,
    });
  });
});
