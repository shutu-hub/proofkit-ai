import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TestMission } from "@proofkit/contracts";
import { EnvironmentInspectionInputSchema, hasPositiveSurfaceAssertion, SurfaceReadinessSchema, TestCharterSchema, TestCoverageSchema, TestScopeInputSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "@proofkit/local-runner";

// MCP annotations are host scheduling hints, not authorization. Only operations
// that read existing source/config/Mission state receive a read-only hint.
const READ_ONLY_TOOL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerTools(server: McpServer, runner: LocalRunnerService): void {
  server.tool(
    "discover_project",
    "Scan the configured local project and report its Web, Electron, backend, scripts, and workspace packages.",
    {},
    READ_ONLY_TOOL,
    async () => result(await runner.discover()),
  );

  server.tool(
    "inspect_test_scope",
    "Read candidate source entry points, route declarations, level/surface-compatible plan checks, and registered business capabilities/Oracles. Optional focus is a literal substring. This does not run tests or prove coverage.",
    TestScopeInputSchema.shape,
    READ_ONLY_TOOL,
    async (input) => result(await runner.inspectTestScope(input)),
  );

  server.tool(
    "inspect_test_environment",
    "Observe configured Web/Electron HTTP endpoints and source association with a total deadline. Saves a workspace artifact; starts no app, browser, test or connector operation. This does not prove login, business readiness or product correctness.",
    EnvironmentInspectionInputSchema.shape,
    async (input, extra) => result(await runner.inspectEnvironment(input, extra.signal)),
  );

  server.tool(
    "inspect_surface",
    "Observe the configured Web or Electron page after an optional visible-text prerequisite. Return bounded controls, runtime diagnostics and evidence. This is reconnaissance, not a product pass verdict.",
    { surface: z.enum(["web", "electron"]).default("web"), url: z.string().url().optional(), readyWhen: SurfaceReadinessSchema.optional() },
    async ({ surface, url, readyWhen }, extra) => {
      if (surface === "electron" && url) throw new Error("Electron inspection uses the configured CDP page selector; url is only for Web");
      return result(await runner.inspectSurface({ adapter: surface, url: surfaceUrl(url, runner), readyWhen, signal: extra.signal }));
    },
  );

  server.tool(
    "list_test_charters",
    "List curated, workspace-owned tests that can be selected by natural language or charterId.",
    {},
    READ_ONLY_TOOL,
    async () => result({ charters: runner.listCharters() }),
  );

  server.tool(
    "list_test_suites",
    "List explicitly scoped release suites and the Charters each one includes.",
    {},
    READ_ONLY_TOOL,
    async () => result({ suites: runner.listSuites() }),
  );

  server.tool(
    "create_test_mission",
    "Create a reviewable AI test mission from natural language, a catalog ID, or an agent-submitted structured Charter. The tested project is not modified.",
    {
      intent: z.string().min(1),
      charter: TestCharterSchema.optional(),
      charterId: z.string().min(1).optional(),
      suiteId: z.string().min(1).optional(),
      coverage: TestCoverageSchema.optional().describe("declared limits acceptance to the saved scenarios; project requires whole-project workflow coverage proof"),
      surface: z.enum(["web", "electron", "mobile"]).default("web"),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
    },
    async ({ intent, charter, charterId, suiteId, coverage, surface, url, expect, oracleNames, level, mode, sideEffectPolicy }) => result(await runner.createMission({ intent, charter, charterId, suiteId, coverage, surface, url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy })),
  );

  server.tool(
    "run_test",
    "Run a natural-language ProofKit test mission at the requested intensity. Supply a structured Charter when no catalog entry covers the requested workflow. Poll status and evidence for the final result.",
    {
      intent: z.string().min(1),
      charter: TestCharterSchema.optional(),
      charterId: z.string().min(1).optional(),
      suiteId: z.string().min(1).optional(),
      coverage: TestCoverageSchema.optional().describe("declared limits acceptance to the saved scenarios; project requires whole-project workflow coverage proof"),
      level: z.enum(["quick", "core", "release"]).optional(),
      surface: z.enum(["web", "electron", "mobile"]).default("web"),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
      autoApprove: z.boolean().default(true),
    },
    async ({ intent, charter, charterId, suiteId, coverage, level, surface, url, expect, oracleNames, mode, sideEffectPolicy, autoApprove }) => {
      const mission = await runner.createMission({ intent, charter, charterId, suiteId, coverage, level, surface, url: surfaceUrl(url, runner), expect, oracleNames, mode, sideEffectPolicy });
      const readiness = missionReadiness(mission);
      const started = autoApprove && readiness.ready
        ? await runner.startMission(mission.missionId, { approve: true })
        : { mission, running: false };
      return result(missionStartResponse(started, readiness));
    },
  );

  server.tool(
    "approve_test_plan",
    "Approve a planned mission after reviewing its task graph and policy.",
    { missionId: z.string().min(1) },
    async ({ missionId }) => result(await runner.approveMission(missionId)),
  );

  server.tool(
    "start_mission",
    "Start a ProofKit mission. The mission executes registered tools and preserves deterministic run evidence.",
    { missionId: z.string().min(1), approve: z.boolean().default(false) },
    async ({ missionId, approve }) => result(missionStartResponse(await runner.startMission(missionId, { approve }))),
  );

  server.tool(
    "get_mission_status",
    "Read saved mission status, task graph and verdict. Call get_mission_evidence before claiming a finding or repair is currently supported by intact files.",
    { missionId: z.string().min(1) },
    READ_ONLY_TOOL,
    async ({ missionId }) => result(await runner.missionStatus(missionId)),
  );

  server.tool(
    "await_test_result",
    "Wait briefly for an existing Mission without starting or replaying it. Return a compact, evidence-checked terminal result, a still-running receipt, or the action needed for a Mission that is not running. Cancelling this wait does not cancel the Mission.",
    { missionId: z.string().min(1), timeoutMs: z.number().int().min(500).max(30_000).default(20_000) },
    async ({ missionId, timeoutMs }, extra) => result(await awaitTestResult(runner, missionId, timeoutMs, extra.signal)),
  );

  server.tool(
    "get_mission_evidence",
    "Read traceable Mission evidence, current presented-evidence integrity, a bounded result summary and its local HTML report path. Report generation does not execute tests or change the saved verdict.",
    { missionId: z.string().min(1) },
    async ({ missionId }) => result(await runner.missionEvidence(missionId)),
  );

  server.tool(
    "cancel_mission",
    "Cancel a running mission while retaining all evidence collected so far.",
    { missionId: z.string().min(1), reason: z.string().min(1).optional() },
    async ({ missionId, reason }) => result(await runner.cancelMission(missionId, reason)),
  );

  server.tool(
    "replay_mission",
    "Create a new mission from a previous mission charter and execute it for regression verification.",
    { missionId: z.string().min(1) },
    async ({ missionId }) => result(await runner.replayMission(missionId)),
  );

  server.tool(
    "compare_missions",
    "Compare an original Mission with its completed direct replay using saved Run evidence. A green comparison means only that the original business defect was not reproduced in the same configured scope.",
    { baselineMissionId: z.string().min(1), candidateMissionId: z.string().min(1) },
    async ({ baselineMissionId, candidateMissionId }) => result(await runner.compareMissions(baselineMissionId, candidateMissionId)),
  );

  server.tool(
    "plan_test",
    "Turn a natural-language intent into a validated, reviewable ProofKit Test Charter. Planning does not execute the project.",
    {
      intent: z.string().min(1),
      coverage: TestCoverageSchema.optional(),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
    },
    async ({ intent, coverage, url, expect, oracleNames, level, mode, sideEffectPolicy }) => result({
      charter: await runner.plan(intent, { coverage, url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy }),
    }),
  );

  server.tool(
    "start_run",
    "Start an evidence-producing Web, Electron or mobile test in the configured local project. Returns immediately with a run ID.",
    {
      intent: z.string().min(1).optional(),
      charter: TestCharterSchema.optional(),
      adapter: z.enum(["web", "electron", "mobile"]).default("web"),
      mobileServer: z.string().url().optional(),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      startProject: z.boolean().default(false),
      oracleUrl: z.string().url().optional(),
      oracleName: z.string().min(1).optional(),
    },
    async ({ intent, charter, adapter, mobileServer, url, expect, oracleNames, level, mode, startProject, oracleUrl, oracleName }) => result(await runner.start({
      intent,
      charter,
      adapter,
      mobileServer,
      url: surfaceUrl(url, runner),
      expect,
      oracleNames,
      level,
      mode,
      start: startProject,
      oracleUrl: localOnlyUrl(oracleUrl),
      oracleName,
    })),
  );

  server.tool(
    "get_run_status",
    "Read the current status, verdict, summary, and report path for a ProofKit run.",
    { runId: z.string().min(1) },
    async ({ runId }) => result(await runner.status(runId)),
  );

  server.tool(
    "inspect_run_resources",
    "Inspect registered connector resources, Run ownership and saved recovery evidence. This does not clean resources or assert a product verdict.",
    { runId: z.string().regex(/^[a-zA-Z0-9_-]+$/) },
    async ({ runId }) => result(await runner.inspectRunResources(runId)),
  );

  server.tool(
    "recover_run_resources",
    "Recover orphaned resources using the exact versioned connector and scoped cleanup readbacks. Requires operator write permission; refuses an active owner and preserves original test evidence and verdict.",
    { runId: z.string().regex(/^[a-zA-Z0-9_-]+$/) },
    async ({ runId }) => result(await runner.recoverRunResources(runId)),
  );

  server.tool(
    "cancel_run",
    "Cancel a running ProofKit test. The run keeps its evidence and finishes with a cancelled verdict.",
    {
      runId: z.string().min(1),
      reason: z.string().min(1).optional(),
    },
    async ({ runId, reason }) => result(await runner.cancel(runId, reason)),
  );

  server.tool(
    "get_evidence",
    "Read bounded evidence from a completed or running ProofKit run. Use events for the timeline and summary for the verdict.",
    {
      runId: z.string().min(1),
      section: z.enum(["summary", "events", "report"]).default("summary"),
      maxChars: z.number().int().positive().max(100_000).default(20_000),
    },
    async ({ runId, section, maxChars }) => result(await runner.evidenceFor(runId, section, maxChars)),
  );

  server.tool(
    "replay_run",
    "Replay a previous validated charter against the configured adapter and create a new evidence run.",
    {
      runId: z.string().min(1),
      adapter: z.enum(["web", "electron", "mobile"]).optional(),
      mobileServer: z.string().url().optional(),
      url: z.string().url().optional(),
      startProject: z.boolean().default(false),
    },
    async ({ runId, adapter, mobileServer, url, startProject }) => result(await runner.replay(runId, { adapter, mobileServer, url: surfaceUrl(url, runner), start: startProject })),
  );
}

async function awaitTestResult(runner: LocalRunnerService, missionId: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const current = await runner.missionStatus(missionId);
    signal?.throwIfAborted();
    let status = current.mission.status;
    let running = current.running;
    const terminal = ["completed", "failed", "blocked", "cancelled"].includes(status);
    if (terminal && !running) {
      const evidence = await runner.missionEvidence(missionId);
      signal?.throwIfAborted();
      if (!evidence.running && ["completed", "failed", "blocked", "cancelled"].includes(evidence.status)) {
        return { state: "terminal" as const, missionId, status: evidence.status, verdict: evidence.verdict,
          level: evidence.level, summary: evidence.summary, evidenceIntegrity: evidence.evidenceIntegrity,
          firstFailure: evidence.firstFailure, report: evidence.report, reportUnavailable: evidence.reportUnavailable,
          next: ["get_mission_evidence"] };
      }
      status = evidence.status;
      running = evidence.running;
    }
    if (!running) {
      return { state: "needs-action" as const, missionId, status, running: false,
        next: status === "awaiting-approval" ? ["approve_test_plan", "start_mission"] : ["get_mission_status", "start_mission"] };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "still-running" as const, missionId, status,
      running: true, next: ["await_test_result"] };
    await delay(Math.min(500, remaining), undefined, signal ? { signal } : undefined);
  }
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function missionReadiness(mission: TestMission): { ready: boolean; missing: string[]; acceptanceGaps: string[] } {
  const missing: string[] = [];
  const acceptanceGaps: string[] = [];
  const charters = mission.suite?.charters.map((item) => item) ?? [{ charterId: "", charter: mission.charter }];
  for (const { charterId, charter } of charters) {
    const prefix = charterId ? `${charterId}: ` : "";
    if (!hasPositiveSurfaceAssertion(charter?.assertions ?? [])) missing.push(`${prefix}至少一个明确的正向表面断言`);
    if (mission.plan.executionProfile.requireBusinessOracle && !charter?.oracles?.length) {
      missing.push(`${prefix}至少一个独立业务 Oracle`);
    }
  }
  for (const gap of mission.plan.planning?.evidenceGaps ?? []) {
    if (mission.suite && mission.plan.planning?.coverage?.requested === "project"
      && (gap === "project-workflow-coverage" || gap === "project-map-truncated")) {
      acceptanceGaps.push(gap);
    } else {
      missing.push(`规划证据缺口：${gap}`);
    }
  }
  return { ready: missing.length === 0, missing, acceptanceGaps };
}

function missionStartResponse(started: { mission: TestMission; running: boolean }, readiness = missionReadiness(started.mission)) {
  const mission = started.mission;
  const profile = mission.plan.executionProfile;
  const terminal = ["completed", "failed", "blocked", "cancelled"];
  // startMission can acquire an owner before its first status write. The owner,
  // not the stale awaiting-approval snapshot, determines the next host action.
  const status = started.running && mission.status === "awaiting-approval" ? "running" : mission.status;
  const projectInventoryGap = mission.status === "awaiting-approval" && !readiness.ready
    && mission.plan.planning?.coverage?.requested === "project"
    && mission.plan.planning.evidenceGaps.includes("project-workflow-coverage");
  let next: string[];
  if (started.running || mission.status === "running") next = ["await_test_result"];
  else if (terminal.includes(mission.status)) next = ["get_mission_evidence"];
  else if (projectInventoryGap) next = ["inspect_test_scope"];
  else if (!readiness.ready && mission.status === "awaiting-approval") next = ["inspect_test_scope", "inspect_surface", "plan_test", "run_test"];
  else if (mission.status === "awaiting-approval") next = ["approve_test_plan"];
  else next = ["start_mission", "get_mission_status"];
  return {
    missionId: mission.missionId,
    ...(mission.replayOfMissionId ? { replayOfMissionId: mission.replayOfMissionId } : {}),
    projectRoot: mission.projectRoot,
    workspaceRoot: mission.workspaceRoot,
    status,
    running: started.running,
    verdict: mission.verdict,
    level: mission.level,
    levelSelection: mission.levelSelection,
    planning: mission.plan.planning,
    executionProfile: profile,
    readiness,
    ...(typeof mission.charter?.metadata.catalogId === "string" ? { catalogId: mission.charter.metadata.catalogId } : {}),
    ...(mission.suite ? { suiteId: mission.suite.suiteId, includedCharterIds: mission.suite.charters.map((item) => item.charterId) } : {}),
    taskSummary: mission.plan.graph.tasks.map((task) => ({
      taskId: task.taskId,
      ...(task.charterId ? { charterId: task.charterId } : {}),
      title: task.title,
      tool: task.tool,
      status: task.status,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      ...(task.error ? { error: task.error } : {}),
    })),
    oracleRequirement: {
      required: profile.requireBusinessOracle,
      declared: mission.suite ? mission.suite.charters.reduce((count, item) => count + (item.charter.oracles?.length ?? 0), 0) : mission.charter?.oracles?.length ?? 0,
      ...(mission.suite ? { byCharter: mission.suite.charters.map((item) => ({ charterId: item.charterId, declared: item.charter.oracles?.length ?? 0 })) } : {}),
      message: profile.requireBusinessOracle
        ? "该测试级别必须有独立业务 Oracle；UI 点击或截图不能单独证明通过。"
        : "该测试级别不强制独立业务 Oracle。",
    },
    polling: {
      waitTool: "await_test_result",
      statusTool: "get_mission_status",
      evidenceTool: "get_mission_evidence",
      intervalMs: 500,
      terminalStatuses: terminal,
    },
    next,
  };
}

function localOnlyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  if (!isLoopback(parsed.hostname)) {
    throw new Error("MCP business oracles are restricted to loopback URLs");
  }
  return url;
}

function surfaceUrl(url: string | undefined, runner: LocalRunnerService): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  const configured = runner.config.surfaces.web?.baseUrl;
  if (isLoopback(parsed.hostname)) return url;
  if (configured && new URL(configured).origin === parsed.origin) return url;
  throw new Error("MCP web runs are restricted to loopback or the configured web origin");
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
