import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSourceState, inspectWorkflowInventory, loadConfig, scanProject } from "@proofkit/project";
import { createProgram } from "./main.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator workflow review CLI", () => {
  it("signs a complete external inventory and authenticates it only with an external trust file", async () => {
    const project = await mkdtemp(join(tmpdir(), "proofkit-review-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-review-workspace-"));
    const keysRoot = await mkdtemp(join(tmpdir(), "proofkit-review-keys-"));
    roots.push(project, workspace, keysRoot);
    await mkdir(join(project, "src"));
    await mkdir(join(workspace, ".proofkit"));
    await writeFile(join(project, "package.json"), '{"name":"review-fixture","devDependencies":{"vite":"1"}}');
    await writeFile(join(project, "src", "main.ts"), "export const ready = true;\n");
    await git(project, "init", "-q");
    await git(project, "add", ".");
    await git(project, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");
    const source = await captureSourceState(project);
    expect(source.complete).toBe(true);
    await writeFile(join(workspace, ".proofkit", "config.yaml"), stringify({ project: { root: project }, charters: [
      { id: "ready-core", path: "charters/ready.yaml", aliases: ["ready core"], level: "core", surfaces: ["web"] },
    ] }));
    const inventory = { schemaVersion: 1, source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
      review: { by: "operator", at: new Date().toISOString(), method: "Checked all entry points and business workflows" },
      workflows: [{ id: "ready", title: "Ready flow", sourcePaths: ["src/main.ts"], charterIds: ["ready-core"], surfaces: ["web"] }], exclusions: [] };
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify(inventory));
    const map = await scanProject(project);
    expect(map.inventory.entryPoints.some((item) => item.path === "src/main.ts")).toBe(true);
    const keys = generateKeyPairSync("ed25519");
    const privatePath = join(keysRoot, "review-private.pem");
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "proofkit", "review-workflows", "--root", project, "--workspace", workspace,
      "--key-id", "operator-1", "--private-key", privatePath]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ status: "signed", acceptance: "unverified-until-executed-and-audited" });
    const attestation = JSON.parse(await readFile(join(workspace, ".proofkit", "workflow-review.json"), "utf8"));
    expect(attestation.keyId).toBe("operator-1");
    const config = await loadConfig(project, { workspaceRoot: workspace });
    const untrusted = await inspectWorkflowInventory(project, workspace, config, source, map, {});
    expect(untrusted.inspection.reviewAuthentication?.status).toBe("untrusted");
    const trustPath = join(keysRoot, "trusted-reviewers.json");
    await writeFile(trustPath, JSON.stringify({ "operator-1": publicPem }));
    const prior = process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
    try {
      process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = trustPath;
      const trusted = await inspectWorkflowInventory(project, workspace, config, source, map);
      expect(trusted.inspection.reviewAuthentication?.status).toBe("verified");
      expect(trusted.inspection.issues).toContain("workflow-inventory-completeness-unverified");
      const workspaceTrust = join(workspace, ".proofkit", "trusted-reviewers.json");
      await writeFile(workspaceTrust, JSON.stringify({ "operator-1": publicPem }));
      process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = workspaceTrust;
      expect((await inspectWorkflowInventory(project, workspace, config, source, map)).inspection.reviewAuthentication?.status)
        .toBe("untrusted");
      process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = trustPath;
      await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify({ ...inventory,
        workflows: [{ ...inventory.workflows[0], title: "Changed after signing" }] }));
      expect((await inspectWorkflowInventory(project, workspace, config, source, map)).inspection.reviewAuthentication?.status).toBe("invalid");
    } finally {
      if (prior === undefined) delete process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
      else process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = prior;
    }
    await writeFile(join(workspace, ".proofkit", "workflows.yaml"), stringify(inventory));
    const insideKey = join(workspace, ".proofkit", "private.pem");
    await writeFile(insideKey, await readFile(privatePath));
    await expect(createProgram().parseAsync(["node", "proofkit", "review-workflows", "--root", project,
      "--workspace", workspace, "--key-id", "operator-1", "--private-key", insideKey])).rejects.toThrow("outside");
  });
});

async function git(root: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd: root, timeout: 10_000 });
}
