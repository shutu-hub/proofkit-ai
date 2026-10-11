import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMapSchema } from "@proofkit/contracts";
import { scanProject } from "./index.js";

const git = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-focus-"));
  roots.push(root);
  return root;
}

describe("focused project inventory", () => {
  it("retains a late route after more than 1,000 declarations and normalizes literal focus", async () => {
    const root = await fixture();
    const path = join(root, "router.ts");
    const source = `${Array.from({ length: 1_101 }, (_, index) => `const r${index} = { path: '/other/${index}' };`).join("\n")}\nconst target = { path: '/resume-target' };`;
    await writeFile(path, source);
    const ordinary = await scanProject(root, { routeHintLimit: 200 });
    expect(ordinary.inventory.routeHints).toHaveLength(200);
    expect(ordinary.inventory.routeHints.some((route) => route.path === "/resume-target")).toBe(false);
    expect(ordinary.inventory.retentionFocus).toBeUndefined();
    const focused = await scanProject(root, { focus: " ＲＥＳＵＭＥ ", routeHintLimit: 200 });
    expect(focused.inventory).toMatchObject({ retentionFocus: "resume", filesScanned: 1, truncated: true });
    expect(focused.inventory.routeHints).toHaveLength(200);
    expect(focused.inventory.routeHints[0]).toMatchObject({ path: "/resume-target", source: "router.ts", line: 1_102 });
    expect(await readFile(path, "utf8")).toBe(source);
    const { retentionFocus: _focus, ...legacyInventory } = focused.inventory;
    expect(ProjectMapSchema.parse({ ...focused, inventory: legacyInventory }).inventory.retentionFocus).toBeUndefined();
  });

  it("prioritizes source paths for both entry points and routes without expanding the caps", async () => {
    const root = await fixture();
    await mkdir(join(root, "apps", "other"), { recursive: true });
    await Promise.all(Array.from({ length: 205 }, async (_, index) => {
      const path = join(root, "apps", "other", String(index));
      await mkdir(path);
      await writeFile(join(path, "router.ts"), `const route = { path: '/other/${index}' };`);
    }));
    await mkdir(join(root, "services", "zz-resume"), { recursive: true });
    await writeFile(join(root, "services", "zz-resume", "main.go"), 'api.GET("/api/v1/files", handler)');
    const focused = await scanProject(root, { focus: "ZZ-RESUME", routeHintLimit: 200 });
    expect(focused.inventory.entryPoints).toHaveLength(200);
    expect(focused.inventory.routeHints).toHaveLength(200);
    expect(focused.inventory.truncated).toBe(true);
    expect(focused.inventory.entryPoints[0]).toMatchObject({ kind: "backend", path: "services/zz-resume/main.go" });
    expect(focused.inventory.routeHints[0]).toMatchObject({ path: "/api/v1/files", source: "services/zz-resume/main.go" });
  });

  it("retains reviewed alias targets by exact kind, method and source", async () => {
    const root = await fixture();
    await writeFile(join(root, "router.ts"), 'api.POST("/api/v1/files", wrongSource);');
    await mkdir(join(root, "services", "upload"), { recursive: true });
    await writeFile(join(root, "services", "upload", "main.go"), `${Array.from({ length: 1_101 }, () => 'api.GET("/api/v1/files", wrongMethod);').join("\n")}\napi.POST("/api/v1/files", correct);`);
    const target = { kind: "api" as const, path: "/api/v1/files", method: "POST" as const, origin: "http://localhost:8080", source: "services/upload/main.go" };
    const focused = await scanProject(root, { focus: "简历获取", routeTargets: [target], routeHintLimit: 200 });
    expect(focused.inventory.routeHints[0]).toMatchObject({ kind: "api", method: "POST", path: target.path, source: target.source, line: 1_102 });
    expect(focused.inventory.routeHints).toHaveLength(200);
    expect(focused.inventory.truncated).toBe(true);
    const unfocused = await scanProject(root, { routeTargets: [target], routeHintLimit: 200 });
    expect(unfocused.inventory.retentionFocus).toBeUndefined();
    expect(unfocused.inventory.routeHints.some((route) => route.method === "POST" && route.source === target.source)).toBe(false);
  });

  it("keeps focused unresolved locations when earlier diagnostics fill the detail cap", async () => {
    const root = await fixture();
    await writeFile(join(root, "aaa.go"), `package routes\nimport "github.com/gin-gonic/gin"\nfunc unknown(api *gin.RouterGroup) {\n${Array.from({ length: 25 }, (_, index) => `api.GET("/other/${index}", handler)`).join("\n")}\n}`);
    await writeFile(join(root, "zz-resume.go"), 'package routes\nimport "github.com/gin-gonic/gin"\nfunc unknown(api *gin.RouterGroup) { api.GET("/files", handler) }');
    const focused = await scanProject(root, { focus: "zz-resume" });
    expect(focused.inventory.routeDiagnostics).toMatchObject({ total: 26, omitted: 6 });
    expect(focused.inventory.routeDiagnostics?.items).toHaveLength(20);
    expect(focused.inventory.routeDiagnostics?.items[0]).toMatchObject({ source: "zz-resume.go", line: 3 });
    expect(focused.inventory.truncated).toBe(false);
  });

  it.each(["git", "filesystem"])("prioritizes a known source path before the %s file cap", async (sourceKind) => {
    const root = await fixture();
    if (sourceKind === "git") await git("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "apps", "bulk"), { recursive: true });
    await mkdir(join(root, "services", "zz-target"), { recursive: true });
    for (let offset = 0; offset < 4_001; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 4_001 - offset) }, (_, index) => writeFile(join(root, "apps", "bulk", `${offset + index}.txt`), "ignored content")));
    }
    await writeFile(join(root, "services", "zz-target", "main.go"), 'api.GET("/target", handler)');
    const focused = await scanProject(root, { focus: "SERVICES/ZZ-TARGET/MAIN.GO" });
    expect(focused.inventory).toMatchObject({ source: sourceKind, filesScanned: 4_000, truncated: true, truncationReasons: ["file-count-cap"] });
    expect(focused.inventory.routeHints).toContainEqual(expect.objectContaining({ path: "/target", source: "services/zz-target/main.go" }));
  }, 30_000);

  it.each([" ", "x".repeat(129)])("rejects invalid normalized focus rather than implying a scoped scan", async (focus) => {
    await expect(scanProject(await fixture(), { focus })).rejects.toThrow("Inventory focus");
  });
});
