import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initProject, scanProject } from "./index.js";

const execFileAsync = promisify(execFile);

describe("scanProject", () => {
  it("maps package scripts and workspace surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-project-"));
    await mkdir(join(root, "apps", "desktop"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@10", scripts: { dev: "vite" }, devDependencies: { vite: "1" } }));
    await writeFile(join(root, "apps", "desktop", "package.json"), JSON.stringify({ name: "desktop", scripts: { dev: "electron ." }, dependencies: { electron: "1" } }));
    await writeFile(join(root, "apps", "desktop", "main.ts"), "router.get('/health', handler);\n");
    await writeFile(join(root, "apps", "desktop", "router.ts"), "export const routes = [{ path: '/resume' }];\n");
    await mkdir(join(root, "apps", "desktop", "tests"), { recursive: true });
    await writeFile(join(root, "apps", "desktop", "tests", "resume.test.ts"), "test('resume', () => {});\n");
    const map = await scanProject(root);
    expect(map.detected.web).toBe(true);
    expect(map.detected.electron).toBe(true);
    expect(map.packages[0]?.name).toBe("desktop");
    expect(map.inventory.sourceFiles).toBe(3);
    expect(map.inventory.testFiles).toBe(1);
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.source).toBe("filesystem");
    expect(map.inventory.testFrameworks).toContain("repository-tests");
    expect(map.inventory.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "electron", path: "apps/desktop/main.ts" }),
      expect.objectContaining({ kind: "web", path: "apps/desktop/router.ts" }),
    ]));
    expect(map.inventory.routeHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api", path: "/health", source: "apps/desktop/main.ts", line: 1 }),
      expect.objectContaining({ kind: "web", path: "/resume", source: "apps/desktop/router.ts", line: 1 }),
    ]));
  });

  it("uses the Git working tree and includes untracked source without scanning ignored archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-git-inventory-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "archive/\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "current-app" }));
    await mkdir(join(root, "apps", "web", "src"), { recursive: true });
    await writeFile(join(root, "apps", "web", "src", "router.ts"), "export const routes = [{ path: '/current' }];\n");
    await execFileAsync("git", ["add", ".gitignore", "package.json", "apps/web/src/router.ts"], { cwd: root });
    await writeFile(join(root, "apps", "web", "src", "new-feature.ts"), "export const feature = true;\n");
    await mkdir(join(root, "apps", "new-feature", "src"), { recursive: true });
    await writeFile(join(root, "apps", "new-feature", "src", "router.ts"), "export const routes = [{ path: '/new' }];\n");
    await writeFile(join(root, "apps", "new-feature", "src", "dynamic.ts"), "const route = { path: `/users/${userId}?token=${token}` };\n");
    await mkdir(join(root, "archive"), { recursive: true });
    await writeFile(join(root, "archive", "router.ts"), "export const routes = [{ path: '/obsolete' }];\n");
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "router.ts"), "export const routes = [{ path: '/internal' }];\n");
    await execFileAsync("git", ["add", ".proofkit/router.ts"], { cwd: root });

    const map = await scanProject(root);
    expect(map.inventory.source).toBe("git");
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.sourceFiles).toBe(4);
    expect(map.inventory.routeHints).toContainEqual(expect.objectContaining({ path: "/current", source: "apps/web/src/router.ts" }));
    expect(map.inventory.routeHints).toContainEqual(expect.objectContaining({ path: "/new", source: "apps/new-feature/src/router.ts" }));
    expect(map.inventory.routeHints.some((hint) => hint.path === "/obsolete")).toBe(false);
    expect(map.inventory.routeHints.some((hint) => hint.path === "/internal")).toBe(false);
    expect(map.inventory.routeHints.some((hint) => hint.path.includes("token"))).toBe(false);
  });

  it("keeps the bounded inventory out of dependency and generated directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-inventory-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { vitest: "1" } }));
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "node_modules", "dependency", "index.ts"), "export const ignored = true;\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "generated.ts"), "export const ignored = true;\n");
    await writeFile(join(root, "src.ts"), "export const included = true;\n");
    const map = await scanProject(root);
    expect(map.inventory.sourceFiles).toBe(1);
    expect(map.inventory.filesScanned).toBe(2);
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.testFrameworks).toContain("vitest");
  });

  it("creates a config and integration starter without overwriting either", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-init-"));
    await initProject(root, { workspaceRoot: root });
    const integrationPath = join(root, ".proofkit", "integration.mjs");
    expect(await readFile(integrationPath, "utf8")).toContain("project-integration");
    await writeFile(integrationPath, "export default { name: 'custom' };", "utf8");
    await initProject(root, { workspaceRoot: root });
    expect(await readFile(integrationPath, "utf8")).toContain("custom");
  });
});
