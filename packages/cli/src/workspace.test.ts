import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  it("accepts external workspace options on every nested repeat command", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-repeat-cli-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-repeat-cli-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"repeat-cli"}');
    await expect(createProgram().parseAsync(["node", "proofkit", "mission", "repeat", "create", "mission-baseline",
      "--samples", "6", "--root", root, "--workspace", workspace])).rejects.toThrow("3 to 5 total samples");
    await expect(createProgram().parseAsync(["node", "proofkit", "mission", "repeat", "status", "invalid",
      "--root", root, "--workspace", workspace])).rejects.toThrow("Invalid repeat series id");
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("creates a Mission from a scope-pinned external candidate without changing source", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-pinned-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-pinned-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"pinned-source"}');
    await mkdir(join(workspace, ".proofkit", "charters"), { recursive: true });
    await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({ project: { root } }));
    const path = ".proofkit/charters/quick.yml";
    await writeFile(join(workspace, ".proofkit", "charters", "quick.yml"), JSON.stringify({
      intent: "quick candidate", level: "quick", surfaces: ["web"], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = (...args: string[]) => createProgram().parseAsync(["node", "proofkit", ...args, "--root", root, "--workspace", workspace]);
    await run("scope", "--level", "quick");
    const candidate = JSON.parse(String(log.mock.calls[0]?.[0])).workspaceCandidates.items[0];
    log.mockClear();
    await run("mission", "create", "快速检查候选流程", "--level", "quick", "--candidate", path, "--candidate-sha256", candidate.sha256);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).charter).toMatchObject({ metadata: { proofkitCandidate: { path, sha256: candidate.sha256 } } });
    await expect(run("mission", "create", "快速检查候选流程", "--level", "quick", "--candidate", path)).rejects.toThrow("requires the SHA-256");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"pinned-source"}');
  });
  it("rejects invalid inspection prerequisites before creating a Run or launching a browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-inspection-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-inspection-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"inspection-source"}');
    await mkdir(join(workspace, ".proofkit"));
    await writeFile(join(workspace, ".proofkit/config.yaml"), JSON.stringify({
      project: { root }, surfaces: { web: { baseUrl: "http://127.0.0.1:1" } },
    }));
    const run = (...args: string[]) => createProgram().parseAsync(["node", "proofkit", "inspect", "--root", root, "--workspace", workspace, ...args]);
    await expect(run("--ready-timeout-ms", "100")).rejects.toThrow("requires --ready-text");
    await expect(run("--ready-text", " ")).rejects.toThrow();
    await expect(run("--ready-text", "ready", "--ready-timeout-ms", "NaN")).rejects.toThrow();
    await expect(run("--ready-text", "ready", "--ready-timeout-ms", "15001")).rejects.toThrow();
    expect(await readdir(join(workspace, ".proofkit"))).toEqual(["config.yaml"]);
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("reports environment prerequisites and an external artifact without changing source", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-environment-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-environment-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"environment-source"}');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      await createProgram().parseAsync(["node", "proofkit", "environment", "--root", root, "--workspace", workspace, "--surface", "electron"]);
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result).toMatchObject({ testVerdict: "not-asserted", status: "blocked", surface: "electron" });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(await readFile(result.artifact.path, "utf8")).inspectionId).toBe(result.inspectionId);
      expect(await readdir(root)).toEqual(["package.json"]);
      await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({ project: { root }, surfaces: { mobile: { serverUrl: "http://127.0.0.1:1" } } }));
      log.mockClear();
      await createProgram().parseAsync(["node", "proofkit", "environment", "--root", root, "--workspace", workspace, "--surface", "mobile", "--timeout-ms", "500"]);
      const mobile = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(mobile).toMatchObject({ testVerdict: "not-asserted", status: "blocked", surface: "mobile",
        checks: expect.arrayContaining([expect.objectContaining({ id: "webdriver-status", status: "blocked" })]) });
      expect(await readdir(root)).toEqual(["package.json"]);
      await expect(createProgram().parseAsync(["node", "proofkit", "environment", "--root", root, "--workspace", workspace, "--timeout-ms", "NaN"])).rejects.toThrow();
    } finally { process.exitCode = exitCode; }
  });
  it("accepts a one-time Web environment URL without rewriting the workspace configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-candidate-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-candidate-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"candidate-source"}');
    await mkdir(join(workspace, ".proofkit"));
    const configPath = join(workspace, ".proofkit", "config.yaml");
    const config = JSON.stringify({ project: { root }, surfaces: { web: { baseUrl: "http://127.0.0.1:1/old" } } });
    await writeFile(configPath, config);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      await createProgram().parseAsync(["node", "proofkit", "environment", "--root", root, "--workspace", workspace,
        "--url", "http://127.0.0.1:2/candidate?private=hidden", "--timeout-ms", "500"]);
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.testVerdict).toBe("not-asserted");
      expect(result.checks).toContainEqual(expect.objectContaining({ id: "surface-http", http: expect.objectContaining({ endpoint: "http://127.0.0.1:2/candidate" }) }));
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally { process.exitCode = exitCode; }
  });

  it("returns bounded static scope with defaults and validates level, surface and limit inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cli-scope-source-"));
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-cli-scope-workspace-"));
    roots.push(root, workspace);
    await writeFile(join(root, "package.json"), '{"name":"scope-source","devDependencies":{"vite":"1"}}');
    await mkdir(join(root, "src"));
    const router = "const routes = [{ path: '/resumes' }, { path: '/login' }];\n";
    await writeFile(join(root, "src", "router.ts"), router);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = (...args: string[]) => createProgram().parseAsync(["node", "proofkit", "scope", "--root", root, "--workspace", workspace, ...args]);
    await run();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run", selection: { level: "core", surface: "web" }, routes: { total: 2, mapped: 0, unmapped: 2 },
      planningReadiness: { status: "authoring-needed", compatibleReady: 0, gaps: expect.arrayContaining([expect.objectContaining({ code: "no-compatible-plan" })]) } });
    log.mockClear();
    await run("--level", "release", "--surface", "electron", "--limit", "1");
    const limited = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(limited.selection.requiredSurfaces).toEqual(["web", "electron"]);
    expect(limited.routes).toMatchObject({ matched: 2, omitted: 1 });
    expect(limited.routes.items).toHaveLength(1);
    log.mockClear();
    await run("--focus", "RESUMES");
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).routes).toMatchObject({ total: 2, matched: 1, items: [{ path: "/resumes", source: "src/router.ts" }] });
    log.mockClear();
    await run("--source-state");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ sourceState: { method: "unavailable", complete: false }, workflowInventory: { status: "missing" } });
    for (const options of [["--level", "unknown"], ["--surface", "desktop"], ["--limit", "0"], ["--limit", "NaN"], ["--limit", "51"]]) {
      await expect(run(...options)).rejects.toThrow();
    }
    expect(await readdir(workspace)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(["package.json", "src"]);
    expect(await readFile(join(root, "src", "router.ts"), "utf8")).toBe(router);
  });

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
    await run("mission", "create", "verify ready", "--charter", "charters/ready.yml");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ level: "quick", charter: { assertions: [{ kind: "text-visible", text: "ready" }] } });
    await expect(run("mission", "create", "上线完整回归", "--charter", "charters/ready.yml"))
      .rejects.toThrow("intent indicates release but supplied selection is quick");
    await expect(run("mission", "create", "测试整个项目", "--charter", "charters/ready.yml", "--coverage", "declared"))
      .rejects.toThrow("Test coverage conflict");
    await expect(run("plan", "测试整个项目", "--coverage", "declared"))
      .rejects.toThrow("Test coverage conflict");
    await expect(run("mission", "create", "verify ready", "--charter", "../outside.yml")).rejects.toThrow("within the ProofKit workspace");
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
    for (const id of ["resume", "login"]) {
      await writeFile(join(workspace, "charters", `${id}.yml`), JSON.stringify({
        intent: `test ${id}`, level: "release", mode: "deterministic", preconditions: [], actions: [],
        assertions: [{ kind: "text-visible", text: `${id} ready` }], oracles: [`${id}-terminal`],
        sideEffectPolicy: "deny", metadata: {},
      }));
    }
    await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({
      project: { root },
      charters: ["resume", "login"].map((id) => ({ id, path: `charters/${id}.yml`, aliases: [id], level: "release", surfaces: ["web", "electron"] })),
      suites: [{ id: "release-critical", aliases: ["上线完整回归"], level: "release", charterIds: ["resume", "login"], surfaces: ["web", "electron"] }],
      oracles: ["resume", "login"].map((id) => ({ name: `${id}-terminal`, url: `http://127.0.0.1:8080/${id}`, statusPointer: "/state", successValues: ["done"] })),
    }));
    log.mockClear();
    await run("suites");
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).suites).toEqual([expect.objectContaining({ id: "release-critical" })]);
    log.mockClear();
    await run("mission", "create", "上线完整回归", "--suite-id", "release-critical");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ level: "release", levelSelection: { source: "inferred", resolved: "release" }, suite: { suiteId: "release-critical", charters: [{ charterId: "resume" }, { charterId: "login" }] } });
    await expect(run("plan", "ready", "--out", "../outside.yml")).rejects.toThrow("within the ProofKit workspace");
    expect(await readdir(root)).toEqual(["package.json"]);
  });
});
