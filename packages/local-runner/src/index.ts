import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { analyzeRun, InMemoryMissionToolRegistry, JsonMissionStore, MissionAgent, type MissionTool, type MissionToolResult } from "@proofkit/agent";
import { ElectronAdapter, WebAdapter } from "@proofkit/adapters";
import { createRunId, EvidenceStore } from "@proofkit/evidence";
import { EvidenceRefSchema, FailureBoundarySchema, FindingSchema, ObservationSchema, ProofkitConfigSchema, TestCharterSchema, type EvidenceRef, type ProofkitConfig, type ProjectMap, type RunMode, type RunSummary, type SideEffectPolicy, type TestCharter, type TestLevel, type TestMission } from "@proofkit/contracts";
import { configuredHttpOracle, httpOracle } from "@proofkit/oracles";
import { getTestLevelProfile, IntentPlanner, OpenAICompatiblePlannerProvider, resolveTestLevel, StructuredPlanner, loadCharter, type PlanOptions, type PlannerProvider } from "@proofkit/planner";
import { loadConfig, scanProject } from "@proofkit/project";
import { CancelledError, ExecutionRunner, z, type BusinessOracle, type CapabilityDefinition, type IntegrationSetup, type ProjectIntegration, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";
import { loadProjectIntegration } from "./integration.js";

export { loadProjectIntegration } from "./integration.js";

export type LocalAdapterName = "web" | "electron";

export type LocalRunInput = {
  intent?: string;
  charter?: TestCharter;
  charterPath?: string;
  adapter?: LocalAdapterName;
  url?: string;
  cdp?: string;
  devtoolsPortFile?: string;
  headful?: boolean;
  start?: boolean;
  expect?: string[];
  oracleNames?: string[];
  mode?: RunMode;
  sideEffectPolicy?: SideEffectPolicy;
  oracleUrl?: string;
  oracleName?: string;
  level?: TestLevel;
};

export type LocalRunStatus = {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  verdict?: RunSummary["verdict"];
  summary?: RunSummary;
  error?: string;
  report?: string;
};

export type MissionCreateOptions = {
  intent: string;
  surface?: "web" | "electron" | "mobile" | "api";
  adapter?: LocalAdapterName;
  charter?: TestCharter;
  url?: string;
  cdp?: string;
  devtoolsPortFile?: string;
  expect?: string[];
  oracleNames?: string[];
  mode?: RunMode;
  sideEffectPolicy?: SideEffectPolicy;
  policy?: Partial<TestMission["policy"]>;
  level?: TestLevel;
};

export type MissionStatus = {
  mission: TestMission;
  running: boolean;
};

type LocalRunRecord = {
  runId: string;
  status: LocalRunStatus["status"];
  promise: Promise<RunSummary>;
  controller: AbortController;
  summary?: RunSummary;
  error?: string;
};

type MissionRecord = {
  controller: AbortController;
  promise: Promise<TestMission>;
};

export type LocalRunnerOptions = {
  root: string;
  config?: ProofkitConfig;
  evidenceDir?: string;
  restrictWebOrigins?: boolean;
  oracles?: BusinessOracle[];
  capabilities?: CapabilityDefinition<any, any>[];
  allowCapabilityWrites?: boolean;
  plannerProvider?: PlannerProvider;
  integration?: ProjectIntegration;
};

export class LocalRunnerService {
  readonly root: string;
  readonly config: ProofkitConfig;
  readonly evidenceDir: string;
  readonly integration?: ProjectIntegration;
  private readonly records = new Map<string, LocalRunRecord>();
  private readonly evidence: EvidenceStore;
  private readonly restrictWebOrigins: boolean;
  private readonly oracles: BusinessOracle[];
  private readonly capabilities: CapabilityDefinition<any, any>[];
  private readonly allowCapabilityWrites: boolean;
  private readonly plannerProvider?: PlannerProvider;
  private readonly missionAgent: MissionAgent;
  private readonly missionRecords = new Map<string, MissionRecord>();
  private readonly missionStarts = new Map<string, Promise<MissionStatus>>();

  constructor(options: LocalRunnerOptions) {
    this.root = resolve(options.root);
    this.config = ProofkitConfigSchema.parse(options.config ?? loadConfigDefaults());
    this.evidenceDir = resolve(this.root, options.evidenceDir ?? ".proofkit/runs");
    this.evidence = new EvidenceStore(this.evidenceDir);
    this.restrictWebOrigins = options.restrictWebOrigins ?? false;
    this.integration = options.integration;
    this.oracles = [...(this.integration?.oracles ?? []), ...(options.oracles ?? [])];
    this.capabilities = [...(this.integration?.capabilities ?? []), ...(options.capabilities ?? [])];
    this.allowCapabilityWrites = options.allowCapabilityWrites ?? false;
    this.plannerProvider = options.plannerProvider;
    this.missionAgent = new MissionAgent({
      store: new JsonMissionStore(resolve(this.root, ".proofkit/missions")),
      tools: new InMemoryMissionToolRegistry(this.createMissionTools()),
    });
  }

  static async create(options: Omit<LocalRunnerOptions, "config"> & { config?: ProofkitConfig }): Promise<LocalRunnerService> {
    const config = options.config ?? await loadConfig(options.root);
    const integration = options.integration ?? await loadProjectIntegration(options.root, config);
    return new LocalRunnerService({ ...options, config, integration });
  }

  async discover(): Promise<ProjectMap> {
    return scanProject(this.root);
  }

  async createMission(input: MissionCreateOptions): Promise<TestMission> {
    const surface = input.surface ?? input.adapter ?? "web";
    if (surface === "mobile" || surface === "api") throw new Error(`Mission surface is not enabled by the local runner: ${surface}`);
    const levelSelection = resolveTestLevel(input.intent, input.level ?? input.charter?.level);
    const charter = input.charter ?? await this.plan(input.intent, {
      url: input.url,
      expect: input.expect,
      oracleNames: input.oracleNames,
      mode: input.mode,
      sideEffectPolicy: input.sideEffectPolicy,
      level: input.level,
    });
    if (charter.level !== levelSelection.resolved) {
      throw new Error(`Charter level ${charter.level} does not match requested level ${levelSelection.resolved}`);
    }
    const normalizedCharter = TestCharterSchema.parse({ ...charter, levelSelection: charter.levelSelection ?? levelSelection });
    return this.missionAgent.create({
      intent: input.intent,
      projectRoot: this.root,
      surface,
      charter: normalizedCharter,
      policy: { ...input.policy, level: levelSelection.resolved },
    });
  }

  async approveMission(missionId: string): Promise<TestMission> {
    return this.missionAgent.approve(missionId);
  }

  async startMission(missionId: string, options: { approve?: boolean } = {}): Promise<MissionStatus> {
    const safeMissionId = validateMissionId(missionId);
    const start = this.missionStarts.get(safeMissionId) ?? this.startMissionOnce(safeMissionId, options);
    this.missionStarts.set(safeMissionId, start);
    try {
      return await start;
    } finally {
      if (this.missionStarts.get(safeMissionId) === start) this.missionStarts.delete(safeMissionId);
    }
  }

  private async startMissionOnce(missionId: string, options: { approve?: boolean }): Promise<MissionStatus> {
    const current = await this.missionAgent.load(missionId);
    const existing = this.missionRecords.get(current.missionId);
    if (existing) {
      const mission = await this.missionAgent.load(current.missionId);
      return { mission, running: mission.status === "running" };
    }
    const controller = new AbortController();
    const promise = this.missionAgent.run(current.missionId, { approve: options.approve, signal: controller.signal });
    this.missionRecords.set(current.missionId, { controller, promise });
    // Attach both fulfillment and rejection handlers so a rejected mission does
    // not create an unhandled Promise rejection while the record is cleaned up.
    void promise.then(
      () => this.missionRecords.delete(current.missionId),
      () => this.missionRecords.delete(current.missionId),
    );
    const mission = await this.missionAgent.load(current.missionId);
    return { mission, running: mission.status === "running" && this.missionRecords.has(current.missionId) };
  }

  async waitMission(missionId: string): Promise<TestMission> {
    const safeMissionId = validateMissionId(missionId);
    const record = this.missionRecords.get(safeMissionId);
    if (record) return record.promise;
    return this.missionAgent.load(safeMissionId);
  }

  async missionStatus(missionId: string): Promise<MissionStatus> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    return { mission, running: this.missionRecords.has(mission.missionId) || mission.status === "running" };
  }

  async cancelMission(missionId: string, reason = "Mission cancelled by user"): Promise<MissionStatus> {
    const safeMissionId = validateMissionId(missionId);
    const record = this.missionRecords.get(safeMissionId);
    if (!record) return this.missionStatus(safeMissionId);
    record.controller.abort(new CancelledError(reason));
    return { mission: await record.promise, running: false };
  }

  async missionEvidence(missionId: string): Promise<{
    missionId: string;
    status: TestMission["status"];
    running: boolean;
    verdict?: TestMission["verdict"];
    level: TestMission["level"];
    levelSelection?: TestMission["levelSelection"];
    executionProfile: TestMission["plan"]["executionProfile"];
    taskSummary: Array<{
      taskId: string;
      title: string;
      tool: string;
      status: TestMission["plan"]["graph"]["tasks"][number]["status"];
      attempts: number;
      maxAttempts: number;
      error?: string;
    }>;
    evidence: EvidenceRef[];
    findings: TestMission["findings"];
    firstFailure?: TestMission["firstFailure"];
    diagnosis?: TestMission["diagnosis"];
    repairSuggestions: TestMission["repairSuggestions"];
  }> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    return {
      missionId: mission.missionId,
      status: mission.status,
      running: this.missionRecords.has(mission.missionId) || mission.status === "running",
      verdict: mission.verdict,
      level: mission.level,
      levelSelection: mission.levelSelection,
      executionProfile: mission.plan.executionProfile,
      taskSummary: mission.plan.graph.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        tool: task.tool,
        status: task.status,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        ...(task.error ? { error: task.error } : {}),
      })),
      evidence: mission.evidence,
      findings: mission.findings,
      firstFailure: mission.firstFailure,
      diagnosis: mission.diagnosis,
      repairSuggestions: mission.repairSuggestions,
    };
  }

  async replayMission(missionId: string): Promise<MissionStatus> {
    const previous = await this.missionAgent.load(validateMissionId(missionId));
    const replay = await this.missionAgent.create({
      intent: previous.intent,
      projectRoot: this.root,
      surface: previous.surface,
      charter: previous.charter,
      policy: { ...previous.policy, requireApproval: false },
    });
    return this.startMission(replay.missionId, { approve: true });
  }

  private createMissionTools(): MissionTool[] {
    type MissionToolContext = Parameters<NonNullable<MissionTool["execute"]>>[1];
    type SurfaceRunKind = "primary" | "replay";

    const discover = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      const project = await this.discover();
      const observation = ObservationSchema.parse({
        observationId: `${context.task.taskId}-${Date.now()}`,
        source: "planner",
        kind: "project.discovered",
        data: project,
        observedAt: new Date().toISOString(),
      });
      return { output: project, observations: [observation] };
    };

    const collectSurfaceRun = async (summary: RunSummary, context: MissionToolContext, adapter: LocalAdapterName, runKind: SurfaceRunKind, sourceRunId?: string): Promise<MissionToolResult> => {
      const evidence = this.runEvidence(summary);
      const observation = ObservationSchema.parse({
        observationId: `${context.task.taskId}-${summary.runId}`,
        source: "surface",
        kind: "surface.run",
        data: {
          runId: summary.runId,
          sourceRunId,
          surface: adapter,
          runKind,
          verdict: summary.verdict,
          steps: summary.steps.length,
          assertions: summary.assertions.length,
          passedAssertions: summary.assertions.filter((item) => item.passed).length,
          oracles: summary.oracles.length,
          passedOracles: summary.oracles.filter((item) => item.passed === true).length,
          businessEvidence: summary.oracles.reduce((count, oracle) => count + oracle.evidence.length, 0),
        },
        evidence,
        observedAt: new Date().toISOString(),
      });
      const analysis = analyzeRun({ summary, evidence });
      const findings = analysis.finding
        ? [FindingSchema.parse(analysis.finding)]
        : summary.verdict === "failed" || summary.verdict === "blocked"
          ? [FindingSchema.parse({
              findingId: `run-${summary.runId}`,
              severity: "medium",
              category: summary.verdict === "blocked" ? "environment" : "unknown",
              status: "suspected",
              title: "Surface run did not pass",
              message: summary.findings.join("; ") || `Surface run ended with verdict ${summary.verdict}`,
              evidence,
              createdAt: new Date().toISOString(),
            })]
          : [];
      return {
        output: { runId: summary.runId, verdict: summary.verdict, report: this.reportPath(summary.runId) },
        verdict: summary.verdict,
        observations: [observation],
        evidence,
        findings,
        firstFailure: analysis.boundary,
        diagnosis: analysis.diagnosis,
        repairSuggestions: analysis.repairSuggestion ? [analysis.repairSuggestion] : [],
      };
    };

    const runCharter = async (input: { charter?: TestCharter; adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      const charter = input.charter ?? context.mission.charter;
      if (!charter) throw new Error("Mission has no Test Charter to execute");
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const started = await this.start({ charter, adapter });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "primary");
    };

    const replayCharter = async (input: { adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const source = [...context.mission.observations].reverse().find((item) => item.kind === "surface.run"
        && item.data.surface === adapter
        && (item.data.runKind === "primary" || item.data.runKind === undefined));
      const sourceRunId = typeof source?.data.runId === "string" ? source.data.runId : undefined;
      if (!sourceRunId) {
        const observedAt = new Date().toISOString();
        const message = `没有找到 ${adapter} 的主运行证据，无法执行回放`;
        return {
          output: { adapter, verified: false, reason: message },
          verdict: "blocked",
          firstFailure: FailureBoundarySchema.parse({ kind: "evidence", message, evidence: [], observedAt }),
          findings: [FindingSchema.parse({ findingId: `replay-source-${adapter}`, severity: "high", category: "test", status: "confirmed", title: "回放缺少主运行证据", message, createdAt: observedAt })],
        };
      }
      const started = await this.replay(sourceRunId, { adapter });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "replay", sourceRunId);
    };

    const verify = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      const runs = context.mission.observations.filter((item) => item.kind === "surface.run");
      if (runs.length === 0) throw new Error("No surface run observation is available for verification");
      const executionProfile = context.mission.plan.executionProfile;
      const expectedSurfaces = executionProfile.surfaceMatrix;
      const missing: string[] = [];
      for (const surface of expectedSurfaces) {
        const primary = runs.some((item) => item.data.surface === surface && (item.data.runKind === "primary" || item.data.runKind === undefined));
        if (!primary) missing.push(`${surface} 主运行`);
        if (executionProfile.requireReplay && !runs.some((item) => item.data.surface === surface && item.data.runKind === "replay")) {
          missing.push(`${surface} 回放运行`);
        }
      }
      const assertionCount = runs.reduce((total, item) => total + numberValue(item.data.assertions), 0);
      const oracleCount = runs.reduce((total, item) => total + numberValue(item.data.oracles), 0);
      const expectedRunCount = expectedSurfaces.length * (executionProfile.requireReplay ? 2 : 1);
      const expectedRuns = runs.filter((item) => expectedSurfaces.includes(item.data.surface as typeof expectedSurfaces[number])
        && (item.data.runKind === "primary" || item.data.runKind === "replay" || item.data.runKind === undefined));
      if (expectedRuns.length < expectedRunCount) missing.push(`至少 ${expectedRunCount} 次表面运行`);
      if (assertionCount < 1) missing.push("至少一个可观察断言");
      if (context.mission.policy.requireEvidence && context.mission.evidence.length === 0) {
        return { output: { verified: false, reason: "No evidence was captured" }, verdict: "failed", findings: [FindingSchema.parse({ findingId: "missing-evidence", severity: "high", category: "test", status: "confirmed", title: "Mission has no evidence", message: "The configured evidence requirement was not met.", createdAt: new Date().toISOString() })] };
      }
      if (executionProfile.requireBusinessOracle && oracleCount < 1) missing.push("至少一个独立业务 Oracle");
      if (executionProfile.minimumEvidence > 0 && context.mission.evidence.length < executionProfile.minimumEvidence) {
        missing.push(`至少 ${executionProfile.minimumEvidence} 份可追溯证据`);
      }
      if (missing.length > 0) {
        const message = `${context.mission.level} 测试证据门禁未满足：${missing.join("、")}`;
        const observedAt = new Date().toISOString();
        return {
          output: { verified: false, reason: message, level: context.mission.level },
          verdict: "inconclusive",
          firstFailure: FailureBoundarySchema.parse({ kind: "evidence", message, evidence: context.mission.evidence.slice(0, 4), observedAt }),
          findings: [FindingSchema.parse({ findingId: `evidence-gate-${context.mission.level}`, severity: "high", category: "test", status: "confirmed", title: `${context.mission.level} 测试证据不足`, message, evidence: context.mission.evidence.slice(0, 4), createdAt: observedAt })],
        };
      }
      const failed = expectedRuns.some((item) => item.data.verdict === "failed" || item.data.verdict === "blocked" || item.data.verdict === "cancelled");
      const inconclusive = expectedRuns.some((item) => item.data.verdict === "inconclusive");
      const verdict = failed ? "failed" : inconclusive ? "inconclusive" : "passed";
      return { output: { verified: verdict === "passed", runVerdict: verdict, surfaces: expectedSurfaces }, verdict };
    };
    return [
      { name: "project.discover", description: "Inspect the local project without modifying it.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.inspect", description: "Inspect the configured Web or Electron surface.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.run-charter", description: "Run a validated charter through the existing deterministic runner and collect evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, inputSchema: z.object({ charter: TestCharterSchema.optional(), adapter: z.enum(["web", "electron"]).optional() }), execute: runCharter },
      { name: "surface.replay-charter", description: "Replay the preceding surface run using the saved charter and preserve a second evidence trail.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, inputSchema: z.object({ adapter: z.enum(["web", "electron"]).optional() }), execute: replayCharter },
      { name: "mission.verify", description: "Verify the terminal verdict and evidence completeness of the preceding run.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: verify },
    ];
  }

  private runEvidence(summary: RunSummary): EvidenceRef[] {
    const paths = new Set([`${summary.runId}/run.json`, `${summary.runId}/report.html`, ...summary.artifacts]);
    return [...paths].map((path) => EvidenceRefSchema.parse({
      evidenceId: `${summary.runId}:${path}`,
      kind: path.endsWith(".png") ? "screenshot" : path.endsWith("report.html") ? "report" : path.includes("oracle") ? "business" : "snapshot",
      path: resolve(this.evidenceDir, path),
      description: `Evidence captured by run ${summary.runId}`,
      capturedAt: summary.endedAt ?? summary.startedAt,
    }));
  }

  async plan(intent: string, options: PlanOptions = {}): Promise<TestCharter> {
    const levelSelection = resolveTestLevel(intent, options.level);
    const levelProfile = getTestLevelProfile(levelSelection.resolved);
    const policy = options.sideEffectPolicy ?? this.config.policies.sideEffects;
    if (this.restrictWebOrigins && policy === "allow" && this.config.policies.sideEffects !== "allow") {
      throw new Error("MCP interactive planning requires sideEffects=allow in project config");
    }
    const constraints = {
      url: options.url ?? this.config.surfaces.web?.baseUrl,
      expect: options.expect,
      mode: options.mode,
      sideEffectPolicy: policy,
      oracleNames: options.oracleNames,
      level: levelSelection.resolved,
      requireAssertions: levelProfile.evidencePolicy.requireAssertions,
      allowedActionKinds: policy === "allow"
        ? ["goto", "click", "fill", "press", "waitForText", "screenshot", "observe"]
        : ["goto", "waitForText", "screenshot", "observe"],
      allowedOracleNames: [...new Set([
        ...this.config.oracles.map((oracle) => oracle.name),
        ...this.oracles.map((oracle) => oracle.name),
      ])],
    };
    const provider = this.plannerProvider ?? this.createPlannerProvider();
    const charter = provider
      ? await new StructuredPlanner(provider).plan({ intent, projectMap: await this.discover(), constraints })
      : new IntentPlanner().plan(intent, constraints);
    if (charter.sideEffectPolicy !== constraints.sideEffectPolicy) throw new Error("Planner changed the side-effect policy");
    if (charter.oracles?.some((name) => !constraints.allowedOracleNames.includes(name))) throw new Error("Planner referenced an unregistered oracle");
    if (options.oracleNames && (charter.oracles?.length !== options.oracleNames.length || options.oracleNames.some((name) => !charter.oracles?.includes(name)))) {
      throw new Error("Planner changed the requested business oracles");
    }
    if (provider && charter.actions.some((action) => action.kind === "goto")) {
      const approvedUrl = constraints.url;
      if (!approvedUrl) throw new Error("Model navigation requires a configured Web URL or --url");
      const approvedOrigin = new URL(approvedUrl).origin;
      for (const action of charter.actions) {
        if (action.kind === "goto" && new URL(action.url).origin !== approvedOrigin) {
          throw new Error(`Planner navigation is outside the approved origin: ${action.url}`);
        }
      }
    }
    this.validateWebOrigins(charter, { url: constraints.url });
    return charter;
  }

  async start(input: LocalRunInput): Promise<LocalRunStatus> {
    const runId = createRunId();
    const controller = new AbortController();
    const record: LocalRunRecord = { runId, status: "running", controller, promise: Promise.resolve(undefined as never) };
    this.records.set(runId, record);
    const promise = this.execute(runId, input, controller.signal);
    record.promise = promise;
    void promise.then((summary) => {
      record.status = "completed";
      record.summary = summary;
    }).catch((error: unknown) => {
      record.status = "failed";
      record.error = toError(error).message;
    });
    return this.toStatus(record);
  }

  async cancel(runId: string, reason = "Run cancelled by user"): Promise<LocalRunStatus> {
    const safeRunId = validateRunId(runId);
    const record = this.records.get(safeRunId);
    if (!record) throw new Error(`Run not found: ${safeRunId}`);
    if (record.status === "running" || record.status === "queued") {
      record.controller.abort(new CancelledError(reason));
    }
    return this.toStatus(record);
  }

  async wait(runId: string): Promise<RunSummary> {
    const record = this.records.get(validateRunId(runId));
    if (record) return record.promise;
    return this.evidence.loadSummary(runId);
  }

  async status(runId: string): Promise<LocalRunStatus> {
    const safeRunId = validateRunId(runId);
    const record = this.records.get(safeRunId);
    if (record) {
      if (record.status === "running") {
        try { record.summary = await this.evidence.loadSummary(safeRunId); } catch { /* run has not written its initial summary yet */ }
      }
      return this.toStatus(record);
    }
    try {
      const summary = await this.evidence.loadSummary(safeRunId);
      return {
        runId: safeRunId,
        status: summary.status === "completed" ? "completed" : "running",
        verdict: summary.verdict,
        summary,
        report: this.reportPath(safeRunId),
      };
    } catch {
      throw new Error(`Run not found: ${safeRunId}`);
    }
  }

  async evidenceFor(runId: string, section: "summary" | "events" | "report" = "summary", maxChars = 20_000): Promise<{ runId: string; section: string; content: string; truncated: boolean }> {
    const safeRunId = validateRunId(runId);
    const path = section === "summary"
      ? resolve(this.evidenceDir, safeRunId, "run.json")
      : section === "events"
        ? resolve(this.evidenceDir, safeRunId, "events.jsonl")
        : resolve(this.evidenceDir, safeRunId, "report.html");
    const content = await readFile(path, "utf8");
    return { runId: safeRunId, section, content: content.slice(0, maxChars), truncated: content.length > maxChars };
  }

  async replay(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath"> = {}): Promise<LocalRunStatus> {
    const previous = await this.evidence.loadSummary(validateRunId(runId));
    return this.start({ ...input, charter: previous.charter });
  }

  private async execute(runId: string, input: LocalRunInput, signal: AbortSignal): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(await this.resolveCharter(input));
    if (this.restrictWebOrigins && charter.sideEffectPolicy === "allow" && this.config.policies.sideEffects !== "allow") {
      throw new Error("MCP interactive runs require sideEffects=allow in project config");
    }
    this.validateWebOrigins(charter, input);
    this.validateCdpEndpoint(input);
    if (this.restrictWebOrigins && this.config.project.start && input.start !== false) {
      throw new Error("MCP runs cannot execute project.start; start the project through the CLI or use startProject=false");
    }
    if (this.restrictWebOrigins && input.oracleUrl) {
      const oracleHost = new URL(input.oracleUrl).hostname;
      if (!isLoopback(oracleHost)) throw new Error("Business oracle URL must use loopback");
    }
    const adapter = this.createAdapter(input);
    const oracleNames = charter.oracles ?? [];
    if (new Set(oracleNames).size !== oracleNames.length) throw new Error("Duplicate oracle name in Charter");
    const registered = new Map(this.oracles.map((oracle) => [oracle.name, oracle]));
    const configured = oracleNames.map((name) => {
      const projectOracle = registered.get(name);
      if (projectOracle) return projectOracle;
      const definition = this.config.oracles.find((oracle) => oracle.name === name);
      if (!definition) throw new Error(`Oracle is not registered: ${name}`);
      if (this.restrictWebOrigins && !isLoopback(new URL(definition.url).hostname)) throw new Error(`MCP oracle ${name} must use loopback`);
      return configuredHttpOracle(definition);
    });
    const oracles = input.oracleUrl
      ? [httpOracle({ name: input.oracleName ?? "http-check", url: input.oracleUrl })]
      : [];
    const setup: IntegrationSetup | undefined = input.start !== false && this.config.project.start ? async ({ emit }) => {
      const runtime = new ProjectRuntime({
        root: this.root,
        config: this.config,
        onEvent: (event) => void emit({ timestamp: new Date().toISOString(), type: "adapter.event", payload: { source: "project-runtime", ...event } }),
      });
      try {
        await runtime.start();
      } catch (error) {
        await runtime.stop();
        throw error;
      }
      return () => runtime.stop();
    } : undefined;
    const integrationSetup = this.integration?.setup;
    return new ExecutionRunner(adapter, {
      evidenceDir: this.evidenceDir,
      oracles: [...this.oracles, ...configured, ...oracles],
      capabilities: this.capabilities,
      environment: this.config.policies.environment,
      allowCapabilityWrites: this.allowCapabilityWrites,
      signal,
      timeoutMs: this.config.run.timeoutMs,
      integration: this.integration ? { name: this.integration.name, version: this.integration.version } : undefined,
      setup: setup || integrationSetup ? async (context) => {
        const cleanups: Array<() => void | Promise<void>> = [];
        const cleanupAll = async () => {
          let firstError: Error | undefined;
          for (const cleanup of cleanups.reverse()) {
            try { await cleanup(); } catch (error) { firstError ??= toError(error); }
          }
          if (firstError) throw firstError;
        };
        try {
          if (integrationSetup) {
            const cleanup = await integrationSetup(context);
            if (cleanup) cleanups.push(cleanup);
          }
          if (setup) {
            const cleanup = await setup(context);
            if (cleanup) cleanups.push(cleanup);
          }
          return cleanupAll;
        } catch (error) {
          try { await cleanupAll(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Integration setup and cleanup failed"); }
          throw error;
        }
      } : undefined,
    }).run(charter, runId);
  }

  private async resolveCharter(input: LocalRunInput): Promise<TestCharter> {
    if (input.charter) return input.charter;
    if (input.charterPath) return loadCharter(resolveWithinRoot(this.root, input.charterPath));
    if (!input.intent) throw new Error("An intent, charter, or charterPath is required");
    return this.plan(input.intent, {
      url: input.url,
      expect: input.expect,
      mode: input.mode,
      sideEffectPolicy: input.sideEffectPolicy,
      oracleNames: input.oracleNames,
      level: input.level,
    });
  }

  private createPlannerProvider(): PlannerProvider | undefined {
    const planning = this.config.planning;
    if (planning.provider === "deterministic") return undefined;
    if (!planning.baseUrl || !planning.model) throw new Error("OpenAI-compatible planning requires baseUrl and model");
    if (this.restrictWebOrigins && !isLoopback(new URL(planning.baseUrl).hostname)) throw new Error("MCP planner endpoint must use loopback");
    const apiKey = planning.apiKeyEnv ? process.env[planning.apiKeyEnv] : undefined;
    if (planning.apiKeyEnv && !apiKey) throw new Error(`Planner API key environment variable is missing: ${planning.apiKeyEnv}`);
    return new OpenAICompatiblePlannerProvider({ baseUrl: planning.baseUrl, model: planning.model, apiKey, timeoutMs: planning.timeoutMs });
  }

  private createAdapter(input: LocalRunInput): SurfaceAdapter {
    if ((input.adapter ?? "web") === "electron") {
      return new ElectronAdapter({
        cdpUrl: input.cdp ?? this.config.surfaces.electron?.cdpUrl,
        devtoolsActivePortPath: input.devtoolsPortFile ?? this.config.surfaces.electron?.devtoolsActivePort,
      });
    }
    if ((input.adapter ?? "web") !== "web") throw new Error(`Unsupported adapter: ${input.adapter}`);
    return new WebAdapter({
      baseUrl: input.url ?? this.config.surfaces.web?.baseUrl,
      cdpUrl: input.cdp,
      headless: !input.headful,
    });
  }

  private validateWebOrigins(charter: TestCharter, input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const configuredOrigin = this.config.surfaces.web?.baseUrl
      ? new URL(this.config.surfaces.web.baseUrl).origin
      : undefined;
    const urls = [input.url, ...charter.actions.filter((action) => action.kind === "goto").map((action) => action.url)];
    for (const value of urls) {
      if (!value) continue;
      const parsed = new URL(value);
      if (isLoopback(parsed.hostname) || parsed.origin === configuredOrigin) continue;
      throw new Error(`Web URL is outside the configured origin: ${parsed.origin}`);
    }
  }

  private validateCdpEndpoint(input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const cdp = input.cdp ?? (input.adapter === "electron" ? this.config.surfaces.electron?.cdpUrl : undefined);
    if (cdp && !isLoopback(new URL(cdp).hostname)) {
      throw new Error("CDP endpoint must use loopback in MCP runs");
    }
  }

  private toStatus(record: LocalRunRecord): LocalRunStatus {
    return {
      runId: record.runId,
      status: record.status,
      verdict: record.summary?.verdict,
      summary: record.summary,
      error: record.error,
      report: record.status === "completed" ? this.reportPath(record.runId) : undefined,
    };
  }

  private reportPath(runId: string): string {
    return resolve(this.evidenceDir, runId, "report.html");
  }
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
  return runId;
}

function validateMissionId(missionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(missionId)) throw new Error("Invalid mission id");
  return missionId;
}

function resolveWithinRoot(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path must stay within the project root");
  return absolute;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function loadConfigDefaults(): ProofkitConfig {
  return {
    project: { root: ".", health: [], startupTimeoutMs: 60_000 },
    surfaces: {},
    planning: { provider: "deterministic", timeoutMs: 30_000 },
    integration: {},
    run: { timeoutMs: 300_000 },
    oracles: [],
    policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
