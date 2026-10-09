import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeRun, InMemoryMissionToolRegistry, MissionAgent, type MissionTool, type MissionToolResult } from "@proofkit/agent";
import { ElectronAdapter, MobileAdapter, WebAdapter } from "@proofkit/adapters";
import { createRunId, EvidenceStore } from "@proofkit/evidence";
import { EvidenceRefSchema, FailureBoundarySchema, FindingSchema, NegativeCaseSchema, ObservationSchema, TestCharterSchema, TestLevelSelectionSchema, TestSuiteSchema, type EvidenceRef, type NegativeCase, type ProofkitConfig, type ProjectMap, type RouteCoverageTarget, type RunMode, type RunSummary, type SideEffectPolicy, type TestCharter, type TestLevel, type TestMission, type TestSuite, type Verdict } from "@proofkit/contracts";
import { configuredHttpOracle, httpOracle } from "@proofkit/oracles";
import { getTestLevelProfile, IntentPlanner, OpenAICompatiblePlannerProvider, resolveTestLevel, selectCatalogCharter, selectCatalogSuite, StructuredPlanner, loadCharter, type PlanOptions, type PlannerProvider } from "@proofkit/planner";
import { initProject, loadConfigForContext, resolveProjectContext, resolveWithinWorkspace, sameProjectPath, scanProject } from "@proofkit/project";
import { CancelledError, ExecutionRunner, z, type BusinessOracle, type CapabilityDefinition, type IntegrationSetup, type ProjectIntegration, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";
import { loadProjectIntegration } from "./integration.js";
import { ProjectMissionStore } from "./mission-store.js";
import { summarizeSuiteScope, verifySuiteMission, type SuiteScopeSummary } from "./suite-verifier.js";

export { loadProjectIntegration } from "./integration.js";

export type LocalAdapterName = "web" | "electron" | "mobile";

const SURFACE_CANCELLATION_GRACE_MS = 10_000;

export type LocalRunInput = {
  signal?: AbortSignal;
  intent?: string;
  charter?: TestCharter;
  charterPath?: string;
  adapter?: LocalAdapterName;
  url?: string;
  cdp?: string;
  devtoolsPortFile?: string;
  mobileServer?: string;
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
  charterId?: string;
  suiteId?: string;
  surface?: "web" | "electron" | "mobile" | "api";
  adapter?: LocalAdapterName;
  charter?: TestCharter;
  url?: string;
  cdp?: string;
  devtoolsPortFile?: string;
  mobileServer?: string;
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

/**
 * Bounded AgentStep data exposed to MCP/CLI evidence consumers. The full
 * Mission still retains inputs and outputs locally; this summary keeps the
 * decision/audit trail useful without copying potentially large payloads.
 */
export type MissionAgentStepSummary = Pick<TestMission["agentSteps"][number],
  "agentStepId" | "sequence" | "taskId" | "charterId" | "phase" | "tool" | "decision" | "status" | "startedAt" | "endedAt" | "durationMs" | "toolCallIds" | "observationIds" | "evidence" | "error">;

export type { SuiteScopeSummary } from "./suite-verifier.js";

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
  workspaceRoot?: string;
  config?: ProofkitConfig;
  evidenceDir?: string;
  restrictWebOrigins?: boolean;
  /** Registry of available Oracles. Only names selected by a Charter execute. */
  oracles?: BusinessOracle[];
  capabilities?: CapabilityDefinition<any, any>[];
  allowCapabilityWrites?: boolean;
  plannerProvider?: PlannerProvider;
  integration?: ProjectIntegration;
};

export class LocalRunnerService {
  readonly root: string;
  readonly workspaceRoot: string;
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
    const context = resolveProjectContext(options.root, { workspaceRoot: options.workspaceRoot });
    this.root = context.projectRoot;
    this.workspaceRoot = context.workspaceRoot;
    this.config = loadConfigForContext(context, options.config);
    this.evidenceDir = resolve(this.workspaceRoot, options.evidenceDir ?? ".proofkit/runs");
    this.evidence = new EvidenceStore(this.evidenceDir);
    this.restrictWebOrigins = options.restrictWebOrigins ?? false;
    this.integration = options.integration;
    this.oracles = [...(this.integration?.oracles ?? []), ...(options.oracles ?? [])];
    const oracleNames = [...this.oracles, ...this.config.oracles].map((oracle) => oracle.name);
    if (new Set(oracleNames).size !== oracleNames.length) throw new Error("Duplicate oracle registration");
    this.capabilities = [...(this.integration?.capabilities ?? []), ...(options.capabilities ?? [])];
    this.allowCapabilityWrites = options.allowCapabilityWrites ?? false;
    this.plannerProvider = options.plannerProvider;
    this.missionAgent = new MissionAgent({
      store: new ProjectMissionStore(context),
      tools: new InMemoryMissionToolRegistry(this.createMissionTools()),
    });
  }

  static async create(options: Omit<LocalRunnerOptions, "config"> & { config?: ProofkitConfig }): Promise<LocalRunnerService> {
    const context = resolveProjectContext(options.root, { workspaceRoot: options.workspaceRoot });
    const config = loadConfigForContext(context, options.config);
    const integration = options.integration ?? await loadProjectIntegration(context.projectRoot, config, undefined, context.workspaceRoot);
    return new LocalRunnerService({ ...options, root: context.projectRoot, workspaceRoot: context.workspaceRoot, config, integration });
  }

  async discover(): Promise<ProjectMap> {
    return scanProject(this.root);
  }

  listCharters(): ProofkitConfig["charters"] {
    return this.config.charters;
  }

  listSuites(): ProofkitConfig["suites"] {
    return this.config.suites;
  }

  async createMission(input: MissionCreateOptions): Promise<TestMission> {
    const surface = input.surface ?? input.adapter ?? "web";
    if (surface === "api") throw new Error(`Mission surface is not enabled by the local runner: ${surface}`);
    if (input.charter && input.charterId) throw new Error("Supply either a Charter or charterId, not both");
    if (input.suiteId && (input.charter || input.charterId)) throw new Error("Supply either suiteId or a Charter, not both");
    const catalogLevel = input.charterId ? this.config.charters.find((entry) => entry.id === input.charterId)?.level : undefined;
    const levelSelection = input.suiteId && !input.level
      ? TestLevelSelectionSchema.parse({ resolved: "release", source: "inferred", reason: `选定的测试套件 ${input.suiteId} 要求 release 级别`, confidence: 1 })
      : resolveTestLevel(input.intent, input.level ?? input.charter?.level ?? catalogLevel);
    const hasAdHocOptions = Boolean(input.url || input.expect?.length || input.oracleNames?.length || input.mode || input.sideEffectPolicy);
    if (input.charterId && hasAdHocOptions) throw new Error("charterId cannot be combined with ad-hoc planning options");
    if (input.suiteId && hasAdHocOptions) throw new Error("suiteId cannot be combined with ad-hoc planning options");
    const selectedSuite = input.charter || input.charterId || (hasAdHocOptions && !input.suiteId)
      ? undefined
      : selectCatalogSuite(this.config.suites, { intent: input.intent, level: levelSelection.resolved, surface, suiteId: input.suiteId });
    if (selectedSuite && !input.suiteId) {
      const competingCharter = selectCatalogCharter(this.config.charters, { intent: input.intent, level: levelSelection.resolved, surface });
      if (competingCharter) throw new Error(`Intent matches suite ${selectedSuite.entry.id} and Charter ${competingCharter.entry.id}; specify suiteId or charterId`);
    }
    const selected = input.charter || selectedSuite ? undefined : !hasAdHocOptions || input.charterId
      ? selectCatalogCharter(this.config.charters, { intent: input.intent, level: levelSelection.resolved, surface, charterId: input.charterId })
      : undefined;
    if (selectedSuite) {
      const suite = await this.loadSuite(selectedSuite.entry);
      const sideEffectPolicy: SideEffectPolicy = suite.charters.some((item) => item.charter.sideEffectPolicy === "allow")
        ? "allow" : suite.charters.some((item) => item.charter.sideEffectPolicy === "confirm") ? "confirm" : "deny";
      if (input.policy?.sideEffectPolicy && input.policy.sideEffectPolicy !== sideEffectPolicy) {
        throw new Error("Mission policy side effects must match the selected suite");
      }
      const expectedRuns = suite.charters.reduce((count, item) => count + suite.surfaces.length * (2 + (item.charter.negativeCases?.length ?? 0)), 0);
      const timeoutMs = input.policy?.timeoutMs ?? Math.min(3_600_000, Math.max(300_000, expectedRuns * this.config.run.timeoutMs));
      await this.ensureWorkspace();
      return this.missionAgent.create({
        intent: input.intent,
        projectRoot: this.root,
        workspaceRoot: this.workspaceRoot,
        surface,
        suite,
        levelSelection,
        policy: { ...input.policy, level: "release", sideEffectPolicy, timeoutMs },
      });
    }
    let charter: TestCharter;
    if (input.charter) {
      charter = input.charter;
    } else if (selected) {
      const saved = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, selected.entry.path));
      if (saved.level !== selected.entry.level) {
        throw new Error(`Test catalog entry ${selected.entry.id} declares ${selected.entry.level}, but its Charter is ${saved.level}`);
      }
      charter = TestCharterSchema.parse({
        ...saved,
        metadata: { ...saved.metadata, catalogId: selected.entry.id, ...(selected.matchedAlias ? { matchedAlias: selected.matchedAlias } : {}) },
      });
    } else {
      charter = await this.plan(input.intent, {
        url: input.url,
        expect: input.expect,
        oracleNames: input.oracleNames,
        mode: input.mode,
        sideEffectPolicy: input.sideEffectPolicy,
        level: input.level,
      });
    }
    if (charter.level !== levelSelection.resolved) {
      throw new Error(`Charter level ${charter.level} does not match requested level ${levelSelection.resolved}`);
    }
    const normalizedCharter = TestCharterSchema.parse({ ...charter, levelSelection: charter.levelSelection ?? levelSelection });
    if (selected) this.validateCatalogCharter(selected.entry.id, normalizedCharter, surface);
    if (input.policy?.sideEffectPolicy && input.policy.sideEffectPolicy !== normalizedCharter.sideEffectPolicy) {
      throw new Error("Mission policy side effects must match the selected Charter");
    }
    await this.ensureWorkspace();
    return this.missionAgent.create({
      intent: input.intent,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      surface,
      charter: normalizedCharter,
      levelSelection,
      policy: { ...input.policy, level: levelSelection.resolved, sideEffectPolicy: normalizedCharter.sideEffectPolicy },
    });
  }

  private async loadSuite(entry: ProofkitConfig["suites"][number]): Promise<TestSuite> {
    const entries = new Map(this.config.charters.map((charter) => [charter.id, charter]));
    const charters: TestSuite["charters"] = [];
    for (const charterId of entry.charterIds) {
      const catalog = entries.get(charterId);
      if (!catalog) throw new Error(`Test suite ${entry.id} references unknown Charter: ${charterId}`);
      if (catalog.level !== "release" || !entry.surfaces.every((surface) => catalog.surfaces.includes(surface))) {
        throw new Error(`Test suite ${entry.id} Charter ${charterId} does not support its complete release surface matrix`);
      }
      const saved = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, catalog.path));
      if (saved.level !== catalog.level) throw new Error(`Test suite ${entry.id} Charter ${charterId} has a mismatched level`);
      const charter = TestCharterSchema.parse({ ...saved, metadata: { ...saved.metadata, catalogId: charterId, suiteId: entry.id } });
      for (const surface of entry.surfaces) this.validateCatalogCharter(charterId, charter, surface);
      charters.push({ charterId, charter, routeTargets: catalog.routeTargets ?? [] });
    }
    const included = new Set(entry.charterIds);
    const uncoveredCharterIds = this.config.charters.filter((item) => item.level === "release" && !included.has(item.id)).map((item) => item.id);
    return TestSuiteSchema.parse({ suiteId: entry.id, level: entry.level, surfaces: entry.surfaces, charters, uncoveredCharterIds });
  }

  private validateCatalogCharter(id: string, charter: TestCharter, surface: LocalAdapterName): void {
    if (charter.assertions.length === 0) throw new Error(`Test catalog entry ${id} needs a surface assertion before it can run`);
    if (getTestLevelProfile(charter.level).evidencePolicy.requireBusinessOracle && !charter.oracles?.length) {
      throw new Error(`Test catalog entry ${id} needs an independent business Oracle for ${charter.level}`);
    }
    const availableOracles = new Set([...this.oracles.map((oracle) => oracle.name), ...this.config.oracles.map((oracle) => oracle.name)]);
    for (const oracle of [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((item) => item.oracles)]) {
      if (!availableOracles.has(oracle)) throw new Error(`Test catalog entry ${id} references an unregistered Oracle: ${oracle}`);
      const configured = this.config.oracles.find((item) => item.name === oracle);
      if (this.restrictWebOrigins && configured && !isLoopback(new URL(configured.url).hostname)) {
        throw new Error(`Test catalog entry ${id} requires a loopback Oracle in MCP mode: ${oracle}`);
      }
    }
    const availableCapabilities = new Map(this.capabilities.map((capability) => [capability.name, capability]));
    const scenarios = [{ actions: charter.actions, sideEffectPolicy: charter.sideEffectPolicy }, ...(charter.negativeCases ?? [])];
    for (const scenario of scenarios) {
      for (const action of scenario.actions) {
        if (action.kind !== "capability") continue;
        const capability = availableCapabilities.get(action.name);
        if (!capability) throw new Error(`Test catalog entry ${id} references an unregistered capability: ${action.name}`);
        if (capability.sideEffect === "write" && scenario.sideEffectPolicy !== "allow") {
          throw new Error(`Test catalog entry ${id} must allow write capability ${action.name} in its scenario`);
        }
      }
    }
    if (this.restrictWebOrigins && scenarios.some((scenario) => scenario.sideEffectPolicy === "allow") && this.config.policies.sideEffects !== "allow") {
      throw new Error(`Test catalog entry ${id} requires policies.sideEffects=allow in the test workspace`);
    }
    this.validateWebOrigins(charter, { adapter: surface });
    for (const negativeCase of charter.negativeCases ?? []) {
      this.validateWebOrigins({ ...charter, actions: negativeCase.actions }, { adapter: surface });
    }
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
    projectRoot: string;
    workspaceRoot: string;
    status: TestMission["status"];
    running: boolean;
    verdict?: TestMission["verdict"];
    level: TestMission["level"];
    levelSelection?: TestMission["levelSelection"];
    executionProfile: TestMission["plan"]["executionProfile"];
    suiteScope?: SuiteScopeSummary;
    taskSummary: Array<{
      taskId: string;
      charterId?: string;
      title: string;
      tool: string;
      status: TestMission["plan"]["graph"]["tasks"][number]["status"];
      attempts: number;
      maxAttempts: number;
      error?: string;
    }>;
    agentSteps: MissionAgentStepSummary[];
    evidence: EvidenceRef[];
    findings: TestMission["findings"];
    firstFailure?: TestMission["firstFailure"];
    diagnosis?: TestMission["diagnosis"];
    repairSuggestions: TestMission["repairSuggestions"];
  }> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    return {
      missionId: mission.missionId,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      status: mission.status,
      running: this.missionRecords.has(mission.missionId) || mission.status === "running",
      verdict: mission.verdict,
      level: mission.level,
      levelSelection: mission.levelSelection,
      executionProfile: mission.plan.executionProfile,
      suiteScope: summarizeSuiteScope(mission),
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
      agentSteps: mission.agentSteps.map(summarizeAgentStep),
      evidence: mission.evidence,
      findings: mission.findings,
      firstFailure: mission.firstFailure,
      diagnosis: mission.diagnosis,
      repairSuggestions: mission.repairSuggestions,
    };
  }

  async replayMission(missionId: string): Promise<MissionStatus> {
    const previous = await this.missionAgent.load(validateMissionId(missionId));
    await this.ensureWorkspace();
    const replay = await this.missionAgent.create({
      intent: previous.intent,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      surface: previous.surface,
      charter: previous.charter,
      suite: previous.suite,
      levelSelection: previous.levelSelection,
      policy: { ...previous.policy, requireApproval: false },
    });
    return this.startMission(replay.missionId, { approve: true });
  }

  private createMissionTools(): MissionTool[] {
    type MissionToolContext = Parameters<NonNullable<MissionTool["execute"]>>[1];
    type SurfaceRunKind = "primary" | "replay" | "negative";

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

    const collectSurfaceRun = async (summary: RunSummary, context: MissionToolContext, adapter: LocalAdapterName, runKind: SurfaceRunKind, sourceRunId?: string, negativeCaseId?: string, expectedVerdict?: Verdict, charterId?: string): Promise<MissionToolResult> => {
      if (context.mission.suite && summary.charter.metadata.catalogId !== charterId) {
        throw new Error(`Run ${summary.runId} returned evidence for a different Charter`);
      }
      const actualVerdict = summary.verdict ?? "inconclusive";
      const outcomeMatched = expectedVerdict === undefined ? undefined : actualVerdict === expectedVerdict;
      const effectiveVerdict: Verdict = expectedVerdict === undefined
        ? actualVerdict
        : outcomeMatched ? "passed" : actualVerdict === "passed" ? "failed" : actualVerdict;
      const evidence = this.runEvidence(summary);
      const observation = ObservationSchema.parse({
        observationId: `${context.task.taskId}-${summary.runId}`,
        charterId,
        source: "surface",
        kind: "surface.run",
        data: {
          runId: summary.runId,
          charterId,
          sourceRunId,
          surface: adapter,
          runKind,
          negativeCaseId,
          verdict: actualVerdict,
          expectedVerdict,
          outcomeMatched,
          steps: summary.steps.length,
          assertions: summary.assertions.length,
          passedAssertions: summary.assertions.filter((item) => item.passed).length,
          oracles: summary.oracles.length,
          passedOracles: summary.oracles.filter((item) => item.passed === true).length,
          businessEvidence: summary.oracles.reduce((count, oracle) => count + (oracle.sourceEvidenceCount ?? 0), 0),
          matchedRoutePaths: matchedWebRouteTargets(summary, context.mission.suite?.charters.find((item) => item.charterId === charterId)?.routeTargets ?? []),
        },
        evidence,
        observedAt: new Date().toISOString(),
      });
      // A negative case may intentionally expect a failed or blocked surface
      // run. Do not turn that expected outcome into a product finding; retain
      // the raw run verdict in the observation and report the normalized
      // scenario verdict to the Mission Agent.
      const expectedFailureOutcome = runKind === "negative" && expectedVerdict !== undefined && expectedVerdict !== "passed";
      const analysis = expectedFailureOutcome ? {} : outcomeMatched === true ? {} : analyzeRun({ summary, evidence });
      const findings = analysis.finding
        ? [FindingSchema.parse({ ...analysis.finding, charterId, surface: adapter })]
        : expectedVerdict !== undefined && outcomeMatched === false
          ? [FindingSchema.parse({
              findingId: `negative-outcome-${summary.runId}`,
              charterId,
              surface: adapter,
              severity: "high",
              category: "test",
              status: "confirmed",
              title: "Negative case outcome did not match expectation",
              message: `Expected ${expectedVerdict}, but the surface run ended with ${actualVerdict}.`,
              evidence,
              createdAt: summary.endedAt ?? summary.startedAt,
            })]
        : runKind !== "negative" && (summary.verdict === "failed" || summary.verdict === "blocked")
          ? [FindingSchema.parse({
              findingId: `run-${summary.runId}`,
              charterId,
              surface: adapter,
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
        output: { runId: summary.runId, charterId, verdict: effectiveVerdict, actualVerdict, expectedVerdict, outcomeMatched, report: this.reportPath(summary.runId), ...(negativeCaseId ? { negativeCaseId } : {}) },
        verdict: effectiveVerdict,
        observations: [observation],
        evidence,
        findings,
        firstFailure: analysis.boundary ? FailureBoundarySchema.parse({ ...analysis.boundary, charterId, surface: adapter }) : undefined,
        diagnosis: analysis.diagnosis ? { ...analysis.diagnosis, charterId, surface: adapter } : undefined,
        repairSuggestions: analysis.repairSuggestion ? [{ ...analysis.repairSuggestion, charterId, surface: adapter }] : [],
      };
    };

    const runCharter = async (input: { charter?: TestCharter; charterId?: string; adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite && context.task.charterId !== input.charterId) throw new Error("Suite task Charter ID does not match its input");
      const charter = context.mission.suite
        ? context.mission.suite.charters.find((item) => item.charterId === input.charterId)?.charter
        : input.charter ?? context.mission.charter;
      if (!charter) throw new Error("Mission has no Test Charter to execute");
      const charterId = context.mission.suite ? input.charterId : typeof charter.metadata.catalogId === "string" ? charter.metadata.catalogId : undefined;
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const started = await this.start({ charter, adapter, signal: context.signal });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "primary", undefined, undefined, undefined, charterId);
    };

    const replayCharter = async (input: { charterId?: string; adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite && context.task.charterId !== input.charterId) throw new Error("Suite replay Charter ID does not match its input");
      if (context.mission.suite && !context.mission.suite.charters.some((item) => item.charterId === input.charterId)) throw new Error("Replay Charter is not in the suite");
      const charterId = context.mission.suite ? input.charterId : typeof context.mission.charter?.metadata.catalogId === "string" ? context.mission.charter.metadata.catalogId : undefined;
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const source = [...context.mission.observations].reverse().find((item) => item.kind === "surface.run"
        && item.data.surface === adapter
        && (!context.mission.suite || item.charterId === charterId)
        && (item.data.runKind === "primary" || item.data.runKind === undefined));
      const sourceRunId = typeof source?.data.runId === "string" ? source.data.runId : undefined;
      if (!sourceRunId) {
        const observedAt = new Date().toISOString();
        const message = `没有找到 ${charterId ? `${charterId} · ` : ""}${adapter} 的主运行证据，无法执行回放`;
        return {
          output: { adapter, verified: false, reason: message },
          verdict: "blocked",
          firstFailure: FailureBoundarySchema.parse({ kind: "evidence", message, evidence: [], observedAt }),
          findings: [FindingSchema.parse({ findingId: `replay-source-${adapter}`, severity: "high", category: "test", status: "confirmed", title: "回放缺少主运行证据", message, createdAt: observedAt })],
        };
      }
      const started = await this.replay(sourceRunId, { adapter, signal: context.signal });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "replay", sourceRunId, undefined, undefined, charterId);
    };

    const runNegativeCharter = async (input: { charterId?: string; negativeCase: NegativeCase; adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite && context.task.charterId !== input.charterId) throw new Error("Suite negative-case Charter ID does not match its input");
      const requestedCase = NegativeCaseSchema.parse(input.negativeCase);
      const baseCharter = context.mission.suite
        ? context.mission.suite.charters.find((item) => item.charterId === input.charterId)?.charter
        : context.mission.charter;
      if (!baseCharter) throw new Error("Mission has no Test Charter for the negative case");
      const negativeCase = baseCharter.negativeCases?.find((item) => item.caseId === requestedCase.caseId);
      if (!negativeCase) throw new Error(`Negative case is not declared by its Charter: ${requestedCase.caseId}`);
      const charterId = context.mission.suite ? input.charterId : typeof baseCharter.metadata.catalogId === "string" ? baseCharter.metadata.catalogId : undefined;
      const charter = TestCharterSchema.parse({
        ...baseCharter,
        intent: `${context.mission.intent}: ${negativeCase.title}`,
        actions: negativeCase.actions,
        assertions: negativeCase.assertions,
        oracles: negativeCase.oracles,
        sideEffectPolicy: negativeCase.sideEffectPolicy,
        metadata: { ...baseCharter.metadata, negativeCaseId: negativeCase.caseId },
      });
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const started = await this.start({ charter, adapter, signal: context.signal });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "negative", undefined, negativeCase.caseId, negativeCase.expectedVerdict ?? "passed", charterId);
    };

    const verify = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite) {
        return verifySuiteMission(context.mission);
      }
      const runs = context.mission.observations.filter((item) => item.kind === "surface.run");
      if (runs.length === 0) throw new Error("No surface run observation is available for verification");
      const executionProfile = context.mission.plan.executionProfile;
      const expectedSurfaces = executionProfile.surfaceMatrix;
      const missing: string[] = [];
      for (const surface of expectedSurfaces) {
        for (const runKind of executionProfile.requireReplay ? ["primary", "replay"] as const : ["primary"] as const) {
          const label = runKind === "primary" ? "主运行" : "回放运行";
          const matchingRuns = runs.filter((item) => item.data.surface === surface
            && (item.data.runKind === runKind || (runKind === "primary" && item.data.runKind === undefined)));
          if (matchingRuns.length === 0) {
            missing.push(`${surface} ${label}`);
            continue;
          }
          for (const run of matchingRuns) {
            if (numberValue(run.data.passedAssertions) < 1) missing.push(`${surface} ${label}至少一个可观察断言`);
            if (executionProfile.requireBusinessOracle && numberValue(run.data.passedOracles) < 1) {
              missing.push(`${surface} ${label}至少一个独立业务 Oracle`);
            }
            if (executionProfile.requireBusinessOracle && numberValue(run.data.businessEvidence) < 1) {
              missing.push(`${surface} ${label}至少一份业务事实证据`);
            }
          }
        }
        if (executionProfile.requireNegativeCases) {
          for (const caseId of executionProfile.declaredNegativeCases) {
            if (!runs.some((item) => item.data.surface === surface && item.data.runKind === "negative" && item.data.negativeCaseId === caseId)) {
              missing.push(`${surface} 负向场景 ${caseId}`);
            }
          }
        }
      }
      const expectedRunCount = expectedSurfaces.length * (1 + (executionProfile.requireReplay ? 1 : 0) + (executionProfile.requireNegativeCases ? executionProfile.declaredNegativeCases.length : 0));
      const expectedRuns = runs.filter((item) => expectedSurfaces.includes(item.data.surface as typeof expectedSurfaces[number])
        && (item.data.runKind === "primary" || item.data.runKind === "replay" || item.data.runKind === "negative" || item.data.runKind === undefined));
      if (expectedRuns.length < expectedRunCount) missing.push(`至少 ${expectedRunCount} 次表面运行`);
      if (context.mission.policy.requireEvidence && context.mission.evidence.length === 0) {
        return { output: { verified: false, reason: "No evidence was captured" }, verdict: "failed", findings: [FindingSchema.parse({ findingId: "missing-evidence", severity: "high", category: "test", status: "confirmed", title: "Mission has no evidence", message: "The configured evidence requirement was not met.", createdAt: new Date().toISOString() })] };
      }
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
      const failed = expectedRuns.some((item) => item.data.outcomeMatched !== true
        && (item.data.verdict === "failed" || item.data.verdict === "blocked" || item.data.verdict === "cancelled"));
      const inconclusive = expectedRuns.some((item) => item.data.outcomeMatched !== true && item.data.verdict === "inconclusive");
      const verdict = failed ? "failed" : inconclusive ? "inconclusive" : "passed";
      return { output: { verified: verdict === "passed", runVerdict: verdict, surfaces: expectedSurfaces }, verdict };
    };
    return [
      { name: "project.discover", description: "Inspect the local project without modifying it.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.inspect", description: "Inspect the configured Web, Electron or mobile surface.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.run-charter", description: "Run a validated charter through the existing deterministic runner and collect evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charter: TestCharterSchema.optional(), charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runCharter },
      { name: "surface.replay-charter", description: "Replay the preceding surface run using the saved charter and preserve a second evidence trail.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: replayCharter },
      { name: "surface.run-negative-charter", description: "Run an explicitly declared negative or recovery Charter and collect independent evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), negativeCase: NegativeCaseSchema, adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runNegativeCharter },
      { name: "mission.verify", description: "Verify the terminal verdict and evidence completeness of the preceding run.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: verify },
    ];
  }

  private runEvidence(summary: RunSummary): EvidenceRef[] {
    const paths = new Set([`${summary.runId}/run.json`, `${summary.runId}/report.html`, ...summary.artifacts]);
    const oracleArtifacts = new Map(summary.oracles.map((oracle) => [oracle.evidence.at(-1), oracle.sourceEvidenceCount ?? 0]));
    return [...paths].map((path) => EvidenceRefSchema.parse({
      evidenceId: `${summary.runId}:${path}`,
      kind: path.endsWith(".png") ? "screenshot" : path.endsWith("report.html") || (oracleArtifacts.has(path) && !oracleArtifacts.get(path))
        ? "report" : oracleArtifacts.has(path) ? "business" : "snapshot",
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
    await this.ensureWorkspace();
    const runId = createRunId();
    const controller = new AbortController();
    const onAbort = () => {
      const reason = input.signal?.reason;
      controller.abort(new CancelledError(reason instanceof Error ? reason.message : "Run cancelled by caller"));
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const detachSignal = () => input.signal?.removeEventListener("abort", onAbort);
    const record: LocalRunRecord = { runId, status: "running", controller, promise: Promise.resolve(undefined as never) };
    this.records.set(runId, record);
    const promise = this.execute(runId, input, controller.signal);
    record.promise = promise;
    void promise.then((summary) => {
      detachSignal();
      record.status = "completed";
      record.summary = summary;
    }).catch((error: unknown) => {
      detachSignal();
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
    return this.loadRunSummary(runId);
  }

  async status(runId: string): Promise<LocalRunStatus> {
    const safeRunId = validateRunId(runId);
    const record = this.records.get(safeRunId);
    if (record) {
      if (record.status === "running") {
        try { record.summary = await this.loadRunSummary(safeRunId); } catch { /* run has not written its initial summary yet */ }
      }
      return this.toStatus(record);
    }
    try {
      const summary = await this.loadRunSummary(safeRunId);
      return {
        runId: safeRunId,
        status: summary.status === "completed" ? "completed" : "running",
        verdict: summary.verdict,
        summary,
        report: this.reportPath(safeRunId),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Run not found: ${safeRunId}`);
    }
  }

  async evidenceFor(runId: string, section: "summary" | "events" | "report" = "summary", maxChars = 20_000): Promise<{ runId: string; section: string; content: string; truncated: boolean }> {
    const safeRunId = validateRunId(runId);
    await this.loadRunSummary(safeRunId);
    const path = section === "summary"
      ? resolve(this.evidenceDir, safeRunId, "run.json")
      : section === "events"
        ? resolve(this.evidenceDir, safeRunId, "events.jsonl")
        : resolve(this.evidenceDir, safeRunId, "report.html");
    const content = await readFile(path, "utf8");
    return { runId: safeRunId, section, content: content.slice(0, maxChars), truncated: content.length > maxChars };
  }

  async replay(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath"> = {}): Promise<LocalRunStatus> {
    const previous = await this.loadRunSummary(validateRunId(runId));
    return this.start({ ...input, charter: previous.charter });
  }

  private async execute(runId: string, input: LocalRunInput, signal: AbortSignal): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(await this.resolveCharter(input));
    if (this.restrictWebOrigins && charter.sideEffectPolicy === "allow" && this.config.policies.sideEffects !== "allow") {
      throw new Error("MCP interactive runs require sideEffects=allow in project config");
    }
    this.validateWebOrigins(charter, input);
    this.validateCdpEndpoint(input);
    this.validateMobileEndpoint(input);
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
    const setup: IntegrationSetup | undefined = input.start !== false && this.config.project.start ? async ({ emit, signal: setupSignal }) => {
      const runtime = new ProjectRuntime({
        root: this.root,
        config: this.config,
        onEvent: (event) => void emit({ timestamp: new Date().toISOString(), type: "adapter.event", payload: { source: "project-runtime", ...event } }),
      });
      try {
        await runtime.start(setupSignal);
      } catch (error) {
        await runtime.stop();
        throw error;
      }
      return () => runtime.stop();
    } : undefined;
    const integrationSetup = this.integration?.setup;
    return new ExecutionRunner(adapter, {
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      evidenceDir: this.evidenceDir,
      oracles: [...configured, ...oracles],
      capabilities: this.capabilities,
      environment: this.config.policies.environment,
      allowCapabilityWrites: this.allowCapabilityWrites,
      preflight: this.integration?.preflight,
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
    if (input.charterPath) return loadCharter(resolveWithinWorkspace(this.workspaceRoot, input.charterPath));
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

  private async loadRunSummary(runId: string): Promise<RunSummary> {
    const summary = await this.evidence.loadSummary(validateRunId(runId));
    if (summary.projectRoot && !sameProjectPath(summary.projectRoot, this.root)) throw new Error("Run belongs to another project");
    if (summary.workspaceRoot && !sameProjectPath(summary.workspaceRoot, this.workspaceRoot)) throw new Error("Run belongs to another workspace");
    if ((!summary.projectRoot || !summary.workspaceRoot) && !sameProjectPath(this.root, this.workspaceRoot)) throw new Error("Run has no project/workspace binding");
    return summary;
  }

  private async ensureWorkspace(): Promise<void> {
    await initProject(this.root, { workspaceRoot: this.workspaceRoot });
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
    if ((input.adapter ?? "web") === "mobile") {
      const mobile = this.config.surfaces.mobile;
      return new MobileAdapter({
        serverUrl: input.mobileServer ?? mobile?.serverUrl ?? "http://127.0.0.1:4723",
        capabilities: {
          ...mobile?.capabilities,
          ...(mobile?.platformName ? { platformName: mobile.platformName } : {}),
          ...(mobile?.deviceName ? { "appium:deviceName": mobile.deviceName } : {}),
          ...(mobile?.automationName ? { "appium:automationName": mobile.automationName } : {}),
          ...(mobile?.app ? { "appium:app": mobile.app } : {}),
          ...(mobile?.appPackage ? { "appium:appPackage": mobile.appPackage } : {}),
          ...(mobile?.appActivity ? { "appium:appActivity": mobile.appActivity } : {}),
          ...(mobile?.noReset !== undefined ? { "appium:noReset": mobile.noReset } : {}),
        },
      });
    }
    if ((input.adapter ?? "web") !== "web") throw new Error(`Unsupported adapter: ${input.adapter}`);
    return new WebAdapter({
      baseUrl: input.url ?? this.config.surfaces.web?.baseUrl,
      cdpUrl: input.cdp ?? this.config.surfaces.web?.cdpUrl,
      headless: !input.headful,
      executablePath: this.config.surfaces.web?.executablePath,
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
    const cdp = input.cdp ?? (input.adapter === "electron" ? this.config.surfaces.electron?.cdpUrl : this.config.surfaces.web?.cdpUrl);
    if (cdp && !isLoopback(new URL(cdp).hostname)) {
      throw new Error("CDP endpoint must use loopback in MCP runs");
    }
  }

  private validateMobileEndpoint(input: LocalRunInput): void {
    if (!this.restrictWebOrigins || input.adapter !== "mobile") return;
    const serverUrl = input.mobileServer ?? this.config.surfaces.mobile?.serverUrl;
    if (serverUrl && !isLoopback(new URL(serverUrl).hostname)) {
      throw new Error("Mobile WebDriver endpoint must use loopback in MCP runs");
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

function summarizeAgentStep(step: TestMission["agentSteps"][number]): MissionAgentStepSummary {
  return {
    agentStepId: step.agentStepId,
    sequence: step.sequence,
    taskId: step.taskId,
    charterId: step.charterId,
    phase: step.phase,
    tool: step.tool,
    decision: step.decision,
    status: step.status,
    startedAt: step.startedAt,
    ...(step.endedAt ? { endedAt: step.endedAt } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    toolCallIds: step.toolCallIds,
    observationIds: step.observationIds,
    evidence: step.evidence,
    ...(step.error ? { error: step.error } : {}),
  };
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
  return runId;
}

function validateMissionId(missionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(missionId)) throw new Error("Invalid mission id");
  return missionId;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Persist only declared route patterns; concrete URL paths may contain private IDs. */
function matchedWebRouteTargets(summary: RunSummary, targets: RouteCoverageTarget[]): string[] {
  const paths = new Set<string>();
  for (const step of summary.steps) {
    for (const value of [step.beforeSnapshot?.url, step.receipt?.urlBefore, step.receipt?.urlAfter, step.afterSnapshot?.url]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.hash.startsWith("#/")) paths.add(url.hash.slice(1).split(/[?#]/, 1)[0]!);
        else if (url.protocol === "http:" || url.protocol === "https:") paths.add(url.pathname);
      } catch { /* A malformed adapter URL is not route coverage evidence. */ }
    }
  }
  return [...new Set(targets.filter((target) => target.kind === "web" && [...paths].some((path) => routeMatches(target.path, path))).map((target) => target.path))].sort();
}

function routeMatches(declared: string, observed: string): boolean {
  const expected = declared.split("/");
  const actual = observed.split("/");
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index]);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
