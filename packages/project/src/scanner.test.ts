import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanProject } from "./index.js";

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
});
