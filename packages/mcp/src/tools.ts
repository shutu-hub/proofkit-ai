import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TestCharter, TestMission } from "@proofkit/contracts";
import { EnvironmentInspectionInputSchema, hasPositiveSurfaceAssertion, IntegrationReadinessInputSchema, SelectOptionActionSchema, SelectOptionsActionSchema, SetCheckedActionSchema, SurfaceReadinessSchema, SurfaceSnapshotSchema, SurfaceTableReadRequestSchema, SurfaceTextReadRequestSchema, TestCharterSchema, TestCoverageSchema, TestScopeInputSchema } from "@proofkit/contracts";
import { LocalRunnerService, PlannerConfigurationError, PlanningObservationError, summarizePlanReview } from "@proofkit/local-runner";
import { briefMissionEvidence } from "./mission-evidence-brief.js";
import { RepairHypothesisInputSchema } from "@proofkit/contracts";
import { PlanningInspectionPinSchema, PlanningContinuationPinSchema } from "@proofkit/contracts";
import { SwitchPageActionSchema, WaitForValueActionSchema } from "@proofkit/contracts";

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
    "Call only a connector-declared read-only readiness check before product writes. Select exactly one charterId, an unregistered workspace charterPath plus exact charterSha256, or a submitted charter draft declaring its surfaces. Draft output identifies the normalized checked content by draftSha256; changes require a new check. Saved candidates reject changed bytes or endpoint bindings. This starts no Run, setup, capability or business Oracle and proves neither product correctness nor plan admission. Preserve required business fields, level, surface and coverage; unavailable observations must not be silently removed to obtain a ready result.",
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
    "Observe a Web, Electron or mobile surface without asserting product success. Overview text is capped at 2000 chars. Web/Electron controls include a nearest fieldset groupName when available; use it with a unique selector to distinguish repeated field labels. On dense pages use controlOffset=60 then snapshot.controlWindow.nextOffset to inspect later windows of at most 60 visible main-frame controls. Each window is separately pinned, not proof of whole-page coverage; actions still recheck unique targets. Web/Electron readText returns a hash-bound text window; readTable={selector,offset,limit,columns} returns rows from one visible HTML table page. Continue with snapshot.tableRead.nextOffset and expectedSourceSha256. The table's allPagesVerified=false remains false even at the last rendered row: inspect pagination, filters, virtualized rows and independent business facts separately. Both reads are sanitized and reject changed sources; choose only one read. Mobile supports neither scoped read.",
    { surface: z.enum(["web", "electron", "mobile"]).default("web"), url: z.string().url().optional(), sessionId: z.string().uuid().optional(),
      keepSession: z.boolean().optional().describe("Web only: create an owned retained context using read-only observation; returns sessionId for subsequent inspection, planning and reviewed actions. Does not require an exploratory click."),
      controlOffset: z.number().int().min(0).max(500).optional().describe("Web/Electron only: later window of visible main-frame controls; follow controlWindow.nextOffset"),
      sessionLabel: z.string().trim().min(1).max(80).regex(/^[^\r\n]+$/).optional(),
      headful: z.boolean().optional().describe("Web only: open a visible browser; Electron visibility is controlled by the attached app process"), readyWhen: SurfaceReadinessSchema.optional(), readText: SurfaceTextReadRequestSchema.optional(), readTable: SurfaceTableReadRequestSchema.optional() },
    async ({ surface, url, sessionId, keepSession, sessionLabel, controlOffset, headful, readyWhen, readText, readTable }, extra) => {
      if (surface !== "web" && (url || sessionId || keepSession || sessionLabel)) throw new Error("Only Web inspection accepts a URL override or retained session; Electron uses CDP and mobile uses its configured WebDriver server");
      if (readText && readTable) throw new Error("Choose one scoped read per inspection");
      if (controlOffset !== undefined && (readText || readTable || surface === "mobile")) throw new Error("Targeted controls require Web/Electron and no other scoped read");
      if (surface === "mobile" && (readText || readTable)) throw new Error("Targeted rendered inspection currently supports Web and Electron only");
      return result(await runner.inspectSurface({ adapter: surface, url: surfaceUrl(url, runner), sessionId, keepSession, sessionLabel, controlOffset, headful, readyWhen, readText, readTable, signal: extra.signal }));
    },
  );

  server.tool(
    "interact_surface",
    'Perform exactly one exploratory Web/Electron action, then observe the resulting page in the same owned browser context. Prefer a unique control.selector returned by inspect_surface; after a click that reveals controls, follow next=inspect_surface when the compact observation is truncated. For repeated from/to or similar labels, use the full observation groupName and unique selector instead of guessing an nth position. If action.failureCode is surface-target-ambiguous or runner-action-timeout, inspect again and choose a new unique target instead of repeating the failed selector. selectOption targets a native single-select: action={"kind":"selectOption","selector":"#status","option":{"label":"Ready"}}. selectOptions replaces the entire native multiple-select set: action={"kind":"selectOptions","selector":"#statuses","options":[{"label":"Ready"},{"value":"pending"}]}; options=[] clears it. Read actual labels/values from the inspected page. Each option is an object with either label or value; string arrays and numeric indices are invalid. Use selectOptions when the inspected control has multiple=true; selectOption cannot operate that control. It saves a Run and evidence but always returns testVerdict=not-asserted; a click or form action needs sideEffects=allow in the test workspace. For product acceptance use run_test with a positive assertion and independent business Oracle when required.',
    { surface: z.enum(["web", "electron"]).default("web"), url: z.string().url().optional(), headful: z.boolean().optional().describe("Web only: keep the exploratory browser visible"),
      keepSession: z.boolean().optional().describe("Web only: keep this owned browser context for another action; returns sessionId"),
      sessionId: z.string().uuid().optional().describe("Web only: reuse the sessionId returned by a previous interact_surface call"),
      inspection: PlanningInspectionPinSchema.optional().describe("Guard this exploratory action with an original inspect_surface manifest pin from the same retained Web session"),
      sessionLabel: z.string().trim().min(1).max(80).regex(/^[^\n]+$/).optional().describe("Human-readable session label only; not an account or credential assertion"),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("goto"), url: z.string().url() }),
        SwitchPageActionSchema,
        z.object({ kind: z.literal("click"), selector: z.string().min(1).max(512), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }),
        z.object({ kind: z.literal("fill"), selector: z.string().min(1).max(512), value: z.string().max(4096), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }),
        z.object({ kind: z.literal("press"), selector: z.string().min(1).max(512), key: z.string().min(1).max(64), observationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }),
        SelectOptionActionSchema,
        SelectOptionsActionSchema,
        SetCheckedActionSchema,
        WaitForValueActionSchema.extend({ value: z.string().max(4096) }),
        z.object({ kind: z.literal("waitForText"), text: z.string().min(1).max(512), timeoutMs: z.number().int().min(100).max(30_000).optional() }),
      ]) },
    async ({ surface, url, headful, action, keepSession, sessionId, sessionLabel, inspection }, extra) => {
      if (surface === "electron" && (url || action.kind === "goto")) throw new Error("Electron interaction uses its configured application UI");
      const mapped = action.kind === "goto" ? { ...action, url: surfaceUrl(action.url, runner)! } : action;
      return result(await runner.interactSurface({ adapter: surface, url: surfaceUrl(url, runner), headful, action: mapped, signal: extra.signal, inspection,
        ...(keepSession !== undefined ? { keepSession } : {}), ...(sessionId ? { sessionId } : {}), ...(sessionLabel ? { sessionLabel } : {}) }));
    },
  );

  server.tool(
    "close_surface_session",
    "Close an explicitly retained Web exploratory session and its browser context. Returns networkCapture with its metadata report, initial primary-page recording, optional first explicitly selected popup clip, bounded omission counts and pinned manifest. Session recording is enabled through sessions.recordVideo and finalized only on close. partial/unavailable means the capture cannot establish completeness. An idle session also expires automatically. If prepare_surface_session owns resources, close verifies their cleanup and returns the preparation Run ID and cleanup receipt; a failed close requires inspect_run_resources/recover_run_resources. Closing does not assert product correctness.",
    { sessionId: z.string().uuid() },
    async ({ sessionId }) => result(await runner.closeSurfaceSession(sessionId)),
  );

  server.tool(
    "prepare_surface_session",
    "Explicitly prepare connector-owned resources for an existing idle retained Web session. This is a write operation requiring operator opt-in, policies.sideEffects=allow, a versioned integration with a recovery hook, and a reviewed Web Charter permitting writes. The connector must register exact resource ownership before its first external write. Returns a preparation Run ID and not-asserted; it never proves a business outcome. Keep the session open while exploring; close_surface_session verifies cleanup. After interruption use inspect_run_resources and recover_run_resources on the preparation Run ID, never replay the write to guess whether it succeeded.",
    { sessionId: z.string().uuid(), charter: TestCharterSchema },
    async ({ sessionId, charter }, extra) => result(await runner.prepareSurfaceSession({ sessionId, charter, signal: extra.signal })),
  );

  server.tool(
    "list_surface_sessions",
    "List retained owned Web sessions and their live networkCapture segment IDs/status, including requested recording state, without exposing cookies, storage state or credentials. Labels are operator metadata only; reusable=false means the context is no longer safe to adopt. Network and optional primary/selected-page clips span calls but do not cover process downtime or establish action causality.",
    {},
    READ_ONLY_TOOL,
    async () => result(await runner.listSurfaceSessions()),
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
      headful: z.boolean().optional().describe("Freeze visible Web execution into the Mission plan"),
      sessionId: z.string().uuid().optional().describe("Web only: adopt a retained exploratory session for this Mission"),
    },
    async ({ intent, charter, charterPath, charterSha256, charterId, suiteId, coverage, surface, url, expect, oracleNames, level, mode, sideEffectPolicy, headful, sessionId }, extra) => planningResult(() => runner.createMission({ intent: missionIntent(intent, charter), charter, charterPath, charterSha256, charterId, suiteId, coverage, surface, url: surfaceUrl(url, runner), expect, oracleNames, level, mode, sideEffectPolicy, headful, sessionId, signal: extra.signal })),
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
      headful: z.boolean().optional().describe("Freeze visible Web execution into the Mission plan"),
      sessionId: z.string().uuid().optional().describe("Web only: adopt a retained exploratory session for this Mission"),
      autoApprove: z.boolean().default(true),
    },
    async ({ intent, charter, charterPath, charterSha256, charterId, suiteId, coverage, level, surface, url, expect, oracleNames, mode, sideEffectPolicy, headful, sessionId, autoApprove }, extra) => planningResult(async () => {
      const mission = await runner.createMission({ intent: missionIntent(intent, charter), charter, charterPath, charterSha256, charterId, suiteId, coverage, level, surface, url: surfaceUrl(url, runner), expect, oracleNames, mode, sideEffectPolicy, headful, sessionId, signal: extra.signal });
      extra.signal.throwIfAborted();
      const readiness = missionReadiness(mission);
      const started = autoApprove && readiness.ready
        ? await runner.startMission(mission.missionId, { approve: true })
        : { mission, running: false };
      return missionStartResponse(started, readiness);
    }),
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
    "Read the current audited verdict, key findings and evidence links, and local HTML report. The default brief view includes omission counts and a bounded retained-session capture status. A Mission can finish before its retained session recording is sealed: if capture integrity is not-sealed, explicitly close_surface_session with the returned sessionId when no further interaction is needed, then call get_mission_evidence again and deliver the refreshed report. Do not claim the provisional report includes playable footage. use detail=full for all saved traces and references. testVerdict can be inconclusive even when the historical verdict passed.",
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
    "Return a Charter plus needs-input or ready-for-review status, structural gaps and action/reason next steps. Both statuses are not-asserted with executionStarted=false; ready-for-review does not establish environment, authentication, data readiness, evidence availability or business correctness. Planning observes the configured surface read-only when no snapshot or pinned inspections are supplied and never executes proposed interactions. A model may return needs-observation with an observationRequest instead of a Charter. Review its single-step proposal under the workspace action policy; with a retained Web session, pass its original source pin as interact_surface.inspection, inspect the resulting state, and retry plan_test with the returned observationRequest.continuation and only the additional inspection pins. The saved reference restores the original requirements and earlier pins; conflicting requirements, changed bytes and foreign workspaces are refused. Continuations are bounded to ten saved observation requests and ten states. Reused selectors require the correct observationId. Inspection pins use inspect_surface inspectionId and original manifest.sha256. The formal Charter must replay the whole workflow and independently verify its outcome.",
    {
      intent: z.string().min(1).optional().describe("Required for a new plan; omit when resuming a saved continuation"),
      charter: TestCharterSchema.optional().describe("Host-authored draft: validate and bind it to observed sources without invoking a second model provider"),
      coverage: TestCoverageSchema.optional(),
      url: z.string().url().optional(),
      expect: z.array(z.string().min(1)).optional(),
      oracleNames: z.array(z.string().min(1)).optional(),
      level: z.enum(["quick", "core", "release"]).optional(),
      mode: z.enum(["deterministic", "guided", "explore"]).optional(),
      sideEffectPolicy: z.enum(["deny", "confirm", "allow"]).optional(),
      surfaceSnapshot: SurfaceSnapshotSchema.optional().describe("Optional exact inspect_surface result; planned selectors are checked against it"),
      inspections: PlanningInspectionPinSchema.array().min(1).max(10).optional().describe("Previously observed states: use each inspect_surface inspectionId as runId and its original manifest.sha256 as manifestSha256"),
      continuation: PlanningContinuationPinSchema.optional().describe("Saved needs-observation continuation: restore original requirements and earlier inspection pins; supply only additional observations. Conflicting requirements are rejected."),
      surface: z.enum(["web", "electron", "mobile"]).optional(),
      sessionId: z.string().uuid().optional(),
      keepSession: z.boolean().optional().describe("Web only: start a new retained read-only planning observation. Do not combine with sessionId, continuation, inspections or caller snapshot. Successful drafts and observation continuations return the sessionId; unexpected planning failure closes the newly owned context."),
      sessionLabel: z.string().trim().min(1).max(80).regex(/^[^\r\n]+$/).optional().describe("Label for a newly retained planning context; requires keepSession=true"),
      headful: z.boolean().optional(),
    },
    async ({ intent, charter, coverage, url, expect, oracleNames, level, mode, sideEffectPolicy, surfaceSnapshot, inspections, continuation, surface, sessionId, keepSession, sessionLabel, headful }, extra) => {
      if (surface && surface !== "web" && (url || sessionId || keepSession || sessionLabel)) throw new Error("Only Web planning accepts an entry URL or retained session");
      return planningResult(async () => {
        const planned = await runner.plan(intent, { charter, coverage, url: url ? surfaceUrl(url, runner) : undefined, expect, oracleNames, level, mode,
          sideEffectPolicy, surfaceSnapshot, inspections, continuation, adapter: surface ?? (continuation ? undefined : "web"), sessionId, keepSession, sessionLabel, headful, signal: extra.signal });
        return { ...summarizePlanReview(planned), charter: planned };
      });
    },
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
      headful: z.boolean().optional().describe("Web only: launch the browser visibly for this Run"),
      sessionId: z.string().uuid().optional().describe("Web only: reuse a retained exploratory session for this formal Run"),
      startProject: z.boolean().default(false),
      oracleUrl: z.string().url().optional(),
      oracleName: z.string().min(1).optional(),
    },
    async ({ intent, charter, adapter, mobileServer, url, expect, oracleNames, level, mode, headful, sessionId, startProject, oracleUrl, oracleName }) => result(await runner.start({
      intent,
      charter,
      adapter,
      mobileServer,
      url: surfaceUrl(url, runner),
      expect,
      oracleNames,
      level,
      mode,
      headful,
      sessionId,
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
    "recover_session_capture",
    "Finalize an orphaned retained-Web session evidence segment after its process owner disappeared. Requires the exact session ID and only closes a non-active capture owner. Network/event evidence may be sealed as partial; an interrupted recording is explicitly unavailable and is never promoted to playable complete footage. This returns context evidence with no product verdict and does not clean connector resources.",
    { runId: z.string().regex(/^session-network-[a-f0-9-]{36}$/), sessionId: z.string().uuid() },
    async ({ runId, sessionId }) => result(await runner.recoverSessionCapture(runId, sessionId)),
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
      section: z.enum(["summary", "events", "report", "manifest"]).default("summary"),
      maxChars: z.number().int().positive().max(100_000).default(20_000),
    },
    async ({ runId, section, maxChars }) => {
      if (section === "manifest") await runner.evidenceManifest(runId);
      return result(await runner.evidenceFor(runId, section, maxChars));
    },
  );

  server.tool(
    "verify_evidence_manifest",
    "Verify a previously generated Run manifest, every listed evidence file and the current file inventory. Empty, malformed or oversized manifests remain unverified; unexpected files are reported separately. Without an expected manifest digest this checks local file consistency; provide the digest from the original handoff for stronger bundle verification.",
    { runId: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() },
    READ_ONLY_TOOL,
    async ({ runId, manifestSha256 }) => result(await runner.verifyEvidenceManifest(runId, manifestSha256)),
  );

  server.tool(
    "approve_surface_replan",
    "Review and optionally approve a selector-drift proposal. Without approve=true this only returns the verified proposal. With approve=true, selector must exactly match an observed candidate; ProofKit creates a replacement Charter linked to the source Run and starts a new replay Run.",
    { runId: z.string().min(1), stepId: z.string().regex(/^step-\d{3}$/), selector: z.string().min(1).max(512), approve: z.boolean().default(false) },
    async ({ runId, stepId, selector, approve }) => result(await runner.approveSurfaceReplan({ runId, stepId, selector, approve })),
  );

  server.tool(
    "analyze_surface_replan_stability",
    "Analyze approved selector replacements for one source Run. Requires replacement Run IDs that were explicitly replay-linked to that source; reports outcome distribution, selector repetition, approval latency and integrity gaps without inferring causality.",
    { sourceRunId: z.string().min(1), replacementRunIds: z.array(z.string().min(1)).min(1).max(20) },
    async ({ sourceRunId, replacementRunIds }) => result(await runner.analyzeSurfaceReplanStability(sourceRunId, replacementRunIds)),
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

async function planningResult(operation: () => Promise<unknown>) {
  try { return result(await operation()); }
  catch (error) {
    if (error instanceof PlannerConfigurationError) return result(error.receipt());
    if (!(error instanceof PlanningObservationError)) throw error;
    return result(error.receipt());
  }
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
