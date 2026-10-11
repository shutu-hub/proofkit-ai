import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMapSchema, ProofkitConfigSchema, WorkflowInventorySchema } from "@proofkit/contracts";
import { captureSourceState } from "./source-state.js";
import { inspectWorkflowInventory } from "./workflow-inventory.js";
import { collectWorkflowReviewMaterials, signWorkflowReview } from "./workflow-review.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("external workflow inventory", () => {
  it("reports a missing inventory without creating files in the source or workspace", async () => {
    const project = await mkdtemp(join(tmpdir(), "proofkit-workflow-project-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-workflow-workspace-"));
    roots.push(project, workspace);
    const result = await inspectWorkflowInventory(project, workspace, ProofkitConfigSchema.parse({}));
    expect(result.inventory).toBeUndefined();
    expect(result.inspection).toMatchObject({ status: "missing", sourceMatch: "not-checked", issues: ["workflow-inventory-missing"] });
  });

  it("binds a reviewed declaration to source facts and checks Charter and surface links", async () => {
    const { project, workspace, source } = await fixture();
    const config = ProofkitConfigSchema.parse({ charters: [
      { id: "resume-web", path: "charters/resume-web.yaml", aliases: ["resume web"], level: "core", surfaces: ["web"] },
      { id: "resume-electron", path: "charters/resume-electron.yaml", aliases: ["resume electron"], level: "core", surfaces: ["electron"] },
    ] });
    const inventory = {
      schemaVersion: 1,
      source: { headSha: source.headSha!, worktreeSha256: source.worktreeSha256! },
      review: { by: "fixture reviewer", at: new Date().toISOString(), method: "Reviewed source entries and product workflow list" },
      workflows: [{ id: "resume", title: "Resume acquisition", sourcePaths: ["src/app.ts"], checks: [
        { charterId: "resume-web", surfaces: ["web"] }, { charterId: "resume-electron", surfaces: ["electron"] },
      ], surfaces: ["web", "electron"] }],
      exclusions: [],
    };
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify(inventory));
    const valid = await inspectWorkflowInventory(project, workspace, config);
    expect(valid.inspection).toMatchObject({ status: "loaded", sourceMatch: "matching", reviewDeclared: true, workflowCount: 1, linkedWorkflowCount: 1, missingCharterIds: [], missingSourcePaths: [] });
    expect(valid.inspection.issues).toContain("workflow-inventory-completeness-unverified");
    expect(valid.inventory?.workflows[0]?.id).toBe("resume");
    const projectMap = ProjectMapSchema.parse({ root: project, detected: { web: true, electron: true, backend: false },
      inventory: { routeHints: [{ kind: "web", path: "/resume", source: "src/app.ts", line: 1 }],
        entryPoints: [{ kind: "web", path: "src/other.ts", reason: "entry" }] }, generatedAt: new Date().toISOString() });
    const audited = (await inspectWorkflowInventory(project, workspace, config, source, projectMap)).inspection;
    expect(audited.candidateAudit).toMatchObject({ routeCandidates: 1, entryCandidates: 1, unlinkedRoutes: 1, unclaimed: 1 });
    expect(audited.issues).toEqual(expect.arrayContaining(["workflow-inventory-routes-unlinked", "workflow-inventory-candidates-unclaimed"]));

    await writeFile(join(project, "src", "app.ts"), "export const changed = true;\n");
    expect((await inspectWorkflowInventory(project, workspace, config)).inspection.sourceMatch).toBe("changed");
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify({ ...inventory,
      workflows: [{ ...inventory.workflows[0], sourcePaths: ["src/removed.ts"], checks: [
        { charterId: "resume-web", surfaces: ["web"] }, { charterId: "unknown", surfaces: ["electron"] },
      ] }],
      exclusions: [{ id: "billing", reason: "No isolated billing fixture yet", sourcePaths: ["src/app.ts"] }],
    }));
    const gaps = (await inspectWorkflowInventory(project, workspace, config)).inspection;
    expect(gaps).toMatchObject({ linkedWorkflowCount: 0, exclusionCount: 1, missingCharterIds: ["unknown"], uncoveredSurfaces: [{ workflowId: "resume", surface: "electron" }], missingSourcePaths: ["src/removed.ts"] });
    expect(gaps.issues).toEqual(expect.arrayContaining(["workflow-inventory-source-changed", "workflow-inventory-charter-mapping-incomplete", "workflow-inventory-source-path-missing", "workflow-inventory-has-exclusions"]));
  });

  it("rejects traversal, duplicate identities, malformed YAML and a redirected inventory path", async () => {
    expect(() => WorkflowInventorySchema.parse({ schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) }, workflows: [
      { id: "same", title: "One", sourcePaths: ["../outside"], charterIds: ["test"], surfaces: ["web"] },
    ] })).toThrow();
    expect(() => WorkflowInventorySchema.parse({ schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) }, workflows: [
      { id: "same", title: "One", sourcePaths: ["src/app.ts"], charterIds: ["test"], surfaces: ["web"] },
      { id: "same", title: "Two", sourcePaths: ["src/app.ts"], charterIds: ["test"], surfaces: ["web"] },
    ] })).toThrow();
    expect(() => WorkflowInventorySchema.parse({ schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) }, workflows: [
      { id: "resume", title: "Resume", sourcePaths: ["src/app.ts"], checks: [{ charterId: "web", surfaces: ["web"] }], surfaces: ["web", "electron"] },
    ] })).toThrow();
    const { project, workspace } = await fixture();
    const path = join(workspace, ".proofkit", "workflows.yaml");
    await writeFile(path, "private_key: [secret-text\n");
    const invalid = await inspectWorkflowInventory(project, workspace, ProofkitConfigSchema.parse({}));
    expect(invalid.inspection).toMatchObject({ status: "invalid", issues: ["workflow-inventory-invalid"] });
    expect(JSON.stringify(invalid)).not.toContain("secret-text");
    await rm(join(workspace, ".proofkit"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "proofkit-workflow-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "workflows.yaml"), "schemaVersion: 1\n");
    await symlink(outside, join(workspace, ".proofkit"), process.platform === "win32" ? "junction" : "dir");
    expect((await inspectWorkflowInventory(project, workspace, ProofkitConfigSchema.parse({}))).inspection.status).toBe("invalid");
  });

  it("reads a workspace attestation but trusts only an independently supplied reviewer key", async () => {
    const { project, workspace, source } = await fixture();
    const config = ProofkitConfigSchema.parse({ charters: [
      { id: "resume-core", path: "charters/resume.yaml", aliases: ["resume flow"], level: "core", surfaces: ["web"] },
    ] });
    const inventory = WorkflowInventorySchema.parse({ schemaVersion: 1,
      source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
      review: { by: "operator", at: new Date().toISOString(), method: "Reviewed all candidate entries and workflows" },
      workflows: [{ id: "resume", title: "Resume", sourcePaths: ["src/app.ts"], charterIds: ["resume-core"], surfaces: ["web"] }],
      exclusions: [],
    });
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify(inventory));
    await mkdir(join(workspace, "charters"));
    await writeFile(join(workspace, "charters", "resume.yaml"), "intent: Verify resume\nlevel: core\n");
    const map = ProjectMapSchema.parse({ root: project, detected: { web: true, electron: false, backend: false },
      inventory: { entryPoints: [{ kind: "web", path: "src/app.ts", reason: "entry" }] }, generatedAt: new Date().toISOString() });
    const unsigned = (await inspectWorkflowInventory(project, workspace, config, source, map)).inspection;
    expect(unsigned.reviewAuthentication?.status).toBe("missing");
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const materials = await collectWorkflowReviewMaterials(inventory, config, map, workspace);
    const signed = signWorkflowReview(inventory, unsigned.candidateAudit!, materials, "reviewer-1", privatePem);
    await writeFile(join(workspace, ".proofkit", "workflow-review.json"), JSON.stringify(signed));
    const untrusted = (await inspectWorkflowInventory(project, workspace, config, source, map, {})).inspection;
    expect(untrusted.reviewAuthentication?.status).toBe("untrusted");
    const verified = (await inspectWorkflowInventory(project, workspace, config, source, map,
      { "reviewer-1": publicPem })).inspection;
    expect(verified.reviewAuthentication).toMatchObject({ status: "verified", keyId: "reviewer-1" });
    expect(verified.issues).toContain("workflow-inventory-completeness-unverified");

    await writeFile(join(workspace, "charters", "resume.yaml"), "intent: Weakened check\nlevel: core\n");
    const changedCharter = (await inspectWorkflowInventory(project, workspace, config, source, map,
      { "reviewer-1": publicPem })).inspection;
    expect(changedCharter.reviewAuthentication?.status).toBe("invalid");
    await writeFile(join(workspace, "charters", "resume.yaml"), "intent: Verify resume\nlevel: core\n");

    const additional = ProjectMapSchema.parse({ ...map, inventory: { ...map.inventory,
      entryPoints: [...map.inventory.entryPoints, { kind: "web", path: "src/other.ts", reason: "entry" }] } });
    const changed = (await inspectWorkflowInventory(project, workspace, config, source, additional,
      { "reviewer-1": publicPem })).inspection;
    expect(changed.reviewAuthentication?.status).toBe("invalid");
    expect(changed.issues).toContain("workflow-inventory-candidates-unclaimed");

    const sameSummary = ProjectMapSchema.parse({ ...map, inventory: { ...map.inventory,
      entryPoints: [{ kind: "web", path: "src/app.ts", reason: "different entry reason" }] } });
    const changedDetail = (await inspectWorkflowInventory(project, workspace, config, source, sameSummary,
      { "reviewer-1": publicPem })).inspection;
    expect(changedDetail.candidateAudit).toEqual(verified.candidateAudit);
    expect(changedDetail.reviewAuthentication?.status).toBe("invalid");
  });
});

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "proofkit-workflow-project-"));
  const workspace = await mkdtemp(join(tmpdir(), "proofkit-workflow-workspace-"));
  roots.push(project, workspace);
  await mkdir(join(project, "src"));
  await mkdir(join(workspace, ".proofkit"));
  await writeFile(join(project, "src", "app.ts"), "export const initial = true;\n");
  await git(project, "init", "-q");
  await git(project, "add", "src/app.ts");
  await git(project, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");
  const source = await captureSourceState(project);
  if (!source.complete || !source.headSha || !source.worktreeSha256) throw new Error("Fixture source fingerprint is unavailable");
  return { project, workspace, source };
}

async function git(root: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd: root, timeout: 10_000 });
}
