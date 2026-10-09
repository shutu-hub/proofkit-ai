import { describe, expect, it } from "vitest";
import { DeterministicMissionPlanner } from "@proofkit/agent";
import { FindingSchema, MissionPolicySchema, ObservationSchema, TestCharterSchema, TestMissionSchema, type Observation, type TestMission } from "@proofkit/contracts";
import { projectMissionResult } from "./mission-result.js";

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
  });

  it("pairs suite runs by Charter, surface and kind rather than observation order", async () => {
    const mission = await fixture("release");
    const suite = { suiteId: "critical", level: "release" as const, surfaces: ["web", "electron"] as Array<"web" | "electron">, charters: ["resume", "login"].map((charterId) => ({ charterId, charter: { ...mission.charter!, intent: `Test ${charterId}`, negativeCases: [] } })), uncoveredCharterIds: [] };
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
});
