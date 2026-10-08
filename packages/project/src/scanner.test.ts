import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initProject, scanProject } from "./index.js";

describe("scanProject", () => {
  it("maps package scripts and workspace surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-project-"));
    await mkdir(join(root, "apps", "desktop"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@10", scripts: { dev: "vite" }, devDependencies: { vite: "1" } }));
    await writeFile(join(root, "apps", "desktop", "package.json"), JSON.stringify({ name: "desktop", scripts: { dev: "electron ." }, dependencies: { electron: "1" } }));
    const map = await scanProject(root);
    expect(map.detected.web).toBe(true);
    expect(map.detected.electron).toBe(true);
    expect(map.packages[0]?.name).toBe("desktop");
  });

  it("creates a config and integration starter without overwriting either", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-init-"));
    await initProject(root);
    const integrationPath = join(root, ".proofkit", "integration.mjs");
    expect(await readFile(integrationPath, "utf8")).toContain("project-integration");
    await writeFile(integrationPath, "export default { name: 'custom' };", "utf8");
    await initProject(root);
    expect(await readFile(integrationPath, "utf8")).toContain("custom");
  });
});
