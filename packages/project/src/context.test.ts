import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultWorkspaceRoot, initProject, loadConfig, resolveProjectContext, resolveWithinWorkspace } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-context-"));
  roots.push(base);
  const project = join(base, "source", "app");
  const workspace = join(base, "tests");
  const home = join(base, "workspace-home");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), '{"name":"source-app"}');
  return { base, project, workspace, home };
}

describe("ProjectContext", () => {
  it("defaults to an external stable workspace without writing into the source", async () => {
    const { project, home, base } = await fixture();
    const before = await readdir(project);
    const options = { workspaceHome: home };
    const context = resolveProjectContext(project, options);
    expect(context.workspaceRoot).toBe(defaultWorkspaceRoot(project, home));
    expect(resolveProjectContext(join(project, "..", "app"), options)).toEqual(context);
    expect(await initProject(project, options)).toBe(context.configPath);
    expect((await loadConfig(project, options)).project.root).toBe(context.projectRoot);
    expect(await readdir(project)).toEqual(before);
    const other = join(base, "other", "app");
    await mkdir(other, { recursive: true });
    expect(defaultWorkspaceRoot(other, home)).not.toBe(context.workspaceRoot);
  });

  it("prefers an explicit workspace over a legacy project layout", async () => {
    const { project, workspace } = await fixture();
    await mkdir(join(project, ".proofkit"));
    expect(resolveProjectContext(project).workspaceRoot).toBe(project);
    const context = resolveProjectContext(project, { workspaceRoot: workspace });
    expect(context.legacy).toBe(false);
    await initProject(project, { workspaceRoot: workspace });
    expect(await readdir(join(project, ".proofkit"))).toEqual([]);
  });

  it("reads legacy relative bindings and preserves the config and connector", async () => {
    const { project } = await fixture();
    await mkdir(join(project, ".proofkit"));
    const configPath = join(project, ".proofkit", "config.yaml");
    const integrationPath = join(project, ".proofkit", "integration.mjs");
    const config = 'project:\n  root: .\nsurfaces:\n  web:\n    baseUrl: http://127.0.0.1:5173\n';
    await writeFile(configPath, config);
    await writeFile(integrationPath, "export default { name: 'custom' };");
    expect((await loadConfig(project)).surfaces.web?.baseUrl).toBe("http://127.0.0.1:5173");
    await initProject(project);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(integrationPath, "utf8")).toContain("custom");
  });

  it("rejects rebinding before writing a starter connector", async () => {
    const { base, project, workspace } = await fixture();
    await initProject(project, { workspaceRoot: workspace });
    await rm(join(workspace, ".proofkit", "integration.mjs"));
    const other = join(base, "other");
    await mkdir(other);
    await expect(initProject(other, { workspaceRoot: workspace })).rejects.toThrow("bound to another project");
    await expect(loadConfig(other, { workspaceRoot: workspace })).rejects.toThrow("bound to another project");
    expect(await readdir(join(workspace, ".proofkit"))).toEqual(["config.yaml"]);
  });

  it("allows only one project to bind a concurrently initialized workspace", async () => {
    const { base, project, workspace } = await fixture();
    const other = join(base, "other");
    await mkdir(other);
    const results = await Promise.allSettled([initProject(project, { workspaceRoot: workspace }), initProject(other, { workspaceRoot: workspace })]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("bound to another project");
  });

  it("rejects parent and symlink escapes and canonicalizes a project alias", async () => {
    const { base, project, workspace } = await fixture();
    await mkdir(workspace);
    const alias = join(base, "project-alias");
    const escape = join(workspace, "escape");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    await symlink(project, escape, process.platform === "win32" ? "junction" : "dir");
    expect(defaultWorkspaceRoot(alias, base)).toBe(defaultWorkspaceRoot(project, base));
    expect(() => resolveWithinWorkspace(workspace, "../source/app/package.json")).toThrow("within the ProofKit workspace");
    expect(() => resolveWithinWorkspace(workspace, "escape/package.json")).toThrow("within the ProofKit workspace");
    expect(resolveWithinWorkspace(workspace, ".proofkit/new-charter.yaml")).toBe(join(workspace, ".proofkit", "new-charter.yaml"));
  });
});
