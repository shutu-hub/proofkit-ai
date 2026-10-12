import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TestCharter, TestMission } from "@proofkit/contracts";
import { EnvironmentInspectionInputSchema, hasPositiveSurfaceAssertion, IntegrationReadinessInputSchema, SurfaceReadinessSchema, TestCharterSchema, TestCoverageSchema, TestScopeInputSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "@proofkit/local-runner";
import { briefMissionEvidence } from "./mission-evidence-brief.js";
import { RepairHypothesisInputSchema } from "@proofkit/contracts";

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
    "Read candidate source entry points, route declarations, required surface connection declarations, registered and unregistered workspace Charter hints, plan gaps, and business capabilities/Oracles. Optional focus is a literal substring. A direct workspace candidate needs declared surfaces matching the requested matrix. candidate-review-needed means inspect the external Charter and source flow, then use its returned path and SHA-256 with run_test. Target configuration is not a runtime check; this does not register or run tests or prove coverage.",
    TestScopeInputSchema.shape,
    READ_ONLY_TOOL,
    async (input) => result(await runner.inspectTestScope(input)),
  );

  server.tool(
    "inspect_integration_readiness",
    "Call only a connector-declared read-only readiness check. Select either charterId or an unregistered workspace charterPath with the exact charterSha256 returned by scope inspection; changed files or endpoint bindings are rejected. This runs no Run, setup, capability, or business Oracle, and does not prove product correctness or plan admission. Resolve prerequisites and preserve the requested level, surface and coverage at Mission creation.",
    IntegrationReadinessInputSchema.innerType().shape,
    READ_ONLY_TOOL,
    async (input, extra) => result(await runner.inspectIntegrationReadiness(IntegrationReadinessInputSchema.parse(input), extra.signal)),
  );

  server.tool(
    "inspect_test_environment",
    "Observe configured Web/Electron endpoints or mobile WebDriver /status, plus applicable source association, with a total deadline. A one-time URL applies only to Web. Saves a workspace artifact; starts no app, device session, browser, test or connector operation. This does not prove login, business readiness or product correctness.",
    EnvironmentInspectionInputSchema.shape,
    async (input, extra) => {
      if (input.url && input.surface !== "web") throw new Error("Only Web environment inspection accepts a URL override");
      const url = surfaceUrl(input.url, runner);
      return result(await runner.inspectEnvironment(url ? { ...input, url } : input, extra.signal));
    },
  );

  server.tool(
    "inspect_surface",
    "Observe the configured Web, Electron or mobile surface after an optional visible-text prerequisite. Web/Electron return bounded controls; mobile returns a bounded driver snapshot. This is reconnaissance, not a product pass verdict.",
    { surface: z.enum(["web", "electron", "mobile"]).default("web"), url: z.string().url().optional(), readyWhen: SurfaceReadinessSchema.optional() },
    async ({ surface, url, readyWhen }, extra) => {
      if (surface !== "web" && url) throw new Error("Only Web inspection accepts a URL override; Electron uses CDP and mobile uses its configured WebDriver server");
      return result(await runner.inspectSurface({ adapter: surface, url: surfaceUrl(url, runner), readyWhen, signal: extra.signal }));
    },
  );

  server.tool(
    "interact_surface",
    "Perform exactly one exploratory Web/Electron action, then observe the resulting page in the same owned browser context. Use this to navigate before authoring a full test. It saves a Run and evidence but always returns testVerdict=not-asserted; a click or form action needs sideEffects=allow in the test workspace. For product acceptance use run_test with a positive assertion and independent business Oracle when required.",
    { surface: z.enum(["web", "electron"]).default("web"), url: z.string().url().optional(),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("goto"), url: z.string().url() }),
        z.object({ kind: z.literal("click"), selector: z.string().min(1).max(512) }),
        z.object({ kind: z.literal("fill"), selector: z.string().min(1).max(512), value: z.string().max(4096) }),
        z.object({ kind: z.literal("press"), selector: z.string().min(1).max(512), key: z.string().min(1).max(64) }),
        z.object({ kind: z.literal("waitForText"), text: z.string().min(1).max(512), timeoutMs: z.number().int().min(100).max(30_000).optional() }),
      ]) },
    async ({ surface, url, action }, extra) => {
      if (surface === "electron" && (url || action.kind === "goto")) throw new Error("Electron interaction uses its configured application UI");
      const mapped = action.kind === "goto" ? { ...action, url: surfaceUrl(action.url, runner)! } : action;
      return result(await runner.interactSurface({ adapter: surface, url: surfaceUrl(url, runner), action: mapped, signal: extra.signal }));
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
    "Create a reviewable AI test mission from natural language, a catalog ID, a structured Charter, or a reviewed external-workspace candidate path and scope SHA-256. Intent is required unless a structured Charter supplies its own intent. Use the candidate's relative path exactly as returned by workspaceCandidates; do not combine it with charter, charterId, suiteId, url, expect, oracleNames, mode or sideEffectPolicy. When surface is omitted, an unambiguous platform in the intent is used. The tested project is not modified.",
    {
      intent: z.string().min(1).optional(),
      charter: TestCharterSchema.optional(),
      charterPath: z.string().min(1).max(512).optional(),
      charterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      charterId: z.string().min(1).optional(),
      suiteId: z.string().min(1).optional(),
      coverage: TestCoverageSchema.optional().describe("declared limits acceptance to the saved scenarios; project requires whole-project workflow coverage proof"),
      surface: z.enum(["web", "electron", "mobile"]).optional(),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
    },
    async ({ intent, charter, charterPath, charterSha256, charterId, suiteId, coverage, surface, url, expect, oracleNames, level, mode, sideEffectPolicy }) => result(await runner.createMission({ intent: missionIntent(intent, charter), charter, charterPath, charterSha256, charterId, suiteId, coverage, surface, url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy })),
  );

  server.tool(
    "run_test",
    "Run a natural-language ProofKit test mission at the requested intensity. Intent is required unless a structured Charter supplies its own intent. When surface is omitted, an unambiguous platform in the intent is used. Supply a structured Charter or a reviewed external-workspace candidate relative path and scope SHA-256 when no catalog entry covers the workflow. A submitted Charter owns mode and sideEffectPolicy; identical top-level repeats are accepted, conflicting values are rejected. Do not combine it with top-level url, expect or oracleNames. A candidate path must not be combined with charter, charterId, suiteId or ad-hoc planning fields. For single exploratory clicks/fills use interact_surface first; its result is not a product verdict. Poll status and evidence for the final result.",
    {
      intent: z.string().min(1).optional(),
      charter: TestCharterSchema.optional(),
      charterPath: z.string().min(1).max(512).optional(),
      charterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      charterId: z.string().min(1).optional(),
      suiteId: z.string().min(1).optional(),
      coverage: TestCoverageSchema.optional().describe("declared limits acceptance to the saved scenarios; project requires whole-project workflow coverage proof"),
      level: z.enum(["quick", "core", "release"]).optional(),
      surface: z.enum(["web", "electron", "mobile"]).optional(),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
      autoApprove: z.boolean().default(true),
    },
    async ({ intent, charter, charterPath, charterSha256, charterId, suiteId, coverage, level, surface, url, expect, oracleNames, mode, sideEffectPolicy, autoApprove }) => {
      const mission = await runner.createMission({ intent: missionIntent(intent, charter), charter, charterPath, charterSha256, charterId, suiteId, coverage, level, surface, url: surfaceUrl(url, runner), expect, oracleNames, mode, sideEffectPolicy });
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
    "Read saved mission status, task graph and historical verdict. testVerdict stays not-asserted here because this receipt does not audit evidence; call get_mission_evidence before claiming a product outcome or repair.",
    { missionId: z.string().min(1) },
    READ_ONLY_TOOL,
    async ({ missionId }) => {
      const current = await runner.missionStatus(missionId);
      return result({ ...current, testVerdict: "not-asserted" });
    },
  );

  server.tool(
    "inspect_mission_recovery",
    "Read-only recovery check for a persisted Mission. Reports whether an active owner is still running, which interrupted tasks are safe to retry under the unchanged recovery contract, and which tasks require review. It never acquires a lease, starts a tool or changes the Mission; use start_mission to perform an approved safe retry.",
    { missionId: z.string().min(1) },
    READ_ONLY_TOOL,
    async ({ missionId }) => result(await runner.inspectMissionRecovery(missionId)),
  );

  server.tool(
    "await_test_result",
    "Wait 500–30000 ms for an existing Mission (omit timeoutMs to use 20000). For longer Missions, call again with the same missionId; never request a larger timeoutMs. This does not start or replay it. A terminal result includes an audited brief verdict and cited evidence, so another evidence read is optional unless more detail is needed. A saved running Mission whose owner is temporarily unseen is rechecked until this wait ends; an unstarted Mission returns not-asserted and readiness gaps. Cancelling this wait does not cancel the Mission.",
    { missionId: z.string().min(1), timeoutMs: z.number().int().min(500).max(30_000).default(20_000) },
    async ({ missionId, timeoutMs }, extra) => result(await awaitTestResult(runner, missionId, timeoutMs, extra.signal)),
  );

  server.tool(
    "get_mission_evidence",
    "Read the current audited verdict, key findings and evidence links, and local HTML report. The default brief view includes omission counts; use detail=full for all saved traces and references. testVerdict can be inconclusive even when the historical verdict passed.",
    { missionId: z.string().min(1), detail: z.enum(["brief", "full"]).default("brief") },
    async ({ missionId, detail }) => {
      const evidence = await runner.missionEvidence(missionId);
      return result(detail === "full"
        ? { ...evidence, testVerdict: evidence.testVerdict ?? "not-asserted" }
        : briefMissionEvidence(evidence));
    },
  );

  server.tool(
    "submit_repair_hypothesis",
    "Save a concrete advisory repair hypothesis for a confirmed failure in a terminal Mission. First read audited evidence and inspect source. Supply summary.revision, Finding evidence IDs, exact SHA-256 of each UTF-8 source file and 1-based line ranges, a causal explanation, proposed changes and a regression check. Evidence and current-checkout references are checked; causality remains a host hypothesis. Writes only Mission metadata, never edits product code, marks a repair verified or executes a test. Refresh get_mission_evidence after submission; replay the same scope after an authorized repair.",
    RepairHypothesisInputSchema.shape,
    async (input) => result(await runner.submitRepairHypothesis(RepairHypothesisInputSchema.parse(input))),
  );

  server.tool(
    "cancel_mission",
    "Cancel a running mission while retaining all evidence collected so far.",
    { missionId: z.string().min(1), reason: z.string().min(1).optional() },
    async ({ missionId, reason }) => result(await runner.cancelMission(missionId, reason)),
  );

  server.tool(
    "replay_mission",
    "Create a new mission from a previous mission charter. When the saved policy requires approval or the scenario has side effects, approve=true explicitly authorizes this new execution; otherwise the replay remains awaiting approval for review.",
    { missionId: z.string().min(1), approve: z.boolean().default(false) },
    async ({ missionId, approve }) => result(await runner.replayMission(missionId, { approve })),
  );

  server.tool(
    "compare_missions",
    "Compare an original Mission with its completed direct replay using saved Run evidence. A green comparison means only that the original business defect was not reproduced in the same configured scope.",
    { baselineMissionId: z.string().min(1), candidateMissionId: z.string().min(1) },
    async ({ baselineMissionId, candidateMissionId }) => result(await runner.compareMissions(baselineMissionId, candidateMissionId)),
  );

  server.tool(
    "analyze_mission_stability",
    "Re-audit three to five ordered Missions from one direct-replay chain. Requires matching source, scope, target, file inputs and business proof. Variable outcomes are an investigation signal, not a flaky-test diagnosis. This tool never starts a Run but may refresh report snapshots in the test workspace.",
    { missionIds: z.array(z.string().min(1)).min(3).max(5) },
    async ({ missionIds }) => result(await runner.analyzeMissionStability(missionIds)),
  );

  server.tool(
    "create_mission_repeat",
    "Save a resumable 3–5 sample series from an evidenced terminal Mission. This does not start a Run. Progress lives in the external ProofKit workspace.",
    { baselineMissionId: z.string().min(1), targetSamples: z.number().int().min(3).max(5) },
    async ({ baselineMissionId, targetSamples }) => result(await runner.createMissionRepeatSeries(baselineMissionId, targetSamples)),
  );

  server.tool(
    "get_mission_repeat_status",
    "Re-audit a persisted repeat series and its completed Missions. May refresh report snapshots; does not start a Run.",
    { seriesId: z.string().min(1) },
    async ({ seriesId }) => result(await runner.missionRepeatSeriesStatus(seriesId)),
  );

  server.tool(
    "advance_mission_repeat",
    "Create or resume exactly one replay slot. approve=true authorizes at most this one interactive execution; another replay needs fresh approval. Poll its Mission and call again to continue.",
    { seriesId: z.string().min(1), approve: z.boolean().default(false) },
    async ({ seriesId, approve }) => result(await runner.advanceMissionRepeatSeries(seriesId, approve)),
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
    "Start an evidence-producing Web, Electron or mobile test in the configured local project. Returns immediately with a run ID. oracleUrl only observes HTTP reachability and cannot establish business success; use a declared business Oracle for that.",
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
        return { state: "terminal" as const, ...briefMissionEvidence(evidence), next: [] };
      }
      status = evidence.status;
      running = evidence.running;
    }
    const remaining = deadline - Date.now();
    if (!running && status === "running" && remaining > 0) {
      // The durable status can lead the execution lease during startup or finalization.
      // Do not tell a host to restart a Mission while that transition can still settle.
      await delay(Math.min(500, remaining), undefined, signal ? { signal } : undefined);
      continue;
    }
    if (!running) {
      const readiness = missionReadiness(current.mission);
      let next: string[];
      if (status === "awaiting-approval" && projectInventoryGap(current.mission, readiness)) {
        next = ["inspect_test_scope"];
      } else if (status === "awaiting-approval" && !readiness.ready) {
        next = ["inspect_test_scope", "inspect_surface", "plan_test", "run_test"];
      } else if (status === "awaiting-approval") {
        next = ["approve_test_plan", "start_mission"];
      } else {
        next = ["get_mission_status", "start_mission"];
      }
      return { state: "needs-action" as const, missionId, status, running: false,
        testVerdict: "not-asserted" as const, progress: missionProgress(current.mission), readiness, next };
    }
    if (remaining <= 0) return { state: "still-running" as const, missionId, status,
      running: true, testVerdict: "not-asserted" as const,
      progress: missionProgress(current.mission), next: ["await_test_result"] };
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

