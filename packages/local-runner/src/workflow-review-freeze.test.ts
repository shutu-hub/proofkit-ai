import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, WorkflowInventorySchema } from "@proofkit/contracts";
import { captureSourceState, collectWorkflowReviewMaterials, inspectWorkflowInventory, scanProject, signWorkflowReview } from "@proofkit/project";
import { LocalRunnerService } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Mission workflow review snapshot", () => {
  it("freezes the signed source scope without writing to the tested project or starting a Run", async () => {
    const project = await mkdtemp(join(tmpdir(), "proofkit-review-mission-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-review-mission-workspace-"));
    const keyRoot = await mkdtemp(join(tmpdir(), "proofkit-review-mission-key-"));
    roots.push(project, workspace, keyRoot);
    await mkdir(join(project, "src"));
    await mkdir(join(workspace, ".proofkit"));
    await mkdir(join(workspace, "charters"));
    await writeFile(join(project, "package.json"), '{"name":"reviewed-project","devDependencies":{"vite":"1"}}');
    await writeFile(join(project, "src", "main.ts"), "export const ready = true;\n");
    await git(project, "init", "-q");
    await git(project, "add", ".");
    await git(project, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");
    const source = await captureSourceState(project);
    if (!source.complete || !source.headSha || !source.worktreeSha256) throw new Error("fixture source unavailable");
    const config = ProofkitConfigSchema.parse({ project: { root: project }, surfaces: { web: { baseUrl: "http://127.0.0.1:1" } },
      charters: [{ id: "ready-core", path: "charters/ready.yaml", aliases: ["ready core"], level: "core", surfaces: ["web"] }],
      oracles: [{ name: "ready.terminal", url: "http://127.0.0.1:2/ready", statusPointer: "/state", successValues: ["done"] }] });
    const charterPath = join(workspace, "charters", "ready.yaml");
    await writeFile(charterPath, JSON.stringify({ intent: "Ready flow", level: "core", actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["ready.terminal"], sideEffectPolicy: "deny" }));
    const inventory = WorkflowInventorySchema.parse({ schemaVersion: 1,
      source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
      review: { by: "operator", at: new Date().toISOString(), method: "Reviewed source entries and product workflows" },
      workflows: [{ id: "ready", title: "Ready", sourcePaths: ["src/main.ts"], charterIds: ["ready-core"], surfaces: ["web"] }], exclusions: [] });
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), JSON.stringify(inventory));
    const map = await scanProject(project);
    const inspection = await inspectWorkflowInventory(project, workspace, config, source, map);
    expect(inspection.inspection.candidateAudit).toMatchObject({ status: "scanned", unclaimed: 0, unlinkedRoutes: 0 });
    const materials = await collectWorkflowReviewMaterials(inventory, config, map, workspace);
    const keys = generateKeyPairSync("ed25519");
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signed = signWorkflowReview(inventory, inspection.inspection.candidateAudit!, materials, "operator", keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    await writeFile(join(workspace, ".proofkit", "workflow-review.json"), JSON.stringify(signed));
    const trustPath = join(keyRoot, "trusted.json");
    await writeFile(trustPath, JSON.stringify({ operator: publicPem }));
    const prior = process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
    try {
      process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = trustPath;
      const runner = new LocalRunnerService({ root: project, workspaceRoot: workspace, config });
      const mission = await runner.createMission({ intent: "测试整个项目", level: "core", surface: "web" });
      expect(mission.workflowInventoryInspection?.reviewAuthentication?.status).toBe("verified");
      expect(mission.workflowReview).toMatchObject({ attestation: { keyId: "operator" }, materials: { charterManifest: [{ id: "ready-core" }] } });
      expect(mission.plan.planning?.evidenceGaps).toContain("project-workflow-coverage");
      const reopened = new LocalRunnerService({ root: project, workspaceRoot: workspace, config });
      expect((await reopened.missionStatus(mission.missionId)).mission.workflowReview).toEqual(mission.workflowReview);
      const evidence = await reopened.missionEvidence(mission.missionId);
      expect(evidence.workflowReviewAudit).toMatchObject({ status: "unverified", reason: "execution-incomplete" });
      expect(evidence.testVerdict).toBe("not-asserted");
      expect(await readFile(join(project, "src", "main.ts"), "utf8")).toBe("export const ready = true;\n");
    } finally {
      if (prior === undefined) delete process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
      else process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = prior;
    }
  });
});

async function git(root: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd: root, timeout: 10_000 });
}
