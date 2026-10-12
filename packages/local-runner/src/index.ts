import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeRun, selectEvidencedBusinessFailure, InMemoryMissionToolRegistry, MissionAgent, MissionAlreadyRunningError, type MissionTool, type MissionToolResult } from "@proofkit/agent";
import { ElectronAdapter, MobileAdapter, WebAdapter, resolveElectronCdpUrl } from "@proofkit/adapters";
import { auditMissionVerdict, createRunId, EvidenceStore, LocalExecutionOwnership, MissionReportStore, sha256, type LocalExecutionLease } from "@proofkit/evidence";
import type { EnvironmentInspection, EnvironmentInspectionInput, IntegrationReadiness } from "@proofkit/contracts";
import { SurfaceReadinessSchema, type SurfaceReadiness } from "@proofkit/contracts";
import { inspectEnvironment } from "./environment.js";
import { FailureBoundarySchema, FindingSchema, hasPositiveSurfaceAssertion, IntegrationReadinessInputSchema, IntegrationReadinessSchema, NegativeCaseSchema, ObservationSchema, SourceStateSchema, suiteChecks, TargetBindingSchema, TestCharterSchema, TestLevelSelectionSchema, TestScopeInputSchema, TestSuiteSchema, workflowChecks, type EvidenceRef, type MissionAcceptanceIntegrity, type MissionComparison, type MissionEvidenceIntegrity, type MissionProofClassification, type MissionRecoveryInspection, type NegativeCase, type ProofkitConfig, type ProjectMap, type RouteCoverageTarget, type RunMode, type RunSummary, type SideEffectPolicy, type SourceState, type SurfaceSnapshot, type TargetBinding, type TestCharter, type TestLevel, type TestMission, type TestScope, type TestScopeInput, type TestSuite, type Verdict, type WorkflowInventory } from "@proofkit/contracts";
import { configuredHttpOracle, httpOracle } from "@proofkit/oracles";
import { assessPlanningCoverage, assessPlanningQuality, withPlanningCoverage, getTestLevelProfile, intentTestLevelHints, IntentPlanner, OpenAICompatiblePlannerProvider, requiredCatalogSurfaces, resolveTestLevel, selectCatalogCharter, selectCatalogSuite, supportsCatalogCharter, StructuredPlanner, loadCharter, type PlanOptions, type PlannerProvider } from "@proofkit/planner";
import { captureSourceState, initProject, inspectTargetBinding, inspectWorkflowInventory, loadConfigForContext, resolveProjectContext, resolveWithinWorkspace, sameProjectPath, scanProject, verifySourceLocationHints } from "@proofkit/project";
import { BlockedError, CancelledError, ExecutionRunner, z, type BusinessOracle, type CapabilityDefinition, type IntegrationPreflight, type IntegrationSetup, type ProjectIntegration, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";
import { loadProjectIntegration } from "./integration.js";
import { readinessCredentialValues, sanitizeReadinessCheck } from "./integration-readiness.js";
import { auditComparisonCurrentSource, compareMissionRecords } from "./mission-comparison.js";
import { analyzeMissionStability as analyzeMissionStabilityRecords } from "./mission-stability.js";
import { MissionRepeatSeriesService } from "./mission-repeat-series.js";
import { hasCompleteCleanupEvidence } from "./cleanup-evidence.js";
import { ProjectMissionStore } from "./mission-store.js";
import { summarizeSuiteScope, verifySuiteMission, type SuiteScopeSummary } from "./suite-verifier.js";
import { summarizeWorkflowExecution } from "./workflow-coverage.js";
import { admitReviewedWorkflowScope, auditWorkflowReview } from "./workflow-review-audit.js";
import { inspectTestScope } from "./test-scope.js";
import { firstInlineOracleIssue, isAllowedMcpWebUrl, isLoopbackHost } from "./inline-oracle-validation.js";
import { readWorkspaceCharterFile } from "./workspace-charter-file.js";
import { compareCurrentSource, projectMissionResult } from "./mission-result.js";
import type { MissionResult, MissionRepeatSeriesStatus, MissionStabilityAnalysis } from "@proofkit/contracts";
import { ResourceRecoveryService } from "./resource-recovery.js";
import { captureRunEvidence, materializedRunArtifact } from "./run-evidence.js";
import { auditMissionProofClassification } from "./mission-proof-classification.js";
import { auditMissionExecution, auditMissionRunFacts } from "./mission-execution-audit.js";
import { auditMissionAgentTrace } from "./mission-agent-trace-audit.js";
import { negativeOutcomeProofGap } from "./negative-outcome.js";
import { acquireCdpTarget, acquireElectronPortFileScope, acquireExecutionScope, sharedTargetIdentity } from "./execution-scope.js";
import { sourceBindingTarget } from "./source-binding-target.js";
import { assertMissionSurfaceCoverage, selectMissionSurface } from "./mission-surface.js";

export { loadProjectIntegration } from "./integration.js";
export { inspectEvidenceRetention, type EvidenceRetentionAudit, type EvidenceRetentionRow } from "./evidence-retention.js";

export type LocalAdapterName = "web" | "electron" | "mobile";

const SURFACE_CANCELLATION_GRACE_MS = 10_000;

export type LocalRunInput = {
  signal?: AbortSignal;
  /** Internal replay association used to validate fixture identity against saved Run facts. */
  replayOfRunId?: string;
  /** Internal catalog declarations projected into safe route snapshot facts. */
  coverageRouteTargets?: RouteCoverageTarget[];
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

export type SurfaceInspectionInput = Pick<LocalRunInput, "adapter" | "url" | "cdp" | "devtoolsPortFile" | "mobileServer" | "headful" | "signal"> & {
  readyWhen?: { text: string; timeoutMs?: number };
};
export type SurfaceInspection = {
  inspectionId: string;
  surface: "web" | "electron" | "mobile";
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
  /** Direct external-workspace candidate, pinned to the digest returned by scope inspection. */
  charterPath?: string;
  charterSha256?: string;
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
  private readonly missionRecoveryKey?: string;
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
    // Direct injected operations have no portable implementation version. A
    // workspace connector must declare one before its interrupted tasks can
    // be retried in a new process.
    const versionedIntegration = !this.integration || (typeof this.integration.version === "string" && this.integration.version.trim().length > 0);
    if (versionedIntegration && !options.oracles?.length && !options.capabilities?.length) {
      this.missionRecoveryKey = `local-runner-v1:${sha256(JSON.stringify({
        projectRoot: this.root, workspaceRoot: this.workspaceRoot, evidenceDir: this.evidenceDir,
        config: this.config, integration: this.integration ? { name: this.integration.name, version: this.integration.version } : null,
        restrictWebOrigins: this.restrictWebOrigins, allowCapabilityWrites: this.allowCapabilityWrites,
      }))}`;
    }
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
      allowCapabilityWrites: this.allowCapabilityWrites, restrictWebOrigins: this.restrictWebOrigins,
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

  async inspectIntegrationReadiness(input: { charterId: string }, signal?: AbortSignal): Promise<IntegrationReadiness> {
    signal?.throwIfAborted();
    const request = IntegrationReadinessInputSchema.parse(input);
    const entry = this.config.charters.find((charter) => charter.id === request.charterId);
    if (!entry) throw new Error(`Unknown Charter: ${request.charterId}`);
    const charter = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, entry.path));
    if (charter.level !== entry.level) throw new Error(`Test catalog entry ${entry.id} declares ${entry.level}, but its Charter is ${charter.level}`);
    const base = {
      schemaVersion: 1 as const,
      testVerdict: "not-asserted" as const,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      charterId: entry.id,
      level: entry.level,
      surfaces: entry.surfaces,
      environment: this.config.policies.environment,
      checkedAt: new Date().toISOString(),
    };
    if (!this.integration?.readiness) return IntegrationReadinessSchema.parse({
      ...base, status: "unavailable", integration: this.integration ? { name: this.integration.name, version: this.integration.version } : undefined,
      next: ["Configure a connector that declares a read-only readiness check before running this Charter."],
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const deadline = setTimeout(() => controller.abort(new Error("Connector readiness exceeded 15 seconds")), 15_000);
    let removeAbortListener = () => {};
    try {
      const credentials = readinessCredentialValues();
      const operation = this.integration.readiness({
        charter, environment: this.config.policies.environment, projectRoot: this.root,
        workspaceRoot: this.workspaceRoot, signal: controller.signal,
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error("Connector readiness cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", rejectAbort);
        if (controller.signal.aborted) rejectAbort();
      });
      const checked = sanitizeReadinessCheck(await Promise.race([operation, aborted]), [...credentials, ...readinessCredentialValues()]);
      return IntegrationReadinessSchema.parse({
        ...base, status: checked.passed ? "ready" : "blocked",
        integration: { name: this.integration.name, version: this.integration.version },
        check: checked,
        next: checked.passed ? ["Review the Charter, then create or start a Mission."] : ["Resolve the reported connector prerequisites, then inspect readiness again."],
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return IntegrationReadinessSchema.parse({
        ...base, status: "unavailable", integration: { name: this.integration.name, version: this.integration.version },
        next: ["The connector readiness check did not return a verified result; inspect trusted local connector diagnostics."],
      });
    } finally {
      clearTimeout(deadline);
      removeAbortListener();
      signal?.removeEventListener("abort", onAbort);
    }
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
      const readinessObserved = Boolean(observed && summary.steps.find((step) => step.action.kind === "waitForText")?.status === "passed");
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
    if (input.charterPath !== undefined) {
      if (input.surface === "api") throw new Error("Mission surface is not enabled by the local runner: api");
      if (!input.charterSha256) throw new Error("Candidate Charter path requires the SHA-256 returned by scope inspection");
      if (input.charter || input.charterId || input.suiteId) throw new Error("Candidate Charter path cannot be combined with a submitted Charter or catalog selection");
      if (input.url || input.expect?.length || input.oracleNames?.length || input.mode || input.sideEffectPolicy) {
        throw new Error("Candidate Charter path cannot be combined with ad-hoc planning options");
      }
      // Let the shared candidate reader reject redirected files consistently
      // before resolving the path for catalog identity comparison.
      const loaded = await readWorkspaceCharterFile(this.workspaceRoot, input.charterPath, input.charterSha256);
      const selectedPath = resolveWithinWorkspace(this.workspaceRoot, input.charterPath);
      if (this.config.charters.some((entry) => {
        try { return sameProjectPath(resolveWithinWorkspace(this.workspaceRoot, entry.path), selectedPath); }
        catch { return false; }
      })) {
        throw new Error("Candidate Charter is already registered; select its charterId instead");
      }
      const requestedLevel = resolveTestLevel(input.intent, input.level).resolved;
      if (loaded.charter.level !== requestedLevel) {
        throw new Error(`Candidate Charter level ${loaded.charter.level} does not match requested level ${requestedLevel}`);
      }
      const requestedSurface = selectMissionSurface(input.intent, input.surface ?? input.adapter);
      const requiredSurfaces = requiredCatalogSurfaces(requestedLevel, requestedSurface);
      if (!loaded.charter.surfaces) throw new Error("Candidate Charter must declare its supported surfaces before Mission creation");
      if (!requiredSurfaces.every((surface) => loaded.charter.surfaces?.includes(surface))) {
        throw new Error(`Candidate Charter does not support the requested ${requiredSurfaces.join(" + ")} surface matrix`);
      }
      return this.createMission({ ...input, level: requestedLevel, charterPath: undefined, charterSha256: undefined,
        charter: TestCharterSchema.parse({ ...loaded.charter, metadata: { ...loaded.charter.metadata,
          proofkitCandidate: { path: input.charterPath, sha256: loaded.sha256 } } }),
      });
    }
    if (input.charterSha256 !== undefined) throw new Error("Candidate Charter SHA-256 requires charterPath");
    if (input.surface === "api") throw new Error(`Mission surface is not enabled by the local runner: ${input.surface}`);
    const surface = selectMissionSurface(input.intent, input.surface ?? input.adapter);
    if (input.charter && input.charterId) throw new Error("Supply either a Charter or charterId, not both");
    if (input.suiteId && (input.charter || input.charterId)) throw new Error("Supply either suiteId or a Charter, not both");
    const catalogLevel = input.charterId ? this.config.charters.find((entry) => entry.id === input.charterId)?.level : undefined;
    const suppliedLevel = input.level ?? input.charter?.level ?? catalogLevel ?? (input.suiteId ? "release" : undefined);
    const intentLevels = intentTestLevelHints(input.intent);
    if (suppliedLevel && intentLevels.length === 1 && intentLevels[0] !== suppliedLevel) {
      throw new Error(`Test level conflict: intent indicates ${intentLevels[0]} but supplied selection is ${suppliedLevel}; align the request and test selection`);
    }
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
    const projectSuite = !input.suiteId && !input.charter && !input.charterId && !hasAdHocOptions && inventory
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
      assertMissionSurfaceCoverage(input.intent, suiteChecks(suite).map((check) => check.surface));
      const workflowReviewAdmission = projectSuite && projectMap && workflowInventory?.reviewSnapshot
        ? await admitReviewedWorkflowScope({ level: suite.level, projectRoot: this.root, workspaceRoot: this.workspaceRoot,
          workflowInventory: inventory, workflowInventoryInspection: inspection,
          workflowReview: workflowInventory.reviewSnapshot, suite, projectMap })
        : undefined;
      const plannedCoverage = workflowReviewAdmission
        ? { ...coverage, gaps: coverage.gaps.filter((gap) => gap !== "project-workflow-coverage") }
        : coverage;
      suite.charters = suite.charters.map((item) => {
        const planning = withPlanningCoverage(item.charter.planning, plannedCoverage);
        return { ...item, charter: TestCharterSchema.parse({ ...item.charter, planning: workflowReviewAdmission
          ? { ...planning, missingInputs: planning.missingInputs.filter((value) =>
            value !== "全项目业务流程清单与可度量的执行覆盖证明"),
            evidenceGaps: planning.evidenceGaps.filter((value) => value !== "project-workflow-coverage") }
          : planning }) };
      });
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
        workflowReview: workflowInventory?.reviewSnapshot,
        workflowReviewAdmission,
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
    if (charter.surfaces && !requiredCatalogSurfaces(levelSelection.resolved, surface).every((required) => charter.surfaces?.includes(required))) {
      throw new Error(`Charter does not support the requested ${requiredCatalogSurfaces(levelSelection.resolved, surface).join(" + ")} surface matrix`);
    }
    const normalizedCharter = TestCharterSchema.parse({ ...charter,
      levelSelection: charter.levelSelection ?? levelSelection,
      ...(projectMap ? { planning: withPlanningCoverage(charter.planning, coverage) } : {}),
    });
    if (normalizedCharter.httpOracles?.length) this.validateInlineHttpOracles("Submitted Charter", normalizedCharter);
    if (selected) this.validateCatalogCharter(selected.entry.id, normalizedCharter, surface);
    else if (input.charter && this.restrictWebOrigins) this.validateMissionCharterSafety("Submitted Charter", normalizedCharter, surface);
    assertMissionSurfaceCoverage(input.intent, requiredCatalogSurfaces(levelSelection.resolved, surface));
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
      workflowReview: workflowInventory?.reviewSnapshot,
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

  private async loadWorkflowSuite(inventory: WorkflowInventory, level: TestLevel): Promise<TestSuite> {
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
    this.validateInlineHttpOracles(label, charter);
    const availableOracles = new Set([...this.oracles.map((oracle) => oracle.name), ...this.config.oracles.map((oracle) => oracle.name),
      ...(charter.httpOracles ?? []).map((oracle) => oracle.name)]);
    for (const oracle of [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((item) => item.oracles)]) {
      if (!availableOracles.has(oracle)) throw new Error(`${label} references an unregistered Oracle: ${oracle}`);
      const configured = this.config.oracles.find((item) => item.name === oracle);
      if (this.restrictWebOrigins && configured && !isLoopback(new URL(configured.url).hostname)) {
        throw new Error(`${label} requires a loopback Oracle in MCP mode: ${oracle}`);
      }
      const inline = charter.httpOracles?.find((item) => item.name === oracle);
      if (this.restrictWebOrigins && inline && !isLoopback(new URL(inline.url).hostname)) {
        throw new Error(`${label} requires a loopback inline Oracle in MCP mode: ${oracle}`);
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

  private validateInlineHttpOracles(label: string, charter: TestCharter): void {
    const registered = new Set([...this.oracles.map((oracle) => oracle.name), ...this.config.oracles.map((oracle) => oracle.name)]);
    const issue = firstInlineOracleIssue(charter, registered, this.restrictWebOrigins);
    if (!issue) return;
    if (issue.code === "duplicate-name") throw new Error(`${label} has duplicate inline Oracle names`);
    if (issue.code === "registered-name-conflict") throw new Error(`${label} inline Oracle shadows a registered Oracle: ${issue.name}`);
    if (issue.code === "origin-disallowed") throw new Error(`${label} inline Oracle must use loopback in MCP mode: ${issue.name}`);
    if (issue.code === "binding-invalid") throw new Error(`${label} inline Oracle ${issue.name} must bind a captured field in ${issue.scenario}`);
    throw new Error(`${label} inline Oracle ${issue.name} needs a captured current ID in ${issue.scenario}`);
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

  async inspectMissionRecovery(missionId: string): Promise<MissionRecoveryInspection> {
    return this.missionAgent.inspectRecovery(validateMissionId(missionId));
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
    testVerdict: NonNullable<TestMission["verdict"]> | "not-asserted";
    testVerdictReason?: string;
    level: TestMission["level"];
    levelSelection?: TestMission["levelSelection"];
    planning?: TestMission["plan"]["planning"];
    workflowInventoryInspection?: TestMission["workflowInventoryInspection"];
    workflowExecution?: import("@proofkit/contracts").WorkflowExecutionCoverage;
    workflowReviewAudit?: import("@proofkit/contracts").WorkflowReviewAudit;
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
    diagnoses: TestMission["diagnoses"];
    repairSuggestions: TestMission["repairSuggestions"];
    targetBindings: Array<{ runId: string; surface: string; binding: TargetBinding }>;
    sourceStability: "stable" | "changed" | "unverified";
    sourceFreshness: "matching" | "changed" | "unavailable" | "unverified";
    sourceState?: SourceState;
    finalSourceState?: SourceState;
    currentSourceState?: SourceState;
    comparison?: MissionComparison;
    comparisonUnavailable?: string;
    evidenceIntegrity: MissionEvidenceIntegrity;
    diagnosticSupport: MissionEvidenceIntegrity["diagnosticSupport"];
    acceptanceEvidenceIntegrity: MissionAcceptanceIntegrity;
    proofClassification: MissionProofClassification;
    summary: MissionResult;
    report?: string;
    reportUnavailable?: string;
  }> {
    const mission = await this.missionAgent.load(validateMissionId(missionId));
    const sourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state")?.data);
    const finalSourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state-final")?.data);
    const running = await this.missionAgent.isRunning(mission.missionId);
    const suiteScope = summarizeSuiteScope(mission, this.evidenceDir);
    const workflowExecution = summarizeWorkflowExecution(mission, suiteScope);
    const workflowReviewAudit = await auditWorkflowReview(mission, workflowExecution, undefined, suiteScope?.routeCoverage);
    const runFacts = new Map<string, Promise<RunSummary>>();
    const loadAuditRun = (runId: string): Promise<RunSummary> => {
      let pending = runFacts.get(runId);
      if (!pending) { pending = this.loadRunSummary(runId); runFacts.set(runId, pending); }
      return pending;
    };
    const proofClassification = await auditMissionProofClassification(mission, loadAuditRun);
    const executionAudit = await auditMissionRunFacts(mission,
      auditMissionExecution(mission, this.evidenceDir, mission.verdict === "failed" ? "observed-failure" : "acceptance"), loadAuditRun);
    const agentTraceAudit = auditMissionAgentTrace(mission);
    const referencedRunIds = new Set(mission.observations.flatMap((item) => {
      const id = item.kind === "surface.run" ? item.data.runId
        : item.kind === "surface.inspected" ? item.data.inspectionId : undefined;
      return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id) ? [id] : [];
    }));
    // Diagnostic proposals are advisory claims. Audit their evidence in the
    // report, but do not let a proposal-only artifact withdraw an otherwise
    // evidenced product verdict.
    const acceptanceReferences = [
      ...mission.evidence,
      ...mission.agentSteps.flatMap((step) => step.evidence),
      ...mission.toolCalls.flatMap((call) => call.evidence),
      ...mission.observations.flatMap((observation) => observation.evidence),
      ...mission.findings.flatMap((finding) => finding.evidence),
      ...(mission.firstFailure?.evidence ?? []),
    ];
    const acceptanceEvidenceIntegrity = await this.missionReports.inspectMissionEvidence(acceptanceReferences, referencedRunIds);
    const currentSourceState = (mission.verdict === "passed" || mission.verdict === "failed")
      && finalSourceState.success && finalSourceState.data.complete && finalSourceState.data.method === "git"
      ? await captureSourceState(this.root) : undefined;
    const sourceFreshness = compareCurrentSource(finalSourceState.success ? finalSourceState.data : undefined, currentSourceState);
    let comparison: MissionComparison | undefined;
    let comparisonUnavailable: string | undefined;
    if (mission.replayOfMissionId && ["completed", "failed", "blocked", "cancelled"].includes(mission.status)) {
      try {
        comparison = await this.compareMissions(mission.replayOfMissionId, mission.missionId, currentSourceState);
      } catch {
        comparisonUnavailable = "The replay source Mission could not be loaded or compared in this workspace.";
      }
    }
    let summary: MissionResult = { ...projectMissionResult(mission, { workspaceRoot: this.workspaceRoot, running, suiteScope, workflowExecution, agentTraceAudit, workflowReviewAudit, comparison, comparisonUnavailable, proofClassification, executionAudit, sourceFreshness, currentSourceState }), acceptanceEvidenceIntegrity };
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
      summary = { ...summary, evidenceIntegrity, ...auditMissionVerdict(summary, evidenceIntegrity) };
    }
    const testVerdict = summary.testVerdict ?? "not-asserted";
    const testVerdictReason = summary.testVerdictReason;
    return {
      missionId: mission.missionId,
      replayOfMissionId: mission.replayOfMissionId,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      status: mission.status,
      running,
      verdict: mission.verdict,
      testVerdict,
      ...(testVerdictReason ? { testVerdictReason } : {}),
      level: mission.level,
      levelSelection: mission.levelSelection,
      planning: mission.plan.planning,
      workflowInventoryInspection: mission.workflowInventoryInspection,
      workflowExecution,
      workflowReviewAudit,
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
      diagnoses: mission.diagnoses.length ? mission.diagnoses : mission.diagnosis ? [mission.diagnosis] : [],
      repairSuggestions: mission.repairSuggestions,
      targetBindings: mission.observations.flatMap((observation) => {
        if (observation.kind !== "surface.run" || typeof observation.data.runId !== "string" || typeof observation.data.surface !== "string") return [];
        const binding = TargetBindingSchema.safeParse(observation.data.targetBinding);
        return binding.success ? [{ runId: observation.data.runId, surface: observation.data.surface, binding: binding.data }] : [];
      }),
      sourceStability: summary.scope.sourceStability ?? "unverified",
      sourceFreshness,
      ...(sourceState.success ? { sourceState: sourceState.data } : {}),
      ...(finalSourceState.success ? { finalSourceState: finalSourceState.data } : {}),
      ...(currentSourceState ? { currentSourceState } : {}),
      ...(comparison ? { comparison } : {}),
      ...(comparisonUnavailable ? { comparisonUnavailable } : {}),
      evidenceIntegrity,
      diagnosticSupport: evidenceIntegrity.diagnosticSupport,
      acceptanceEvidenceIntegrity,
      proofClassification,
      summary,
      ...(report ? { report } : {}),
      ...(reportUnavailable ? { reportUnavailable } : {}),
    };
  }

  async compareMissions(baselineMissionId: string, candidateMissionId: string, currentSourceState?: SourceState): Promise<MissionComparison> {
    const [baseline, candidate] = await Promise.all([
      this.missionAgent.load(validateMissionId(baselineMissionId)),
      this.missionAgent.load(validateMissionId(candidateMissionId)),
    ]);
    const savedComparison = await compareMissionRecords(baseline, candidate, this.evidenceDir, (runId) => this.wait(runId));
    const candidateFinal = SourceStateSchema.safeParse([...candidate.observations].reverse().find((item) => item.kind === "project.source-state-final")?.data);
    const finalSourceState = candidateFinal.success ? candidateFinal.data : undefined;
    const current = currentSourceState ?? ((candidate.verdict === "passed" || candidate.verdict === "failed")
      && finalSourceState?.complete && finalSourceState.method === "git" ? await captureSourceState(this.root) : undefined);
    return auditComparisonCurrentSource(savedComparison, finalSourceState, current);
  }

  async analyzeMissionStability(missionIds: string[]): Promise<MissionStabilityAnalysis> {
    if (missionIds.length < 3 || missionIds.length > 5) throw new Error("Stability analysis requires 3 to 5 ordered Missions");
    if (new Set(missionIds).size !== missionIds.length) throw new Error("Stability analysis requires distinct Missions");
    const samples = [];
    for (const id of missionIds) {
      const mission = await this.missionAgent.load(validateMissionId(id));
      const evidence = await this.missionEvidence(id);
      samples.push({ mission, result: evidence.summary, sourceState: evidence.sourceState, finalSourceState: evidence.finalSourceState });
    }
    return analyzeMissionStabilityRecords(samples, (runId) => this.loadRunSummary(runId));
  }

  async createMissionRepeatSeries(baselineMissionId: string, targetSamples: number): Promise<MissionRepeatSeriesStatus> {
    return new MissionRepeatSeriesService(this).create(validateMissionId(baselineMissionId), targetSamples);
  }

  async missionRepeatSeriesStatus(seriesId: string): Promise<MissionRepeatSeriesStatus> {
    return new MissionRepeatSeriesService(this).status(seriesId);
  }

  async advanceMissionRepeatSeries(seriesId: string, approve = false): Promise<MissionRepeatSeriesStatus> {
    return new MissionRepeatSeriesService(this).advance(seriesId, approve);
  }

  async driveMissionRepeatSeries(seriesId: string, approveNext = false): Promise<MissionRepeatSeriesStatus> {
    return new MissionRepeatSeriesService(this).drive(seriesId, approveNext);
  }

  async replayMission(missionId: string, options: { approve?: boolean; repeatSeries?: TestMission["repeatSeries"] } = {}): Promise<MissionStatus> {
    const previous = await this.missionAgent.load(validateMissionId(missionId));
    if (!["completed", "failed", "blocked", "cancelled"].includes(previous.status)) {
      throw new Error("Only a terminal Mission can be replayed");
    }
    await this.ensureWorkspace();
    const replayCharters = previous.charter ? [previous.charter] : previous.suite?.charters.map((item) => item.charter) ?? [];
    const scenarioRequiresApproval = replayCharters.some((charter) => charter.sideEffectPolicy !== "deny"
      || charter.negativeCases?.some((negativeCase) => negativeCase.sideEffectPolicy !== "deny"));
    let replay: TestMission;
    try {
      replay = await this.missionAgent.create({
      replayOfMissionId: previous.missionId,
      repeatSeries: options.repeatSeries,
      intent: previous.intent,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      surface: previous.surface,
      charter: previous.charter,
      suite: previous.suite,
      workflowInventory: previous.workflowInventory,
      workflowInventoryInspection: previous.workflowInventoryInspection,
      workflowReview: previous.workflowReview,
      workflowReviewAdmission: previous.workflowReviewAdmission,
      levelSelection: previous.levelSelection,
      // A prior approval covers one execution, not an unbounded series of
      // writes or UI interactions against the same test environment.
      policy: { ...previous.policy, requireApproval: previous.policy.requireApproval
        || previous.policy.sideEffectPolicy !== "deny" || scenarioRequiresApproval },
      });
    } catch (error) {
      if (!options.repeatSeries || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      replay = await this.missionAgent.load(`mission-${options.repeatSeries.seriesId}-${options.repeatSeries.ordinal}`);
      if (replay.replayOfMissionId !== previous.missionId
        || replay.repeatSeries?.seriesId !== options.repeatSeries.seriesId
        || replay.repeatSeries.ordinal !== options.repeatSeries.ordinal
        || !sameProjectPath(replay.projectRoot, this.root)
        || !sameProjectPath(replay.workspaceRoot ?? replay.projectRoot, this.workspaceRoot)) {
        throw new Error("Repeat-series Mission slot is occupied by another scope");
      }
    }
    if (replay.policy.requireApproval && options.approve !== true) return { mission: replay, running: false };
    return this.startMission(replay.missionId, { approve: options.approve === true });
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
      if (context.mission.surface === "api") {
        throw new Error("Surface inspection is unavailable for API-only Missions");
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
      const provenanceGap = summary.targetContinuity === "changed" || summary.targetContinuity === "unverified"
        || summary.applicationContinuity === "changed" || summary.applicationContinuity === "unverified"
        || summary.integrationPostRunCheck?.passed === false;
      const negativeProofGap = expectedVerdict === undefined ? undefined : negativeOutcomeProofGap(expectedVerdict, summary, evidence);
      const outcomeMatched = expectedVerdict === undefined ? undefined : !cleanupIncomplete && !replayInputMismatch
        && !responseFactsMissing && !negativeProofGap && actualVerdict === expectedVerdict;
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
          targetBindingAfterRun: summary.targetBindingAfterRun,
          targetContinuity: summary.targetContinuity,
          applicationBinding: summary.applicationBinding,
          applicationBindingAfterRun: summary.applicationBindingAfterRun,
          applicationContinuity: summary.applicationContinuity,
          integrationPostRunCheck: summary.integrationPostRunCheck,
          integrationCleanup: summary.integrationCleanup,
          businessEvidence: summary.oracles.reduce((count, oracle) => count + (oracle.verificationKind !== "http-contract" && (oracle.sourceEvidenceArtifacts ?? []).some((path) =>
            evidence.some((item) => item.kind === "business" && item.evidenceId === `${summary.runId}:${path}`))
            ? oracle.sourceEvidenceCount ?? 0 : 0), 0),
          matchedRoutePaths: matchedWebRouteTargets(summary, routeTargets, adapter === "electron" ? this.config.surfaces.electron?.targetUrlPrefix : undefined),
          matchedApiTargets: apiTraffic.matched,
          networkLogAvailable: apiTraffic.available,
        },
        evidence,
        observedAt: new Date().toISOString(),
      });
      // A negative case may intentionally expect a failed surface run.
      // Do not turn that expected outcome into a product finding; retain
      // the raw run verdict in the observation and report the normalized
      // scenario verdict to the Mission Agent.
      const expectedFailureOutcome = runKind === "negative" && expectedVerdict !== undefined && expectedVerdict !== "passed";
      const failedOracle = provenanceGap ? undefined : selectEvidencedBusinessFailure(summary, evidence);
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
              category: provenanceGap ? "environment" : "test",
              status: "confirmed",
              title: provenanceGap ? "Negative case environment continuity was not established" : "Negative case outcome did not match expectation",
              message: cleanupIncomplete ? "Test resource cleanup was not established; the expected negative outcome cannot certify this failure."
                : responseFactsMissing ? "A declared action response was not observed; the expected negative outcome cannot certify missing response evidence."
                : replayInputMismatch ? "Replay input files were missing, changed or unverified; the expected negative outcome cannot validate different test inputs."
                : negativeProofGap ?? `Expected ${expectedVerdict}, but the surface run ended with ${actualVerdict}.`,
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
      const coverageRouteTargets = context.mission.suite?.charters.find((item) => item.charterId === charterId)?.routeTargets ?? [];
      const started = await this.start({ charter, adapter, signal: context.signal, replayOfRunId: baselineRunId, coverageRouteTargets });
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
      const coverageRouteTargets = context.mission.suite?.charters.find((item) => item.charterId === charterId)?.routeTargets ?? [];
      const started = await this.replay(sourceRunId, { adapter, signal: context.signal, coverageRouteTargets });
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
      const executionAudit = auditMissionExecution(context.mission, this.evidenceDir, "verification");
      missing.push(...executionAudit.issues);
      if (executionAudit.omittedIssues) missing.push(`还有 ${executionAudit.omittedIssues} 个 Run 匹配问题`);
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
      const observedFailure = expectedRuns.some((item) => item.data.outcomeMatched !== true && item.data.verdict === "failed");
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
          verdict: observedFailure ? "failed" : "inconclusive",
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
    const tools: MissionTool[] = [
      { name: "project.discover", description: "Inspect the local project without modifying it.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
      { name: "surface.inspect", description: "Inspect the configured Web or Electron surface without declaring a product verdict.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: 40_000, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({}), execute: inspect },
      { name: "surface.run-charter", description: "Run a validated charter through the existing deterministic runner and collect evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charter: TestCharterSchema.optional(), charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runCharter },
      { name: "surface.replay-charter", description: "Replay the preceding surface run using the saved charter and preserve a second evidence trail.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: replayCharter },
      { name: "surface.run-negative-charter", description: "Run an explicitly declared negative or recovery Charter and collect independent evidence.", sideEffect: "read", environments: ["test", "staging", "local"], timeoutMs: this.config.run.timeoutMs, cancellationGraceMs: SURFACE_CANCELLATION_GRACE_MS, inputSchema: z.object({ charterId: z.string().optional(), negativeCase: NegativeCaseSchema, adapter: z.enum(["web", "electron", "mobile"]).optional() }), execute: runNegativeCharter },
      { name: "mission.verify", description: "Verify the terminal verdict and evidence completeness of the preceding run.", sideEffect: "none", environments: ["test", "staging", "local"], timeoutMs: 30_000, inputSchema: z.object({}), execute: verify },
    ];
    return tools.map((tool) => ({ ...tool, recoveryKey: this.missionRecoveryKey }));
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
        if (payload.urlPathEvidence === "redacted") continue;
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
    const sourceLease = input.replayOfRunId ? await this.acquireReplaySource(input.replayOfRunId) : undefined;
    try { return await this.startWithSourceLease(input, sourceLease); }
    catch (error) {
      await sourceLease?.release();
      throw error;
    }
  }

  private async startWithSourceLease(input: LocalRunInput, sourceLease?: LocalExecutionLease): Promise<LocalRunStatus> {
    if (input.replayOfRunId) {
      const source = await this.loadRunSummary(validateRunId(input.replayOfRunId));
      if (source.status !== "completed" || !source.endedAt) throw new Error("Replay source Run is not complete");
    }
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
    // A replay's source stays owned until the child Run has persisted its
    // source reference (or failed). wait() must not resolve before release.
    const promise = this.execute(runId, input, controller.signal).finally(async () => {
      await sourceLease?.release().catch(() => {});
    });
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

  private async acquireReplaySource(runId: string): Promise<LocalExecutionLease> {
    const lease = await new LocalExecutionOwnership(this.evidenceDir, "run").acquire(validateRunId(runId));
    if (!lease) throw new Error("Replay source Run is active or being recovered");
    return lease;
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

  /** Historical Run reports are evidence: return the saved file without rewriting it. */
  async savedRunReport(runId: string): Promise<string> {
    const safeRunId = validateRunId(runId);
    const lease = await new LocalExecutionOwnership(this.evidenceDir, "run").acquire(safeRunId);
    if (!lease) throw new Error("Run is active or being recovered; saved report is unavailable");
    try {
      const summary = await this.loadRunSummary(safeRunId);
      if (summary.status !== "completed" || !summary.endedAt) throw new Error("Run is not complete");
      const path = this.reportPath(safeRunId);
      const ref: EvidenceRef = { evidenceId: `${safeRunId}:report`, kind: "report", path, capturedAt: summary.endedAt };
      const materialized = materializedRunArtifact(ref, safeRunId, `${safeRunId}/report.html`, this.evidenceDir);
      if (!materialized) throw new Error("Saved Run report is unavailable or redirected");
      return materialized;
    } finally { await lease.release(); }
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
    const preview = await this.evidence.readPreview(safeRunId, section, maxChars);
    return { runId: safeRunId, section, ...preview };
  }

  async replay(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath"> = {}): Promise<LocalRunStatus> {
    await this.ensureWorkspace();
    const lease = await this.acquireReplaySource(runId);
    try {
      const previous = await this.loadRunSummary(validateRunId(runId));
      return await this.startWithSourceLease({ ...input, charter: previous.charter, replayOfRunId: previous.runId }, lease);
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private async execute(runId: string, input: LocalRunInput, signal: AbortSignal): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(await this.resolveCharter(input));
    const replaySource = input.replayOfRunId ? await this.loadRunSummary(validateRunId(input.replayOfRunId)) : undefined;
    const expectedInputFiles = replaySource ? Object.fromEntries(replaySource.charter.actions.flatMap((action, index) => {
      if (action.kind !== "setInputFiles") return [];
      const stepId = `step-${String(index + 1).padStart(3, "0")}`;
      return [[stepId, replaySource.steps.find((step) => step.stepId === stepId)?.inputFiles ?? []]];
    })) : undefined;
    this.validateInlineHttpOracles("Run Charter", charter);
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
      const definition = this.config.oracles.find((oracle) => oracle.name === name)
        ?? charter.httpOracles?.find((oracle) => oracle.name === name);
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
    const electronCdp = input.cdp ?? this.config.surfaces.electron?.cdpUrl;
    const electronPortFile = input.devtoolsPortFile ?? this.config.surfaces.electron?.devtoolsActivePort
      ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT;
    const resolveElectronPortFile = surface === "electron" && !electronCdp && electronPortFile
      && !/^(https?|wss?):\/\//i.test(electronPortFile);
    let preSetupCdpUrl: string | undefined;
    let pinnedCdpUrl: string | undefined;
    const targetUrl = charter.actions.find((action) => action.kind === "goto")?.url
      ?? input.url
      ?? (surface === "electron" ? this.config.surfaces.electron?.targetUrlPrefix : this.config.surfaces.web?.baseUrl);
    const healthOrigins = [...new Set(this.config.project.health.flatMap((check) => {
      try {
        const endpoint = new URL(typeof check === "string" ? check : check.url);
        return ["http:", "https:"].includes(endpoint.protocol) && isLoopback(endpoint.hostname) ? [endpoint.origin] : [];
      } catch { return []; }
    }))];
    const firstForeignHealth = async (bindingSignal: AbortSignal): Promise<TargetBinding | undefined> => {
      for (const origin of healthOrigins) {
        const binding = await inspectTargetBinding(this.root, origin, bindingSignal);
        if (binding.status === "different-project") return binding;
      }
      return undefined;
    };
    const healthResult = (foreign: TargetBinding | undefined, phase: "preflight" | "after-setup") => foreign
      ? { passed: this.config.policies.targetBinding !== "block-different",
        message: `A declared local health listener belongs to another Git checkout ${phase === "after-setup" ? "after setup" : "before setup"}.`,
        evidence: { healthOrigin: foreign.targetOrigin ?? "unknown", expectedProjectRoot: this.root,
          observedProjectRoot: foreign.observedProjectRoot ?? "unknown", listenerProcessId: foreign.processId ?? 0 } }
      : undefined;
    const integrationPreflight = this.integration?.preflight;
    const integrationPostSetupCheck = this.integration?.postSetupCheck;
    const preflight: IntegrationPreflight | undefined = healthOrigins.length ? async (context) => {
      const foreign = await firstForeignHealth(context.signal);
      const observed = healthResult(foreign, "preflight");
      if (observed && !observed.passed) return observed;
      if (!integrationPreflight) return observed ?? { passed: true, message: "Declared local health listener source checks completed." };
      const connector = await integrationPreflight(context);
      return observed ? { ...connector, evidence: { ...connector.evidence, ...observed.evidence } } : connector;
    } : integrationPreflight;
    const checkHealthAfterSetup = healthOrigins.length > 0 && Boolean(setup || integrationSetup);
    const postSetupCheck: IntegrationPreflight | undefined = checkHealthAfterSetup || integrationPostSetupCheck ? async (context) => {
      const foreign = checkHealthAfterSetup ? await firstForeignHealth(context.signal) : undefined;
      const observed = healthResult(foreign, "after-setup");
      if (observed && !observed.passed) return observed;
      if (!integrationPostSetupCheck) return observed ?? { passed: true, message: "Declared local health listener source checks completed after setup." };
      const connector = await integrationPostSetupCheck(context);
      return observed ? { ...connector, evidence: { ...connector.evidence, ...observed.evidence } } : connector;
    } : undefined;
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
      replayOfRunId: input.replayOfRunId,
      preflight,
      postSetupCheck,
      postRunCheck: this.integration?.postRunCheck,
      signal,
      timeoutMs: this.config.run.timeoutMs,
      runtimeQuality: this.config.policies.runtime,
      urlEvidenceTargets: input.coverageRouteTargets,
      webEvidenceOrigin: targetUrl && /^(https?):\/\//i.test(targetUrl) ? new URL(targetUrl).origin : undefined,
      executionLease: async (leaseSignal) => {
        const identity = sharedTargetIdentity(surface, input, this.config);
        if (!resolveElectronPortFile || !identity) return acquireExecutionScope(this.workspaceRoot, identity);
        const acquired = await acquireElectronPortFileScope(this.workspaceRoot, identity, electronPortFile, leaseSignal,
          input.start === false || !this.config.project.start);
        preSetupCdpUrl = acquired.cdpUrl;
        return acquired.lease;
      },
      ...(resolveElectronPortFile ? { attachmentLease: async (leaseSignal: AbortSignal) => {
        const cdpUrl = await resolveElectronCdpUrl({ devtoolsActivePortPath: electronPortFile }, leaseSignal);
        if (!cdpUrl) throw new Error("Electron CDP endpoint is missing from its port file");
        if (cdpUrl === preSetupCdpUrl) {
          (adapter as ElectronAdapter).pinCdpUrl(cdpUrl);
          pinnedCdpUrl = cdpUrl;
          return { release: async () => {} };
        }
        const lease = await acquireCdpTarget(cdpUrl);
        if (!lease) return undefined;
        try { (adapter as ElectronAdapter).pinCdpUrl(cdpUrl); pinnedCdpUrl = cdpUrl; }
        catch (error) { await lease.release(); throw error; }
        return lease;
      } } : {}),
      ...(surface === "web" || surface === "electron" ? {
        targetBinding: async (bindingSignal: AbortSignal) => inspectTargetBinding(this.root,
          await sourceBindingTarget(surface, targetUrl, pinnedCdpUrl ?? electronCdp, electronPortFile, bindingSignal), bindingSignal),
        ...(surface === "electron" ? { applicationBinding: async (bindingSignal: AbortSignal) => inspectTargetBinding(this.root,
          await sourceBindingTarget("electron", undefined, pinnedCdpUrl ?? electronCdp, electronPortFile, bindingSignal), bindingSignal) } : {}),
        targetBindingPolicy: this.config.policies.targetBinding,
        targetBindingRecheckAfterSetup: Boolean(integrationSetup || (input.start !== false && this.config.project.start)),
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
        routePatterns: input.coverageRouteTargets?.filter((target) => target.kind === "web").map((target) => target.path),
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
      routePatterns: input.coverageRouteTargets?.filter((target) => target.kind === "web").map((target) => target.path),
      headless: !input.headful,
      executablePath: this.config.surfaces.web?.executablePath ?? process.env.PROOFKIT_BROWSER_PATH,
    });
  }

  private validateWebOrigins(charter: TestCharter, input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const urls = [input.url, ...charter.actions.flatMap((action) => action.kind === "goto" ? [action.url]
      : action.kind === "captureResponse" ? [action.response.url] : [])];
    for (const value of urls) {
      if (!value) continue;
      const parsed = new URL(value);
      if (isAllowedMcpWebUrl(value, this.config.surfaces.web?.baseUrl)) continue;
      throw new Error(`Web URL is outside the configured origin: ${parsed.origin}`);
    }
  }

  private validateCdpEndpoint(input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const cdp = input.cdp ?? (input.adapter === "electron" ? this.config.surfaces.electron?.cdpUrl : this.config.surfaces.web?.cdpUrl);
    const portCandidate = input.adapter === "electron" && !cdp
      ? input.devtoolsPortFile ?? this.config.surfaces.electron?.devtoolsActivePort ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT
      : undefined;
    const endpoint = cdp ?? (portCandidate && /^(https?|wss?):\/\//i.test(portCandidate) ? portCandidate : undefined);
    if (endpoint && !isLoopback(new URL(endpoint).hostname)) {
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
function matchedWebRouteTargets(summary: RunSummary, targets: RouteCoverageTarget[], fileTargetUrlPrefix?: string): string[] {
  const declared = new Set(targets.filter((target) => target.kind === "web").map((target) => target.path));
  if (declared.size === 0) return [];
  // HTTP pages must have the configured origin recorded in this Run. A file
  // page must be the exact configured HTML document, not a same-prefix file.
  let approvedOrigin: string | undefined;
  let approvedFile: URL | undefined;
  try {
    const origin = summary.targetBinding?.targetOrigin;
    if (origin) {
      const target = new URL(origin);
      if (target.protocol === "http:" || target.protocol === "https:") approvedOrigin = target.origin;
    }
  } catch { /* An invalid HTTP target cannot establish HTTP route coverage. */ }
  try {
    if (fileTargetUrlPrefix) {
      const target = new URL(fileTargetUrlPrefix);
      if (target.protocol === "file:" && !target.search && /\.html?$/i.test(target.pathname)) approvedFile = target;
    }
  } catch { /* An invalid file target cannot establish file route coverage. */ }
  if (!approvedOrigin && !approvedFile) return [];
  const approvedFileSha256 = approvedFile ? sha256(`${approvedFile.host}${approvedFile.pathname}`) : undefined;
  const paths = new Set<string>();
  const matchedPatterns = new Set<string>();
  const accept = (value: string, patterns?: unknown, adapter?: unknown, pathEvidence?: unknown, fileDocumentSha256?: unknown) => {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* A redacted file URL may not be parseable. */ }
    const http = approvedOrigin !== undefined && url?.origin === approvedOrigin;
    const file = approvedFile !== undefined && adapter === "electron" && (fileDocumentSha256 === approvedFileSha256
      || url?.protocol === "file:" && url.host === approvedFile.host && url.pathname === approvedFile.pathname);
    if (!http && !file) return;
    if (http && url && pathEvidence !== "redacted" && url.pathname !== "/__redacted__") paths.add(url.pathname);
    if (Array.isArray(patterns)) for (const pattern of patterns) {
      if (typeof pattern === "string" && declared.has(pattern)) matchedPatterns.add(pattern);
    }
  };
  for (const step of summary.steps) {
    for (const snapshot of [step.beforeSnapshot, step.afterSnapshot]) {
      if (snapshot?.url) accept(snapshot.url, snapshot.metadata.matchedRoutePaths, snapshot.metadata.adapter,
        snapshot.metadata.urlPathEvidence, snapshot.metadata.fileDocumentSha256);
    }
    if (step.receipt?.urlBefore) accept(step.receipt.urlBefore, undefined, undefined, step.receipt.metadata.urlBeforePathEvidence);
    if (step.receipt?.urlAfter) accept(step.receipt.urlAfter, undefined, undefined, step.receipt.metadata.urlAfterPathEvidence);
  }
  return [...declared].filter((pattern) => matchedPatterns.has(pattern) || [...paths].some((path) => routeMatches(pattern, path))).sort();
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
  return isLoopbackHost(hostname);
}
