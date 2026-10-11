import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeterministicMissionPlanner } from "@proofkit/agent";
import {
  MissionPolicySchema, ProjectMapSchema, ProofkitConfigSchema, TestCharterSchema, TestMissionSchema,
  TestSuiteSchema, WorkflowExecutionCoverageSchema, WorkflowInventorySchema, type TestMission,
} from "@proofkit/contracts";
import { auditWorkflowCandidates, signWorkflowReview, workflowCandidateSetSha256, workflowCharterExecutionSha256 } from "@proofkit/project";
import { admitReviewedWorkflowScope, auditWorkflowReview } from "./workflow-review-audit.js";

const now = new Date().toISOString();
const headSha = "a".repeat(40);
const worktreeSha256 = "b".repeat(64);
const charter = TestCharterSchema.parse({ intent: "Verify resume acquisition", level: "core",
  actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "ready" }],
  oracles: ["resume.terminal"], sideEffectPolicy: "deny" });
const catalog = ProofkitConfigSchema.parse({ charters: [{ id: "resume-core", path: "charters/resume.yaml",
  aliases: ["resume acquisition"], level: "core", surfaces: ["web"] }] });
const inventory = WorkflowInventorySchema.parse({ schemaVersion: 1, source: { headSha, worktreeSha256 },
  review: { by: "operator", at: now, method: "Reviewed candidate entries and business transitions" },
  workflows: [{ id: "resume", title: "Resume acquisition", sourcePaths: ["src/resume.ts"],
    charterIds: ["resume-core"], surfaces: ["web"] }], exclusions: [] });
const map = ProjectMapSchema.parse({ root: "/source", detected: { web: true, electron: false, backend: false },
  inventory: { entryPoints: [{ kind: "web", path: "src/resume.ts", reason: "entry" }] }, generatedAt: now });
const candidate = auditWorkflowCandidates(map, inventory, catalog);
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const trust = { reviewer: publicPem };
const materials = { candidateSetSha256: "c".repeat(64), charterManifest: [{ id: "resume-core", catalog: catalog.charters[0]!,
  fileSha256: "d".repeat(64), executionSha256: workflowCharterExecutionSha256(charter) }] };

describe("frozen project workflow review audit", () => {
  it("admits only the reviewed level and its exact suite before execution", async () => {
    const mission = await fixture();
    const scope = { level: mission.level, projectRoot: mission.projectRoot, workspaceRoot: mission.workspaceRoot,
      workflowInventory: mission.workflowInventory, workflowInventoryInspection: mission.workflowInventoryInspection,
      workflowReview: mission.workflowReview, suite: mission.suite, projectMap: map };
    expect(await admitReviewedWorkflowScope(scope, trust)).toMatchObject({ keyId: "reviewer",
      scope: "reviewed-source-workflows" });
    expect(await admitReviewedWorkflowScope({ ...scope, level: "quick" }, trust)).toBeUndefined();
    expect(await admitReviewedWorkflowScope({ ...scope, level: "release" }, trust)).toBeUndefined();
    expect(await admitReviewedWorkflowScope(scope, {})).toBeUndefined();
  });

  it("authenticates only the signed source map, exact Charter and completed business matrix", async () => {
    const mission = await fixture();
    const execution = completeExecution();
    // A guessed candidate digest cannot authenticate a saved map.
    mission.workflowReview!.materials.candidateSetSha256 = "f".repeat(64);
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("candidate-mismatch");
    mission.workflowReview!.materials.candidateSetSha256 = workflowCandidateSetSha256(map);
    mission.workflowReview!.attestation = signWorkflowReview(inventory, candidate, mission.workflowReview!.materials, "reviewer", privatePem);
    expect(await auditWorkflowReview(mission, execution, trust))
      .toMatchObject({ status: "verified", keyId: "reviewer", scope: "reviewed-source-workflows" });
    expect((await auditWorkflowReview(mission, execution, {})).reason).toBe("review-untrusted");
    expect((await auditWorkflowReview(mission, undefined, trust)).reason).toBe("execution-incomplete");
    expect((await auditWorkflowReview(mission, { ...execution, sourceBinding: "changed" }, trust)).reason).toBe("source-mismatch");
    expect((await auditWorkflowReview(mission, { ...execution, evidencedChecks: 0, status: "partial" }, trust)).reason)
      .toBe("execution-incomplete");
    delete mission.workflowReviewAdmission;
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("missing-admission");
  });

  it("rejects a changed Charter, candidate detail, omitted workflow and false review", async () => {
    const mission = await fixture();
    const execution = completeExecution();
    expect((await auditWorkflowReview(mission, execution, trust)).status).toBe("verified");
    mission.suite!.charters[0]!.charter.assertions = [{ kind: "text-visible", text: "weaker" }];
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("charter-mismatch");
    mission.suite!.charters[0]!.charter.assertions = charter.assertions;
    const discovered = mission.observations.find((item) => item.kind === "project.discovered")!;
    discovered.data = { ...map, inventory: { ...map.inventory,
      entryPoints: [{ kind: "web", path: "src/resume.ts", reason: "different entry" }] } };
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("candidate-mismatch");
    discovered.data = map;
    mission.workflowInventory!.workflows[0]!.sourcePaths = ["src/other.ts"];
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("candidate-mismatch");
    mission.workflowInventory!.workflows[0]!.sourcePaths = ["src/resume.ts"];
    mission.workflowReview!.attestation.signature = "x".repeat(86) + "==";
    expect((await auditWorkflowReview(mission, execution, trust)).reason).toBe("review-invalid");
  });
});

