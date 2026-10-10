import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeRun, InMemoryMissionToolRegistry, MissionAgent, MissionAlreadyRunningError, type MissionTool, type MissionToolResult } from "@proofkit/agent";
import { ElectronAdapter, MobileAdapter, WebAdapter } from "@proofkit/adapters";
import { createRunId, EvidenceStore, MissionReportStore, sha256 } from "@proofkit/evidence";
import type { EnvironmentInspection, EnvironmentInspectionInput } from "@proofkit/contracts";
import { SurfaceReadinessSchema, type SurfaceReadiness } from "@proofkit/contracts";
import { inspectEnvironment } from "./environment.js";
import { FailureBoundarySchema, FindingSchema, hasPositiveSurfaceAssertion, NegativeCaseSchema, ObservationSchema, SourceStateSchema, suiteChecks, TargetBindingSchema, TestCharterSchema, TestLevelSelectionSchema, TestScopeInputSchema, TestSuiteSchema, workflowChecks, type EvidenceRef, type MissionComparison, type MissionEvidenceIntegrity, type MissionProofClassification, type NegativeCase, type ProofkitConfig, type ProjectMap, type RouteCoverageTarget, type RunMode, type RunSummary, type SideEffectPolicy, type SourceState, type SurfaceSnapshot, type TargetBinding, type TestCharter, type TestLevel, type TestMission, type TestScope, type TestScopeInput, type TestSuite, type Verdict, type WorkflowInventory } from "@proofkit/contracts";
import { configuredHttpOracle, httpOracle } from "@proofkit/oracles";
import { assessPlanningCoverage, assessPlanningQuality, withPlanningCoverage, getTestLevelProfile, IntentPlanner, OpenAICompatiblePlannerProvider, requiredCatalogSurfaces, resolveTestLevel, selectCatalogCharter, selectCatalogSuite, supportsCatalogCharter, StructuredPlanner, loadCharter, type PlanOptions, type PlannerProvider } from "@proofkit/planner";
import { captureSourceState, initProject, inspectTargetBinding, inspectWorkflowInventory, loadConfigForContext, resolveProjectContext, resolveWithinWorkspace, sameProjectPath, scanProject, verifySourceLocationHints } from "@proofkit/project";
import { BlockedError, CancelledError, ExecutionRunner, z, type BusinessOracle, type CapabilityDefinition, type IntegrationSetup, type ProjectIntegration, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";
import { loadProjectIntegration } from "./integration.js";
import { compareMissionRecords } from "./mission-comparison.js";
import { hasCompleteCleanupEvidence } from "./cleanup-evidence.js";
import { ProjectMissionStore } from "./mission-store.js";
import { summarizeSuiteScope, verifySuiteMission, type SuiteScopeSummary } from "./suite-verifier.js";
import { summarizeWorkflowExecution } from "./workflow-coverage.js";
import { inspectTestScope } from "./test-scope.js";
import { projectMissionResult } from "./mission-result.js";
import type { MissionResult } from "@proofkit/contracts";
import { ResourceRecoveryService } from "./resource-recovery.js";
import { captureRunEvidence } from "./run-evidence.js";
import { auditMissionProofClassification } from "./mission-proof-classification.js";

export { loadProjectIntegration } from "./integration.js";

export type LocalAdapterName = "web" | "electron" | "mobile";

const SURFACE_CANCELLATION_GRACE_MS = 10_000;

export type LocalRunInput = {
  signal?: AbortSignal;
  /** Internal replay association used to validate fixture identity against saved Run facts. */
  replayOfRunId?: string;
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

export type SurfaceInspectionInput = Pick<LocalRunInput, "adapter" | "url" | "cdp" | "devtoolsPortFile" | "headful" | "signal"> & {
  readyWhen?: { text: string; timeoutMs?: number };
};
export type SurfaceInspection = {
  inspectionId: string;
  surface: "web" | "electron";
  status: "observed" | "failed" | "blocked" | "cancelled";
  /** Inspection records what was visible; it does not assert product success. */
  testVerdict: "not-asserted";
  snapshot?: SurfaceSnapshot;
  targetBinding?: TargetBinding;
  runtimeHealth?: RunSummary["runtimeHealth"];
  readiness: { status: "not-requested" | "observed" | "unverified"; condition?: SurfaceReadiness };
  runtimeFindings: NonNullable<RunSummary["runtimeFindings"]>;
  runtimeFindingsOmitted: number;
  findings: string[];
  evidence: EvidenceRef[];
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
  coverage?: PlanOptions["coverage"];
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
  private readonly missionReports: MissionReportStore;
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
    this.missionReports = new MissionReportStore(this.workspaceRoot, this.evidenceDir);
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

  async inspectRunResources(runId: string) {
    return this.resourceRecovery().inspect(runId);
  }

  async recoverRunResources(runId: string) {
    return this.resourceRecovery().recover(runId);
  }

  private resourceRecovery(): ResourceRecoveryService {
    return new ResourceRecoveryService({ projectRoot: this.root, workspaceRoot: this.workspaceRoot,
      evidenceDir: this.evidenceDir, config: this.config, integration: this.integration, allowWrites: this.allowCapabilityWrites });
  }

  async inspectTestScope(input: TestScopeInput = {}): Promise<TestScope> {
    const request = TestScopeInputSchema.parse(input);
    const focus = request.focus?.normalize("NFKC").toLowerCase();
    const matches = (...values: Array<string | undefined>) => Boolean(focus && values.some((value) => value?.normalize("NFKC").toLowerCase().includes(focus)));
    const routeTargets = this.config.charters.filter((entry) => supportsCatalogCharter(entry, request.level, request.surface)
      && matches(entry.id, entry.path, ...entry.aliases, ...(entry.routeTargets ?? []).flatMap((target) => [target.path, target.source])))
      .flatMap((entry) => entry.routeTargets ?? []);
    const [sourceState, project] = await Promise.all([
      request.includeSourceState ? captureSourceState(this.root) : Promise.resolve(undefined),
      focus ? scanProject(this.root, { focus, routeTargets }) : this.discover(),
    ]);
    const workflowInventory = await inspectWorkflowInventory(this.root, this.workspaceRoot, this.config, sourceState, project);
    return inspectTestScope({
      project, workspaceRoot: this.workspaceRoot, config: this.config,
      sourceState,
      workflowInventory: workflowInventory.inspection,
      integration: this.integration, capabilities: this.capabilities, oracles: this.oracles,
      allowCapabilityWrites: this.allowCapabilityWrites,
      checkCharter: async (entry) => {
        const charter = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, entry.path));
        if (charter.level !== entry.level) throw new Error(`Test catalog entry ${entry.id} declares ${entry.level}, but its Charter is ${charter.level}`);
        const surfaces = requiredCatalogSurfaces(request.level, request.surface);
        for (const surface of surfaces) this.validateCatalogCharter(entry.id, charter, surface);
        if (charter.planning?.evidenceGaps.length) throw new Error(`Saved planning evidence gaps: ${charter.planning.evidenceGaps.join(", ")}`);
      },
      checkSuite: async (entry) => {
        const suite = await this.loadSuite(entry);
        const gaps = suite.charters.flatMap((item) => item.charter.planning?.evidenceGaps ?? []);
        if (gaps.length) throw new Error(`Saved suite planning evidence gaps: ${gaps.join(", ")}`);
      },
    }, request);
  }

  async inspectEnvironment(input: EnvironmentInspectionInput = {}, signal?: AbortSignal): Promise<EnvironmentInspection & { artifact: { path: string; sha256: string } }> {
    const inspection = await inspectEnvironment({ root: this.root, workspaceRoot: this.workspaceRoot, config: this.config, restrictWebOrigins: this.restrictWebOrigins }, input, `environment-${createRunId()}`, signal);
    signal?.throwIfAborted();
    const candidate = `.proofkit/inspections/${inspection.inspectionId}.json`;
    await mkdir(dirname(resolveWithinWorkspace(this.workspaceRoot, candidate)), { recursive: true });
    const path = resolveWithinWorkspace(this.workspaceRoot, candidate);
    const content = `${JSON.stringify(inspection, null, 2)}\n`;
    await writeFile(path, content, "utf8");
    return { ...inspection, artifact: { path, sha256: sha256(content) } };
  }

  async inspectSurface(input: SurfaceInspectionInput = {}): Promise<SurfaceInspection> {
    const surface = input.adapter ?? "web";
    if (surface === "mobile") throw new Error("Surface inspection currently supports Web and Electron; mobile inspection needs device-backed semantics");
    if (surface === "web" && !(input.url || input.cdp || this.config.surfaces.web?.baseUrl || this.config.surfaces.web?.cdpUrl)) {
      throw new Error("Web inspection needs a configured baseUrl, CDP endpoint, or explicit URL");
    }
    const configuredReadiness = input.readyWhen ?? this.config.surfaces[surface]?.readyWhen;
    const readyWhen = configuredReadiness === undefined ? undefined : SurfaceReadinessSchema.parse(configuredReadiness);
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error("Surface inspection exceeded 30 seconds")), 30_000);
    try {
      const charter = TestCharterSchema.parse({
        intent: `Inspect the current ${surface} surface`, level: "quick", mode: "deterministic",
        actions: [...(readyWhen ? [{ kind: "waitForText", ...readyWhen }] : []), { kind: "observe" }], assertions: [], sideEffectPolicy: "deny",
        metadata: { purpose: "surface-inspection" },
      });
      const started = await this.start({ ...input, adapter: surface, charter, start: false, signal: controller.signal });
      const summary = await this.wait(started.runId);
      const observation = summary.steps.find((step) => step.action.kind === "observe");
      const observed = observation?.status === "passed" ? observation.afterSnapshot : undefined;
      const stopped = summary.verdict === "blocked" || summary.verdict === "cancelled" ? summary.verdict : undefined;
      const readinessObserved = Boolean(!stopped && observed && summary.steps.find((step) => step.action.kind === "waitForText")?.status === "passed");
      const runtimeFindings = summary.runtimeFindings ?? [];
      return {
        inspectionId: summary.runId,
        surface,
        status: stopped ?? (observed ? "observed" : "failed"),
        testVerdict: "not-asserted",
        ...(observed ? { snapshot: { ...observed, text: observed.text?.slice(0, 2_000) } } : {}),
        ...(summary.targetBinding ? { targetBinding: summary.targetBinding } : {}),
        runtimeHealth: summary.runtimeHealth,
        readiness: readyWhen ? { status: readinessObserved ? "observed" : "unverified", condition: readyWhen } : { status: "not-requested" },
        runtimeFindings: runtimeFindings.slice(0, 10).map((finding) => ({ ...finding, message: finding.message.slice(0, 2_000) })),
        runtimeFindingsOmitted: Math.max(0, runtimeFindings.length - 10),
        findings: summary.findings.filter((finding) => finding !== "No executable assertion or business oracle was declared.").slice(0, 10),
        evidence: this.runEvidence(summary),
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
    }
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
    if (input.charter && hasAdHocOptions) throw new Error("A submitted Charter cannot be combined with ad-hoc planning options");
    if (input.charterId && hasAdHocOptions) throw new Error("charterId cannot be combined with ad-hoc planning options");
    if (input.suiteId && hasAdHocOptions) throw new Error("suiteId cannot be combined with ad-hoc planning options");
    const projectRequested = assessPlanningCoverage(input.intent, undefined, input.coverage).requested === "project";
    const selectedSuite = input.charter || input.charterId || (hasAdHocOptions && !input.suiteId) || (projectRequested && !input.suiteId)
      ? undefined
      : selectCatalogSuite(this.config.suites, { intent: input.intent, level: levelSelection.resolved, surface, suiteId: input.suiteId });
    const preliminarySelected = input.charter || selectedSuite || (projectRequested && !input.charterId) ? undefined : !hasAdHocOptions || input.charterId
      ? selectCatalogCharter(this.config.charters, { intent: input.intent, level: levelSelection.resolved, surface, charterId: input.charterId })
      : undefined;
    const projectMap = projectRequested || input.charter || preliminarySelected || selectedSuite ? await this.discover() : undefined;
    const coverage = assessPlanningCoverage(input.intent, projectMap, input.coverage);
    const workflowInventory = coverage.requested === "project"
      ? await inspectWorkflowInventory(this.root, this.workspaceRoot, this.config, undefined, projectMap)
      : undefined;
    const inspection = workflowInventory?.inspection;
    const inventory = workflowInventory?.inventory;
    const projectSuite = levelSelection.resolved !== "quick" && !input.suiteId && !input.charter && !input.charterId && !hasAdHocOptions && inventory
      && inspection?.status === "loaded" && inspection.sourceMatch === "matching"
      && inspection.missingCharterIds.length === 0 && inspection.uncoveredSurfaces.length === 0 && inspection.missingSourcePaths.length === 0
      && inventory.workflows.flatMap(workflowChecks).every(({ charterId }) => this.config.charters.some((entry) => entry.id === charterId && entry.level === levelSelection.resolved))
      ? await this.loadWorkflowSuite(inventory, levelSelection.resolved)
      : undefined;
    if (selectedSuite && !input.suiteId && !projectSuite) {
      const competingCharter = selectCatalogCharter(this.config.charters, { intent: input.intent, level: levelSelection.resolved, surface });
      if (competingCharter) throw new Error(`Intent matches suite ${selectedSuite.entry.id} and Charter ${competingCharter.entry.id}; specify suiteId or charterId`);
    }
    const selected = projectSuite ? undefined : preliminarySelected ?? (projectRequested && !selectedSuite && !hasAdHocOptions
      ? selectCatalogCharter(this.config.charters, { intent: input.intent, level: levelSelection.resolved, surface, charterId: input.charterId }) : undefined);
    if (projectSuite || selectedSuite) {
      const suite = projectSuite ?? await this.loadSuite(selectedSuite!.entry);
      suite.charters = suite.charters.map((item) => ({ ...item,
        charter: TestCharterSchema.parse({ ...item.charter, planning: withPlanningCoverage(item.charter.planning, coverage) }),
      }));
      const sideEffectPolicy: SideEffectPolicy = suite.charters.some((item) => item.charter.sideEffectPolicy === "allow")
        ? "allow" : suite.charters.some((item) => item.charter.sideEffectPolicy === "confirm") ? "confirm" : "deny";
      if (input.policy?.sideEffectPolicy && input.policy.sideEffectPolicy !== sideEffectPolicy) {
        throw new Error("Mission policy side effects must match the selected suite");
      }
      const expectedRuns = suiteChecks(suite).reduce((count, item) => count + (suite.level === "release" ? 2 : 1) + (item.charter.negativeCases?.length ?? 0), 0);
      const timeoutMs = input.policy?.timeoutMs ?? Math.min(3_600_000, Math.max(300_000, expectedRuns * this.config.run.timeoutMs));
      await this.ensureWorkspace();
      return this.missionAgent.create({
        intent: input.intent,
        projectRoot: this.root,
        workspaceRoot: this.workspaceRoot,
        surface: suite.surfaces.includes(surface) ? surface : suite.surfaces[0]!,
        suite,
        workflowInventory: workflowInventory?.inventory,
        workflowInventoryInspection: workflowInventory?.inspection,
        levelSelection,
        policy: { ...input.policy, level: suite.level, sideEffectPolicy, timeoutMs },
      });
    }
    let charter: TestCharter;
    if (input.charter) {
      const submitted = TestCharterSchema.parse(input.charter);
      charter = this.restrictWebOrigins
        ? TestCharterSchema.parse({
          ...submitted,
          planning: assessPlanningQuality(submitted, {
            projectMap,
            constraints: {
              level: levelSelection.resolved,
              url: this.config.surfaces.web?.baseUrl,
              requireAssertions: true,
              requireBusinessOracle: getTestLevelProfile(levelSelection.resolved).evidencePolicy.requireBusinessOracle,
              coverage: input.coverage,
            },
            source: "submitted",
            coverageIntent: input.intent,
          }),
        })
        : submitted;
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
        coverage: input.coverage,
      });
    }
    if (charter.level !== levelSelection.resolved) {
      throw new Error(`Charter level ${charter.level} does not match requested level ${levelSelection.resolved}`);
    }
    const normalizedCharter = TestCharterSchema.parse({ ...charter,
      levelSelection: charter.levelSelection ?? levelSelection,
      ...(projectMap ? { planning: withPlanningCoverage(charter.planning, coverage) } : {}),
    });
    if (selected) this.validateCatalogCharter(selected.entry.id, normalizedCharter, surface);
    else if (input.charter && this.restrictWebOrigins) this.validateMissionCharterSafety("Submitted Charter", normalizedCharter, surface);
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
      workflowInventory: workflowInventory?.inventory,
      workflowInventoryInspection: workflowInventory?.inspection,
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

  private async loadWorkflowSuite(inventory: WorkflowInventory, level: "core" | "release"): Promise<TestSuite> {
    const catalog = new Map(this.config.charters.map((entry) => [entry.id, entry]));
    const surfacesByCharter = new Map<string, Set<LocalAdapterName>>();
    for (const workflow of inventory.workflows) {
      for (const check of workflowChecks(workflow)) {
        const surfaces = surfacesByCharter.get(check.charterId) ?? new Set<LocalAdapterName>();
        for (const surface of check.surfaces) surfaces.add(surface);
        surfacesByCharter.set(check.charterId, surfaces);
      }
    }
    const charters: TestSuite["charters"] = [];
    for (const [charterId, surfaces] of surfacesByCharter) {
      const entry = catalog.get(charterId);
      if (!entry || entry.level !== level) throw new Error(`Workflow Charter ${charterId} is not registered at ${level} level`);
      const saved = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, entry.path));
      if (saved.level !== level) throw new Error(`Workflow Charter ${charterId} has a mismatched saved level`);
      const charter = TestCharterSchema.parse({ ...saved, metadata: { ...saved.metadata, catalogId: charterId, suiteId: "project-workflows" } });
      for (const surface of surfaces) this.validateCatalogCharter(charterId, charter, surface);
      charters.push({ charterId, charter, surfaces: [...surfaces], routeTargets: entry.routeTargets ?? [] });
    }
    const included = new Set(surfacesByCharter.keys());
    const uncoveredCharterIds = this.config.charters.filter((entry) => entry.level === level && !included.has(entry.id)).map((entry) => entry.id);
    return TestSuiteSchema.parse({
      suiteId: "project-workflows", origin: "workflow-inventory", level,
      surfaces: [...new Set(inventory.workflows.flatMap((workflow) => workflow.surfaces))],
      charters, uncoveredCharterIds,
    });
  }

  private validateCatalogCharter(id: string, charter: TestCharter, surface: LocalAdapterName): void {
    if (!hasPositiveSurfaceAssertion(charter.assertions)) throw new Error(`Test catalog entry ${id} needs a positive surface assertion before it can run`);
    if (getTestLevelProfile(charter.level).evidencePolicy.requireBusinessOracle && !charter.oracles?.length) {
      throw new Error(`Test catalog entry ${id} needs an independent business Oracle for ${charter.level}`);
    }
    this.validateMissionCharterSafety(`Test catalog entry ${id}`, charter, surface);
  }

  private validateMissionCharterSafety(label: string, charter: TestCharter, surface: LocalAdapterName): void {
    const availableOracles = new Set([...this.oracles.map((oracle) => oracle.name), ...this.config.oracles.map((oracle) => oracle.name)]);
    for (const oracle of [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((item) => item.oracles)]) {
      if (!availableOracles.has(oracle)) throw new Error(`${label} references an unregistered Oracle: ${oracle}`);
      const configured = this.config.oracles.find((item) => item.name === oracle);
      if (this.restrictWebOrigins && configured && !isLoopback(new URL(configured.url).hostname)) {
        throw new Error(`${label} requires a loopback Oracle in MCP mode: ${oracle}`);
      }
    }
    const availableCapabilities = new Map(this.capabilities.map((capability) => [capability.name, capability]));
    const scenarios = [{ actions: charter.actions, sideEffectPolicy: charter.sideEffectPolicy }, ...(charter.negativeCases ?? [])];
    for (const scenario of scenarios) {
      for (const action of scenario.actions) {
        if (this.restrictWebOrigins && (action.kind === "click" || action.kind === "fill" || action.kind === "press" || action.kind === "setInputFiles" || action.kind === "captureResponse") && scenario.sideEffectPolicy !== "allow") {
          throw new Error(`${label} interactive action ${action.kind} requires sideEffectPolicy=allow`);
        }
        if (action.kind !== "capability") continue;
        const capability = availableCapabilities.get(action.name);
        if (!capability) throw new Error(`${label} references an unregistered capability: ${action.name}`);
        if (capability.sideEffect === "write" && scenario.sideEffectPolicy !== "allow") {
          throw new Error(`${label} must allow write capability ${action.name} in its scenario`);
        }
      }
    }
    if (this.restrictWebOrigins && scenarios.some((scenario) => scenario.sideEffectPolicy === "allow") && this.config.policies.sideEffects !== "allow") {
      throw new Error(`${label} requires policies.sideEffects=allow in the test workspace`);
    }
    this.validateWebOrigins(charter, { adapter: surface });
    for (const negativeCase of charter.negativeCases ?? []) {
      this.validateWebOrigins({ ...charter, actions: negativeCase.actions }, { adapter: surface });
    }
    this.validateCdpEndpoint({ adapter: surface });
    this.validateMobileEndpoint({ adapter: surface });
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
      return { mission, running: await this.missionAgent.isRunning(current.missionId) };
    }
    const controller = new AbortController();
    const promise = this.runOrJoinMission(current.missionId, options, controller.signal);
    this.missionRecords.set(current.missionId, { controller, promise });
    // Attach both fulfillment and rejection handlers so a rejected mission does
    // not create an unhandled Promise rejection while the record is cleaned up.
    void promise.then(
      () => this.missionRecords.delete(current.missionId),
      () => this.missionRecords.delete(current.missionId),
    );
    const mission = await this.missionAgent.load(current.missionId);
    return { mission, running: await this.missionAgent.isRunning(current.missionId) };
  }

  private async runOrJoinMission(missionId: string, options: { approve?: boolean }, signal: AbortSignal): Promise<TestMission> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await this.missionAgent.run(missionId, { approve: options.approve, signal });
      } catch (error) {
        if (!(error instanceof MissionAlreadyRunningError)) throw error;
        const settled = await this.missionAgent.waitUntilIdle(missionId);
        if (signal.aborted || ["completed", "failed", "blocked", "cancelled"].includes(settled.status)) return settled;
        // A previous owner can exit after approval or midway through a task.
        // Retry under a fresh OS lease; the Agent's recovery policy decides
        // whether any interrupted task is safe to repeat.
      }
    }
    throw new Error(`Mission ${missionId} changed execution owner too many times`);
  }

  async waitMission(missionId: string): Promise<TestMission> {
    const safeMissionId = validateMissionId(missionId);
    const record = this.missionRecords.get(safeMissionId);
    if (record) return record.promise;
    return this.missionAgent.waitUntilIdle(safeMissionId);
  }

  async missionStatus(missionId: string): Promise<MissionStatus> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    return { mission, running: await this.missionAgent.isRunning(mission.missionId) };
  }

  async cancelMission(missionId: string, reason = "Mission cancelled by user"): Promise<MissionStatus> {
    const safeMissionId = validateMissionId(missionId);
    const record = this.missionRecords.get(safeMissionId);
    if (record) record.controller.abort(new CancelledError(reason));
    const accepted = await this.missionAgent.cancel(safeMissionId, reason);
    if (!record && !accepted) return this.missionStatus(safeMissionId);
    return { mission: await this.waitMission(safeMissionId), running: false };
  }

  async missionEvidence(missionId: string): Promise<{
    missionId: string;
    replayOfMissionId?: string;
    projectRoot: string;
    workspaceRoot: string;
    status: TestMission["status"];
    running: boolean;
    verdict?: TestMission["verdict"];
    level: TestMission["level"];
    levelSelection?: TestMission["levelSelection"];
    planning?: TestMission["plan"]["planning"];
    workflowInventoryInspection?: TestMission["workflowInventoryInspection"];
    workflowExecution?: import("@proofkit/contracts").WorkflowExecutionCoverage;
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
    targetBindings: Array<{ runId: string; surface: string; binding: TargetBinding }>;
    sourceState?: SourceState;
    finalSourceState?: SourceState;
    comparison?: MissionComparison;
    comparisonUnavailable?: string;
    evidenceIntegrity: MissionEvidenceIntegrity;
    proofClassification: MissionProofClassification;
    summary: MissionResult;
    report?: string;
    reportUnavailable?: string;
  }> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    const sourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state")?.data);
    const finalSourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state-final")?.data);
    let comparison: MissionComparison | undefined;
    let comparisonUnavailable: string | undefined;
    if (mission.replayOfMissionId && ["completed", "failed", "blocked", "cancelled"].includes(mission.status)) {
      try {
        comparison = await this.compareMissions(mission.replayOfMissionId, mission.missionId);
      } catch {
        comparisonUnavailable = "The replay source Mission could not be loaded or compared in this workspace.";
      }
    }
    const running = await this.missionAgent.isRunning(mission.missionId);
    const suiteScope = summarizeSuiteScope(mission, this.evidenceDir);
    const workflowExecution = summarizeWorkflowExecution(mission, suiteScope);
    const proofClassification = await auditMissionProofClassification(mission, (runId) => this.loadRunSummary(runId));
    let summary = projectMissionResult(mission, { workspaceRoot: this.workspaceRoot, running, suiteScope, workflowExecution, comparison, comparisonUnavailable, proofClassification });
    let report: string | undefined;
    let reportUnavailable: string | undefined;
    let evidenceIntegrity: MissionEvidenceIntegrity;
    try {
      const snapshot = await this.missionReports.writeReportSnapshot(summary);
      report = snapshot.path;
      summary = snapshot.result;
      evidenceIntegrity = snapshot.integrity;
    } catch {
      // Evidence remains readable when the workspace is read-only or a report
      // path escapes its ownership boundary. Rendering never changes a verdict.
      reportUnavailable = "The Mission report could not be written inside this test workspace.";
      evidenceIntegrity = await this.missionReports.inspectIntegrity(summary);
      summary = { ...summary, evidenceIntegrity };
    }
    return {
      missionId: mission.missionId,
      replayOfMissionId: mission.replayOfMissionId,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      status: mission.status,
      running,
      verdict: mission.verdict,
      level: mission.level,
      levelSelection: mission.levelSelection,
      planning: mission.plan.planning,
      workflowInventoryInspection: mission.workflowInventoryInspection,
      workflowExecution,
      executionProfile: mission.plan.executionProfile,
      suiteScope,
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
      targetBindings: mission.observations.flatMap((observation) => {
        if (observation.kind !== "surface.run" || typeof observation.data.runId !== "string" || typeof observation.data.surface !== "string") return [];
        const binding = TargetBindingSchema.safeParse(observation.data.targetBinding);
        return binding.success ? [{ runId: observation.data.runId, surface: observation.data.surface, binding: binding.data }] : [];
      }),
      ...(sourceState.success ? { sourceState: sourceState.data } : {}),
      ...(finalSourceState.success ? { finalSourceState: finalSourceState.data } : {}),
      ...(comparison ? { comparison } : {}),
      ...(comparisonUnavailable ? { comparisonUnavailable } : {}),
      evidenceIntegrity,
      proofClassification,
      summary,
      ...(report ? { report } : {}),
      ...(reportUnavailable ? { reportUnavailable } : {}),
    };
  }

  async compareMissions(baselineMissionId: string, candidateMissionId: string): Promise<MissionComparison> {
    const [baseline, candidate] = await Promise.all([
      this.missionAgent.load(validateMissionId(baselineMissionId)),
      this.missionAgent.load(validateMissionId(candidateMissionId)),
    ]);
    return compareMissionRecords(baseline, candidate, this.evidenceDir, (runId) => this.wait(runId));
  }

  async replayMission(missionId: string): Promise<MissionStatus> {
    const previous = await this.missionAgent.load(validateMissionId(missionId));
    if (!["completed", "failed", "blocked", "cancelled"].includes(previous.status)) {
      throw new Error("Only a terminal Mission can be replayed");
    }
    await this.ensureWorkspace();
    const replay = await this.missionAgent.create({
      replayOfMissionId: previous.missionId,
      intent: previous.intent,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      surface: previous.surface,
      charter: previous.charter,
      suite: previous.suite,
      workflowInventory: previous.workflowInventory,
      workflowInventoryInspection: previous.workflowInventoryInspection,
      levelSelection: previous.levelSelection,
      policy: { ...previous.policy, requireApproval: false },
    });
    return this.startMission(replay.missionId, { approve: true });
  }

  private createMissionTools(): MissionTool[] {
    type MissionToolContext = Parameters<NonNullable<MissionTool["execute"]>>[1];
    type SurfaceRunKind = "primary" | "replay" | "negative";

    const discover = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      const [project, sourceState] = await Promise.all([this.discover(), captureSourceState(this.root)]);
      const observation = ObservationSchema.parse({
        observationId: `${context.task.taskId}-${Date.now()}`,
        source: "planner",
        kind: "project.discovered",
        data: project,
        observedAt: new Date().toISOString(),
      });
      const revisionObservation = ObservationSchema.parse({
        observationId: `source-state-${context.task.taskId}-${Date.now()}`,
        source: "planner",
        kind: "project.source-state",
        data: sourceState,
        observedAt: sourceState.capturedAt,
      });
      return { output: project, observations: [observation, revisionObservation] };
    };
    const inspect = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.surface === "api" || context.mission.surface === "mobile") {
        throw new Error("Surface inspection currently supports Web and Electron");
      }
      const result = await this.inspectSurface({ adapter: context.mission.surface, signal: context.signal });
      const observation = ObservationSchema.parse({
        observationId: `surface-inspection-${context.task.taskId}-${Date.now()}`,
        source: "surface",
        kind: "surface.inspected",
        data: { inspectionId: result.inspectionId, surface: result.surface, status: result.status,
          controlCount: result.snapshot?.controls?.length ?? 0, controlsTruncated: result.snapshot?.controlsTruncated ?? false },
        observedAt: result.snapshot?.capturedAt ?? new Date().toISOString(),
      });
      return { output: result, observations: [observation], evidence: result.evidence };
    };

    const collectSurfaceRun = async (summary: RunSummary, context: MissionToolContext, adapter: LocalAdapterName, runKind: SurfaceRunKind, sourceRunId?: string, negativeCaseId?: string, expectedVerdict?: Verdict, charterId?: string): Promise<MissionToolResult> => {
      if (context.mission.suite && summary.charter.metadata.catalogId !== charterId) {
        throw new Error(`Run ${summary.runId} returned evidence for a different Charter`);
      }
      const actualVerdict = summary.verdict ?? "inconclusive";
      // A stop before a file step leaves no per-step mismatch flag. Such a
      // replay still cannot certify an expected negative outcome: its input
      // identity was never checked against the baseline.
      const replayInputMismatch = summary.steps.some((step) => step.replayInputMatched === false)
        || (sourceRunId !== undefined && summary.charter.actions.some((action, index) => action.kind === "setInputFiles"
          && summary.steps.find((step) => step.stepId === `step-${String(index + 1).padStart(3, "0")}`)?.replayInputMatched !== true));
      const responseFactsMissing = summary.charter.actions.some((action, index) => action.kind === "captureResponse"
        && !summary.steps.find((step) => step.stepId === `step-${String(index + 1).padStart(3, "0")}`)?.response);
      const evidence = this.runEvidence(summary);
      const cleanupIncomplete = !hasCompleteCleanupEvidence(summary.integrationCleanup, summary.runId, evidence, this.evidenceDir);
      const outcomeMatched = expectedVerdict === undefined ? undefined : !cleanupIncomplete && !replayInputMismatch && !responseFactsMissing && actualVerdict === expectedVerdict;
      const effectiveVerdict: Verdict = cleanupIncomplete && actualVerdict === "passed" ? "blocked" : expectedVerdict === undefined
        ? actualVerdict
        : outcomeMatched ? "passed" : actualVerdict === "passed" ? "failed" : actualVerdict;
      const routeTargets = context.mission.suite?.charters.find((item) => item.charterId === charterId)?.routeTargets ?? [];
      const apiTraffic = await this.matchedApiRouteTargets(summary.runId, adapter, routeTargets);
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
          passedOracles: summary.oracles.filter((item) => item.verificationKind !== "http-contract" && item.passed === true).length,
          runtimeHealth: summary.runtimeHealth ?? "passed",
          runtimeFindingCount: (summary.runtimeFindings ?? []).length,
          runtimeFindings: (summary.runtimeFindings ?? []).slice(0, 20).map((finding) => ({
            kind: finding.kind,
            severity: finding.severity,
            status: finding.status,
            message: finding.message,
            ...(finding.url ? { url: finding.url } : {}),
            ...(finding.statusCode !== undefined ? { statusCode: finding.statusCode } : {}),
            ...(finding.consoleLevel ? { consoleLevel: finding.consoleLevel } : {}),
          })),
          targetBinding: summary.targetBinding,
          integrationCleanup: summary.integrationCleanup,
          businessEvidence: summary.oracles.reduce((count, oracle) => count + (oracle.verificationKind !== "http-contract" && (oracle.sourceEvidenceArtifacts ?? []).some((path) =>
            evidence.some((item) => item.kind === "business" && item.evidenceId === `${summary.runId}:${path}`))
            ? oracle.sourceEvidenceCount ?? 0 : 0), 0),
          matchedRoutePaths: matchedWebRouteTargets(summary, routeTargets),
          matchedApiTargets: apiTraffic.matched,
          networkLogAvailable: apiTraffic.available,
        },
        evidence,
        observedAt: new Date().toISOString(),
      });
      // A negative case may intentionally expect a failed or blocked surface
      // run. Do not turn that expected outcome into a product finding; retain
      // the raw run verdict in the observation and report the normalized
      // scenario verdict to the Mission Agent.
      const expectedFailureOutcome = runKind === "negative" && expectedVerdict !== undefined && expectedVerdict !== "passed";
      const failedOracle = summary.oracles.find((oracle) => oracle.verificationKind !== "http-contract" && oracle.passed === false);
      const verifiedSourceLocations = expectedFailureOutcome || outcomeMatched === true || !failedOracle
        ? [] : await verifySourceLocationHints(this.root, failedOracle.sourceLocations ?? []);
      const analysis = expectedFailureOutcome ? {} : outcomeMatched === true ? {} : analyzeRun({ summary, evidence, verifiedSourceLocations });
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
              message: cleanupIncomplete ? "Test resource cleanup was not established; the expected negative outcome cannot certify this failure."
                : responseFactsMissing ? "A declared action response was not observed; the expected negative outcome cannot certify missing response evidence."
                : replayInputMismatch ? "Replay input files were missing, changed or unverified; the expected negative outcome cannot validate different test inputs."
                : `Expected ${expectedVerdict}, but the surface run ended with ${actualVerdict}.`,
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
      if (cleanupIncomplete) findings.push(FindingSchema.parse({
        findingId: `cleanup-${summary.runId}`, charterId, surface: adapter, severity: "high", category: "environment",
        status: "confirmed", title: "Test resource cleanup was not established",
        message: "Cleanup failed or lacks scoped readback evidence. Resources may still be active; an expected negative verdict cannot certify this failure.",
        evidence: summary.integrationCleanup?.artifact ? evidence.filter((item) => item.evidenceId === `${summary.runId}:${summary.integrationCleanup!.artifact}`) : evidence.slice(0, 2),
        createdAt: summary.endedAt ?? summary.startedAt,
      }));
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

    const fileReplaySource = async (charter: TestCharter, context: MissionToolContext, adapter: LocalAdapterName,
      charterId?: string, negativeCaseId?: string): Promise<string | undefined> => {
      if (!context.mission.replayOfMissionId || !charter.actions.some((action) => action.kind === "setInputFiles")) return undefined;
      const baseline = await this.missionAgent.load(context.mission.replayOfMissionId);
      const sources = baseline.observations.filter((item) => item.kind === "surface.run" && item.data.surface === adapter
        && item.charterId === charterId && (negativeCaseId
          ? item.data.runKind === "negative" && item.data.negativeCaseId === negativeCaseId
          : item.data.runKind === "primary" || item.data.runKind === undefined));
      if (sources.length !== 1 || typeof sources[0]?.data.runId !== "string") {
        throw new BlockedError("File replay requires a unique matching baseline Run");
      }
      return sources[0].data.runId;
    };

    const runCharter = async (input: { charter?: TestCharter; charterId?: string; adapter?: LocalAdapterName }, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite && context.task.charterId !== input.charterId) throw new Error("Suite task Charter ID does not match its input");
      const charter = context.mission.suite
        ? context.mission.suite.charters.find((item) => item.charterId === input.charterId)?.charter
        : input.charter ?? context.mission.charter;
      if (!charter) throw new Error("Mission has no Test Charter to execute");
      const charterId = context.mission.suite ? input.charterId : typeof charter.metadata.catalogId === "string" ? charter.metadata.catalogId : undefined;
      const adapter = input.adapter ?? (context.mission.surface === "electron" ? "electron" : "web");
      const baselineRunId = await fileReplaySource(charter, context, adapter, charterId);
      const started = await this.start({ charter, adapter, signal: context.signal, replayOfRunId: baselineRunId });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "primary", baselineRunId, undefined, undefined, charterId);
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
      const baselineRunId = await fileReplaySource(charter, context, adapter, charterId, negativeCase.caseId);
      const started = await this.start({ charter, adapter, signal: context.signal, replayOfRunId: baselineRunId });
      const summary = await this.wait(started.runId);
      return collectSurfaceRun(summary, context, adapter, "negative", baselineRunId, negativeCase.caseId, negativeCase.expectedVerdict ?? "passed", charterId);
    };

    const verifyOutcome = async (_input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      if (context.mission.suite) {
        return verifySuiteMission(context.mission, this.evidenceDir);
      }
      const runs = context.mission.observations.filter((item) => item.kind === "surface.run");
      if (runs.length === 0) throw new Error("No surface run observation is available for verification");
      const executionProfile = context.mission.plan.executionProfile;
      const expectedSurfaces = executionProfile.surfaceMatrix;
      const missing: string[] = [];
      if (!hasPositiveSurfaceAssertion(context.mission.charter?.assertions ?? [])) missing.push("至少一个正向表面断言");
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
      const planningGaps = context.mission.plan.planning?.evidenceGaps ?? [];
      if (planningGaps.length > 0) {
        missing.push(`规划阶段存在证据缺口：${planningGaps.join("、")}`);
      }
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
      const cleanupIncomplete = expectedRuns.some((item) => !hasCompleteCleanupEvidence(item.data.integrationCleanup,
        String(item.data.runId), item.evidence, this.evidenceDir));
      const failed = expectedRuns.some((item) => item.data.outcomeMatched !== true
        && (item.data.verdict === "failed" || item.data.verdict === "blocked" || item.data.verdict === "cancelled"));
      const inconclusive = expectedRuns.some((item) => item.data.outcomeMatched !== true && item.data.verdict === "inconclusive");
      const verdict = cleanupIncomplete ? "blocked" : failed ? "failed" : inconclusive ? "inconclusive" : "passed";
      return { output: { verified: verdict === "passed", runVerdict: verdict, surfaces: expectedSurfaces }, verdict };
    };
    const verify = async (input: Record<string, never>, context: MissionToolContext): Promise<MissionToolResult> => {
      const result = await verifyOutcome(input, context);
      const sourceState = await captureSourceState(this.root);
      const observation = ObservationSchema.parse({
        observationId: `source-state-final-${context.task.taskId}-${Date.now()}`,
        source: "planner",
        kind: "project.source-state-final",
        data: sourceState,
        observedAt: sourceState.capturedAt,
      });
      return { ...result, observations: [...(result.observations ?? []), observation] };
    };
    return [
      { name: "project.discover", description: "Inspect the local project without modifying it.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.inspect", description: "Inspect the configured Web or Electron surface without declaring a product verdict.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: 40_000, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({}), execute: inspect },
      { name: "surface.run-charter", description: "Run a validated charter through the existing deterministic runner and collect evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charter: TestCharterSchema.optional(), charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runCharter },
      { name: "surface.replay-charter", description: "Replay the preceding surface run using the saved charter and preserve a second evidence trail.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: replayCharter },
      { name: "surface.run-negative-charter", description: "Run an explicitly declared negative or recovery Charter and collect independent evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), negativeCase: NegativeCaseSchema, adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runNegativeCharter },
      { name: "mission.verify", description: "Verify the terminal verdict and evidence completeness of the preceding run.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: verify },
    ];
  }

  private runEvidence(summary: RunSummary): EvidenceRef[] {
    return captureRunEvidence(summary, this.evidenceDir);
  }

  private async matchedApiRouteTargets(runId: string, adapter: LocalAdapterName, targets: RouteCoverageTarget[]): Promise<{
    matched: Extract<RouteCoverageTarget, { kind: "api" }>[];
    available: boolean;
  }> {
    const path = resolve(this.evidenceDir, runId, "events.jsonl");
    if (!existsSync(path)) return { matched: [], available: false };
    const apiTargets = targets.filter((target): target is Extract<RouteCoverageTarget, { kind: "api" }> => target.kind === "api");
    if (apiTargets.length === 0) return { matched: [], available: true };
    const matched = new Map<string, Extract<RouteCoverageTarget, { kind: "api" }>>();
    try {
      for await (const event of this.evidence.readEvents(runId)) {
        const payload = event.payload;
        if (event.type !== "adapter.event" || payload.adapter !== adapter || payload.eventType !== "response") continue;
        if (typeof payload.url !== "string" || typeof payload.method !== "string" || typeof payload.status !== "number") continue;
        if (payload.status < 200 || payload.status >= 300) continue;
        let responseUrl: URL;
        try { responseUrl = new URL(payload.url); } catch { continue; }
        for (const target of apiTargets) {
          if (responseUrl.origin !== new URL(target.origin).origin || payload.method !== target.method || !routeMatches(target.path, responseUrl.pathname)) continue;
          matched.set(`${target.method}\0${target.origin}\0${target.path}`, target);
        }
      }
      return { matched: [...matched.values()], available: true };
    } catch {
      // A missing or malformed log cannot establish API coverage.
      return { matched: [], available: false };
    }
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
      coverage: options.coverage,
      requireAssertions: levelProfile.evidencePolicy.requireAssertions,
      requireBusinessOracle: levelProfile.evidencePolicy.requireBusinessOracle,
      allowedActionKinds: policy === "allow"
        ? ["goto", "click", "fill", "press", "setInputFiles", "captureResponse", "waitForText", "screenshot", "observe"]
        : ["goto", "waitForText", "screenshot", "observe"],
      allowedOracleNames: [...new Set([
        ...this.config.oracles.map((oracle) => oracle.name),
        ...this.oracles.map((oracle) => oracle.name),
      ])],
    };
    const provider = this.plannerProvider ?? this.createPlannerProvider();
    const projectMap = await this.discover();
    let charter: TestCharter;
    if (provider) {
      charter = await new StructuredPlanner(provider).plan({ intent, projectMap, constraints });
    } else {
      const draft = new IntentPlanner().plan(intent, constraints);
      charter = TestCharterSchema.parse({
        ...draft,
        planning: assessPlanningQuality(draft, { projectMap, constraints, source: "deterministic" }),
      });
    }
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
    return this.start({ ...input, charter: previous.charter, replayOfRunId: previous.runId });
  }

  private async execute(runId: string, input: LocalRunInput, signal: AbortSignal): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(await this.resolveCharter(input));
    const replaySource = input.replayOfRunId ? await this.loadRunSummary(validateRunId(input.replayOfRunId)) : undefined;
    const expectedInputFiles = replaySource ? Object.fromEntries(replaySource.charter.actions.flatMap((action, index) => {
      if (action.kind !== "setInputFiles") return [];
      const stepId = `step-${String(index + 1).padStart(3, "0")}`;
      return [[stepId, replaySource.steps.find((step) => step.stepId === stepId)?.inputFiles ?? []]];
    })) : undefined;
    if (this.restrictWebOrigins) this.validateMissionCharterSafety("MCP Charter", charter, input.adapter ?? "web");
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
    const surface = input.adapter ?? "web";
    const targetUrl = charter.actions.find((action) => action.kind === "goto")?.url
      ?? input.url
      ?? (surface === "electron" ? this.config.surfaces.electron?.targetUrlPrefix : this.config.surfaces.web?.baseUrl);
    return new ExecutionRunner(adapter, {
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      evidenceDir: this.evidenceDir,
      oracles: [...configured, ...oracles],
      capabilities: this.capabilities,
      environment: this.config.policies.environment,
      allowCapabilityWrites: this.allowCapabilityWrites,
      allowSetupWrites: this.allowCapabilityWrites && this.config.policies.sideEffects === "allow",
      allowFileUploads: this.config.policies.sideEffects === "allow",
      expectedInputFiles,
      preflight: this.integration?.preflight,
      signal,
      timeoutMs: this.config.run.timeoutMs,
      runtimeQuality: this.config.policies.runtime,
      ...(surface === "web" || surface === "electron" ? {
        targetBinding: (bindingSignal: AbortSignal) => inspectTargetBinding(this.root, targetUrl, bindingSignal),
        targetBindingPolicy: this.config.policies.targetBinding,
        targetBindingRecheckAfterSetup: Boolean(input.start !== false && this.config.project.start),
      } : {}),
      integration: this.integration ? { name: this.integration.name, version: this.integration.version } : undefined,
      setup: [
        ...(integrationSetup ? [{ setup: integrationSetup, policy: this.integration?.setupPolicy }] : []),
        ...(setup ? [setup] : []),
      ],
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
        targetUrlPrefix: this.config.surfaces.electron?.targetUrlPrefix,
        targetTitleContains: this.config.surfaces.electron?.targetTitleContains,
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
      targetUrlPrefix: this.config.surfaces.web?.targetUrlPrefix,
      targetTitleContains: this.config.surfaces.web?.targetTitleContains,
      headless: !input.headful,
      executablePath: this.config.surfaces.web?.executablePath,
    });
  }

  private validateWebOrigins(charter: TestCharter, input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const configuredOrigin = this.config.surfaces.web?.baseUrl
      ? new URL(this.config.surfaces.web.baseUrl).origin
      : undefined;
    const urls = [input.url, ...charter.actions.flatMap((action) => action.kind === "goto" ? [action.url]
      : action.kind === "captureResponse" ? [action.response.url] : [])];
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
