import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestScopeSchema } from "@proofkit/contracts";
import { z } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read-only test scope", () => {
  it("discovers unregistered external Charters as bounded hints without making a plan ready", async () => {
    const { runner, callbacks } = await fixture();
    const before = await sourceFiles(runner.root);
    const candidateDir = join(runner.workspaceRoot, ".proofkit", "charters");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(join(candidateDir, "online-resume.yml"), JSON.stringify({
      intent: "验证简历获取链路", level: "core", actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "done" }], oracles: ["resume.terminal"],
    }));
    await writeFile(join(runner.workspaceRoot, "charters", "unregistered.yml"), JSON.stringify({
      intent: "another workflow", level: "quick", actions: [], assertions: [{ kind: "title-contains", text: "ready" }],
    }));
    const scope = await runner.inspectTestScope({ focus: "简历获取", level: "core" });
    expect(scope.workspaceCandidates).toMatchObject({ scanStatus: "complete", total: 2, matched: 1, selection: "focused", omitted: 0,
      items: [{ path: ".proofkit/charters/online-resume.yml", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), focusMatched: true, parseStatus: "valid", level: "core", actionCount: 1, assertionCount: 1, oracleCount: 1, issues: [] }] });
    expect(scope.workspaceCandidates?.items.some((item) => item.path === "charters/resume-core.yml")).toBe(false);
    expect(scope.planningReadiness).toMatchObject({ status: "authoring-needed", compatibleReady: 0,
      gaps: expect.arrayContaining([expect.objectContaining({ code: "unregistered-workspace-charters" })]) });
    expect(scope.testVerdict).toBe("not-asserted");
    expect(await sourceFiles(runner.root)).toEqual(before);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("uses an explicit unmatched fallback and reports structural gaps without exposing Charter content", async () => {
    const { runner } = await fixture();
    await writeFile(join(runner.workspaceRoot, "charters", "intake.yml"), JSON.stringify({
      intent: "private-intent-token", level: "core", actions: [{ kind: "capability", name: "missing.reader" }],
      assertions: [], oracles: ["missing.oracle"], sideEffectPolicy: "allow",
    }));
    await writeFile(join(runner.workspaceRoot, "charters", "broken.yml"), "intent: [private-yaml-token\n");
    const scope = await runner.inspectTestScope({ focus: "简历获取", limit: 1 });
    expect(scope.workspaceCandidates).toMatchObject({ total: 2, matched: 0, selection: "fallback-unmatched", omitted: 1 });
    expect(scope.limitations).toContainEqual(expect.stringContaining("fallback candidates"));
    const full = await runner.inspectTestScope({ focus: "简历获取", limit: 50 });
    expect(full.workspaceCandidates?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "charters/intake.yml", parseStatus: "valid", actionCount: 1, assertionCount: 0, oracleCount: 1,
        issues: ["missing-positive-assertion", "unregistered-capability", "mcp-workspace-policy-conflict", "unregistered-oracle"] }),
      expect.objectContaining({ path: "charters/broken.yml", parseStatus: "invalid", issues: ["invalid-charter"] }),
    ]));
    expect(JSON.stringify(full)).not.toContain("private-intent-token");
    expect(JSON.stringify(full)).not.toContain("private-yaml-token");
  });

  it("counts selected inline Oracles and reports execution-policy gaps for candidate Charters", async () => {
    const { runner } = await fixture();
    await writeFile(join(runner.workspaceRoot, "charters", "inline-reader.yml"), JSON.stringify({
      intent: "inline reader", level: "core", sideEffectPolicy: "allow",
      actions: [{ kind: "captureResponse", name: "submit", trigger: { kind: "click", selector: "#submit" },
        response: { url: "http://127.0.0.1:5173/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } }],
      assertions: [{ kind: "text-visible", text: "submitted" }], oracles: ["current-file"],
      httpOracles: [{ name: "current-file", url: "http://127.0.0.1:5173/api/v1/status", query: {
        fileId: { source: "response", stepId: "step-001", field: "fileId", matchPointer: "/data/file_id" },
      }, statusPointer: "/data/status", successValues: ["complete"] }],
    }));
    const allowedConfig = ProofkitConfigSchema.parse({ ...runner.config, policies: { ...runner.config.policies, sideEffects: "allow" } });
    const allowed = new LocalRunnerService({ root: runner.root, workspaceRoot: runner.workspaceRoot, config: allowedConfig, restrictWebOrigins: true });
    const inline = await allowed.inspectTestScope({ focus: "inline-reader" });
    expect(inline.workspaceCandidates?.items).toEqual([expect.objectContaining({ path: "charters/inline-reader.yml", oracleCount: 1, issues: [] })]);
    const inlineSource = JSON.parse(await readFile(join(runner.workspaceRoot, "charters", "inline-reader.yml"), "utf8")) as Record<string, unknown>;
    await writeFile(join(runner.workspaceRoot, "charters", "unused-inline.yml"), JSON.stringify({ ...inlineSource, intent: "unused inline", oracles: [] }));
    const unused = await allowed.inspectTestScope({ focus: "unused-inline" });
    expect(unused.workspaceCandidates?.items).toEqual([expect.objectContaining({ path: "charters/unused-inline.yml", oracleCount: 0,
      issues: ["missing-business-oracle"] })]);

    await writeFile(join(runner.workspaceRoot, "charters", "write-candidate.yml"), JSON.stringify({
      intent: "write candidate", level: "core", sideEffectPolicy: "allow",
      actions: [{ kind: "capability", name: "resume.write" }],
      assertions: [{ kind: "text-visible", text: "done" }], oracles: ["resume.terminal"],
    }));
    const restricted = new LocalRunnerService({ root: runner.root, workspaceRoot: runner.workspaceRoot, config: runner.config, restrictWebOrigins: true,
      integration: { name: "candidate-policy", oracles: [{ name: "resume.terminal", check: vi.fn() }], capabilities: [{
        name: "resume.write", description: "write fixture", sideEffect: "write", environments: ["staging"], timeoutMs: 1000,
        inputSchema: z.object({}), outputSchema: z.object({}), execute: vi.fn(), evidence: () => ({}),
      }] },
    });
    const write = await restricted.inspectTestScope({ focus: "write-candidate" });
    expect(write.workspaceCandidates?.items).toEqual([expect.objectContaining({ path: "charters/write-candidate.yml", issues: [
      "capability-environment-mismatch", "write-opt-in-required", "mcp-workspace-policy-conflict",
    ] })]);
    await writeFile(join(runner.workspaceRoot, "charters", "write-policy.yml"), JSON.stringify({
      intent: "write policy", level: "quick", sideEffectPolicy: "deny",
      actions: [{ kind: "capability", name: "resume.write" }], assertions: [{ kind: "text-visible", text: "done" }],
    }));
    const policy = await restricted.inspectTestScope({ focus: "write-policy" });
    expect(policy.workspaceCandidates?.items[0]?.issues).toEqual(expect.arrayContaining(["scenario-side-effect-policy-conflict", "write-opt-in-required"]));
    expect(write.testVerdict).toBe("not-asserted");
  });

  it("caps candidate reads and enumeration and excludes links and registered files", async () => {
    const { runner } = await fixture();
    await writeFile(join(runner.workspaceRoot, "charters", "oversized.yml"), "x".repeat(129 * 1024));
    const oversized = await runner.inspectTestScope({ focus: "oversized", limit: 50 });
    expect(oversized.workspaceCandidates?.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: "charters/oversized.yml", parseStatus: "oversized", issues: ["file-too-large"] })]));
    const secret = join(runner.root, "outside-secret.yml");
    await writeFile(secret, "intent: outside-secret-token\n");
    try { await symlink(secret, join(runner.workspaceRoot, "charters", "linked.yml")); }
    catch (error) { if (!["EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    for (let index = 0; index < 105; index++) await writeFile(join(runner.workspaceRoot, "charters", `candidate-${String(index).padStart(3, "0")}.yml`),
      JSON.stringify({ intent: "candidate", level: "core", assertions: [], actions: [] }));
    const scope = await runner.inspectTestScope({ limit: 2 });
    expect(scope.workspaceCandidates).toMatchObject({ scanStatus: "partial", scanTruncated: true, total: 100, omitted: 98 });
    expect(scope.workspaceCandidates?.items).toHaveLength(2);
    expect(scope.workspaceCandidates?.items.every((item) => item.path.startsWith("charters/candidate-"))).toBe(true);
    expect(JSON.stringify(scope)).not.toContain("outside-secret-token");
  });
  it("retains an eligible alias's reviewed routes before global caps without executing checks", async () => {
    const { runner, callbacks } = await fixture();
    const routePath = "apps/web/src/router.ts";
    const source = `${Array.from({ length: 2_101 }, (_, index) => `const r${index} = { path: '/other/${index}' };`).join("\n")}\nconst target = { path: '/resume' };`;
    await writeFile(join(runner.root, routePath), source);
    const before = await sourceFiles(runner.root);
    const ordinary = await runner.inspectTestScope();
    expect(ordinary.routes.total).toBe(2_000);
    expect(ordinary.routes.items.some((route) => route.path === "/resume")).toBe(false);
    const scope = await runner.inspectTestScope({ focus: "简历", limit: 50 });
    expect(scope.inventory).toMatchObject({ retentionFocus: "简历", truncated: true });
    expect(scope.routes).toMatchObject({ total: 2_000, matched: 1, mapped: 1, omitted: 0 });
    expect(scope.routes.items[0]).toMatchObject({ path: "/resume", source: routePath, line: 2_102, status: "declared", charterIds: ["resume-core"] });
    expect(scope.catalog.items[0]?.check.planReady).toBe(true);
    expect(scope.limitations).toContainEqual(expect.stringContaining("retained candidate slice"));
    expect(scope.limitations).toContainEqual(expect.stringContaining("unscanned files"));
    expect(scope).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run" });
    expect(await sourceFiles(runner.root)).toEqual(before);
    expect((await readdir(runner.workspaceRoot)).sort()).toEqual(["charters"]);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("maps composed Gin paths and exposes unresolved declarations without running checks", async () => {
    const { runner, callbacks } = await fixture();
    await writeFile(join(runner.root, "services", "gateway-service", "main.go"), `package routes
import "github.com/gin-gonic/gin"
func routes() {
  api := gin.New().Group("/api/v1")
  api.Group("/files").GET("/:file_id", handler)
}
func helper(api *gin.RouterGroup) { api.GET("/unknown", handler) }
`);
    runner.config.charters[0]!.routeTargets = [{ kind: "api", path: "/api/v1/files/:file_id", method: "GET", origin: "http://localhost:8080" }];
    const scope = await runner.inspectTestScope({ focus: "files" });
    expect(scope.routes.items).toEqual([expect.objectContaining({ path: "/api/v1/files/:file_id", source: "services/gateway-service/main.go", line: 5, status: "declared", charterIds: ["resume-core"] })]);
    expect(scope.inventory.routeDiagnostics).toMatchObject({ total: 1, omitted: 0 });
    expect(scope.limitations).toContainEqual(expect.stringContaining("1 Gin route declarations"));
    expect(scope).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run" });
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("joins source-backed hints with validated plans and capability inputs without executing or writing", async () => {
    const { runner, callbacks } = await fixture();
    const before = await sourceFiles(runner.root);
    const scope = await runner.inspectTestScope();
    expect(TestScopeSchema.safeParse(scope).success).toBe(true);
    expect(scope).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run", selection: { level: "core", requiredSurfaces: ["web"] } });
    expect(scope.catalog.items.find((item) => item.id === "resume-core")?.check).toEqual({ eligible: true, planReady: true, issues: [] });
    expect(scope.planningReadiness).toMatchObject({ status: "catalog-ready", compatibleReady: 1 });
    expect(scope.next).toEqual(["inspect_test_environment", "inspect_surface", "run_test"]);
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
    const suiteOnlyFocus = await runner.inspectTestScope({ level: "release", surface: "web", focus: "上线" });
    expect(suiteOnlyFocus.catalog.matched).toBe(0);
    expect(suiteOnlyFocus.planningReadiness).toMatchObject({ status: "catalog-ready", compatibleReady: 1 });
    expect(suiteOnlyFocus.next.at(-1)).toBe("run_test");
    const missingSurface = await runner.inspectTestScope({ level: "release", surface: "web", focus: "release-web-only" });
    expect(missingSurface.planningReadiness).toMatchObject({ status: "authoring-needed",
      gaps: expect.arrayContaining([expect.objectContaining({ code: "surface-mismatch", relatedIds: ["release-web-only"] })]) });
    const mobile = await runner.inspectTestScope({ level: "release", surface: "mobile" });
    expect(mobile.selection.requiredSurfaces).toEqual(["mobile"]);
    expect(mobile.next[0]).toBe("inspect_test_environment");
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
    expect(gaps.planningReadiness?.gaps).toContainEqual(expect.objectContaining({ code: "plan-invalid" }));
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
    expect(scope.limitations).toContainEqual(expect.stringContaining("file-local prefix composition"));
  });

  it("bounds output, retains omitted counts, and marks partial inventory and literal focus", async () => {
    const { runner } = await fixture();
    const project = await runner.discover();
    project.inventory.truncated = true;
    project.inventory.truncationReasons = ["route-hint-cap"];
    vi.spyOn(runner, "discover").mockResolvedValue(project);
    const limited = await runner.inspectTestScope({ limit: 1 });
    expect(limited.routes).toMatchObject({ matched: 5, omitted: 4 });
    expect(limited.catalog).toMatchObject({ total: 5, matched: 5, omitted: 4 });
    expect(limited.catalog.items).toHaveLength(1);
    expect(limited.inventory.truncated).toBe(true);
    expect(limited.inventory.truncationReasons).toEqual(["route-hint-cap"]);
    expect(limited.limitations).toContainEqual(expect.stringContaining("route-hint result cap"));
    const focused = await runner.inspectTestScope({ focus: "RESUME", limit: 50 });
    expect(focused.routes).toMatchObject({ total: 5, matched: 2 });
    expect(focused.routes.items.every((item) => item.path.includes("resume"))).toBe(true);
    expect(focused.limitations).toContainEqual(expect.stringContaining("literal substring"));
    const empty = await runner.inspectTestScope({ focus: "no-such-workflow" });
    expect(empty.routes.matched).toBe(0);
    expect(empty.catalog.matched).toBe(0);
    expect(empty.planningReadiness).toMatchObject({ status: "inspection-incomplete", compatibleMatched: 0,
      gaps: expect.arrayContaining([expect.objectContaining({ code: "source-focus-unresolved" })]) });
    expect(empty.next).toEqual(["inspect_test_environment", "inspect_surface", "inspect_test_scope"]);
    await expect(runner.inspectTestScope({ limit: 0 })).rejects.toThrow();
    await expect(runner.inspectTestScope({ level: "unknown" as "core" })).rejects.toThrow();
  });

  it("does not invent ready core coverage for a project with no catalog or business checks", async () => {
    vi.stubEnv("PROOFKIT_ELECTRON_DEVTOOLS_PORT", undefined);
    const { runner } = await fixture();
    const bare = new LocalRunnerService({ root: runner.root, workspaceRoot: runner.workspaceRoot, config: ProofkitConfigSchema.parse({}) });
    const scope = await bare.inspectTestScope();
    expect(scope.catalog).toMatchObject({ total: 0, eligible: 0, items: [] });
    expect(scope.oracles.total).toBe(0);
    expect(scope.planningReadiness).toMatchObject({ status: "authoring-needed",
      gaps: expect.arrayContaining([expect.objectContaining({ code: "no-registered-oracle" })]) });
    expect(scope.routes).toMatchObject({ mapped: 0, unmapped: 5 });
    expect(scope.testVerdict).toBe("not-asserted");
    expect(scope.targetConfiguration).toEqual({ required: [{ surface: "web", status: "missing" }], runtimeChecked: false });
    const desktop = await bare.inspectTestScope({ surface: "electron", focus: "resume" });
    expect(desktop.targetConfiguration).toEqual({ required: [{ surface: "electron", status: "missing" }], runtimeChecked: false });
    const mobile = await bare.inspectTestScope({ surface: "mobile" });
    expect(mobile.targetConfiguration).toEqual({ required: [{ surface: "mobile", status: "default-driver" }], runtimeChecked: false });
    expect(desktop.testVerdict).toBe("not-asserted");
    vi.stubEnv("PROOFKIT_ELECTRON_DEVTOOLS_PORT", "D:/isolated/DevToolsActivePort");
    const attachedDesktop = await bare.inspectTestScope({ surface: "electron" });
    expect(attachedDesktop.targetConfiguration?.required).toEqual([{ surface: "electron", status: "configured" }]);
  });

  it("shows the full release connection matrix without probing either target", async () => {
    const { runner, callbacks } = await fixture();
    const scope = await runner.inspectTestScope({ level: "release", surface: "web" });
    expect(scope.targetConfiguration).toEqual({ required: [
      { surface: "web", status: "configured" }, { surface: "electron", status: "configured" },
    ], runtimeChecked: false });
    expect(scope.limitations).toContainEqual(expect.stringContaining("endpoint reachability"));
    expect(scope.testVerdict).toBe("not-asserted");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("explains an AIHR-like core focus without treating a matching quick Charter as core coverage", async () => {
    const { runner } = await fixture();
    runner.config.charters = [{ id: "resume-ui-quick", path: "charters/quick-check.yml",
      aliases: ["简历获取页面"], level: "quick", surfaces: ["web"] }];
    const scope = await runner.inspectTestScope({ level: "core", surface: "web", focus: "简历获取" });
    expect(scope.catalog.items).toEqual([expect.objectContaining({ id: "resume-ui-quick", level: "quick",
      check: expect.objectContaining({ eligible: false, planReady: false }) })]);
    expect(scope.planningReadiness).toMatchObject({ status: "authoring-needed", compatibleMatched: 0, compatibleReady: 0,
      gaps: expect.arrayContaining([
        expect.objectContaining({ code: "intensity-mismatch", relatedIds: ["resume-ui-quick"] }),
        expect.objectContaining({ code: "no-compatible-plan" }),
        expect.objectContaining({ code: "source-focus-unresolved" }),
        expect.objectContaining({ code: "oracle-name-unmatched" }),
      ]) });
    expect(scope.next.at(-1)).toBe("plan_test");
    expect(scope.testVerdict).toBe("not-asserted");
  });

  it("leaves catalog readiness unverified when the response limit hides compatible plans", async () => {
    const { runner } = await fixture();
    runner.config.charters.push({ id: "a-invalid-core", path: "charters/missing.yml", aliases: ["简历"],
      level: "core", surfaces: ["web"] });
    const scope = await runner.inspectTestScope({ level: "core", surface: "web", focus: "简历", limit: 1 });
    expect(scope.catalog.items).toEqual([expect.objectContaining({ id: "a-invalid-core", check: expect.objectContaining({ planReady: false }) })]);
    expect(scope.planningReadiness).toMatchObject({ status: "inspection-incomplete", compatibleMatched: 2, compatibleChecked: 1,
      compatibleReady: 0, compatibleOmitted: 1,
      gaps: expect.arrayContaining([expect.objectContaining({ code: "catalog-omitted" })]) });
    expect(scope.next.at(-1)).toBe("inspect_test_scope");
  });

  it("exposes a workspace workflow claim and freezes it on a whole-project Mission without clearing the coverage gate", async () => {
    const { runner, callbacks } = await fixture();
    await mkdir(join(runner.workspaceRoot, ".proofkit"));
    await writeFile(join(runner.workspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
      schemaVersion: 1,
      source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) },
      workflows: [{ id: "resume", title: "Resume workflow", sourcePaths: ["apps/web/src/router.ts"], charterIds: ["resume-core"], surfaces: ["web"] }],
    }));
    const scope = await runner.inspectTestScope();
    expect(scope.workflowInventory).toMatchObject({ status: "loaded", sourceMatch: "unverified", workflowCount: 1, linkedWorkflowCount: 1 });
    expect(scope.workflowInventory?.candidateAudit).toMatchObject({ status: "scanned", unlinkedRoutes: 1, unclaimed: expect.any(Number) });
    expect(scope.workflowInventory?.candidateAudit?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "apps/web/src/other-router.ts", reason: "unclaimed-source" }),
    ]));
    expect(scope.testVerdict).toBe("not-asserted");
    const mission = await runner.createMission({ intent: "测试整个项目", charterId: "resume-core", surface: "web" });
    expect(mission.workflowInventory?.workflows[0]?.id).toBe("resume");
    expect(mission.workflowInventoryInspection?.sourceMatch).toBe("unverified");
    expect(mission.workflowInventoryInspection?.candidateAudit).toEqual(scope.workflowInventory?.candidateAudit);
    expect(mission.plan.planning?.coverage?.requested).toBe("project");
    expect(mission.plan.planning?.evidenceGaps).toContain("project-workflow-coverage");
    const evidence = await runner.missionEvidence(mission.missionId);
    expect(evidence.summary.scope.workflowInventory).toMatchObject({ status: "loaded", workflowCount: 1 });
    expect(evidence.summary.scope.workflowInventory?.candidateAudit).toEqual(mission.workflowInventoryInspection?.candidateAudit);
    const report = await readFile(evidence.report!, "utf8");
    expect(report).toContain("Workflow inventory: loaded");
    expect(report).toContain("Static candidate review:");
    expect(report).toContain("apps/web/src/other-router.ts");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
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
