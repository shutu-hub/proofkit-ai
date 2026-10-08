import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TestCharterSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "@proofkit/local-runner";

export function registerTools(server: McpServer, runner: LocalRunnerService): void {
  server.tool(
    "discover_project",
    "Scan the configured local project and report its Web, Electron, backend, scripts, and workspace packages.",
    {},
    async () => result(await runner.discover()),
  );

  server.tool(
    "create_test_mission",
    "Create a reviewable AI test mission from a natural-language intent. The mission plans work without modifying the tested project.",
    {
      intent: z.string().min(1),
      surface: z.enum(["web", "electron"]).default("web"),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
    },
    async ({ intent, surface, url, expect, oracleNames, level, mode, sideEffectPolicy }) => result(await runner.createMission({ intent, surface, url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy })),
  );

  server.tool(
    "run_test",
    "Run a natural-language ProofKit test mission at the requested intensity. Poll get_mission_status and read get_mission_evidence for the final auditable result.",
    {
      intent: z.string().min(1),
      level: z.enum(["quick", "core", "release"]).optional(),
      surface: z.enum(["web", "electron"]).default("web"),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
      autoApprove: z.boolean().default(true),
    },
    async ({ intent, level, surface, url, expect, oracleNames, mode, sideEffectPolicy, autoApprove }) => {
      const mission = await runner.createMission({ intent, level, surface, url: surfaceUrl(url, runner), expect, oracleNames, mode, sideEffectPolicy });
      const started = autoApprove
        ? await runner.startMission(mission.missionId, { approve: true })
        : { mission, running: false };
      return result({ missionId: mission.missionId, level: mission.level, levelSelection: mission.levelSelection, status: started.mission.status, running: started.running, next: ["get_mission_status", "get_mission_evidence"] });
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
    async ({ missionId, approve }) => result(await runner.startMission(missionId, { approve })),
  );

  server.tool(
    "get_mission_status",
    "Read mission status, task graph, verdict, findings, and evidence references.",
    { missionId: z.string().min(1) },
    async ({ missionId }) => result(await runner.missionStatus(missionId)),
  );

  server.tool(
    "get_mission_evidence",
    "Read bounded, traceable evidence references and findings for a mission.",
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
    "plan_test",
    "Turn a natural-language intent into a validated, reviewable ProofKit Test Charter. Planning does not execute the project.",
    {
      intent: z.string().min(1),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
    },
    async ({ intent, url, expect, oracleNames, level, mode, sideEffectPolicy }) => result({
      charter: await runner.plan(intent, { url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy }),
    }),
  );

  server.tool(
    "start_run",
    "Start an evidence-producing Web or Electron test in the configured local project. Returns immediately with a run ID.",
    {
      intent: z.string().min(1).optional(),
      charter: TestCharterSchema.optional(),
      adapter: z.enum(["web", "electron"]).default("web"),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      startProject: z.boolean().default(false),
      oracleUrl: z.string().url().optional(),
      oracleName: z.string().min(1).optional(),
    },
    async ({ intent, charter, adapter, url, expect, oracleNames, level, mode, startProject, oracleUrl, oracleName }) => result(await runner.start({
      intent,
      charter,
      adapter,
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
      adapter: z.enum(["web", "electron"]).optional(),
      url: z.string().url().optional(),
      startProject: z.boolean().default(false),
    },
    async ({ runId, adapter, url, startProject }) => result(await runner.replay(runId, { adapter, url: surfaceUrl(url, runner), start: startProject })),
  );
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
