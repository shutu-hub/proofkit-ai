import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestScopeSchema } from "@proofkit/contracts";
import { z } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read-only test scope", () => {
  it("joins source-backed hints with validated plans and capability inputs without executing or writing", async () => {
    const { runner, callbacks } = await fixture();
    const before = await sourceFiles(runner.root);
    const scope = await runner.inspectTestScope();
    expect(TestScopeSchema.safeParse(scope).success).toBe(true);
    expect(scope).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run", selection: { level: "core", requiredSurfaces: ["web"] } });
    expect(scope.catalog.items.find((item) => item.id === "resume-core")?.check).toEqual({ eligible: true, planReady: true, issues: [] });
    expect(scope.routes).toMatchObject({ total: 5, mapped: 1, unmapped: 4 });
    expect(scope.routes.items.find((item) => item.path === "/resume")).toMatchObject({ source: "apps/web/src/router.ts", line: 3, status: "declared", charterIds: ["resume-core"] });
    expect(scope.routes.items.every((item) => !Object.hasOwn(item, "tested"))).toBe(true);
    expect(scope.oracles.items).toEqual(expect.arrayContaining([{ name: "resume.terminal", kind: "registered" }, { name: "status-http", kind: "configured-http" }]));
    const capability = scope.capabilities.items[0]!;
    expect(capability).toMatchObject({ name: "resume.read", environmentAllowed: true, operatorWriteOptIn: false, inputShape: { hint: { kind: "object", properties: { id: { kind: "string" }, optional: { optional: true, defaultOmitted: true }, transformed: { runtimeEffect: true } } }, partial: true } });
    expect(JSON.stringify(scope)).not.toContain("secret-default");
    expect(JSON.stringify(scope)).not.toContain("secret-query");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    expect(await sourceFiles(runner.root)).toEqual(before);
    expect((await readdir(runner.workspaceRoot)).sort()).toEqual(["charters"]);
  });

  it("reports stale and ambiguous mappings, and validates mapped Charters independently", async () => {
    const { runner } = await fixture();
    runner.config.charters[0]!.routeTargets = [{ kind: "web", path: "/missing" }, { kind: "web", path: "/shared" }, { kind: "web", path: "/resume" }];
    await writeCharter(runner.workspaceRoot, "resume-core", { assertions: [] });
    const scope = await runner.inspectTestScope();
    expect(scope.routes.unresolvedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/missing", reason: "absent" }),
      expect.objectContaining({ path: "/shared", reason: "ambiguous" }),
    ]));
    expect(scope.routes.mapped).toBe(1);
    expect(scope.catalog.items.find((item) => item.id === "resume-core")?.check).toMatchObject({ planReady: false, issues: [expect.stringContaining("positive surface assertion")] });
    runner.config.charters[0]!.routeTargets = [{ kind: "web", path: "/shared", source: "apps/web/src/router.ts" }];
    const qualified = await runner.inspectTestScope();
    expect(qualified.routes.items.find((item) => item.path === "/shared" && item.charterIds.length)).toMatchObject({ runtimeSourceAmbiguous: true, status: "declared" });
  });

  it("uses the same core/quick/release surface selection as Mission creation", async () => {
    const { runner } = await fixture();
    const quick = await runner.inspectTestScope({ level: "quick", surface: "electron" });
    expect(quick.catalog.eligible).toBe(1);
    expect(quick.catalog.items.find((item) => item.id === "quick-check")?.check.planReady).toBe(true);
    const release = await runner.inspectTestScope({ level: "release", surface: "web" });
    expect(release.selection.requiredSurfaces).toEqual(["web", "electron"]);
    expect(release.catalog.eligible).toBe(2);
    expect(release.catalog.items.find((item) => item.id === "release-web-only")?.check).toMatchObject({ eligible: false, planReady: false });
    expect(release.suites.items[0]?.check.planReady).toBe(true);
    const mobile = await runner.inspectTestScope({ level: "release", surface: "mobile" });
    expect(mobile.selection.requiredSurfaces).toEqual(["mobile"]);
    expect(mobile.catalog.eligible).toBe(0);
    const created = await runner.createMission({ intent: "test", charterId: "resume-release", surface: "web" });
    expect(created.plan.executionProfile.surfaceMatrix).toEqual(release.selection.requiredSurfaces);
  });

  it("returns per-plan errors for missing, invalid, unregistered and unsafe Charters", async () => {
    const { runner } = await fixture();
    runner.config.charters.push(...["missing-file", "invalid-file", "unknown-oracle", "outside", "private-yaml", "private-schema"].map((id) => ({ id, aliases: [id], path: `charters/${id}.yml`, level: "core" as const, surfaces: ["web" as const] })));
    await writeFile(join(runner.workspaceRoot, "charters", "invalid-file.yml"), "not-a-charter");
    await writeCharter(runner.workspaceRoot, "unknown-oracle", { oracles: ["not-registered"] });
    await writeCharter(runner.workspaceRoot, "outside", { actions: [{ kind: "goto", url: "https://unconfigured.example/path" }] });
    await writeFile(join(runner.workspaceRoot, "charters", "private-yaml.yml"), "intent: [secret-yaml-value\n");
    await writeCharter(runner.workspaceRoot, "private-schema", { level: "secret-schema-value" });
    const scope = await runner.inspectTestScope();
    for (const id of ["missing-file", "invalid-file", "unknown-oracle", "outside", "private-yaml", "private-schema"]) {
      expect(scope.catalog.items.find((item) => item.id === id)?.check).toMatchObject({ eligible: true, planReady: false });
    }
    expect(scope.catalog.items.find((item) => item.id === "unknown-oracle")?.check.issues[0]).toContain("unregistered Oracle");
    expect(scope.catalog.items.find((item) => item.id === "outside")?.check.issues[0]).toContain("outside the configured origin");
    expect(JSON.stringify(scope)).not.toContain("secret-yaml-value");
    expect(JSON.stringify(scope)).not.toContain("secret-schema-value");
    expect(scope.catalog.items.find((item) => item.id === "private-yaml")?.check.issues).toEqual(["Invalid test plan YAML; inspect the workspace-owned Charter source"]);
    expect(scope.catalog.items.find((item) => item.id === "private-schema")?.check.issues[0]).toContain("level: invalid_enum_value");
    await writeCharter(runner.workspaceRoot, "resume-core", { planning: { source: "catalog", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: ["project-map-truncated"] } });
    const gaps = await runner.inspectTestScope();
    expect(gaps.catalog.items.find((item) => item.id === "resume-core")?.check).toMatchObject({ planReady: false, issues: [expect.stringContaining("planning evidence gaps")] });
  });

  it("preserves method-qualified API declarations and distinguishes fragments from composed routes", async () => {
    const { runner } = await fixture();
    runner.config.charters[0]!.routeTargets = [
      { kind: "api", path: "/api/v1/resumes/:id", method: "GET", origin: "http://127.0.0.1:8080" },
      { kind: "api", path: "/api/v1/resumes/:id", method: "POST", origin: "http://127.0.0.1:8080" },
      { kind: "api", path: "/api/v1/resumes/:file_id", method: "GET", origin: "http://127.0.0.1:8080" },
    ];
    const scope = await runner.inspectTestScope();
    expect(scope.routes.mapped).toBe(1);
    expect(scope.routes.unresolvedTargets).toHaveLength(2);
    expect(scope.routes.items.find((item) => item.path === "/:file_id")?.status).toBe("unmapped");
    expect(scope.limitations).toContainEqual(expect.stringContaining("grouped API prefixes"));
  });

  it("bounds output, retains omitted counts, and marks partial inventory and literal focus", async () => {
    const { runner } = await fixture();
    const project = await runner.discover();
    project.inventory.truncated = true;
    vi.spyOn(runner, "discover").mockResolvedValue(project);
    const limited = await runner.inspectTestScope({ limit: 1 });
    expect(limited.routes).toMatchObject({ matched: 5, omitted: 4 });
    expect(limited.catalog).toMatchObject({ total: 5, matched: 5, omitted: 4 });
    expect(limited.catalog.items).toHaveLength(1);
    expect(limited.inventory.truncated).toBe(true);
    const focused = await runner.inspectTestScope({ focus: "RESUME", limit: 50 });
    expect(focused.routes).toMatchObject({ total: 5, matched: 2 });
    expect(focused.routes.items.every((item) => item.path.includes("resume"))).toBe(true);
    expect(focused.limitations).toContainEqual(expect.stringContaining("literal substring"));
    const empty = await runner.inspectTestScope({ focus: "no-such-workflow" });
    expect(empty.routes.matched).toBe(0);
    expect(empty.catalog.matched).toBe(0);
    await expect(runner.inspectTestScope({ limit: 0 })).rejects.toThrow();
    await expect(runner.inspectTestScope({ level: "unknown" as "core" })).rejects.toThrow();
  });

  it("does not invent ready core coverage for a project with no catalog or business checks", async () => {
    const { runner } = await fixture();
    const bare = new LocalRunnerService({ root: runner.root, workspaceRoot: runner.workspaceRoot, config: ProofkitConfigSchema.parse({}) });
    const scope = await bare.inspectTestScope();
    expect(scope.catalog).toMatchObject({ total: 0, eligible: 0, items: [] });
    expect(scope.oracles.total).toBe(0);
    expect(scope.routes).toMatchObject({ mapped: 0, unmapped: 5 });
    expect(scope.testVerdict).toBe("not-asserted");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-scope-source-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-scope-workspace-"));
  roots.push(root, workspaceRoot);
  await mkdir(join(root, "apps", "web", "src"), { recursive: true });
  await mkdir(join(root, "services", "gateway-service"), { recursive: true });
  await mkdir(join(workspaceRoot, "charters"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "scope-fixture", dependencies: { vite: "1" }, scripts: { dev: "must-not-run" } }));
  await writeFile(join(root, "apps", "web", "src", "router.ts"), "const a = { path: '/resume' };\nconst b = { path: '/shared' };\nconst duplicate = { path: '/resume' };\n");
  await writeFile(join(root, "apps", "web", "src", "other-router.ts"), "const b = { path: '/shared' };\n");
  await writeFile(join(root, "services", "gateway-service", "main.go"), 'api.GET("/api/v1/resumes/:id", get)\ngroup.GET("/:file_id", get)\n');
  const callbacks = { execute: vi.fn(), oracle: vi.fn(), setup: vi.fn(), preflight: vi.fn(), defaultValue: vi.fn(() => "secret-default"), transform: vi.fn((value) => value) };
  const config = ProofkitConfigSchema.parse({
    surfaces: { web: { baseUrl: "http://127.0.0.1:5173" }, electron: { cdpUrl: "http://127.0.0.1:9222" } },
    charters: [
      { id: "resume-core", path: "charters/resume-core.yml", aliases: ["简历", "resume"], level: "core", surfaces: ["web", "electron"], routeTargets: [{ kind: "web", path: "/resume" }] },
      { id: "quick-check", path: "charters/quick-check.yml", aliases: ["快速"], level: "quick", surfaces: ["web", "electron"] },
      ...["resume-release", "login-release", "release-web-only"].map((id) => ({ id, path: `charters/${id}.yml`, aliases: [id], level: "release", surfaces: id === "release-web-only" ? ["web"] : ["web", "electron"] })),
    ],
    suites: [{ id: "release-suite", aliases: ["上线"], level: "release", surfaces: ["web", "electron"], charterIds: ["resume-release", "login-release"] }],
    oracles: [{ name: "status-http", url: "http://127.0.0.1:8080/state?secret-query=x", statusPointer: "/state", successValues: ["done"] }],
  });
  for (const entry of config.charters) await writeCharter(workspaceRoot, entry.id, { level: entry.level });
  const runner = new LocalRunnerService({ root, workspaceRoot, config, restrictWebOrigins: true, integration: {
    name: "scope-fixture", setup: callbacks.setup, preflight: callbacks.preflight,
    oracles: [{ name: "resume.terminal", check: callbacks.oracle }],
    capabilities: [{ name: "resume.read", description: "Read terminal resume facts", sideEffect: "read", environments: ["test"], timeoutMs: 1000,
      inputSchema: z.object({ id: z.string(), optional: z.string().default(callbacks.defaultValue), transformed: z.string().transform(callbacks.transform) }), outputSchema: z.object({}), execute: callbacks.execute, evidence: () => ({}) }],
  } });
  return { runner, callbacks };
}

async function writeCharter(workspace: string, id: string, changes: Record<string, unknown> = {}) {
  await writeFile(join(workspace, "charters", `${id}.yml`), JSON.stringify({ intent: `test ${id}`, level: "core", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["resume.terminal"], sideEffectPolicy: "deny", ...changes }));
}

async function sourceFiles(root: string): Promise<Record<string, string>> {
  const files = ["package.json", "apps/web/src/router.ts", "apps/web/src/other-router.ts", "services/gateway-service/main.go"];
  return Object.fromEntries(await Promise.all(files.map(async (path) => [path, await readFile(join(root, path), "utf8")])));
}