function projectInventoryGap(mission: TestMission, readiness: ReturnType<typeof missionReadiness>): boolean {
  return mission.status === "awaiting-approval" && !readiness.ready
    && mission.plan.planning?.coverage?.requested === "project"
    && mission.plan.planning.evidenceGaps.includes("project-workflow-coverage");
}

function missionProgress(mission: TestMission) {
  const tasks = mission.plan.graph.tasks;
  const deadline = mission.executionDeadlineAt ? Date.parse(mission.executionDeadlineAt) : undefined;
  const now = Date.now();
  return {
    totalTasks: tasks.length,
    passedTasks: tasks.filter((task) => task.status === "passed").length,
    settledTasks: tasks.filter((task) => ["passed", "failed", "blocked", "skipped"].includes(task.status)).length,
    ...(mission.currentTaskId ? { currentTaskId: mission.currentTaskId } : {}),
    ...(mission.executionStartedAt ? { executionStartedAt: mission.executionStartedAt } : {}),
    ...(deadline !== undefined && Number.isFinite(deadline) ? {
      executionDeadlineAt: mission.executionDeadlineAt,
      remainingExecutionMs: Math.max(0, deadline - now),
      deadlineReached: deadline <= now,
    } : {}),
  };
}

function missionStartResponse(started: { mission: TestMission; running: boolean }, readiness = missionReadiness(started.mission)) {
  const mission = started.mission;
  const profile = mission.plan.executionProfile;
  const terminal = ["completed", "failed", "blocked", "cancelled"];
  // startMission can acquire an owner before its first status write. The owner,
  // not the stale awaiting-approval snapshot, determines the next host action.
  const status = started.running && mission.status === "awaiting-approval" ? "running" : mission.status;
  let next: string[];
  if (started.running || mission.status === "running") next = ["await_test_result"];
  else if (terminal.includes(mission.status)) next = ["get_mission_evidence"];
  else if (projectInventoryGap(mission, readiness)) next = ["inspect_test_scope"];
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
    testVerdict: "not-asserted",
    level: mission.level,
    surface: mission.surface,
    levelSelection: mission.levelSelection,
    progress: missionProgress(mission),
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

function missionIntent(intent: string | undefined, charter: TestCharter | undefined): string {
  const selected = intent ?? charter?.intent;
  if (!selected) throw new Error("intent is required unless a structured Charter supplies its own intent");
  return selected;
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
