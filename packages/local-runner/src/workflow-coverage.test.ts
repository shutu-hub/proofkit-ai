import { describe, expect, it } from "vitest";
import { DeterministicMissionPlanner } from "@proofkit/agent";
import { MissionPolicySchema, TestCharterSchema, TestMissionSchema, TestSuiteSchema, WorkflowInventorySchema, type TestMission } from "@proofkit/contracts";
import { summarizeWorkflowExecution } from "./workflow-coverage.js";
import type { SuiteScopeSummary } from "./suite-verifier.js";

const now = new Date().toISOString();
const headSha = "a".repeat(40);
const worktreeSha256 = "b".repeat(64);

describe("project workflow execution coverage", () => {
  it("counts exact Charter/platform suite results while keeping inventory completeness unverified", async () => {
    const mission = await fixture();
    const scope = suiteScope();
    const full = summarizeWorkflowExecution(mission, scope);
    expect(full).toMatchObject({ status: "all-declared-evidenced", workflowCount: 1, evidencedWorkflowCount: 1,
      requiredChecks: 2, evidencedChecks: 2, sourceBinding: "matching", suiteId: "critical", gaps: [] });
    expect(full?.limitations).toEqual(expect.arrayContaining([expect.stringContaining("completeness")]));
    expect(mission.verdict).toBe("inconclusive");

    scope.results = scope.results.filter((item) => !(item.charterId === "resume-electron" && item.surface === "electron"));
    scope.results.push({ charterId: "unrelated", surface: "electron", verdict: "passed", negativeCases: [], missing: [] });
    const incomplete = summarizeWorkflowExecution(mission, scope);
    expect(incomplete).toMatchObject({ status: "partial", evidencedWorkflowCount: 0, evidencedChecks: 1,
      gaps: [{ workflowId: "resume", charterId: "resume-electron", surface: "electron", reason: "not-scheduled" }] });

    scope.results[0]!.verdict = "failed";
    const failed = summarizeWorkflowExecution(mission, scope);
    expect(failed).toMatchObject({ status: "partial", evidencedChecks: 0,
      gaps: expect.arrayContaining([expect.objectContaining({ charterId: "resume-web", reason: "failed", primaryRunId: "resume-web-web-primary" })]) });
  });

  it("separates source drift and absent suite evidence from a saved inventory declaration", async () => {
    const mission = await fixture();
    expect(summarizeWorkflowExecution(mission)).toMatchObject({ status: "not-measured", evidencedChecks: 0,
      requiredChecks: 2, gaps: expect.arrayContaining([expect.objectContaining({ reason: "no-suite" })]) });
    const source = mission.observations.find((item) => item.kind === "project.source-state-final")!;
    source.data = { ...source.data, worktreeSha256: "c".repeat(64) };
    expect(summarizeWorkflowExecution(mission, suiteScope())?.sourceBinding).toBe("changed");
    mission.observations = mission.observations.filter((item) => item.kind !== "project.source-state-final");
    expect(summarizeWorkflowExecution(mission, suiteScope())?.sourceBinding).toBe("unverified");
    delete mission.workflowInventory;
    expect(summarizeWorkflowExecution(mission, suiteScope())).toMatchObject({ status: "not-measured", workflowCount: 0, requiredChecks: 0 });
  });
});

async function fixture(): Promise<TestMission> {
  const charter = TestCharterSchema.parse({ intent: "Verify resume", level: "release", actions: [{ kind: "observe" }],
    assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["resume.terminal"], sideEffectPolicy: "deny" });
  const suite = TestSuiteSchema.parse({ suiteId: "critical", level: "release", surfaces: ["web", "electron"],
    charters: ["resume-web", "resume-electron"].map((charterId) => ({ charterId, charter })), uncoveredCharterIds: [] });
  const policy = MissionPolicySchema.parse({ level: "release" });
  const plan = await new DeterministicMissionPlanner().plan({ intent: "测试整个项目", projectRoot: "/source", workspaceRoot: "/workspace", surface: "web", policy, suite });
  plan.planning = { source: "catalog", confidence: 0, assumptions: [], missingInputs: [], evidenceGaps: ["project-workflow-coverage"],
    coverage: { requested: "project", source: "inferred", reason: "whole project", inventory: "bounded", workflowCoverage: "unmeasured", gaps: ["project-workflow-coverage"] } };
  const inventory = WorkflowInventorySchema.parse({ schemaVersion: 1, source: { headSha, worktreeSha256 },
    review: { by: "fixture", at: now, method: "reviewed all workflows" },
    workflows: [{ id: "resume", title: "Resume", sourcePaths: ["src/resume.ts"], surfaces: ["web", "electron"],
      checks: [{ charterId: "resume-web", surfaces: ["web"] }, { charterId: "resume-electron", surfaces: ["electron"] }] }], exclusions: [] });
  const source = (kind: string) => ({ observationId: kind, source: "planner", kind, data: { method: "git", headSha, worktreeSha256, complete: true, capturedAt: now }, evidence: [], observedAt: now });
  return TestMissionSchema.parse({ missionId: "mission-workflow", intent: "测试整个项目", projectRoot: "/source", workspaceRoot: "/workspace",
    surface: "web", level: "release", policy, status: "completed", verdict: "inconclusive", suite, plan, workflowInventory: inventory,
    workflowInventoryInspection: { status: "loaded", path: ".proofkit/workflows.yaml", sourceMatch: "matching", reviewDeclared: true,
      workflowCount: 1, linkedWorkflowCount: 1, exclusionCount: 0, missingCharterIds: [], omittedMissingCharterIds: 0,
      uncoveredSurfaces: [], omittedUncoveredSurfaces: 0, missingSourcePaths: [], omittedMissingSourcePaths: 0,
      issues: ["workflow-inventory-completeness-unverified"], omittedIssues: 0 },
    observations: [source("project.source-state"), source("project.source-state-final")], createdAt: now, updatedAt: now });
}

function suiteScope(): SuiteScopeSummary {
  const result = (charterId: string, surface: "web" | "electron"): SuiteScopeSummary["results"][number] => ({
    charterId, surface, verdict: "passed", missing: [], negativeCases: [],
    primary: { runId: `${charterId}-${surface}-primary`, verdict: "passed", evidenceCount: 3, matchedRoutePaths: [], matchedApiTargets: [], networkLogAvailable: true },
    replay: { runId: `${charterId}-${surface}-replay`, verdict: "passed", evidenceCount: 3, matchedRoutePaths: [], matchedApiTargets: [], networkLogAvailable: true },
  });
  return { suiteId: "critical", includedCharterIds: ["resume-web", "resume-electron"], uncoveredCharterIds: [],
    results: [result("resume-web", "web"), result("resume-web", "electron"), result("resume-electron", "web"), result("resume-electron", "electron")] };
}
