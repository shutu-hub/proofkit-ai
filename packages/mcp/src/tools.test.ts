import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { TestMission } from "@proofkit/contracts";
import { LocalRunnerService } from "@proofkit/local-runner";
import { registerTools } from "./tools.js";

describe("ProofKit MCP tools", () => {
  it("exposes only the high-level local runner surface", async () => {
    const runner = new LocalRunnerService({ root: process.cwd() });
    const server = new McpServer({ name: "proofkit-test", version: "0.1.0" });
    registerTools(server, runner);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "discover_project",
      "inspect_test_scope",
      "inspect_surface",
      "list_test_charters",
      "list_test_suites",
      "create_test_mission",
      "run_test",
      "approve_test_plan",
      "start_mission",
      "get_mission_status",
      "get_mission_evidence",
      "cancel_mission",
      "replay_mission",
      "compare_missions",
      "plan_test",
      "start_run",
      "get_run_status",
      "cancel_run",
      "get_evidence",
      "replay_run",
    ]);
    expect(listed.tools.some((tool) => tool.name.includes("shell"))).toBe(false);
    const runTest = listed.tools.find((tool) => tool.name === "run_test");
    expect(runTest?.inputSchema).toMatchObject({ properties: { level: { enum: ["quick", "core", "release"] } } });
    const scope = listed.tools.find((tool) => tool.name === "inspect_test_scope");
    expect(scope?.inputSchema).toMatchObject({ properties: { level: { default: "core" }, limit: { maximum: 50 } } });

    await client.close();
    await server.close();
  });

  it("returns a stable mission start contract for an AI client", async () => {
    const mission = fixtureMission("running");
    const runner = {
      config: { surfaces: {} },
      createMission: vi.fn(async () => mission),
      startMission: vi.fn(async () => ({ mission, running: true })),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);

    const response = await client.callTool({
      name: "run_test",
      arguments: { intent: "测试简历获取核心链路", level: "core" },
    });
    const payload = JSON.parse(textContent(response));

    expect(payload).toMatchObject({
      missionId: "mission-test",
      status: "running",
      running: true,
      level: "core",
      executionProfile: {
        surfaceMatrix: ["web"],
        requireBusinessOracle: true,
        requireReplay: false,
      },
      oracleRequirement: {
        required: true,
        declared: 1,
      },
      readiness: { ready: true, missing: [] },
      polling: {
        statusTool: "get_mission_status",
        evidenceTool: "get_mission_evidence",
        terminalStatuses: ["completed", "failed", "blocked", "cancelled"],
      },
      next: ["get_mission_status", "get_mission_evidence"],
    });
    expect(payload.taskSummary).toEqual([
      expect.objectContaining({ taskId: "reconnaissance", status: "passed" }),
      expect.objectContaining({ taskId: "execute-charter", status: "running" }),
    ]);

    await client.close();
    await server.close();
  });

  it("accepts a release suite from one natural-language MCP call", async () => {
    const mission = fixtureMission("running");
    const charter = { ...mission.charter!, level: "release" as const };
    mission.level = "release";
    mission.policy.level = "release";
    mission.plan.level = "release";
    mission.plan.executionProfile = { ...mission.plan.executionProfile, suiteId: "release-critical", charterIds: ["resume", "login"], surfaceMatrix: ["web", "electron"], collectAllResults: true, requireReplay: true };
    mission.suite = { suiteId: "release-critical", level: "release", surfaces: ["web", "electron"], charters: [{ charterId: "resume", charter }, { charterId: "login", charter: { ...charter, intent: "test login" } }], uncoveredCharterIds: [] };
    mission.charter = undefined;
    const runner = {
      config: { surfaces: {} },
      listSuites: vi.fn(() => [{ id: "release-critical", aliases: ["上线完整回归"], level: "release", charterIds: ["resume", "login"], surfaces: ["web", "electron"] }]),
      createMission: vi.fn(async () => mission),
      startMission: vi.fn(async () => ({ mission, running: true })),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);

    const listed = await client.callTool({ name: "list_test_suites", arguments: {} });
    expect(JSON.parse(textContent(listed)).suites).toHaveLength(1);
    const response = await client.callTool({ name: "run_test", arguments: { intent: "上线完整回归", suiteId: "release-critical", surface: "web" } });
    const payload = JSON.parse(textContent(response));
    expect(runner.createMission).toHaveBeenCalledWith(expect.objectContaining({ suiteId: "release-critical", surface: "web" }));
    expect(runner.startMission).toHaveBeenCalled();
    expect(payload).toMatchObject({ suiteId: "release-critical", includedCharterIds: ["resume", "login"], readiness: { ready: true }, running: true });

    await client.close();
    await server.close();
  });

  it("holds an incomplete core request before surface execution", async () => {
    const mission = fixtureMission("awaiting-approval");
    mission.charter = { ...mission.charter!, assertions: [], oracles: [] };
    const runner = {
      config: { surfaces: {} },
      createMission: vi.fn(async () => mission),
      startMission: vi.fn(),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);

    const response = await client.callTool({ name: "run_test", arguments: { intent: "测试简历获取" } });
    const result = JSON.parse(textContent(response));
    expect(result).toMatchObject({
      running: false,
      readiness: { ready: false, missing: ["至少一个明确的正向表面断言", "至少一个独立业务 Oracle"] },
      next: ["inspect_test_scope", "inspect_surface", "plan_test", "run_test"],
    });
    expect(runner.startMission).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("surfaces a planning evidence gap before automatic execution", async () => {
    const mission = fixtureMission("awaiting-approval");
    mission.plan.planning = { source: "model", confidence: 0.5, assumptions: [], missingInputs: ["完整项目地图"], evidenceGaps: ["project-map-truncated"] };
    const runner = {
      config: { surfaces: {} },
      createMission: vi.fn(async () => mission),
      startMission: vi.fn(),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);

    const response = await client.callTool({ name: "run_test", arguments: { intent: "测试简历获取" } });
    const payload = JSON.parse(textContent(response));
    expect(payload).toMatchObject({
      running: false,
      planning: { evidenceGaps: ["project-map-truncated"] },
      readiness: { ready: false, missing: ["规划证据缺口：project-map-truncated"] },
    });
    expect(runner.startMission).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("exposes terminal mission state together with bounded evidence metadata", async () => {
    const mission = fixtureMission("completed");
    const runner = {
      config: { surfaces: {} },
      missionEvidence: vi.fn(async () => ({
        missionId: mission.missionId,
        status: "completed",
        running: false,
        verdict: "passed",
        level: "core",
        levelSelection: mission.levelSelection,
        executionProfile: mission.plan.executionProfile,
        taskSummary: mission.plan.graph.tasks,
        agentSteps: [],
        evidence: [{ evidenceId: "evidence-1", kind: "business", path: "runs/x/oracle.json", capturedAt: new Date().toISOString() }],
        findings: [],
        repairSuggestions: [],
      })),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);

    const response = await client.callTool({ name: "get_mission_evidence", arguments: { missionId: mission.missionId } });
    const payload = JSON.parse(textContent(response));

    expect(payload).toMatchObject({
      missionId: "mission-test",
      status: "completed",
      running: false,
      verdict: "passed",
      level: "core",
      agentSteps: [],
      evidence: [expect.objectContaining({ kind: "business" })],
    });

    await client.close();
    await server.close();
  });

  it("returns the scoped repair comparison through MCP without starting a Run", async () => {
    const compareMissions = vi.fn(async () => ({ baselineMissionId: "before", candidateMissionId: "after", status: "verified-in-scope", scopeMatched: true }));
    const runner = { config: { surfaces: {} }, compareMissions } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    const response = await client.callTool({ name: "compare_missions", arguments: { baselineMissionId: "before", candidateMissionId: "after" } });
    expect(compareMissions).toHaveBeenCalledWith("before", "after");
    expect(JSON.parse(textContent(response))).toMatchObject({ status: "verified-in-scope", scopeMatched: true });
    await client.close();
    await server.close();
  });
});

async function connectedClient(runner: LocalRunnerService) {
  const server = new McpServer({ name: "proofkit-test", version: "0.1.0" });
  registerTools(server, runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function fixtureMission(status: TestMission["status"]): TestMission {
  return {
    missionId: "mission-test",
    intent: "测试简历获取核心链路",
    projectRoot: process.cwd(),
    surface: "web",
    level: "core",
    levelSelection: { requested: "core", resolved: "core", source: "explicit", reason: "用户明确指定核心模块测试", confidence: 1 },
    policy: { level: "core", environment: "test", sideEffectPolicy: "confirm", requireApproval: false, requireEvidence: true, maxSteps: 100, timeoutMs: 300_000 },
    status,
    verdict: status === "completed" ? "passed" : undefined,
    charter: { intent: "测试简历获取核心链路", level: "core", mode: "guided", preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "完成" }], oracles: ["resume-status"], sideEffectPolicy: "confirm", metadata: {} },
    plan: {
      planId: "plan-test",
      version: "1",
      generatedBy: "test",
      graph: {
        tasks: [
          { taskId: "reconnaissance", title: "熟悉项目", objective: "发现项目", tool: "project.discover", input: {}, dependsOn: [], dependencyMode: "passed", status: "passed", attempts: 1, maxAttempts: 1 },
          { taskId: "execute-charter", title: "执行测试", objective: "执行链路", tool: "surface.run-charter", input: {}, dependsOn: ["reconnaissance"], dependencyMode: "passed", status: status === "running" ? "running" : "passed", attempts: 1, maxAttempts: 1 },
        ],
        terminalTaskIds: ["execute-charter"],
      },
      successCriteria: [],
      assumptions: [],
      level: "core",
      executionProfile: { surfaceMatrix: ["web"], charterIds: [], collectAllResults: false, negativeCases: ["关键权限或输入边界"], declaredNegativeCases: [], requireBusinessOracle: true, requireReplay: false, requireNegativeCases: false, minimumEvidence: 2 },
      createdAt: new Date().toISOString(),
    },
    agentSteps: [],
    toolCalls: [],
    observations: [],
    evidence: [],
    findings: [],
    repairSuggestions: [],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function textContent(response: unknown): string {
  const content = typeof response === "object" && response !== null && "content" in response
    ? (response as { content?: unknown }).content
    : undefined;
  if (!Array.isArray(content)) throw new Error("MCP response did not contain text content");
  const item = content.find((candidate): candidate is { type: string; text: string } => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const value = candidate as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string";
  });
  if (!item?.text) throw new Error("MCP response did not contain text content");
  return item.text;
}
