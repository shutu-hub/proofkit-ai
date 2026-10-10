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
      "inspect_test_environment",
      "inspect_surface",
      "list_test_charters",
      "list_test_suites",
      "create_test_mission",
      "run_test",
      "approve_test_plan",
      "start_mission",
      "get_mission_status",
      "await_test_result",
      "get_mission_evidence",
      "cancel_mission",
      "replay_mission",
      "compare_missions",
      "plan_test",
      "start_run",
      "get_run_status",
      "inspect_run_resources",
      "recover_run_resources",
      "cancel_run",
      "get_evidence",
      "replay_run",
    ]);
    expect(listed.tools.some((tool) => tool.name.includes("shell"))).toBe(false);
    const runTest = listed.tools.find((tool) => tool.name === "run_test");
    expect(runTest?.inputSchema).toMatchObject({ properties: { level: { enum: ["quick", "core", "release"] } } });
    const scope = listed.tools.find((tool) => tool.name === "inspect_test_scope");
    expect(scope?.inputSchema).toMatchObject({ properties: { level: { default: "core" }, limit: { maximum: 50 } } });
    for (const name of ["discover_project", "inspect_test_scope", "list_test_charters", "list_test_suites", "get_mission_status"]) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["inspect_test_environment", "inspect_surface", "create_test_mission", "run_test", "get_mission_evidence"]) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).not.toBe(true);
    }

    await client.close();
    await server.close();
  });

  it("routes resource inspection and recovery through the same runner without a tool-level write opt-in", async () => {
    const runner = {
      inspectRunResources: vi.fn(async () => ({ runId: "run-1", status: "active", testVerdict: "not-asserted", resources: [], issues: [] })),
      recoverRunResources: vi.fn(async () => { throw new Error("Resource recovery requires operator write permission"); }),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const inspection = await client.callTool({ name: "inspect_run_resources", arguments: { runId: "run-1" } });
      expect(JSON.parse(textContent(inspection))).toMatchObject({ status: "active", testVerdict: "not-asserted" });
      const recovery = await client.callTool({ name: "recover_run_resources", arguments: { runId: "run-1", allowCapabilityWrites: true } });
      expect(recovery.isError).toBe(true);
      expect(textContent(recovery)).toContain("operator write permission");
      expect(runner.recoverRunResources).toHaveBeenCalledWith("run-1");
      expect((await client.callTool({ name: "recover_run_resources", arguments: { runId: "../foreign" } })).isError).toBe(true);
      expect(runner.recoverRunResources).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it("exposes bounded configured environment observations independently of test planning", async () => {
    const runner = { inspectEnvironment: vi.fn(async () => ({ status: "incomplete", testVerdict: "not-asserted", notChecked: ["business-terminal"] })) } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "inspect_test_environment", arguments: {} });
      expect(JSON.parse(textContent(response))).toMatchObject({ status: "incomplete", testVerdict: "not-asserted" });
      expect(runner.inspectEnvironment).toHaveBeenCalledWith({ surface: "web", timeoutMs: 10000 }, expect.any(AbortSignal));
      expect((await client.callTool({ name: "inspect_test_environment", arguments: { timeoutMs: 15001 } })).isError).toBe(true);
      expect((await client.callTool({ name: "inspect_test_environment", arguments: { surface: "mobile" } })).isError).toBe(true);
      expect(runner.inspectEnvironment).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it("validates reconnaissance prerequisites and propagates MCP cancellation to the inspector", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((done) => { markStarted = done; });
    let markAborted!: () => void;
    const aborted = new Promise<void>((done) => { markAborted = done; });
    const runner = { config: { surfaces: {} }, inspectSurface: vi.fn(async (input) => {
      markStarted();
      return new Promise((done) => input.signal.addEventListener("abort", () => {
        markAborted();
        done({ status: "cancelled", testVerdict: "not-asserted" });
      }, { once: true }));
    }) } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      for (const readyWhen of [{ text: " " }, { text: "ready", timeoutMs: 15001 }, { text: "ready", timeoutMs: 99 }]) {
        expect((await client.callTool({ name: "inspect_surface", arguments: { readyWhen } })).isError).toBe(true);
      }
      expect(runner.inspectSurface).not.toHaveBeenCalled();
      const controller = new AbortController();
      const request = client.callTool({ name: "inspect_surface", arguments: { readyWhen: { text: "ready" } } }, undefined, { signal: controller.signal });
      const rejected = expect(request).rejects.toThrow();
      await started;
      expect(runner.inspectSurface).toHaveBeenCalledWith(expect.objectContaining({
        adapter: "web", readyWhen: { text: "ready", timeoutMs: 5000 }, signal: expect.any(AbortSignal),
      }));
      controller.abort(new Error("Stop reconnaissance"));
      await rejected;
      await aborted;
    } finally { await client.close(); await server.close(); }
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
        waitTool: "await_test_result",
        statusTool: "get_mission_status",
        evidenceTool: "get_mission_evidence",
        terminalStatuses: ["completed", "failed", "blocked", "cancelled"],
      },
      next: ["await_test_result"],
    });
    expect(payload.taskSummary).toEqual([
      expect.objectContaining({ taskId: "reconnaissance", status: "passed" }),
      expect.objectContaining({ taskId: "execute-charter", status: "running" }),
    ]);

    await client.close();
    await server.close();
  });

  it("does not request a second approval while a newly started Mission already has an owner", async () => {
    const mission = fixtureMission("awaiting-approval");
    const runner = {
      config: { surfaces: {} },
      createMission: vi.fn(async () => mission),
      startMission: vi.fn(async () => ({ mission, running: true })),
    } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "run_test", arguments: { intent: "测试简历获取核心链路", level: "core" } });
      expect(JSON.parse(textContent(response))).toMatchObject({
        missionId: "mission-test", status: "running", running: true, next: ["await_test_result"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits for an existing Mission and returns an evidence-checked terminal summary without starting it", async () => {
    const running = fixtureMission("running");
    const completed = fixtureMission("completed");
    const missionStatus = vi.fn()
      .mockResolvedValueOnce({ mission: running, running: true })
      .mockResolvedValue({ mission: completed, running: false });
    const missionEvidence = vi.fn(async () => ({ missionId: "mission-test", status: "completed", running: false,
      verdict: "passed", testVerdict: "inconclusive", testVerdictReason: "Legacy Oracle proof is unverified", level: "core", summary: { missionId: "mission-test", verdict: "passed" },
      evidenceIntegrity: { status: "intact" }, proofClassification: { status: "unverified", legacyOracles: 1 },
      report: "C:/workspace/report.html" }));
    const runner = { missionStatus, missionEvidence, startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "await_test_result", arguments: { missionId: "mission-test", timeoutMs: 1000 } });
      expect(JSON.parse(textContent(response))).toMatchObject({ state: "terminal", missionId: "mission-test",
        status: "completed", verdict: "passed", testVerdict: "inconclusive", evidenceIntegrity: { status: "intact" },
        proofClassification: { status: "unverified", legacyOracles: 1 },
        testVerdictReason: "Legacy Oracle proof is unverified",
        report: "C:/workspace/report.html", next: ["get_mission_evidence"] });
      expect(missionStatus).toHaveBeenCalledTimes(2);
      expect(missionEvidence).toHaveBeenCalledWith("mission-test");
      expect(runner.startMission).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("reports an active Mission at the wait deadline and does not infer a product verdict", async () => {
    const missionStatus = vi.fn(async () => ({ mission: fixtureMission("running"), running: true }));
    const missionEvidence = vi.fn();
    const runner = { missionStatus, missionEvidence, startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "await_test_result", arguments: { missionId: "mission-test", timeoutMs: 500 } });
      const payload = JSON.parse(textContent(response));
      expect(payload).toMatchObject({ state: "still-running", status: "running", running: true, next: ["await_test_result"] });
      expect(payload.verdict).toBeUndefined();
      expect(missionEvidence).not.toHaveBeenCalled();
      expect(runner.startMission).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("returns a next action immediately when the Mission has no active owner", async () => {
    const runner = { missionStatus: vi.fn(async () => ({ mission: fixtureMission("awaiting-approval"), running: false })),
      missionEvidence: vi.fn(), startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "await_test_result", arguments: { missionId: "mission-test" } });
      expect(JSON.parse(textContent(response))).toMatchObject({ state: "needs-action", status: "awaiting-approval",
        running: false, testVerdict: "not-asserted", readiness: { ready: true },
        next: ["approve_test_plan", "start_mission"] });
      expect(runner.missionEvidence).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("does not suggest approval for an unready whole-project Mission", async () => {
    const mission = fixtureMission("awaiting-approval");
    mission.plan.planning = { source: "catalog", confidence: 0, assumptions: [], missingInputs: [],
      evidenceGaps: ["project-workflow-coverage"], coverage: { requested: "project", source: "explicit",
        reason: "测试整个项目", inventory: "bounded", workflowCoverage: "unmeasured", gaps: ["project-workflow-coverage"] } };
    const runner = { missionStatus: vi.fn(async () => ({ mission, running: false })),
      missionEvidence: vi.fn(), startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const status = await client.callTool({ name: "get_mission_status", arguments: { missionId: mission.missionId } });
      expect(JSON.parse(textContent(status))).toMatchObject({ testVerdict: "not-asserted" });
      const response = await client.callTool({ name: "await_test_result", arguments: { missionId: mission.missionId } });
      expect(JSON.parse(textContent(response))).toMatchObject({ state: "needs-action", status: "awaiting-approval",
        testVerdict: "not-asserted", readiness: { ready: false, missing: ["规划证据缺口：project-workflow-coverage"] },
        next: ["inspect_test_scope"] });
      expect(runner.startMission).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("labels an unexecuted Mission evidence snapshot as not-asserted", async () => {
    const runner = { missionEvidence: vi.fn(async () => ({ missionId: "mission-test", status: "awaiting-approval",
      summary: { verdict: undefined }, report: "C:/workspace/planning-report.html" })) } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "get_mission_evidence", arguments: { missionId: "mission-test" } });
      expect(JSON.parse(textContent(response))).toMatchObject({ status: "awaiting-approval", testVerdict: "not-asserted" });
    } finally { await client.close(); await server.close(); }
  });

  it("cancels only the wait when the MCP caller disconnects", async () => {
    let observed!: () => void;
    const firstStatus = new Promise<void>((resolve) => { observed = resolve; });
    const runner = { missionStatus: vi.fn(async () => { observed(); return { mission: fixtureMission("running"), running: true }; }),
      missionEvidence: vi.fn(), cancelMission: vi.fn(), startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const controller = new AbortController();
      const pending = client.callTool({ name: "await_test_result", arguments: { missionId: "mission-test", timeoutMs: 20_000 } }, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      await firstStatus;
      controller.abort(new Error("Stop waiting"));
      await rejected;
      expect(runner.cancelMission).not.toHaveBeenCalled();
      expect(runner.startMission).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("accepts a release suite from one natural-language MCP call", async () => {
    const mission = fixtureMission("running");
    const charter = { ...mission.charter!, level: "release" as const };
    mission.level = "release";
    mission.policy.level = "release";
    mission.plan.level = "release";
    mission.plan.executionProfile = { ...mission.plan.executionProfile, suiteId: "release-critical", charterIds: ["resume", "login"], surfaceMatrix: ["web", "electron"], collectAllResults: true, requireReplay: true };
    mission.suite = { suiteId: "release-critical", origin: "catalog", level: "release", surfaces: ["web", "electron"], charters: [{ charterId: "resume", charter }, { charterId: "login", charter: { ...charter, intent: "test login" } }], uncoveredCharterIds: [] };
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

  it("runs a structurally ready project suite while retaining whole-project acceptance gaps", async () => {
    const mission = fixtureMission("awaiting-approval");
    const charter = { ...mission.charter!, level: "release" as const };
    mission.level = "release";
    mission.policy.level = "release";
    mission.plan.level = "release";
    mission.plan.executionProfile = { ...mission.plan.executionProfile, suiteId: "critical", charterIds: ["resume", "login"], surfaceMatrix: ["web", "electron"], collectAllResults: true, requireReplay: true };
    mission.suite = { suiteId: "critical", origin: "catalog", level: "release", surfaces: ["web", "electron"], charters: [{ charterId: "resume", charter }, { charterId: "login", charter }], uncoveredCharterIds: [] };
    mission.charter = undefined;
    mission.plan.planning = { source: "catalog", confidence: 0, assumptions: [], missingInputs: [], evidenceGaps: ["project-workflow-coverage", "project-map-truncated"],
      coverage: { requested: "project", source: "inferred", reason: "whole project", inventory: "partial", workflowCoverage: "unmeasured", gaps: ["project-map-truncated", "project-workflow-coverage"] } };
    const runner = { config: { surfaces: {} }, createMission: vi.fn(async () => mission), startMission: vi.fn(async () => ({ mission, running: true })) } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    const response = await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目", suiteId: "critical", level: "release" } });
    const payload = JSON.parse(textContent(response));
    expect(payload).toMatchObject({ running: true, readiness: { ready: true, missing: [], acceptanceGaps: ["project-workflow-coverage", "project-map-truncated"] } });
    expect(runner.startMission).toHaveBeenCalled();
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

  it("does not suggest a narrower rerun when whole-project workflow coverage is missing", async () => {
    const mission = fixtureMission("awaiting-approval");
    mission.plan.planning = { source: "catalog", confidence: 0, assumptions: [], missingInputs: [],
      evidenceGaps: ["project-workflow-coverage"], coverage: { requested: "project", source: "explicit",
        reason: "测试整个项目", inventory: "bounded", workflowCoverage: "unmeasured", gaps: ["project-workflow-coverage"] } };
    const runner = { config: { surfaces: {} }, createMission: vi.fn(async () => mission), startMission: vi.fn() } as unknown as LocalRunnerService;
    const { client, server } = await connectedClient(runner);
    try {
      const response = await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目", coverage: "project", level: "core" } });
      expect(JSON.parse(textContent(response))).toMatchObject({
        status: "awaiting-approval", running: false, testVerdict: "not-asserted",
        readiness: { ready: false, missing: ["规划证据缺口：project-workflow-coverage"] },
        next: ["inspect_test_scope"],
      });
      expect(runner.startMission).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
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
        summary: { missionId: mission.missionId, verdict: "passed", expectedRuns: 1, observedRuns: 1 },
        report: "test-workspace/.proofkit/missions/mission-test/report.html",
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
      summary: { missionId: "mission-test", verdict: "passed", expectedRuns: 1, observedRuns: 1 },
      report: "test-workspace/.proofkit/missions/mission-test/report.html",
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
