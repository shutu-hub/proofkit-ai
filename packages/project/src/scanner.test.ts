import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initProject, reconcileRouteDeclarations, scanProject } from "./index.js";
import { ProjectMapSchema } from "@proofkit/contracts";

const execFileAsync = promisify(execFile);

describe("scanProject", () => {
  it("maps package scripts and workspace surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-project-"));
    await mkdir(join(root, "apps", "desktop"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@10", scripts: { dev: "vite" }, devDependencies: { vite: "1" } }));
    await writeFile(join(root, "apps", "desktop", "package.json"), JSON.stringify({ name: "desktop", scripts: { dev: "electron ." }, dependencies: { electron: "1" } }));
    await writeFile(join(root, "apps", "desktop", "main.ts"), "router.get('/health', handler); router.post('/health', handler);\n");
    await writeFile(join(root, "apps", "desktop", "router.ts"), "export const routes = [{ path: '/resume' }];\n");
    await writeFile(join(root, "apps", "desktop", "extra-routes.ts"), "export const routes = [{ path: '/login' }, { path: '/settings' }];\n");
    await mkdir(join(root, "apps", "desktop", "tests"), { recursive: true });
    await writeFile(join(root, "apps", "desktop", "tests", "resume.test.ts"), "const fixture = { path: '/fixture-only' }; test('resume', () => {});\n");
    const map = await scanProject(root);
    expect(map.detected.web).toBe(true);
    expect(map.detected.electron).toBe(true);
    expect(map.packages[0]?.name).toBe("desktop");
    expect(map.inventory.sourceFiles).toBe(4);
    expect(map.inventory.testFiles).toBe(1);
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.source).toBe("filesystem");
    expect(map.inventory.testFrameworks).toContain("repository-tests");
    expect(map.inventory.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "electron", path: "apps/desktop/main.ts" }),
      expect.objectContaining({ kind: "web", path: "apps/desktop/router.ts" }),
    ]));
    expect(map.inventory.routeHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api", method: "GET", path: "/health", source: "apps/desktop/main.ts", line: 1 }),
      expect.objectContaining({ kind: "api", method: "POST", path: "/health", source: "apps/desktop/main.ts", line: 1 }),
      expect.objectContaining({ kind: "web", path: "/resume", source: "apps/desktop/router.ts", line: 1 }),
      expect.objectContaining({ kind: "web", path: "/login", source: "apps/desktop/extra-routes.ts", line: 1 }),
      expect.objectContaining({ kind: "web", path: "/settings", source: "apps/desktop/extra-routes.ts", line: 1 }),
    ]));
    expect(map.inventory.routeHints.some((hint) => hint.path === "/fixture-only")).toBe(false);
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

  it("scans an independent project ignored by its parent repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "proofkit-ignored-parent-"));
    await execFileAsync("git", ["init", "-q"], { cwd: parent });
    await writeFile(join(parent, ".gitignore"), "sandbox/\n");
    const root = join(parent, "sandbox", "project");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ignored-fixture" }));
    await writeFile(join(root, "router.ts"), "export const route = { path: '/resume' };\n");
    const map = await scanProject(root);
    expect(map.inventory.source).toBe("filesystem");
    expect(map.inventory.routeHints).toContainEqual(expect.objectContaining({ kind: "web", path: "/resume" }));
  });

  it("respects an empty Git inventory at the repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-empty-git-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "*\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ignored-root" }));
    await writeFile(join(root, "router.ts"), "export const route = { path: '/ignored' };\n");
    const map = await scanProject(root);
    expect(map.inventory.source).toBe("git");
    expect(map.inventory.routeHints).toHaveLength(0);
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

  it("marks the map partial when route hints exceed the result cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-route-cap-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(root, "router.ts"), Array.from({ length: 205 }, (_, index) => `export const route${index} = { path: '/r${index}' };`).join("\n"));
    const map = await scanProject(root);
    expect(map.inventory.filesScanned).toBe(2);
    expect(map.inventory.routeHints).toHaveLength(200);
    expect(map.inventory.truncated).toBe(true);
    expect(map.inventory.truncationReasons).toEqual(["route-hint-cap"]);
  });

  it("marks the map partial when a source file is too large to inspect", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-large-source-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(root, "router.ts"), `export const route = { path: '/hidden' };\n${"x".repeat(1_000_000)}`);
    const map = await scanProject(root);
    expect(map.inventory.sourceFiles).toBe(1);
    expect(map.inventory.routeHints).toHaveLength(0);
    expect(map.inventory.truncated).toBe(true);
    expect(map.inventory.truncationReasons).toEqual(["source-read-incomplete"]);
  });

  it("maps fully qualified Gin routes and reports unknown helper prefixes separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-gin-inventory-"));
    await writeFile(join(root, "router.go"), `package routes
import "github.com/gin-gonic/gin"
func routes() {
  engine := gin.New()
  files := engine.Group("/api/v1").Group("/files")
  files.POST("", upload)
  files.GET("/:file_id", detail)
}
func helper(api *gin.RouterGroup) { api.GET("/:id", detail) }
`);
    const map = await scanProject(root);
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.routeHints).toEqual([
      expect.objectContaining({ path: "/api/v1/files", method: "POST", line: 6, discovery: "gin" }),
      expect.objectContaining({ path: "/api/v1/files/:file_id", method: "GET", line: 7 }),
    ]);
    expect(map.inventory.routeDiagnostics).toEqual({ total: 1, omitted: 0, items: [{ extractor: "gin", source: "router.go", line: 9, reason: "unknown-router-prefix" }] });
    const mapping = reconcileRouteDeclarations(map.inventory.routeHints, [{ charterId: "files", routeTargets: [{ kind: "api", path: "/api/v1/files/:file_id", method: "GET", origin: "http://localhost:8080" }] }]);
    expect(mapping.unresolvedTargets).toEqual([]);
    expect(mapping.routes.find((item) => item.candidate.method === "GET")?.charterIds).toEqual(["files"]);
  });

  it("bounds Gin diagnostics without marking an otherwise complete file scan truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-gin-diagnostic-cap-"));
    await writeFile(join(root, "router.go"), `package routes\nimport "github.com/gin-gonic/gin"\nfunc routes(api *gin.RouterGroup) {\n${Array.from({ length: 25 }, (_, index) => `api.GET("/unknown${index}", handler)`).join("\n")}\n}`);
    const map = await scanProject(root);
    expect(map.inventory.truncated).toBe(false);
    expect(map.inventory.routeHints).toEqual([]);
    expect(map.inventory.routeDiagnostics).toMatchObject({ total: 25, omitted: 5 });
    expect(map.inventory.routeDiagnostics?.items).toHaveLength(20);
    const { routeDiagnostics: _diagnostics, ...legacyInventory } = map.inventory;
    expect(ProjectMapSchema.parse({ ...map, inventory: legacyInventory }).inventory.routeDiagnostics).toBeUndefined();
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
