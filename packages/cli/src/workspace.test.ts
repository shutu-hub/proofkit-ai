import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "./main.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI workspace onboarding", () => {
  it("initializes, plans, maps and reopens a Mission from the same external workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"source-app","devDependencies":{"vite":"1"}}');
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const location = ["--root", root, "--workspace", workspace];
    const run = (...args: string[]) => createProgram().parseAsync(["node", "proofkit", ...args, ...location]);
    await run("init");
    await run("doctor");
    expect(log.mock.calls.some(([text]) => String(text).includes(workspace))).toBe(true);
    await run("map", "--out", "maps/project.json");
    expect(JSON.parse(await readFile(join(workspace, "maps", "project.json"), "utf8")).packageName).toBe("source-app");
    await run("plan", "verify ready", "--url", "http://127.0.0.1:5173", "--expect", "ready", "--level", "quick", "--out", "charters/ready.yml");
    expect(await readFile(join(workspace, "charters", "ready.yml"), "utf8")).toContain("text-visible");
    expect(stdout).toHaveBeenCalled();
    log.mockClear();
    await run("mission", "create", "verify ready", "--expect", "ready", "--level", "quick");
    const mission = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(mission.projectRoot).toBe(root);
    expect(mission.workspaceRoot).toBe(workspace);
    await run("mission", "approve", mission.missionId);
    log.mockClear();
    await run("mission", "status", mission.missionId);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).mission.status).toBe("approved");
    await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({
      project: { root },
      charters: [{ id: "ready-quick", path: "charters/ready.yml", aliases: ["ready"], level: "quick", surfaces: ["web"] }],
    }));
    log.mockClear();
    await run("charters");
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).charters).toEqual([expect.objectContaining({ id: "ready-quick" })]);
    log.mockClear();
    await run("mission", "create", "unrelated words", "--charter-id", "ready-quick");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ level: "quick", charter: { metadata: { catalogId: "ready-quick" } } });
    await expect(run("plan", "ready", "--out", "../outside.yml")).rejects.toThrow("within the ProofKit workspace");
    expect(await readdir(root)).toEqual(["package.json"]);
  });
});