async function fixture(): Promise<TestMission> {
  const signedMaterials = { ...materials, candidateSetSha256: workflowCandidateSetSha256(map) };
  const policy = MissionPolicySchema.parse({ level: "core" });
  const suite = TestSuiteSchema.parse({ suiteId: "project-workflows", origin: "workflow-inventory", level: "core",
    surfaces: ["web"], charters: [{ charterId: "resume-core", charter, surfaces: ["web"], routeTargets: [] }], uncoveredCharterIds: [] });
  const plan = await new DeterministicMissionPlanner().plan({ intent: "测试整个项目", projectRoot: "/source", workspaceRoot: "/workspace", surface: "web", policy, suite });
  plan.planning = { source: "workflow-inventory", confidence: 0, assumptions: [], missingInputs: [],
    evidenceGaps: [], coverage: { requested: "project", source: "inferred", reason: "whole project",
      inventory: "bounded", workflowCoverage: "unmeasured", gaps: [] } };
  return TestMissionSchema.parse({ missionId: "mission-review", intent: "测试整个项目", projectRoot: "/source", workspaceRoot: "/workspace",
    surface: "web", level: "core", policy, status: "completed", verdict: "inconclusive", suite, plan,
    workflowInventory: inventory,
    workflowInventoryInspection: { status: "loaded", path: ".proofkit/workflows.yaml", sourceMatch: "matching",
      reviewDeclared: true, reviewAuthentication: { status: "verified", keyId: "reviewer" }, workflowCount: 1,
      linkedWorkflowCount: 1, exclusionCount: 0, missingCharterIds: [], omittedMissingCharterIds: 0,
      uncoveredSurfaces: [], omittedUncoveredSurfaces: 0, missingSourcePaths: [], omittedMissingSourcePaths: 0,
      candidateAudit: candidate, issues: ["workflow-inventory-completeness-unverified"], omittedIssues: 0 },
    workflowReview: { materials: signedMaterials, attestation: signWorkflowReview(inventory, candidate, signedMaterials, "reviewer", privatePem) },
    workflowReviewAdmission: { keyId: "reviewer", candidateSetSha256: signedMaterials.candidateSetSha256,
      scope: "reviewed-source-workflows" },
    observations: [{ observationId: "discover", source: "planner", kind: "project.discovered", data: map, observedAt: now }],
    createdAt: now, updatedAt: now });
}

function completeExecution() {
  return WorkflowExecutionCoverageSchema.parse({ status: "all-declared-evidenced", requiredProof: "business", workflowCount: 1,
    evidencedWorkflowCount: 1, requiredChecks: 1, evidencedChecks: 1, sourceBinding: "matching", reviewDeclared: true,
    exclusionCount: 0, suiteId: "project-workflows", gaps: [], omittedGaps: 0, limitations: [] });
}
