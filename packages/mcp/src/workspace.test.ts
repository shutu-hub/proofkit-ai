import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { createProofkitMcp } from "./server.js";

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-client", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payload(result: unknown) {
  const content = typeof result === "object" && result !== null && "content" in result
    ? (result as { content?: unknown }).content
    : undefined;
  if (!Array.isArray(content)) throw new Error("MCP response did not contain text content");
  const item = content.find((candidate): candidate is { type: "text"; text: string } => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const value = candidate as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string";
  });
  if (!item) throw new Error("MCP response did not contain a text item");
  return JSON.parse(item.text);
}

describe("MCP external workspace", () => {
  it("runs a reviewed workspace candidate by path and digest, then rejects a changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-candidate-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-candidate-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
      vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
      vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }));
      await writeFile(join(root, "package.json"), '{"name":"candidate-source"}');
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({ project: { root } }));
      const candidatePath = ".proofkit/charters/quick.yml";
      const file = join(workspaceRoot, ".proofkit", "charters", "quick.yml");
      const charter = { intent: "quick candidate", level: "quick", actions: [],
        assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" };
      await writeFile(file, JSON.stringify(charter));
      server = await createProofkitMcp({ root, workspaceRoot });
      client = await connect(server);
      const scope = payload(await client.callTool({ name: "inspect_test_scope", arguments: { level: "quick" } }));
      const candidate = scope.workspaceCandidates.items[0];
      expect(candidate).toMatchObject({ path: candidatePath, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), parseStatus: "valid" });
      const selected = { intent: "快速检查候选流程", level: "quick", charterPath: candidatePath, charterSha256: candidate.sha256 };
      const started = payload(await client.callTool({ name: "run_test", arguments: selected }));
      expect(started).toMatchObject({ level: "quick", running: true, readiness: { ready: true } });
      expect((await waitForMission(client, started.missionId)).mission.verdict).toBe("passed");
      const evidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
      expect(evidence.testVerdict).toBe("passed");
      expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"candidate-source"}');
      const connections = vi.mocked(WebAdapter.prototype.connect).mock.calls.length;
      await writeFile(file, JSON.stringify({ ...charter, assertions: [{ kind: "text-visible", text: "changed" }] }));
      const changed = await client.callTool({ name: "run_test", arguments: selected });
      expect(changed.isError).toBe(true);
      expect(JSON.stringify(changed.content)).toContain("digest changed");
      expect(vi.mocked(WebAdapter.prototype.connect).mock.calls).toHaveLength(connections);
      const missingDigest = await client.callTool({ name: "create_test_mission", arguments: { intent: selected.intent, charterPath: candidatePath } });
      expect(missingDigest.isError).toBe(true);
      const corePath = ".proofkit/charters/core.yml";
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "core.yml"), JSON.stringify({
        intent: "core candidate", level: "core", actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny",
      }));
      const coreScope = payload(await client.callTool({ name: "inspect_test_scope", arguments: { level: "core", focus: "core.yml" } }));
      const coreCandidate = coreScope.workspaceCandidates.items[0];
      const core = payload(await client.callTool({ name: "run_test", arguments: {
        intent: "测试核心候选流程", level: "core", charterPath: corePath, charterSha256: coreCandidate.sha256,
      } }));
      expect(core).toMatchObject({ running: false, readiness: { ready: false }, planning: { evidenceGaps: ["business-oracle"] } });
      expect(vi.mocked(WebAdapter.prototype.connect).mock.calls).toHaveLength(connections);
    } finally {
      await client?.close();
      await server?.close();
      vi.restoreAllMocks();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
  it("inspects source-backed test scope through MCP without starting a surface or integration operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-scope-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-scope-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    const connectSurface = vi.spyOn(WebAdapter.prototype, "connect");
    try {
      await writeFile(join(root, "package.json"), '{"name":"scope-source","devDependencies":{"vite":"1"}}');
      await mkdir(join(root, "src"));
      const router = "const routes = [{ path: '/resumes' }, { path: '/login' }];\n";
      await writeFile(join(root, "src", "router.ts"), router);
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
        project: { root },
        charters: [{ id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["简历"], level: "core", surfaces: ["web"], routeTargets: [{ kind: "web", path: "/resumes" }] }],
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "resume.yml"), JSON.stringify({
        intent: "检查简历", level: "core", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["fixture.terminal"], sideEffectPolicy: "deny",
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), `
        const unexpected = async () => { throw new Error('Scope inspection invoked an integration operation'); };
        export default { name: 'scope-fixture', preflight: unexpected, setup: unexpected,
          oracles: [{ name: 'fixture.terminal', check: unexpected }] };
      `);
      server = await createProofkitMcp({ root, workspaceRoot });
      client = await connect(server);
      const result = payload(await client.callTool({ name: "inspect_test_scope", arguments: {} }));
      expect(result).toMatchObject({ testVerdict: "not-asserted", executionChecks: "not-run", selection: { level: "core", surface: "web", limit: 20 }, routes: { total: 2, mapped: 1, unmapped: 1 } });
      expect(result.catalog.items[0]).toMatchObject({ id: "resume-core", check: { eligible: true, planReady: true } });
      expect(result.planningReadiness).toMatchObject({ status: "catalog-ready", compatibleReady: 1 });
      const focused = payload(await client.callTool({ name: "inspect_test_scope", arguments: { focus: "简历", limit: 1 } }));
      expect(focused.routes).toMatchObject({ total: 2, matched: 1, omitted: 0 });
      expect(focused.routes.items[0]).toMatchObject({ path: "/resumes", source: "src/router.ts", line: 1, status: "declared" });
      expect(focused.planningReadiness).toMatchObject({ status: "catalog-ready", compatibleReady: 1 });
      const fingerprint = payload(await client.callTool({ name: "inspect_test_scope", arguments: { includeSourceState: true } }));
      expect(fingerprint).toMatchObject({ sourceState: { method: "unavailable", complete: false }, workflowInventory: { status: "missing" } });
      const invalid = await client.callTool({ name: "inspect_test_scope", arguments: { limit: 51 } });
      expect(invalid.isError).toBe(true);
      const conflicting = await client.callTool({ name: "run_test", arguments: { intent: "上线完整回归简历", charterId: "resume-core" } });
      expect(conflicting.isError).toBe(true);
      expect(JSON.stringify(conflicting.content)).toContain("intent indicates release but supplied selection is core");
      expect(connectSurface).not.toHaveBeenCalled();
      expect((await readdir(workspaceRoot)).sort()).toEqual([".proofkit"]);
      expect((await readdir(join(workspaceRoot, ".proofkit"))).sort()).toEqual(["charters", "config.yaml", "integration.mjs"]);
      expect((await readdir(root)).sort()).toEqual(["package.json", "src"]);
      expect(await readFile(join(root, "src", "router.ts"), "utf8")).toBe(router);
    } finally {
      await client?.close();
      await server?.close();
      vi.restoreAllMocks();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("runs a submitted core scenario in a large project while preserving coverage and business gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-submitted-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-submitted-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
      vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
      vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }));
      await writeFile(join(root, "package.json"), '{"name":"submitted-source","devDependencies":{"vite":"1"}}');
      const router = Array.from({ length: 2_030 }, (_, index) => `const route${index} = { path: '/feature-${index}' };`).join("\n");
      await writeFile(join(root, "router.ts"), router);
      await mkdir(join(workspaceRoot, ".proofkit"));
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({ project: { root } }));
      await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), `
        export default { name: 'submitted-fixture', oracles: [{ name: 'fixture.terminal', check: async () => ({
          name: 'fixture.terminal', passed: true, message: 'done', evidence: [JSON.stringify({ state: 'done' })],
        }) }] };
      `);
      server = await createProofkitMcp({ root, workspaceRoot });
      client = await connect(server);
      const charter = {
        intent: "验证新项目核心状态", level: "core", actions: [],
        assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["fixture.terminal"], sideEffectPolicy: "deny",
        planning: { source: "model", confidence: 1, evidenceGaps: ["invented-gap"] },
      };
      const started = payload(await client.callTool({ name: "run_test", arguments: { intent: charter.intent, charter } }));
      expect(started).toMatchObject({ level: "core", planning: { source: "submitted", evidenceGaps: [] }, readiness: { ready: true }, running: true });
      expect(started.planning.coverage).toMatchObject({ requested: "declared", inventory: "partial", workflowCoverage: "unmeasured", gaps: ["project-map-truncated", "project-workflow-coverage"] });
      const final = await waitForMission(client, started.missionId);
      expect(final.mission.verdict).toBe("passed");
      const evidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
      expect(evidence.testVerdict).toBe("passed");
      expect(evidence.proofClassification).toMatchObject({ status: "explicit", legacyOracles: 0 });
      expect(evidence.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "business" })]));
      const full = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId, detail: "full" } }));
      const omittedEvidenceReferences = full.summary.runs.reduce((count: number, run: { omittedEvidence: number }) => count + run.omittedEvidence, 0);
      expect(evidence.evidenceIntegrity).toMatchObject({
        status: omittedEvidenceReferences ? "partial" : "intact",
        scope: "presented-result",
        omittedEvidenceReferences,
      });
      const sourceFact = evidence.evidence.find((ref: { kind: string }) => ref.kind === "business");
      await writeFile(sourceFact.path, "changed after the saved Mission result");
      const changed = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
      expect(changed.verdict).toBe("passed");
      expect(changed.testVerdict).toBe("inconclusive");
      expect(changed.testVerdictReason).toContain("unverifiable evidence");
      expect(changed.acceptanceEvidenceIntegrity).toMatchObject({ status: "degraded", references: { unavailable: 1 } });
      expect(changed.evidenceIntegrity).toMatchObject({ status: "degraded", references: { unavailable: 1 } });
      expect(changed.summary.evidenceIntegrity).toEqual(changed.evidenceIntegrity);
      expect(evidence.planning.coverage).toEqual(started.planning.coverage);
      const connections = vi.mocked(WebAdapter.prototype.connect).mock.calls.length;
      const whole = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目", charter } }));
      expect(whole).toMatchObject({ running: false, readiness: { ready: false }, planning: { coverage: { requested: "project", source: "inferred" }, evidenceGaps: ["project-map-truncated", "project-workflow-coverage"] } });
      const missingOracle = payload(await client.callTool({ name: "run_test", arguments: { intent: charter.intent, charter: { ...charter, oracles: [] } } }));
      expect(missingOracle).toMatchObject({ running: false, readiness: { ready: false }, planning: { evidenceGaps: ["business-oracle"] } });
      expect(vi.mocked(WebAdapter.prototype.connect).mock.calls).toHaveLength(connections);
      for (const name of ["create_test_mission", "run_test", "plan_test"]) {
        const narrowed = await client.callTool({ name, arguments: { intent: "测试整个项目", charter, coverage: "declared" } });
        expect(narrowed.isError).toBe(true);
        expect(JSON.stringify(narrowed.content)).toContain("Test coverage conflict");
      }
      const narrowed = payload(await client.callTool({ name: "run_test", arguments: {
        intent: "不要测试整个项目，只测试简历模块", charter, coverage: "declared", autoApprove: false,
      } }));
      expect(narrowed.planning.coverage).toMatchObject({ requested: "declared", source: "explicit" });
      expect(narrowed.running).toBe(false);
      await client.callTool({ name: "start_mission", arguments: { missionId: whole.missionId, approve: true } });
      const incomplete = await waitForMission(client, whole.missionId);
      expect(incomplete.mission.verdict).toBe("inconclusive");
      expect(incomplete.mission.firstFailure).toMatchObject({ kind: "evidence", message: expect.stringContaining("project-workflow-coverage") });
      expect((await readdir(root)).sort()).toEqual(["package.json", "router.ts"]);
      expect(await readFile(join(root, "router.ts"), "utf8")).toBe(router);
    } finally {
      await client?.close();
      await server?.close();
      vi.restoreAllMocks();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    }
  });

  it("runs a curated write workflow only with the operator's process-level opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-write-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-write-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
      vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
      vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }));
      await writeFile(join(root, "package.json"), '{"name":"write-source"}');
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
        project: { root }, policies: { environment: "test", sideEffects: "allow" },
        charters: [{ id: "write-core", path: ".proofkit/charters/write.yml", aliases: ["写入测试"], level: "core", surfaces: ["web"] }],
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "write.yml"), JSON.stringify({
        intent: "验证隔离写入", level: "core", actions: [{ kind: "capability", name: "fixture.write", input: {} }],
        assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["fixture.written"], sideEffectPolicy: "allow",
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), `
        import { readFile, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export function createIntegration({ workspaceRoot, z }) {
          return { name: 'write-fixture', preflight: async () => ({ passed: true, message: 'isolated test scope' }),
            capabilities: [{ name: 'fixture.write', description: 'write test marker', sideEffect: 'write', environments: ['test'], timeoutMs: 1000,
              inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
              execute: async () => { await writeFile(join(workspaceRoot, 'executed.txt'), 'yes'); return { ok: true }; },
              evidence: (output) => ({ ok: output.ok }) }],
            oracles: [{ name: 'fixture.written', check: async () => {
              const marker = await readFile(join(workspaceRoot, 'executed.txt'), 'utf8');
              return { name: 'fixture.written', passed: marker === 'yes', message: 'marker written', evidence: [JSON.stringify({ marker })] };
            } }] };
        }
      `);

      server = await createProofkitMcp({ root, workspaceRoot, allowCapabilityWrites: false });
      client = await connect(server);
      const denied = payload(await client.callTool({ name: "run_test", arguments: { intent: "写入测试", level: "core" } }));
      const deniedStatus = await waitForMission(client, denied.missionId);
      expect(deniedStatus.mission.verdict).toBe("blocked");
      await expect(readFile(join(workspaceRoot, "executed.txt"), "utf8")).rejects.toThrow();
      await client.close();
      await server.close();

      server = await createProofkitMcp({ root, workspaceRoot, allowCapabilityWrites: true });
      client = await connect(server);
      const allowed = payload(await client.callTool({ name: "run_test", arguments: { intent: "写入测试", level: "core" } }));
      const allowedStatus = await waitForMission(client, allowed.missionId);
      expect(allowedStatus.mission.verdict).toBe("passed");
      expect(await readFile(join(workspaceRoot, "executed.txt"), "utf8")).toBe("yes");
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      vi.restoreAllMocks();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("resolves a one-sentence core request to a curated workspace Charter", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-catalog-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-catalog-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      await writeFile(join(root, "package.json"), '{"name":"catalog-source"}');
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
        project: { root },
        charters: [{ id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["简历获取"], level: "core", surfaces: ["web", "electron"] }],
        oracles: [{ name: "resume-status", url: "http://127.0.0.1:8080/status", statusPointer: "/data/status", successValues: ["complete"] }],
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "resume.yml"), JSON.stringify({
        intent: "验证简历获取完成", level: "core", actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "完成" }], oracles: ["resume-status"], sideEffectPolicy: "deny",
      }));
      server = await createProofkitMcp({ root, workspaceRoot });
      client = await connect(server);
      const catalog = payload(await client.callTool({ name: "list_test_charters", arguments: {} }));
      expect(catalog.charters).toEqual([expect.objectContaining({ id: "resume-core" })]);
      const started = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试简历获取核心链路", surface: "electron", autoApprove: false } }));
      expect(started).toMatchObject({ status: "awaiting-approval", level: "core", catalogId: "resume-core", oracleRequirement: { required: true, declared: 1 } });
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("selects the workspace from environment and reopens a Mission on a new connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      await writeFile(join(root, "package.json"), '{"name":"mcp-source","devDependencies":{"vite":"1"}}');
      vi.stubEnv("PROOFKIT_ROOT", root);
      vi.stubEnv("PROOFKIT_WORKSPACE_ROOT", workspaceRoot);
      server = await createProofkitMcp();
      client = await connect(server);
      const map = payload(await client.callTool({ name: "discover_project", arguments: {} }));
      expect(map.root).toBe(root);
      expect(map.packageName).toBe("mcp-source");
      const mission = payload(await client.callTool({ name: "run_test", arguments: { intent: "verify ready", expect: ["ready"], level: "quick", autoApprove: false } }));
      expect(mission).toMatchObject({ projectRoot: root, workspaceRoot, status: "awaiting-approval", level: "quick" });
      await client.close();
      await server.close();
      server = await createProofkitMcp();
      client = await connect(server);
      const status = payload(await client.callTool({ name: "get_mission_status", arguments: { missionId: mission.missionId } }));
      expect(status.mission.projectRoot).toBe(root);
      expect(status.mission.workspaceRoot).toBe(workspaceRoot);
      expect(status.mission.status).toBe("awaiting-approval");
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      vi.unstubAllEnvs();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
});

async function waitForMission(client: Client, missionId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = payload(await client.callTool({ name: "get_mission_status", arguments: { missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Mission ${missionId} did not finish`);
}
