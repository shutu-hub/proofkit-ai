import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeRun, selectEvidencedBusinessFailure, InMemoryMissionToolRegistry, MissionAgent, MissionAlreadyRunningError, type MissionTool, type MissionToolResult } from "@proofkit/agent";
import { ElectronAdapter, MobileAdapter, WebAdapter, WebTaskSession, resolveElectronCdpUrl, type BenchmarkHarOptions } from "@proofkit/adapters";
import { atomicWriteJson, auditMissionVerdict, createRunId, EvidenceStore, LocalExecutionOwnership, MissionReportStore, sha256, type LocalExecutionLease } from "@proofkit/evidence";
import type { EnvironmentInspection, EnvironmentInspectionInput, IntegrationReadiness, IntegrationReadinessInput } from "@proofkit/contracts";
import { SurfaceReadinessSchema, SurfaceTableReadRequestSchema, SurfaceTextReadRequestSchema, type SurfaceReadiness, type SurfaceTableReadRequest, type SurfaceTextReadRequest } from "@proofkit/contracts";
import { inspectEnvironment } from "./environment.js";
import { loadPlanningContinuation, savePlanningContinuation, mergePlanningInspections, assertResumeRequirements } from "./planning-continuation.js";
import type { PlanningContinuationPin } from "@proofkit/contracts";
import { ActionSchema, FailureBoundarySchema, FindingSchema, hasPositiveSurfaceAssertion, IntegrationReadinessInputSchema, IntegrationReadinessSchema, NegativeCaseSchema, ObservationSchema, SourceStateSchema, SurfaceReplanProposalSchema, SurfaceReplanStabilityAnalysisSchema, suiteChecks, TargetBindingSchema, TestCharterSchema, TestLevelSelectionSchema, TestScopeInputSchema, TestSuiteSchema, workflowChecks, type Action, type EvidenceRef, type MissionAcceptanceIntegrity, type MissionComparison, type MissionEvidenceIntegrity, type MissionProofClassification, type MissionRecoveryInspection, type NegativeCase, type ProofkitConfig, type ProjectMap, type RouteCoverageTarget, type RunMode, type RunSummary, type SideEffectPolicy, type SourceState, type SurfaceSnapshot, type TargetBinding, type TestCharter, type TestLevel, type TestMission, type TestScope, type TestScopeInput, type TestSuite, type Verdict, type WorkflowInventory } from "@proofkit/contracts";
import { configuredHttpOracle, httpOracle } from "@proofkit/oracles";
import { assessPlanningCoverage, assessPlanningQuality, withPlanningCoverage, getTestLevelProfile, intentTestLevelHints, IntentPlanner, OpenAICompatiblePlannerProvider, PlannerConfigurationError, PlanningRequirementsError, requiredCatalogSurfaces, resolveTestLevel, selectCatalogCharter, selectCatalogSuite, supportsCatalogCharter, StructuredPlanner, loadCharter, type PlanOptions, type PlannerProvider } from "@proofkit/planner";
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
import { firstInlineOracleIssue, isAllowedMcpApiUrl, isAllowedMcpWebUrl, isLoopbackHost } from "./inline-oracle-validation.js";
import { MAX_CANDIDATE_BYTES, readWorkspaceCharterFile } from "./workspace-charter-file.js";
export { readWorkspaceCharterFile } from "./workspace-charter-file.js";
import { compareCurrentSource, projectMissionResult } from "./mission-result.js";
import type { MissionResult, MissionRepeatSeriesStatus, MissionStabilityAnalysis } from "@proofkit/contracts";
import { actionSurfaceTargets, SurfaceTargetExpectationSchema, type SurfaceTargetExpectation } from "@proofkit/contracts";
import { auditPlanningObservation } from "@proofkit/evidence";
import { loadPinnedPlanningObservation } from "@proofkit/evidence";
import { PlanningInspectionPinSchema, type PlanningInspectionPin, type SurfaceObservedState } from "@proofkit/contracts";
import { planningObservationSources, type PlanningObservationRequest } from "@proofkit/contracts";
import { bindObservedSurfaceTargets, PlanningObservationRequestError } from "@proofkit/planner";
import { ResourceRecoveryService } from "./resource-recovery.js";
import { prepareSessionResources, type SessionResourcePreparation } from "./session-resource-preparation.js";
import { captureRunEvidence, materializedRunArtifact } from "./run-evidence.js";
import { SessionNetworkEvidence, type SessionNetworkCapture } from "./session-network-evidence.js";
import { auditSessionCaptures } from "./session-capture-audit.js";
import { recoverInterruptedSessionCapture, type SessionCaptureRecovery } from "./session-capture-recovery.js";
export type { SessionNetworkCapture } from "./session-network-evidence.js";
export type { SessionCaptureRecovery } from "./session-capture-recovery.js";
import { auditMissionProofClassification } from "./mission-proof-classification.js";
import { auditMissionExecution, auditMissionRunFacts } from "./mission-execution-audit.js";
import { auditMissionAgentTrace } from "./mission-agent-trace-audit.js";
import { negativeOutcomeProofGap } from "./negative-outcome.js";
import { acquireCdpTarget, acquireElectronPortFileScope, acquireExecutionScope, sharedTargetIdentity } from "./execution-scope.js";
import { sourceBindingTarget } from "./source-binding-target.js";
import { assertMissionSurfaceCoverage, selectMissionSurface } from "./mission-surface.js";
import { RepairHypothesisInputSchema, RepairSuggestionSchema, type RepairHypothesisInput, type RepairSourceAudit } from "@proofkit/contracts";
import { auditRepairSources } from "./repair-hypothesis.js";
import { BenchmarkCaptureSession, type BenchmarkMissionBinding } from "./benchmark-capture.js";
export { PlannerConfigurationError } from "@proofkit/planner";

export { BenchmarkCaptureSession } from "./benchmark-capture.js";
export { auditPersistedBenchmarkTask } from "./benchmark-task-audit.js";

export { loadProjectIntegration } from "./integration.js";
export { inspectEvidenceRetention, type EvidenceRetentionAudit, type EvidenceRetentionRow } from "./evidence-retention.js";

export type LocalAdapterName = "web" | "electron" | "mobile";
export { summarizePlanReview } from "@proofkit/planner";

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
  /** Reuse an explicitly retained Web exploratory context for this formal Run. */
  sessionId?: string;
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

export type SurfaceInspectionInput = Pick<LocalRunInput, "adapter" | "url" | "cdp" | "devtoolsPortFile" | "mobileServer" | "headful" | "sessionId" | "signal"> & {
  keepSession?: boolean;
  sessionLabel?: string;
  controlOffset?: number;
  readyWhen?: { text: string; timeoutMs?: number };
  readText?: SurfaceTextReadRequest;
  readTable?: SurfaceTableReadRequest;
};
export type SurfaceInspection = {
  inspectionId: string;
  sessionId?: string;
  sessionLabel?: string;
  manifest?: { path: string; sha256: string };
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

export type LocalPlanOptions = Omit<PlanOptions, "surfaceObservations"> & Pick<SurfaceInspectionInput, "adapter" | "sessionId" | "headful" | "signal" | "keepSession" | "sessionLabel"> & { inspections?: PlanningInspectionPin[]; charter?: TestCharter; continuation?: PlanningContinuationPin };

export class PlanningObservationError extends Error {
  override readonly name = "PlanningObservationError";
  constructor(readonly inspection?: SurfaceInspection, readonly continuation?: { request: PlanningObservationRequest; inspections: PlanningInspectionPin[]; sessionId?: string; savedPlan?: PlanningContinuationPin }) {
    super(continuation ? "The planner needs another observed state before returning a Charter. Review its exploratory proposal and collect the missing observation."
      : inspection ? `Planning could not establish a usable, independently verifiable surface observation; inspection ${inspection.inspectionId} ended ${inspection.status}. Inspect the target and its evidence before retrying.`
      : "Planning requires a configured target and an independently verifiable surface observation before proposing executable controls. Inspect the target and its evidence before retrying.");
  }

  receipt() {
    return { status: "needs-observation" as const, testVerdict: "not-asserted" as const, reason: this.message,
      ...(this.inspection ? { inspection: this.inspection } : {}),
      ...(this.continuation ? { observationRequest: { ...this.continuation.request, requiresApproval: true,
        ...(this.continuation.savedPlan ? { continuation: this.continuation.savedPlan } : {}),
        inspections: this.continuation.inspections, ...(this.continuation.sessionId ? { sessionId: this.continuation.sessionId } : {}) } } : {}),
      next: this.continuation ? [...(this.continuation.request.action ? ["interact_surface"] : []), "inspect_surface", "plan_test"] : ["inspect_test_environment", "inspect_surface", "plan_test"] };
  }
}

export type SurfaceInteractionInput = Pick<LocalRunInput, "adapter" | "url" | "cdp" | "devtoolsPortFile" | "headful" | "signal"> & {
  action: Extract<Action, { kind: "goto" | "switchPage" | "click" | "fill" | "press" | "selectOption" | "selectOptions" | "setChecked" | "waitForText" | "waitForValue" }>;
  keepSession?: boolean;
  sessionId?: string;
  inspection?: PlanningInspectionPin;
  /** Human-readable context label only; it is not an account or credential assertion. */
  sessionLabel?: string;
};
export type SurfaceInteraction = {
  interactionId: string;
  surface: "web" | "electron";
  status: "observed" | "failed" | "blocked" | "cancelled";
  testVerdict: "not-asserted";
  sessionId?: string;
  sessionLabel?: string;
  action: { kind: SurfaceInteractionInput["action"]["kind"]; status: string; failureCode?: string };
  snapshot?: Pick<SurfaceSnapshot, "capturedAt" | "url" | "title" | "text" | "controls" | "controlsTruncated">;
  next?: Array<"inspect_surface">;
  runtimeHealth?: RunSummary["runtimeHealth"];
  findings: string[];
  evidence: EvidenceRef[];
  evidenceOmitted: number;
};

type InteractiveWebSession = {
  id: string;
  label?: string;
  createdAt: string;
  targetUrl: string;
  headful: boolean;
  owner: WebTaskSession;
  network?: SessionNetworkEvidence;
  preparation?: SessionResourcePreparation;
  preparationCleanup?: import("@proofkit/contracts").IntegrationCleanup;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
};

type SessionPersistence = { directory: string; key: Buffer };
type PersistedSessionMetadata = { schemaVersion: 1; sessionId: string; sessionLabel?: string; createdAt: string; targetUrl: string; headful: boolean; stateFile: string; borrowedRunIds?: string[] };

export type MissionCreateOptions = {
  intent: string;
  signal?: AbortSignal;
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
  /** Freeze whether Web runs open a visible browser for this Mission. */
  headful?: boolean;
  /** Adopt an explicitly retained Web session for this Mission's Web Runs. */
  sessionId?: string;
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
  /** Trusted benchmark controller only; unavailable through project config or tool inputs. */
  benchmarkCapture?: BenchmarkCaptureSession;
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
  private readonly benchmarkCapture?: BenchmarkCaptureSession;
  private readonly interactiveWebSessions = new Map<string, InteractiveWebSession>();
  private readonly sessionPersistence?: SessionPersistence;
  private persistedSessionsLoaded?: Promise<void>;
  private readonly interactiveSessionInputs = new WeakMap<LocalRunInput, WebTaskSession>();
  private readonly runSessionInputs = new WeakMap<LocalRunInput, InteractiveWebSession>();
  private readonly reconnaissanceInputs = new WeakSet<LocalRunInput>();
  private readonly preparedSessionInputs = new WeakSet<LocalRunInput>();
  private readonly preplannedCharters = new WeakMap<LocalRunInput, TestCharter>();
  private readonly benchmarkMissionBindings = new WeakMap<LocalRunInput, BenchmarkMissionBinding>();
  private readonly missionAgent: MissionAgent;
  private readonly missionStore: ProjectMissionStore;
  private readonly missionRecords = new Map<string, MissionRecord>();
  private readonly missionStarts = new Map<string, Promise<MissionStatus>>();

  constructor(options: LocalRunnerOptions) {
    const context = resolveProjectContext(options.root, { workspaceRoot: options.workspaceRoot });
    this.root = context.projectRoot;
    this.workspaceRoot = context.workspaceRoot;
    this.config = loadConfigForContext(context, options.config);
    this.evidenceDir = resolve(this.workspaceRoot, options.evidenceDir ?? ".proofkit/runs");
    this.benchmarkCapture = options.benchmarkCapture;
    this.benchmarkCapture?.bind({ root: this.root, workspaceRoot: this.workspaceRoot, evidenceDir: this.evidenceDir });
    this.evidence = new EvidenceStore(this.evidenceDir);
    this.missionReports = new MissionReportStore(this.workspaceRoot, this.evidenceDir);
    this.restrictWebOrigins = options.restrictWebOrigins ?? false;
    if (this.config.sessions?.persistence === "encrypted") {
      const keyEnv = this.config.sessions.keyEnv;
      const secret = keyEnv ? process.env[keyEnv] : undefined;
      if (!keyEnv || !secret) throw new Error("Encrypted session persistence requires sessions.keyEnv and that environment variable");
      this.sessionPersistence = { directory: resolve(this.workspaceRoot, ".proofkit", "sessions"), key: Buffer.from(sha256(secret), "hex") };
    }
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
    if (versionedIntegration && !options.oracles?.length && !options.capabilities?.length && !this.benchmarkCapture) {
      this.missionRecoveryKey = `local-runner-v1:${sha256(JSON.stringify({
        projectRoot: this.root, workspaceRoot: this.workspaceRoot, evidenceDir: this.evidenceDir,
        config: this.config, integration: this.integration ? { name: this.integration.name, version: this.integration.version } : null,
        restrictWebOrigins: this.restrictWebOrigins, allowCapabilityWrites: this.allowCapabilityWrites,
      }))}`;
    }
    this.missionStore = new ProjectMissionStore(context);
    this.missionAgent = new MissionAgent({
      store: this.missionStore,
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

  async recoverSessionCapture(runId: string, sessionId: string): Promise<SessionCaptureRecovery> {
    return recoverInterruptedSessionCapture({ runId, sessionId, evidenceDir: this.evidenceDir, workspaceRoot: this.workspaceRoot, projectRoot: this.root });
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
        const surfaces = requiredCatalogSurfaces(request.level, request.surface, entry.surfaces);
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

  async inspectIntegrationReadiness(input: IntegrationReadinessInput, signal?: AbortSignal): Promise<IntegrationReadiness> {
    signal?.throwIfAborted();
    const request = IntegrationReadinessInputSchema.parse(input);
    let charter: TestCharter;
    let surfaces: IntegrationReadiness["surfaces"];
    let selection: Pick<IntegrationReadiness, "charterId" | "charterPath" | "charterSha256" | "draftSha256">;
    let draftBytes: string | undefined;
    if (request.charter !== undefined) {
      draftBytes = JSON.stringify(request.charter);
      if (Buffer.byteLength(draftBytes) > MAX_CANDIDATE_BYTES) throw new Error("Readiness draft exceeds the 128 KiB limit");
      charter = TestCharterSchema.parse(JSON.parse(draftBytes));
      draftBytes = JSON.stringify(charter);
      surfaces = [...charter.surfaces!];
      selection = { draftSha256: sha256(draftBytes) };
    } else if (request.charterId !== undefined) {
      const entry = this.config.charters.find((charter) => charter.id === request.charterId);
      if (!entry) throw new Error(`Unknown Charter: ${request.charterId}`);
      charter = await loadCharter(resolveWithinWorkspace(this.workspaceRoot, entry.path));
      if (charter.level !== entry.level) throw new Error(`Test catalog entry ${entry.id} declares ${entry.level}, but its Charter is ${charter.level}`);
      surfaces = entry.surfaces;
      selection = { charterId: entry.id };
    } else {
      const loaded = await this.loadCandidateCharter(request.charterPath!, request.charterSha256!);
      charter = loaded.charter;
      if (!charter.surfaces) throw new Error("Candidate Charter must declare its supported surfaces before readiness inspection");
      surfaces = charter.surfaces;
      selection = { charterPath: request.charterPath, charterSha256: loaded.sha256 };
    }
    signal?.throwIfAborted();
    const base = {
      schemaVersion: 1 as const,
      testVerdict: "not-asserted" as const,
      projectRoot: this.root,
      workspaceRoot: this.workspaceRoot,
      ...selection,
      level: charter.level,
      surfaces,
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
      if (draftBytes !== undefined && JSON.stringify(charter) !== draftBytes) throw new Error("Connector modified the submitted readiness draft");
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
    input.signal?.throwIfAborted();
    await this.loadPersistedSessions();
    const surface = input.adapter ?? "web";
    if (input.sessionLabel && !input.keepSession && !input.sessionId) throw new Error("A session label requires a retained Web session");
    if (input.sessionLabel !== undefined && (!input.sessionLabel.trim() || input.sessionLabel.length > 80 || /[\r\n]/.test(input.sessionLabel))) throw new Error("Invalid surface session label");
    if (surface === "web" && !(input.url || input.cdp || input.sessionId || this.config.surfaces.web?.baseUrl || this.config.surfaces.web?.cdpUrl)) {
      throw new Error("Web inspection needs a configured baseUrl, CDP endpoint, or explicit URL");
    }
    const configuredReadiness = input.readyWhen ?? this.config.surfaces[surface]?.readyWhen;
    const readyWhen = configuredReadiness === undefined ? undefined : SurfaceReadinessSchema.parse(configuredReadiness);
    const readText = input.readText === undefined ? undefined : SurfaceTextReadRequestSchema.parse(input.readText);
    const readTable = input.readTable === undefined ? undefined : SurfaceTableReadRequestSchema.parse(input.readTable);
    if (readText && readTable) throw new Error("Choose one scoped read per inspection");
    if (input.controlOffset !== undefined && (readText || readTable)) throw new Error("Choose one scoped read per inspection");
    if (input.controlOffset !== undefined && surface === "mobile") throw new Error("Targeted control windows currently support Web and Electron only");
    if ((readText || readTable) && surface === "mobile") throw new Error("Targeted rendered inspection currently supports Web and Electron only");
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error("Surface inspection exceeded 30 seconds")), 30_000);
    let session: InteractiveWebSession | undefined;
    let preserveSession = false;
    try {
      const charter = TestCharterSchema.parse({
        intent: `Inspect the current ${surface} surface`, level: "quick", mode: "deterministic",
        actions: [...(readyWhen ? [{ kind: "waitForText", ...readyWhen }] : []), { kind: "observe", ...(readText ? { readText } : {}), ...(readTable ? { readTable } : {}),
          ...(input.controlOffset !== undefined ? { controlOffset: input.controlOffset } : {}) }], assertions: [], sideEffectPolicy: "deny",
        metadata: { purpose: "surface-inspection" },
      });
      controller.signal.throwIfAborted();
      session = this.claimInteractiveSession(input, { kind: "observe" });
      const runInput: LocalRunInput = { ...input, ...(session ? { sessionId: session.id, url: session.targetUrl } : {}),
        adapter: surface, charter, start: false, signal: controller.signal };
      if (session) this.interactiveSessionInputs.set(runInput, session.owner);
      this.reconnaissanceInputs.add(runInput);
      const started = await this.startRun(runInput, this.benchmarkMissionBindings.get(input));
      const summary = await this.wait(started.runId);
      const observation = summary.steps.find((step) => step.action.kind === "observe");
      const observed = observation?.status === "passed" ? observation.afterSnapshot : undefined;
      const stopped = summary.verdict === "blocked" || summary.verdict === "cancelled" ? summary.verdict : undefined;
      const readinessObserved = Boolean(observed && summary.steps.find((step) => step.action.kind === "waitForText")?.status === "passed");
      const runtimeFindings = summary.runtimeFindings ?? [];
      let manifest: SurfaceInspection["manifest"];
      if (observed && !stopped) {
        try {
          const saved = await this.evidence.writeManifest(summary.runId);
          manifest = { path: resolve(this.evidenceDir, saved.path), sha256: saved.sha256 };
        } catch {}
      }
      preserveSession = Boolean(session?.owner.reusable && !controller.signal.aborted);
      return {
        inspectionId: summary.runId,
        ...(preserveSession && session ? { sessionId: session.id, ...(session.label ? { sessionLabel: session.label } : {}) } : {}),
        ...(manifest ? { manifest } : {}),
        surface,
        status: stopped ?? (observed ? "observed" : "failed"),
        testVerdict: "not-asserted",
        ...(observed ? { snapshot: { ...observed, text: observed.textRead ? observed.text : observed.text?.slice(0, 2_000) } } : {}),
        ...(summary.targetBinding ? { targetBinding: summary.targetBinding } : {}),
        runtimeHealth: summary.runtimeHealth,
        readiness: readyWhen ? { status: readinessObserved ? "observed" : "unverified", condition: readyWhen } : { status: "not-requested" },
        runtimeFindings: runtimeFindings.slice(0, 10).map((finding) => ({ ...finding, message: finding.message.slice(0, 2_000) })),
        runtimeFindingsOmitted: Math.max(0, runtimeFindings.length - 10),
        findings: [...summary.findings.filter((finding) => finding !== "No executable assertion or business oracle was declared."),
          ...(observed && !stopped && !manifest ? ["The observed inspection could not be sealed; it cannot be used as a pinned planning source."] : [])].slice(0, 10),
        evidence: this.runEvidence(summary),
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
      if (session) {
        session.busy = false;
        if (preserveSession) {
          await this.persistInteractiveSession(session);
          this.refreshInteractiveSession(session);
        } else await this.retireInteractiveSession(session);
      }
    }
  }

  /** One explicitly requested exploratory action. It saves a Run but never asserts product correctness. */
  async interactSurface(input: SurfaceInteractionInput): Promise<SurfaceInteraction> {
    await this.loadPersistedSessions();
    const surface = input.adapter ?? "web";
    if (surface !== "web" && surface !== "electron") throw new Error("Surface interaction supports Web and Electron only");
    if (surface === "electron" && input.url) throw new Error("Electron interaction uses its configured CDP target");
    const parsed = ActionSchema.parse(input.action);
    if (!["goto", "switchPage", "click", "fill", "press", "selectOption", "selectOptions", "setChecked", "waitForText", "waitForValue"].includes(parsed.kind)) throw new Error("Unsupported exploratory action");
    const action = parsed as SurfaceInteractionInput["action"];
    if (surface === "electron" && action.kind === "goto") throw new Error("Electron navigation must use the owned application UI");
    const interactive = ["click", "fill", "press", "selectOption", "selectOptions", "setChecked"].includes(action.kind);
    if (interactive && this.config.policies.sideEffects !== "allow") {
      throw new Error("Exploratory interaction requires sideEffects=allow in the test workspace");
    }
    input.signal?.throwIfAborted();
    const source = input.inspection ? await (async () => {
      if (surface !== "web" || !input.sessionId || input.keepSession) throw new Error("Pinned exploratory interaction requires one retained Web session");
      if ("observationId" in action && action.observationId && action.observationId !== input.inspection!.runId) throw new Error("Exploratory action references a different observed state");
      return loadPinnedPlanningObservation(this.evidence, input.inspection!, { projectRoot: this.root, workspaceRoot: this.workspaceRoot, adapter: surface, sessionId: input.sessionId });
    })() : undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error("Surface interaction exceeded 30 seconds")), 30_000);
    let session: InteractiveWebSession | undefined;
    let preserveSession = false;
    try {
      let charter = TestCharterSchema.parse({ intent: `Explore one ${surface} action`, level: "quick", mode: "deterministic",
        actions: [action, { kind: "observe" }], assertions: [], sideEffectPolicy: interactive ? "allow" : "deny",
        metadata: { purpose: "surface-interaction" } });
      if (source) {
        charter = bindObservedSurfaceTargets(charter, undefined, [{ observationId: input.inspection!.runId, snapshot: source.snapshot }]);
        if (charter.actions.flatMap(actionSurfaceTargets).some((target) => !target.expectedTarget)) throw new Error("Exploratory action is missing from its original observation");
        charter = TestCharterSchema.parse({ ...charter, surfaceObservation: source.observation });
      }
      session = this.claimInteractiveSession(input, action);
      const runInput: LocalRunInput = { ...input, ...(session ? { sessionId: session.id, url: session.targetUrl } : {}),
        adapter: surface, charter, start: false, signal: controller.signal };
      if (session) this.interactiveSessionInputs.set(runInput, session.owner);
      if (session?.preparation) this.preparedSessionInputs.add(runInput);
      if (!interactive && (action.kind === "waitForText" || action.kind === "waitForValue")) this.reconnaissanceInputs.add(runInput);
      const started = await this.startRun(runInput);
      const summary = await this.wait(started.runId);
      const observed = summary.steps.find((step) => step.action.kind === "observe" && step.status === "passed")?.afterSnapshot;
      const first = summary.steps[0];
      const status = summary.verdict === "blocked" || summary.verdict === "cancelled" ? summary.verdict
        : first?.status === "passed" && observed ? "observed" : "failed";
      const evidence = this.runEvidence(summary);
      preserveSession = Boolean(session?.owner.reusable && !controller.signal.aborted);
      const compactControls = observed?.controls?.slice(0, 20);
      if (compactControls && "selector" in action && typeof action.selector === "string") {
        const actedControl = observed?.controls?.find((control) => control.selector === action.selector || control.alternateSelectors?.includes(action.selector));
        if (actedControl && !compactControls.includes(actedControl)) {
          compactControls.splice(compactControls.length - 1, 1, actedControl);
        }
      }
      return {
        interactionId: summary.runId, surface, status, testVerdict: "not-asserted",
        ...(preserveSession && session ? { sessionId: session.id } : {}),
        ...(preserveSession && session?.label ? { sessionLabel: session.label } : {}),
        action: { kind: action.kind, status: first?.status ?? "not-run",
          ...(first?.failureCode ? { failureCode: first.failureCode } : {}) },
        ...(observed ? { snapshot: { capturedAt: observed.capturedAt, url: observed.url, title: observed.title,
          text: observed.text?.slice(0, 2_000), controls: compactControls,
          ...(observed.pages ? { pages: observed.pages, pagesTruncated: observed.pagesTruncated } : {}),
          controlsTruncated: Boolean(observed.controlsTruncated || (observed.controls?.length ?? 0) > 20) } } : {}),
        ...(observed && ["goto", "click", "switchPage"].includes(action.kind)
          && (observed.controlsTruncated || (observed.controls?.length ?? 0) > 20)
          ? { next: ["inspect_surface" as const] } : {}),
        runtimeHealth: summary.runtimeHealth,
        findings: summary.findings.filter((finding) => finding !== "No executable assertion or business oracle was declared.")
          .slice(0, 5).map((finding) => finding.slice(0, 400)),
        evidence: evidence.slice(0, 12), evidenceOmitted: Math.max(0, evidence.length - 12),
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
      if (session) {
        session.busy = false;
        if (preserveSession) {
          await this.persistInteractiveSession(session);
          this.refreshInteractiveSession(session);
        }
        else await this.retireInteractiveSession(session);
      }
    }
  }

  async prepareSurfaceSession(input: { sessionId: string; charter: TestCharter; signal?: AbortSignal }): Promise<{
    sessionId: string; runId: string; registrationSha256: string; status: "prepared"; testVerdict: "not-asserted";
  }> {
    await this.loadPersistedSessions();
    if (this.sessionPersistence) throw new Error("Prepared resources cannot use browser persistence across a process restart");
    if (!this.allowCapabilityWrites || this.config.policies.sideEffects !== "allow" || !this.integration?.setup || !this.integration.recover) {
      throw new Error("Explicit write permission and a recovery-capable project connector are required for session preparation");
    }
    const session = this.interactiveWebSessions.get(input.sessionId);
    if (!session || !session.owner.reusable || session.busy || session.owner.activeRunId || session.preparation) {
      throw new Error("Preparation requires one idle, reusable, unprepared owned Web session");
    }
    session.busy = true;
    try {
      const preparation = await prepareSessionResources({ sessionId: session.id, charter: input.charter, signal: input.signal,
        projectRoot: this.root, workspaceRoot: this.workspaceRoot, evidenceDir: this.evidenceDir, config: this.config, integration: this.integration });
      session.preparation = preparation;
      return { sessionId: session.id, runId: preparation.runId, registrationSha256: preparation.registrationSha256,
        status: "prepared", testVerdict: "not-asserted" };
    } catch (error) {
      await this.retireInteractiveSession(session).catch(() => {});
      throw error;
    } finally {
      session.busy = false;
      if (this.interactiveWebSessions.get(session.id) === session) this.refreshInteractiveSession(session);
    }
  }

  async closeSurfaceSession(sessionId: string): Promise<{ sessionId: string; status: "closed"; networkCapture?: SessionNetworkCapture;
    resourcePreparation?: { runId: string; cleanup: import("@proofkit/contracts").IntegrationCleanup } }> {
    await this.loadPersistedSessions();
    const session = this.interactiveWebSessions.get(sessionId);
    if (!session) throw new Error("Surface session is missing or expired");
    if (session.busy || session.owner.activeRunId) throw new Error("Surface session has an active Run");
    const networkCapture = await this.retireInteractiveSession(session);
    return { sessionId, status: "closed", ...(networkCapture ? { networkCapture } : {}),
      ...(session.preparation && session.preparationCleanup ? { resourcePreparation: { runId: session.preparation.runId, cleanup: session.preparationCleanup } } : {}) };
  }

  async closeAllSurfaceSessions(): Promise<void> {
    await Promise.all([...this.interactiveWebSessions.values()].map((session) => this.retireInteractiveSession(session)));
  }

  listSurfaceSessions(): { sessions: Array<{
    sessionId: string;
    sessionLabel?: string;
    createdAt: string;
    targetOrigin: string;
    headful: boolean;
    busy: boolean;
    reusable: boolean;
    activeRunId?: string;
    borrowedRunIds: string[];
    preparationRunId?: string;
    networkCapture?: SessionNetworkCapture;
  }> } {
    return { sessions: [...this.interactiveWebSessions.values()].map((session) => ({
      sessionId: session.id,
      ...(session.label ? { sessionLabel: session.label } : {}),
      createdAt: session.createdAt,
      targetOrigin: new URL(session.targetUrl).origin,
      headful: session.headful,
      busy: session.busy,
      reusable: session.owner.reusable,
      ...(session.owner.activeRunId ? { activeRunId: session.owner.activeRunId } : {}),
      borrowedRunIds: session.owner.borrowedRunIds(),
      ...(session.preparation ? { preparationRunId: session.preparation.runId } : {}),
      ...(session.network ? { networkCapture: session.network.state() } : {}),
    })) };
  }

  private claimRunSession(input: LocalRunInput): LocalRunInput {
    if (!input.sessionId) return input;
    if ((input.adapter ?? "web") !== "web") throw new Error("A retained surface session can only run a Web Charter");
    if (input.cdp || this.config.surfaces.web?.cdpUrl || this.benchmarkCapture) {
      throw new Error("A retained surface session requires a new owned Web context without CDP or benchmark capture");
    }
    const session = this.interactiveWebSessions.get(input.sessionId);
    if (!session || !session.owner.reusable) throw new Error("Surface session is missing or unavailable");
    if (session.busy || session.owner.activeRunId) throw new Error("Surface session has an active Run");
    if (input.headful !== undefined && input.headful !== session.headful) {
      throw new Error("Run visibility must match the retained surface session");
    }
    if (input.url && new URL(input.url).href !== session.targetUrl) {
      throw new Error("Run URL does not match the retained surface session target");
    }
    session.busy = true;
    const prepared = { ...input, url: session.targetUrl };
    this.interactiveSessionInputs.set(prepared, session.owner);
    this.runSessionInputs.set(prepared, session);
    return prepared;
  }

  private releaseRunSession(input: LocalRunInput): void {
    const session = this.runSessionInputs.get(input);
    if (!session) return;
    this.runSessionInputs.delete(input);
    session.busy = false;
    if (session.owner.reusable) {
      void this.persistInteractiveSession(session).catch(() => {});
      this.refreshInteractiveSession(session);
    }
    else void this.retireInteractiveSession(session).catch(() => {});
  }

  private async persistInteractiveSession(session: InteractiveWebSession): Promise<void> {
    if (!this.sessionPersistence || !session.owner.reusable) return;
    const metadata: PersistedSessionMetadata = { schemaVersion: 1, sessionId: session.id,
      ...(session.label ? { sessionLabel: session.label } : {}), createdAt: session.createdAt,
      targetUrl: session.targetUrl, headful: session.headful, stateFile: `${session.id}.state.json`,
      borrowedRunIds: session.owner.borrowedRunIds().slice(-100) };
    try {
      await session.owner.persist();
      if (session.owner.reusable) await atomicWriteJson(resolve(this.sessionPersistence.directory, `${session.id}.json`), metadata);
    } finally {
      if (!session.owner.reusable) await this.deletePersistedSession(session.id);
    }
  }

  private claimInteractiveSession(input: Omit<SurfaceInteractionInput, "action">, action: Action): InteractiveWebSession | undefined {
    if (!input.keepSession && !input.sessionId) return undefined;
    if (input.keepSession && input.sessionId) throw new Error("Choose either keepSession or sessionId");
    if ((input.adapter ?? "web") !== "web") throw new Error("Persistent exploration currently supports Web only");
    if (this.benchmarkCapture || input.cdp || this.config.surfaces.web?.cdpUrl) {
      throw new Error("Persistent exploration requires a new owned Web context without CDP or benchmark capture");
    }
    if (input.sessionId) {
      const existing = this.interactiveWebSessions.get(input.sessionId);
      if (!existing || !existing.owner.reusable) throw new Error("Surface session is missing or unavailable");
      if (input.sessionLabel !== undefined && input.sessionLabel !== existing.label) throw new Error("Surface session label does not match");
      if (existing.busy || existing.owner.activeRunId) throw new Error("Surface session has an active Run");
      if (input.url && new URL(input.url).href !== existing.targetUrl) throw new Error("Surface session belongs to another target URL");
      if (input.headful !== undefined && input.headful !== existing.headful) throw new Error("Surface session visibility cannot change while active");
      if (action.kind === "goto" && new URL(action.url).origin !== new URL(existing.targetUrl).origin) {
        throw new Error("Surface session navigation is outside its target origin");
      }
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.busy = true;
      return existing;
    }
    const targetUrl = input.url ?? this.config.surfaces.web?.baseUrl ?? (action.kind === "goto" ? action.url : undefined);
    if (!targetUrl) throw new Error("Persistent exploration needs a Web target URL");
    if (action.kind === "goto" && new URL(action.url).origin !== new URL(targetUrl).origin) {
      throw new Error("Surface session navigation is outside its target origin");
    }
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const targetHref = new URL(targetUrl).href;
    const metadata: PersistedSessionMetadata = { schemaVersion: 1, sessionId, ...(input.sessionLabel ? { sessionLabel: input.sessionLabel } : {}), createdAt, targetUrl: targetHref, headful: Boolean(input.headful), stateFile: `${sessionId}.state.json` };
    const network = this.createSessionNetwork(sessionId, Boolean(input.headful));
    const owner = new WebTaskSession({ startUrl: targetUrl, headless: !input.headful, restrictToOrigin: true,
      executablePath: this.config.surfaces.web?.executablePath ?? process.env.PROOFKIT_BROWSER_PATH,
      ...(network ? { onNetworkEvent: (event) => network.record(event) } : {}),
      ...(network?.recordingOptions() ? { recordVideo: network.recordingOptions() } : {}),
      onRecordingStopped: async (reason) => {
        await network?.finish(true, owner.recordingStatus(), reason, owner.selectedPageRecording());
        await this.deletePersistedSession(sessionId);
      },
      ...(this.sessionPersistence ? { storageStateSaver: async (state) => this.persistSessionState(metadata, state) } : {}) });
    const session: InteractiveWebSession = { id: sessionId, ...(input.sessionLabel ? { label: input.sessionLabel } : {}), createdAt, targetUrl: targetHref, headful: Boolean(input.headful), owner, network, busy: true };
    this.interactiveWebSessions.set(session.id, session);
    return session;
  }

  private refreshInteractiveSession(session: InteractiveWebSession): void {
    if (this.interactiveWebSessions.get(session.id) !== session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.busy || session.owner.activeRunId) this.refreshInteractiveSession(session);
      else void this.retireInteractiveSession(session).catch(() => {});
    }, 600_000);
    session.idleTimer.unref();
  }

  private createSessionNetwork(sessionId: string, headful: boolean): SessionNetworkEvidence | undefined {
    const networkEnabled = this.config.sessions?.recordNetwork !== false;
    const recordVideo = this.config.sessions?.recordVideo === true;
    if (!networkEnabled && !recordVideo) return;
    return new SessionNetworkEvidence({ evidenceDir: this.evidenceDir, projectRoot: this.root, workspaceRoot: this.workspaceRoot, sessionId, headful, networkEnabled, recordVideo, videoBudget: this.config.sessions?.videoBudget });
  }

  private async retireInteractiveSession(session: InteractiveWebSession): Promise<SessionNetworkCapture | undefined> {
    if (this.interactiveWebSessions.get(session.id) !== session) return;
    this.interactiveWebSessions.delete(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    let capture: SessionNetworkCapture | undefined;
    try { await session.owner.close(true); }
    finally {
      try {
        capture = await session.network?.finish(Boolean(session.owner.unavailableReason), session.owner.recordingStatus(), session.owner.recordingStopReason(), session.owner.selectedPageRecording());
      } finally {
        try { session.preparationCleanup = await session.preparation?.close(); }
        finally { await this.deletePersistedSession(session.id); }
      }
    }
    return capture;
  }

  private async loadPersistedSessions(): Promise<void> {
    if (!this.sessionPersistence) return;
    this.persistedSessionsLoaded ??= (async () => {
      await mkdir(this.sessionPersistence!.directory, { recursive: true });
      for (const entry of await readdir(this.sessionPersistence!.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".state.json")) continue;
        try {
          const metadata = JSON.parse(await readFile(resolve(this.sessionPersistence!.directory, entry.name), "utf8")) as PersistedSessionMetadata;
          if (metadata.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/i.test(metadata.sessionId)) continue;
          if (metadata.stateFile !== `${metadata.sessionId}.state.json`) continue;
          const stateFile = resolve(this.sessionPersistence!.directory, metadata.stateFile);
          const encrypted = JSON.parse(await readFile(stateFile, "utf8")) as { iv: string; tag: string; data: string };
          const decipher = createDecipheriv("aes-256-gcm", this.sessionPersistence!.key, Buffer.from(encrypted.iv, "base64"));
          decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
          const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"));
          const borrowedRunIds: string[] = [];
          const candidates = Array.isArray(metadata.borrowedRunIds)
            ? [...new Set(metadata.borrowedRunIds.filter((runId): runId is string => typeof runId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(runId)))].slice(-100)
            : [];
          for (const runId of candidates) {
            try {
              const summary = await this.evidence.loadSummary(runId);
              if (summary.execution?.sessionId === metadata.sessionId) borrowedRunIds.push(runId);
            } catch { /* Stale or changed Run references are not restored into the session inventory. */ }
          }
          const network = this.createSessionNetwork(metadata.sessionId, metadata.headful);
          const owner = new WebTaskSession({ startUrl: metadata.targetUrl, headless: !metadata.headful, restrictToOrigin: true,
            executablePath: this.config.surfaces.web?.executablePath ?? process.env.PROOFKIT_BROWSER_PATH,
            ...(network ? { onNetworkEvent: (event) => network.record(event) } : {}),
            ...(network?.recordingOptions() ? { recordVideo: network.recordingOptions() } : {}),
            onRecordingStopped: async (reason) => {
              await network?.finish(true, owner.recordingStatus(), reason, owner.selectedPageRecording());
              await this.deletePersistedSession(metadata.sessionId);
            },
            borrowedRunIds,
            storageStateLoader: async () => state as NonNullable<Parameters<import("playwright-core").Browser["newContext"]>[0]>["storageState"],
            storageStateSaver: async (next) => this.persistSessionState(metadata, next),
          });
          this.interactiveWebSessions.set(metadata.sessionId, { id: metadata.sessionId, ...(metadata.sessionLabel ? { label: metadata.sessionLabel } : {}), createdAt: metadata.createdAt, targetUrl: metadata.targetUrl, headful: metadata.headful, owner, network, busy: false });
        } catch { /* corrupt or key-mismatched state remains unavailable and is ignored */ }
      }
    })();
    await this.persistedSessionsLoaded;
  }

  private async persistSessionState(metadata: PersistedSessionMetadata, state: unknown): Promise<void> {
    if (!this.sessionPersistence) return;
    await mkdir(this.sessionPersistence.directory, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sessionPersistence.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    await atomicWriteJson(resolve(this.sessionPersistence.directory, metadata.stateFile), { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
    await atomicWriteJson(resolve(this.sessionPersistence.directory, `${metadata.sessionId}.json`), metadata);
  }

  private async deletePersistedSession(sessionId: string): Promise<void> {
    if (!this.sessionPersistence) return;
    await Promise.all([
      unlink(resolve(this.sessionPersistence.directory, `${sessionId}.json`)).catch(() => {}),
      unlink(resolve(this.sessionPersistence.directory, `${sessionId}.state.json`)).catch(() => {}),
    ]);
  }

  private async inspectSurfaceRun(input: SurfaceInspectionInput, binding?: BenchmarkMissionBinding): Promise<SurfaceInspection> {
    if (binding) this.benchmarkMissionBindings.set(input, binding);
    return this.inspectSurface(input);
  }

  listCharters(): ProofkitConfig["charters"] {
    return this.config.charters;
  }

  listSuites(): ProofkitConfig["suites"] {
    return this.config.suites;
  }

  private async loadCandidateCharter(path: string, digest: string): Promise<{ charter: TestCharter; sha256: string }> {
    // Readiness and Mission creation share the same bounded, digest-pinned
    // admission path. A catalog file must retain its registered identity.
    const loaded = await readWorkspaceCharterFile(this.workspaceRoot, path, digest);
    const selectedPath = resolveWithinWorkspace(this.workspaceRoot, path);
    if (this.config.charters.some((entry) => {
      try { return sameProjectPath(resolveWithinWorkspace(this.workspaceRoot, entry.path), selectedPath); }
      catch { return false; }
    })) {
      throw new Error("Candidate Charter is already registered; select its charterId instead");
    }
    return loaded;
  }

  async createMission(input: MissionCreateOptions): Promise<TestMission> {
    input.signal?.throwIfAborted();
    await this.loadPersistedSessions();
    if (input.charterPath !== undefined) {
      if (input.surface === "api") throw new Error("Mission surface is not enabled by the local runner: api");
      if (!input.charterSha256) throw new Error("Candidate Charter path requires the SHA-256 returned by scope inspection");
      if (input.charter || input.charterId || input.suiteId) throw new Error("Candidate Charter path cannot be combined with a submitted Charter or catalog selection");
      if (input.url || input.expect?.length || input.oracleNames?.length || input.mode || input.sideEffectPolicy) {
        throw new Error("Candidate Charter path cannot be combined with ad-hoc planning options");
      }
      const loaded = await this.loadCandidateCharter(input.charterPath, input.charterSha256);
      const requestedLevel = resolveTestLevel(input.intent, input.level).resolved;
      if (loaded.charter.level !== requestedLevel) {
        throw new Error(`Candidate Charter level ${loaded.charter.level} does not match requested level ${requestedLevel}`);
      }
      const requestedSurface = selectMissionSurface(input.intent, input.surface ?? input.adapter);
      const requiredSurfaces = requiredCatalogSurfaces(requestedLevel, requestedSurface, loaded.charter.surfaces);
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
    const retainedSession = input.sessionId ? this.interactiveWebSessions.get(input.sessionId) : undefined;
    if (input.sessionId) {
      if (surface !== "web") throw new Error("A retained surface session can only be used by a Web Mission");
      if (!retainedSession || !retainedSession.owner.reusable) throw new Error("Surface session is missing or unavailable");
      if (input.url && new URL(input.url).href !== retainedSession.targetUrl) throw new Error("Mission URL does not match the retained surface session target");
    }
    const missionHeadful = input.headful ?? retainedSession?.headful ?? false;
    const sessionContext = retainedSession ? await this.captureSessionContext(retainedSession) : undefined;
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
    if (input.charter && input.mode && input.mode !== input.charter.mode) {
      throw new Error(`Submitted Charter mode ${input.charter.mode} conflicts with top-level mode ${input.mode}`);
    }
    if (input.charter && input.sideEffectPolicy && input.sideEffectPolicy !== input.charter.sideEffectPolicy) {
      throw new Error(`Submitted Charter sideEffectPolicy ${input.charter.sideEffectPolicy} conflicts with top-level sideEffectPolicy ${input.sideEffectPolicy}`);
    }
    const hasAdHocOptions = Boolean(input.url || input.expect?.length || input.oracleNames?.length
      || (!input.charter && (input.mode || input.sideEffectPolicy)));
    if (input.charter && (input.url || input.expect?.length || input.oracleNames?.length)) {
      throw new Error("A submitted Charter cannot be combined with top-level url, expect or oracleNames");
    }
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
        webVisibility: missionHeadful ? "headful" : "headless",
        surfaceSessionId: input.sessionId,
        sessionContext,
        policy: { ...input.policy, level: suite.level, sideEffectPolicy, timeoutMs },
      });
    }
    let charter: TestCharter;
    if (input.charter) {
      const submitted = TestCharterSchema.parse(input.charter);
      charter = this.restrictWebOrigins || submitted.planning
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
        ...(saved.level === "release" ? { surfaces: saved.surfaces ?? selected.entry.surfaces } : {}),
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
        adapter: surface,
        sessionId: input.sessionId,
        headful: missionHeadful,
        signal: input.signal,
      });
    }
    if (charter.level !== levelSelection.resolved) {
      throw new Error(`Charter level ${charter.level} does not match requested level ${levelSelection.resolved}`);
    }
    const requestedSurfaces = requiredCatalogSurfaces(levelSelection.resolved, surface, charter.surfaces);
    if (charter.surfaces && !requestedSurfaces.every((required) => charter.surfaces?.includes(required))) {
      throw new Error(`Charter does not support the requested ${requestedSurfaces.join(" + ")} surface matrix`);
    }
    const normalizedCharter = TestCharterSchema.parse({ ...charter,
      levelSelection: charter.levelSelection ?? levelSelection,
      ...(projectMap ? { planning: withPlanningCoverage(charter.planning, coverage) } : {}),
    });
    if (normalizedCharter.httpOracles?.length) this.validateInlineHttpOracles("Submitted Charter", normalizedCharter);
    if (selected) this.validateCatalogCharter(selected.entry.id, normalizedCharter, surface);
    else if (input.charter && this.restrictWebOrigins) this.validateMissionCharterSafety("Submitted Charter", normalizedCharter, surface);
    assertMissionSurfaceCoverage(input.intent, requestedSurfaces);
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
      webVisibility: missionHeadful ? "headful" : "headless",
      surfaceSessionId: input.sessionId,
      sessionContext,
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
    const entry = this.config.charters.find((item) => item.id === id);
    if (charter.level === "release" && charter.surfaces && entry
      && JSON.stringify([...charter.surfaces].sort()) !== JSON.stringify([...entry.surfaces].sort())) {
      throw new Error(`Test catalog entry ${id} and saved Charter declare conflicting release surfaces`);
    }
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
      if (this.restrictWebOrigins && configured && !isAllowedMcpApiUrl(configured.url, this.config.surfaces.web?.apiOrigins)) {
        throw new Error(`${label} requires a loopback Oracle or an explicitly configured API origin in MCP mode: ${oracle}`);
      }
      const inline = charter.httpOracles?.find((item) => item.name === oracle);
      if (this.restrictWebOrigins && inline && !isAllowedMcpApiUrl(inline.url, this.config.surfaces.web?.apiOrigins)) {
        throw new Error(`${label} requires a loopback inline Oracle or an explicitly configured API origin in MCP mode: ${oracle}`);
      }
    }
    const availableCapabilities = new Map(this.capabilities.map((capability) => [capability.name, capability]));
    const scenarios = [{ actions: charter.actions, sideEffectPolicy: charter.sideEffectPolicy }, ...(charter.negativeCases ?? [])];
    for (const scenario of scenarios) {
      for (const action of scenario.actions) {
        if (this.restrictWebOrigins && (action.kind === "click" || action.kind === "fill" || action.kind === "press" || action.kind === "selectOption" || action.kind === "selectOptions" || action.kind === "setChecked" || action.kind === "setInputFiles" || action.kind === "captureResponse") && scenario.sideEffectPolicy !== "allow") {
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
    const issue = firstInlineOracleIssue(charter, registered, this.restrictWebOrigins, this.config.surfaces.web?.apiOrigins);
    if (!issue) return;
    if (issue.code === "duplicate-name") throw new Error(`${label} has duplicate inline Oracle names`);
    if (issue.code === "registered-name-conflict") throw new Error(`${label} inline Oracle shadows a registered Oracle: ${issue.name}`);
    if (issue.code === "origin-disallowed") throw new Error(`${label} inline Oracle must use loopback or an explicitly configured API origin in MCP mode: ${issue.name}`);
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
      return this.missionStatus(current.missionId);
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
    return this.missionStatus(current.missionId);
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
    const safeId = validateMissionId(missionId);
    const running = await this.missionAgent.isRunning(safeId);
    let mission = await this.missionAgent.load(safeId);
    let active = running || await this.missionAgent.isRunning(safeId);
    if (!active && mission.status === "running") {
      mission = await this.missionAgent.load(safeId);
      active = await this.missionAgent.isRunning(safeId);
    }
    return { mission, running: active };
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
    repairSourceAudits: RepairSourceAudit[];
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
    const { mission, running } = await this.missionStatus(missionId);
    const sourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state")?.data);
    const finalSourceState = SourceStateSchema.safeParse([...mission.observations].reverse().find((item) => item.kind === "project.source-state-final")?.data);
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
    const repairSourceAudits = await auditRepairSources(this.root, mission.repairSuggestions);
    const sessionCaptures = await auditSessionCaptures({ mission, workspaceRoot: this.workspaceRoot, projectRoot: this.root, store: this.evidence, loadRun: loadAuditRun });
    const observation = mission.charter?.surfaceObservation;
    const planningObservation = observation ? { observation, ...await auditPlanningObservation(this.evidence, observation, { projectRoot: this.root, workspaceRoot: this.workspaceRoot,
      sessionId: mission.surfaceSessionId, actions: [...mission.charter!.actions, ...(mission.charter!.negativeCases ?? []).flatMap((negative) => negative.actions)] }) } : undefined;
    let summary: MissionResult = { ...projectMissionResult(mission, { workspaceRoot: this.workspaceRoot, running, suiteScope, workflowExecution, agentTraceAudit, workflowReviewAudit, comparison, comparisonUnavailable, proofClassification, executionAudit, sourceFreshness, currentSourceState }), acceptanceEvidenceIntegrity, repairSourceAudits, sessionCaptures, planningObservation };
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
      repairSourceAudits,
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

  /** Append advisory host reasoning under the same ownership used by execution; never mutate a product verdict. */
  async submitRepairHypothesis(value: RepairHypothesisInput) {
    const input = RepairHypothesisInputSchema.parse(value);
    const lease = await this.missionStore.acquireExecution(input.missionId);
    if (!lease) throw new Error("Mission is owned by another operation; wait for it to finish before submitting a hypothesis");
    try {
      const mission = await this.missionStore.load(input.missionId);
      if (!["completed", "failed"].includes(mission.status)) throw new Error("A repair hypothesis requires a terminal tested Mission");
      if (mission.revision !== input.expectedRevision) throw new Error("Mission revision changed; read current evidence before submitting a hypothesis");
      const finding = mission.findings.find((item) => item.findingId === input.findingId);
      if (!finding || finding.status !== "confirmed" || !["product", "unknown"].includes(finding.category)) {
        throw new Error("Hypothesis must reference a confirmed product failure or surface mismatch in this Mission");
      }
      const audited = await this.missionEvidence(input.missionId);
      if (audited.testVerdict !== "failed") throw new Error("Current Mission evidence does not support the saved failure; recheck before proposing a repair");
      const evidence = input.evidenceIds.map((id) => {
        const matches = finding.evidence.filter((ref) => ref.evidenceId === id);
        if (matches.length !== 1) throw new Error("Cited evidence must belong to the referenced Finding");
        return matches[0]!;
      });
      if (new Set(input.evidenceIds).size !== input.evidenceIds.length) throw new Error("Evidence IDs must be unique");
      const runIds = new Set(mission.observations.flatMap((item) =>
        item.kind === "surface.run" && typeof item.data.runId === "string" ? [item.data.runId] : []));
      const integrity = await this.missionReports.inspectMissionEvidence(evidence, runIds);
      if (integrity.status !== "intact") throw new Error("Cited failure evidence is unavailable or changed");
      const sourceKeys = input.sourceReferences.map((ref) => `${ref.path}:${ref.startLine}:${ref.endLine}`);
      if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("Source ranges must be unique");
      const { missionId, expectedRevision, ...content } = input;
      const suggestion = RepairSuggestionSchema.parse({
        suggestionId: `repair-host-${sha256(JSON.stringify(content)).slice(0, 24)}`,
        findingId: finding.findingId, charterId: finding.charterId, surface: finding.surface,
        title: input.title, rationale: input.rationale, changes: input.changes, confidence: input.confidence,
        evidence, status: "proposed", hypothesis: {
          origin: "host-agent", causeStatus: "hypothesis", sourceScope: "current-checkout",
          sourceReferences: input.sourceReferences, regressionCheck: input.regressionCheck, submittedAt: new Date().toISOString(),
        },
      });
      const sourceAudit = (await auditRepairSources(this.root, [suggestion]))[0]!;
      if (sourceAudit.references.some((ref) => ref.status !== "matching")) {
        throw new Error("Source references are missing, changed or outside the valid line range; inspect current source again");
      }
      const existing = mission.repairSuggestions.find((item) => item.suggestionId === suggestion.suggestionId);
      if (existing) return { missionId, revision: mission.revision, suggestion: existing, sourceAudit, testVerdict: "not-asserted" as const };
      if (mission.repairSuggestions.filter((item) => item.hypothesis).length >= 10) throw new Error("This Mission already contains ten host hypotheses; use a new tested Mission");
      mission.repairSuggestions.unshift(suggestion);
      mission.revision += 1;
      mission.updatedAt = suggestion.hypothesis!.submittedAt;
      await this.missionStore.save(mission);
      return { missionId, revision: mission.revision, suggestion, sourceAudit, testVerdict: "not-asserted" as const };
    } finally { await lease.release(); }
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
       webVisibility: previous.plan.executionProfile.webVisibility,
       surfaceSessionId: previous.surfaceSessionId,
      sessionContext: previous.sessionContext,
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

  private missionUsesHeadfulWeb(mission: TestMission): boolean {
    return mission.plan.executionProfile.webVisibility === "headful";
  }

  private missionSurfaceSessionId(mission: TestMission, adapter: LocalAdapterName): string | undefined {
    return adapter === "web" ? mission.surfaceSessionId : undefined;
  }

  private createMissionTools(): MissionTool[] {
    type MissionToolContext = Parameters<NonNullable<MissionTool["execute"]>>[1];
    type SurfaceRunKind = "primary" | "replay" | "negative";
    const binding = (context: MissionToolContext, runKind: BenchmarkMissionBinding["runKind"]): BenchmarkMissionBinding => ({
      missionId: context.mission.missionId, missionTaskId: context.task.taskId, tool: context.task.tool, runKind,
    });

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
      const result = await this.inspectSurfaceRun({ adapter: context.mission.surface, headful: this.missionUsesHeadfulWeb(context.mission), sessionId: this.missionSurfaceSessionId(context.mission, context.mission.surface as LocalAdapterName), signal: context.signal }, binding(context, "inspection"));
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
          executionVisibility: summary.execution?.visibility,
          executionSessionId: summary.execution?.sessionId,
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
      const started = await this.startRun({ charter, adapter, headful: this.missionUsesHeadfulWeb(context.mission), sessionId: this.missionSurfaceSessionId(context.mission, adapter), signal: context.signal, replayOfRunId: baselineRunId, coverageRouteTargets }, binding(context, "primary"));
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
      const started = await this.replayRun(sourceRunId, { adapter, headful: this.missionUsesHeadfulWeb(context.mission), sessionId: this.missionSurfaceSessionId(context.mission, adapter), signal: context.signal, coverageRouteTargets }, binding(context, "replay"));
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
      const started = await this.startRun({ charter, adapter, headful: this.missionUsesHeadfulWeb(context.mission), sessionId: this.missionSurfaceSessionId(context.mission, adapter), signal: context.signal, replayOfRunId: baselineRunId }, binding(context, "negative"));
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

  private async captureSessionContext(session: InteractiveWebSession): Promise<NonNullable<TestMission["sessionContext"]>> {
    const history = session.owner.borrowedRunIds();
    const runs: NonNullable<TestMission["sessionContext"]>["runs"] = [];
    for (const runId of history.slice(-20)) {
      try {
        const summary = await this.loadRunSummary(runId);
        if (summary.status !== "completed" || summary.execution?.sessionId !== session.id) continue;
        const refs = this.runEvidence(summary);
        const evidence = ["snapshot", "report", "network", "screenshot"].flatMap((kind) => {
          const ref = refs.find((item) => kind === "snapshot" ? item.path.endsWith("/run.json") || item.path.endsWith("\\run.json") : item.kind === kind);
          return ref ? [ref] : [];
        });
        runs.push({ runId, startedAt: summary.startedAt, evidence });
      } catch {}
    }
    return { sessionId: session.id, capturedAt: new Date().toISOString(), runs, omittedRuns: history.length - runs.length,
      ...(session.network ? { captureRunId: session.network.runId } : {}) };
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

  async plan(intent: string | undefined, options: LocalPlanOptions = {}): Promise<TestCharter> {
    if (options.sessionLabel && !options.keepSession) throw new Error("A planning session label requires keepSession=true");
    if (!options.keepSession) return this.planObserved(intent, options);
    options.signal?.throwIfAborted();
    if (options.sessionId || options.continuation || options.inspections || options.surfaceSnapshot) throw new Error("New retained planning requires a fresh observation, not an existing session, continuation or caller snapshot");
    if ((options.adapter ?? "web") !== "web") throw new Error("Retained planning currently supports Web only");
    if (typeof intent !== "string" || !intent.length) throw new Error("Planning requires an intent");
    const inspection = await this.inspectSurface({ adapter: "web", url: options.url, headful: options.headful,
      keepSession: true, sessionLabel: options.sessionLabel, signal: options.signal });
    let handedOff = false;
    try {
      if (inspection.status !== "observed" || !inspection.sessionId || !inspection.manifest) throw new PlanningObservationError(inspection);
      const charter = await this.planObserved(intent, { ...options, keepSession: undefined, sessionId: inspection.sessionId,
        inspections: [{ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }] });
      handedOff = true;
      return charter;
    } catch (error) {
      if (error instanceof PlanningObservationError && error.continuation?.savedPlan && error.continuation.sessionId === inspection.sessionId) handedOff = true;
      throw error;
    } finally {
      if (!handedOff && inspection.sessionId) await this.closeSurfaceSession(inspection.sessionId);
    }
  }

  private async planObserved(intent: string | undefined, options: LocalPlanOptions): Promise<TestCharter> {
    options.signal?.throwIfAborted();
    const resumed = options.continuation ? await loadPlanningContinuation(this.workspaceRoot, this.root, options.continuation) : undefined;
    if (resumed) {
      if (options.surfaceSnapshot) throw new Error("Planning continuation requires original pinned inspections, not a caller snapshot");
      assertResumeRequirements(resumed.request, { intent, adapter: options.adapter, url: options.url, expect: options.expect, oracleNames: options.oracleNames,
        mode: options.mode, sideEffectPolicy: options.sideEffectPolicy, level: options.level, coverage: options.coverage, sessionId: options.sessionId, headful: options.headful });
      const { intent: savedIntent, ...requirements } = resumed.request;
      intent = savedIntent;
      options = { ...options, ...requirements, inspections: mergePlanningInspections(resumed.inspections, options.inspections ?? []) };
    }
    if (typeof intent !== "string" || intent.length === 0) throw new Error("Planning requires an intent or a saved continuation");
    assessPlanningCoverage(intent, undefined, options.coverage);
    const submitted = options.charter === undefined ? undefined : TestCharterSchema.parse(options.charter);
    if (submitted) {
      if (Buffer.byteLength(JSON.stringify(submitted)) > MAX_CANDIDATE_BYTES) throw new Error("Submitted planning Charter exceeds the 128 KiB draft limit");
      this.validateInlineHttpOracles("Submitted planning Charter", submitted);
      if (options.mode && options.mode !== submitted.mode) throw new Error("Submitted planning Charter mode conflicts with the requested mode");
    }
    if (options.sessionId) await this.loadPersistedSessions();
    if (options.surfaceSnapshot && options.sessionId) throw new Error("Use sessionId for a fresh bound observation, or supply a snapshot without claiming its session source");
    if (options.inspections && options.surfaceSnapshot) throw new Error("Supply pinned inspections or one caller snapshot, not both");
    const inspectionPins = options.inspections === undefined ? undefined : PlanningInspectionPinSchema.array().min(1).max(10)
      .refine((pins) => new Set(pins.map((pin) => pin.runId)).size === pins.length, "Each planning inspection must be distinct").parse(options.inspections);
    const selectedSession = options.sessionId ? this.interactiveWebSessions.get(options.sessionId) : undefined;
    if (options.sessionId && (!selectedSession || !selectedSession.owner.reusable)) throw new Error("Surface session is missing or unavailable");
    const levelSelection = resolveTestLevel(intent, options.level ?? submitted?.level);
    const levelProfile = getTestLevelProfile(levelSelection.resolved);
    const policy = options.sideEffectPolicy ?? submitted?.sideEffectPolicy ?? this.config.policies.sideEffects;
    if (this.restrictWebOrigins && policy === "allow" && this.config.policies.sideEffects !== "allow") {
      throw new Error("MCP interactive planning requires sideEffects=allow in project config");
    }
    const constraints = {
      url: options.url ?? selectedSession?.targetUrl ?? this.config.surfaces.web?.baseUrl,
      expect: options.expect,
      mode: options.mode,
      sideEffectPolicy: policy,
      oracleNames: options.oracleNames,
      level: levelSelection.resolved,
      coverage: options.coverage,
      requireAssertions: levelProfile.evidencePolicy.requireAssertions,
      requireBusinessOracle: levelProfile.evidencePolicy.requireBusinessOracle,
      allowedActionKinds: policy === "allow"
        ? ["goto", "switchPage", "click", "fill", "press", "selectOption", "selectOptions", "setChecked", "setInputFiles", "captureResponse", "waitForText", "waitForValue", "screenshot", "observe"]
        : ["goto", "switchPage", "waitForText", "waitForValue", "screenshot", "observe"],
      allowedOracleNames: [...new Set([
        ...this.config.oracles.map((oracle) => oracle.name),
        ...this.oracles.map((oracle) => oracle.name),
        ...(submitted?.httpOracles ?? []).map((oracle) => oracle.name),
      ])],
    };
    const provider: PlannerProvider | undefined = submitted ? { name: "submitted-charter", plan: async () => ({ ...submitted, intent }) }
      : this.plannerProvider ?? this.createPlannerProvider();
    const projectMap = await this.discover();
    let surfaceSnapshot = options.surfaceSnapshot;
    let surfaceObservations: SurfaceObservedState[] | undefined;
    let planningObservation: TestCharter["surfaceObservation"];
    let planningInspection: SurfaceInspection | undefined;
    if (inspectionPins) {
      surfaceObservations = [];
      const sources: NonNullable<NonNullable<TestCharter["surfaceObservation"]>["sources"]> = [];
      let contextBytes = 0;
      for (const pin of inspectionPins) {
        options.signal?.throwIfAborted();
        const loaded = await loadPinnedPlanningObservation(this.evidence, pin, { projectRoot: this.root, workspaceRoot: this.workspaceRoot,
          adapter: options.adapter ?? "web", sessionId: options.sessionId }).catch(() => { throw new PlanningObservationError(); });
        const state = { observationId: pin.runId, snapshot: loaded.snapshot };
        contextBytes += Buffer.byteLength(JSON.stringify(state));
        if (contextBytes > 256 * 1024) throw new Error("Planning observations exceed the 256 KiB context budget; use fewer or more focused inspections");
        surfaceObservations.push(state);
        sources.push({ capturedAt: loaded.observation.capturedAt, controlsTruncated: loaded.observation.controlsTruncated, source: loaded.observation.source! });
      }
      planningObservation = { capturedAt: sources[0]!.capturedAt, controlsTruncated: sources.some((state) => state.controlsTruncated),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}), sources };
    }
    if ((provider || options.sessionId) && !surfaceSnapshot && !inspectionPins) {
      const adapter = options.adapter ?? "web";
      if (adapter === "web" && !constraints.url && !this.config.surfaces.web?.cdpUrl) throw new PlanningObservationError();
      const inspection = await this.inspectSurface({ adapter, ...(adapter === "web" ? { url: constraints.url } : {}),
        sessionId: options.sessionId, headful: options.headful, signal: options.signal });
      planningInspection = inspection;
      if (inspection.status !== "observed" || !inspection.snapshot) throw new PlanningObservationError(inspection);
      const summary = await this.loadRunSummary(inspection.inspectionId);
      const observed = summary.steps.find((step) => step.action.kind === "observe" && step.status === "passed");
      const snapshotPath = observed ? `${summary.runId}/artifacts/${observed.stepId}-after.json` : undefined;
      const snapshotRef = snapshotPath ? inspection.evidence.find((ref) => sameProjectPath(ref.path, resolve(this.evidenceDir, snapshotPath))) : undefined;
      if (!observed || !snapshotPath || !snapshotRef?.sha256 || summary.execution?.sessionId !== options.sessionId) throw new PlanningObservationError(inspection);
      const manifest = inspection.manifest;
      if (!manifest) throw new PlanningObservationError(inspection);
      planningObservation = { capturedAt: inspection.snapshot.capturedAt, controlsTruncated: Boolean(inspection.snapshot.controlsTruncated),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}), source: { runId: summary.runId, manifestSha256: manifest.sha256,
          snapshotPath, snapshotSha256: snapshotRef.sha256.toLowerCase() } };
      surfaceSnapshot = inspection.snapshot;
      const audit = await auditPlanningObservation(this.evidence, planningObservation, { projectRoot: this.root, workspaceRoot: this.workspaceRoot,
        adapter: summary.execution?.adapter, sessionId: options.sessionId });
      if (audit.status !== "verified") throw new PlanningObservationError(inspection);
    }
    options.signal?.throwIfAborted();
    let charter: TestCharter;
    if (provider) {
      try {
        charter = await new StructuredPlanner(provider, submitted ? "submitted" : undefined).plan({ intent, projectMap, constraints, surfaceSnapshot, surfaceObservations, signal: options.signal });
      } catch (error) {
        if (!(error instanceof PlanningObservationRequestError)) throw error;
        if (!planningObservation) throw new PlanningObservationError(planningInspection);
        const audit = await auditPlanningObservation(this.evidence, planningObservation, { projectRoot: this.root, workspaceRoot: this.workspaceRoot,
          adapter: options.adapter ?? "web", sessionId: options.sessionId, actions: error.request.action ? [error.request.action] : [] });
        if (audit.status !== "verified") throw new PlanningObservationError(planningInspection);
        const inspections = planningObservationSources(planningObservation).map((state) => ({ runId: state.source.runId, manifestSha256: state.source.manifestSha256 }));
        const round = (resumed?.round ?? 0) + 1;
        if (round > 10) throw new Error("Planning continuation reached its ten-round observation budget; review the unresolved requirements");
        const savedPlan = await savePlanningContinuation(this.workspaceRoot, this.root, { intent, adapter: options.adapter ?? "web",
          url: constraints.url, expect: constraints.expect, oracleNames: constraints.oracleNames, mode: constraints.mode, sideEffectPolicy: policy,
          level: levelSelection.resolved, coverage: assessPlanningCoverage(intent, undefined, options.coverage).requested,
          sessionId: options.sessionId, headful: options.headful ?? selectedSession?.headful ?? false }, inspections, round);
        throw new PlanningObservationError(planningInspection, { request: error.request, inspections, savedPlan,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
      }
    } else {
      const draft = new IntentPlanner().plan(intent, { ...constraints, surfaceSnapshot, surfaceObservations });
      charter = TestCharterSchema.parse({
        ...draft,
        planning: assessPlanningQuality(draft, { projectMap, constraints, source: "deterministic", surfaceSnapshot, surfaceObservations }),
      });
    }
    options.signal?.throwIfAborted();
    if (planningObservation) {
      charter = TestCharterSchema.parse({ ...charter, surfaceObservation: planningObservation });
      const audit = await auditPlanningObservation(this.evidence, planningObservation, { projectRoot: this.root, workspaceRoot: this.workspaceRoot,
        sessionId: options.sessionId, actions: [...charter.actions, ...(charter.negativeCases ?? []).flatMap((negative) => negative.actions)] });
      if (audit.status !== "verified") throw new PlanningObservationError(planningInspection);
    }
    if (charter.sideEffectPolicy !== constraints.sideEffectPolicy) throw new Error("Planner changed the side-effect policy");
    if ([...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((item) => item.oracles)].some((name) => !constraints.allowedOracleNames.includes(name))) throw new Error("Planner referenced an unregistered oracle");
    if (options.oracleNames && (charter.oracles?.length !== options.oracleNames.length || options.oracleNames.some((name) => !charter.oracles?.includes(name)))) {
      throw new Error("Planner changed the requested business oracles");
    }
    const plannedActions = [...charter.actions, ...(charter.negativeCases ?? []).flatMap((item) => item.actions)];
    if (provider && plannedActions.some((action) => action.kind === "goto")) {
      const approvedUrl = constraints.url;
      if (!approvedUrl) throw new Error("Model navigation requires a configured Web URL or --url");
      const approvedOrigin = new URL(approvedUrl).origin;
      for (const action of plannedActions) {
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
    const directIntent = !input.charter && !input.charterPath && Boolean(input.intent);
    const planningInput = directIntent ? await this.resolveCharter(input) : undefined;
    if (planningInput) this.validateWebOrigins(planningInput, { url: input.url });
    if (planningInput?.planning?.evidenceGaps.some((gap) => ["business-oracle", "surface-assertion", "surface-selector", "surface-page"].includes(gap))) {
      throw new PlanningRequirementsError([
        ...planningInput.planning.missingInputs,
        ...planningInput.planning.evidenceGaps.map((gap) => `evidence gap: ${gap}`),
      ], planningInput);
    }
    if (planningInput) this.preplannedCharters.set(input, planningInput);
    const prepared = this.interactiveSessionInputs.has(input) ? input : this.claimRunSession(input);
    if (prepared !== input && planningInput) this.preplannedCharters.set(prepared, planningInput);
    if (this.reconnaissanceInputs.has(input)) this.reconnaissanceInputs.add(prepared);
    if (this.preparedSessionInputs.has(input)) this.preparedSessionInputs.add(prepared);
    let sourceLease: LocalExecutionLease | undefined;
    try {
      sourceLease = prepared.replayOfRunId ? await this.acquireReplaySource(prepared.replayOfRunId) : undefined;
      const binding = this.benchmarkMissionBindings.get(input);
      if (binding) this.benchmarkMissionBindings.set(prepared, binding);
      return await this.startWithSourceLease(prepared, sourceLease, binding);
    }
    catch (error) {
      this.releaseRunSession(prepared);
      await sourceLease?.release();
      throw error;
    }
  }

  private async startRun(input: LocalRunInput, binding?: BenchmarkMissionBinding): Promise<LocalRunStatus> {
    if (binding) this.benchmarkMissionBindings.set(input, binding);
    return this.start(input);
  }

  private async startWithSourceLease(input: LocalRunInput, sourceLease?: LocalExecutionLease, binding?: BenchmarkMissionBinding): Promise<LocalRunStatus> {
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
    const promise = this.execute(runId, input, controller.signal, binding).finally(async () => {
      this.releaseRunSession(input);
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

  async evidenceManifest(runId: string): Promise<{ runId: string; path: string; bytes: number; sha256: string; files: number }> {
    const manifest = await this.evidence.writeManifest(validateRunId(runId));
    return { runId: validateRunId(runId), ...manifest, path: resolve(this.evidenceDir, manifest.path) };
  }

  async verifyEvidenceManifest(runId: string, expectedManifestSha256?: string) {
    return this.evidence.verifyManifest(validateRunId(runId), expectedManifestSha256);
  }

  async evidenceFor(runId: string, section: "summary" | "events" | "report" | "manifest" = "summary", maxChars = 20_000): Promise<{ runId: string; section: string; content: string; truncated: boolean }> {
    const safeRunId = validateRunId(runId);
    await this.loadRunSummary(safeRunId);
    const preview = await this.evidence.readPreview(safeRunId, section, maxChars);
    return { runId: safeRunId, section, ...preview };
  }

  async approveSurfaceReplan(input: { runId: string; stepId: string; selector: string; approve?: boolean }): Promise<{
    status: "awaiting-approval" | "approved";
    proposal: import("@proofkit/contracts").SurfaceReplanProposal;
    charter?: TestCharter;
    run?: LocalRunStatus;
  }> {
    const runId = validateRunId(input.runId);
    const summary = await this.loadRunSummary(runId);
    const step = summary.steps.find((candidate) => candidate.stepId === input.stepId);
    if (!step) throw new Error(`Run step not found: ${input.stepId}`);
    const proposalRef = captureRunEvidence(summary, this.evidenceDir).find((ref) => ref.path.endsWith(`${input.stepId}-replan-proposal.json`));
    if (!proposalRef) throw new Error("Surface replan proposal evidence is missing or unverified");
    const proposalPath = materializedRunArtifact(proposalRef, runId, `${runId}/artifacts/${input.stepId}-replan-proposal.json`, this.evidenceDir);
    if (!proposalPath) throw new Error("Surface replan proposal evidence is unavailable or changed");
    const proposal = SurfaceReplanProposalSchema.parse(JSON.parse(await readFile(proposalPath, "utf8")));
    if (proposal.sourceStepId !== input.stepId || proposal.originalSelector === input.selector) throw new Error("Surface replan proposal does not match the requested replacement");
    if (!proposal.candidates.some((candidate) => candidate.selector === input.selector)) throw new Error("Replacement selector must be one of the observed proposal candidates");
    if (!input.approve) return { status: "awaiting-approval", proposal };
    const index = Number(input.stepId.slice("step-".length)) - 1;
    const original = summary.charter.actions[index];
    if (!original || actionTargetSelectorForReplan(original) !== proposal.originalSelector) throw new Error("Saved Charter action does not match the replan proposal");
    const candidate = proposal.candidates.find((candidate) => candidate.selector === input.selector)!;
    const originalExpectation = actionSurfaceTargets(original)[0]?.expectedTarget;
    if (originalExpectation && !candidate.tag) throw new Error("The proposal lacks a complete control identity; inspect the current surface and submit a reviewed Charter");
    let origin: string | undefined;
    try { const url = new URL(proposal.observedUrl ?? ""); if (["http:", "https:"].includes(url.protocol)) origin = url.origin; } catch {}
    const expectedTarget = candidate.tag ? SurfaceTargetExpectationSchema.parse({ tag: candidate.tag, role: candidate.role,
      name: candidate.name ?? "", groupName: candidate.groupName ?? "", ...(candidate.inputType ? { inputType: candidate.inputType } : {}),
      observedAt: proposal.observedAt, ...(origin ? { origin } : {}) }) : undefined;
    const actions = summary.charter.actions.map((action, actionIndex) => actionIndex === index ? replaceActionTarget(action, input.selector, expectedTarget) : action);
    const charter = TestCharterSchema.parse({ ...summary.charter, actions,
      ...(summary.charter.surfaceObservation ? { surfaceObservation: { capturedAt: proposal.observedAt,
        controlsTruncated: true, ...(summary.charter.surfaceObservation.sessionId ? { sessionId: summary.charter.surfaceObservation.sessionId } : {}) } } : {}),
      metadata: { ...summary.charter.metadata, replanOfRunId: runId, replanSourceStepId: input.stepId,
        replanOriginalSelector: proposal.originalSelector, replanApprovedSelector: input.selector, replanApprovedAt: new Date().toISOString() } });
    const run = await this.start({ charter, replayOfRunId: runId, adapter: (summary.execution?.adapter ?? "web") as LocalAdapterName,
      headful: summary.execution?.visibility === "headful", start: false });
    return { status: "approved", proposal, charter, run };
  }

  async analyzeSurfaceReplanStability(sourceRunId: string, replacementRunIds: string[]): Promise<import("@proofkit/contracts").SurfaceReplanStabilityAnalysis> {
    const sourceId = validateRunId(sourceRunId);
    const ids = [...new Set(replacementRunIds.map(validateRunId))];
    if (ids.length < 1 || ids.length > 20) throw new Error("Surface replan stability analysis requires 1 to 20 replacement Runs");
    const source = await this.loadRunSummary(sourceId);
    const gaps: string[] = [];
    const selectors: string[] = [];
    const latencies: number[] = [];
    let passed = 0, failed = 0, inconclusive = 0;
    for (const id of ids) {
      let summary: RunSummary;
      try { summary = await this.loadRunSummary(id); } catch { gaps.push(`${id}: replacement Run is unavailable`); continue; }
      const metadata = summary.charter.metadata;
      if (metadata.replanOfRunId !== sourceId || summary.execution?.replayOfRunId !== sourceId) {
        gaps.push(`${id}: Run is not an approved replay replacement for ${sourceId}`); continue;
      }
      if (typeof metadata.replanApprovedSelector !== "string") { gaps.push(`${id}: approved selector is missing`); continue; }
      selectors.push(metadata.replanApprovedSelector);
      const verdict = summary.verdict ?? "inconclusive";
      if (verdict === "passed") passed++; else if (verdict === "failed") failed++; else inconclusive++;
      if (typeof metadata.replanApprovedAt === "string" && source.endedAt) {
        const latency = Date.parse(metadata.replanApprovedAt) - Date.parse(source.endedAt);
        if (Number.isFinite(latency) && latency >= 0) latencies.push(latency);
      }
    }
    if (source.verdict !== "failed" && source.verdict !== "inconclusive") gaps.push(`${sourceId}: source Run is not a failed or inconclusive Run`);
    const repeatedSelectorCount = selectors.length - new Set(selectors).size;
    const status = gaps.length ? "inconclusive" : passed > 0 && failed > 0 ? "variable-outcome" : passed > 0 ? "uniform-pass" : failed > 0 ? "uniform-failure" : "inconclusive";
    return SurfaceReplanStabilityAnalysisSchema.parse({ sourceRunId: sourceId, replacementRunIds: ids, approvedSelectors: selectors,
      total: ids.length, passed, failed, inconclusive, repeatedSelectorCount,
      ...(latencies.length ? { meanApprovalLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length } : {}),
      status, gaps: [...new Set(gaps)].slice(0, 20), omittedGaps: Math.max(0, new Set(gaps).size - 20), analyzedAt: new Date().toISOString() });
  }

  async replay(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath"> = {}): Promise<LocalRunStatus> {
    await this.ensureWorkspace();
    const lease = await this.acquireReplaySource(runId);
    try {
      const previous = await this.loadRunSummary(validateRunId(runId));
      return await this.startWithSourceLease({ ...input, charter: previous.charter, replayOfRunId: previous.runId }, lease, this.benchmarkMissionBindings.get(input));
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private async replayRun(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath">, binding?: BenchmarkMissionBinding): Promise<LocalRunStatus> {
    if (binding) this.benchmarkMissionBindings.set(input, binding);
    return this.replay(runId, input);
  }

  private async execute(runId: string, input: LocalRunInput, signal: AbortSignal, binding?: BenchmarkMissionBinding): Promise<RunSummary> {
    if (!this.benchmarkCapture) return this.executeRun(runId, input, signal);
    const capture = await this.benchmarkCapture.begin(runId, binding);
    let adapter: SurfaceAdapter | undefined;
    let summary: RunSummary | undefined;
    try {
      summary = await this.executeRun(runId, input, signal, capture, (created) => { adapter = created; });
      return summary;
    } finally {
      await this.benchmarkCapture.finish(runId, adapter instanceof WebAdapter ? adapter.benchmarkHarManifest() : undefined, summary);
    }
  }

  private async executeRun(runId: string, input: LocalRunInput, signal: AbortSignal,
    capture?: BenchmarkHarOptions, created?: (adapter: SurfaceAdapter) => void): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(this.preplannedCharters.get(input) ?? await this.resolveCharter(input));
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
      if (!isAllowedMcpApiUrl(input.oracleUrl, this.config.surfaces.web?.apiOrigins)) throw new Error("Business oracle URL must use loopback or an explicitly configured API origin");
    }
    if (capture && ((input.adapter ?? "web") !== "web" || input.cdp || this.config.surfaces.web?.cdpUrl)) {
      throw new Error("Benchmark capture requires a new isolated Web context");
    }
    const adapter = this.createAdapter(input, runId, capture);
    created?.(adapter);
    const oracleNames = charter.oracles ?? [];
    if (new Set(oracleNames).size !== oracleNames.length) throw new Error("Duplicate oracle name in Charter");
    const registered = new Map(this.oracles.map((oracle) => [oracle.name, oracle]));
    const configured = oracleNames.map((name) => {
      const projectOracle = registered.get(name);
      if (projectOracle) return projectOracle;
      const definition = this.config.oracles.find((oracle) => oracle.name === name)
        ?? charter.httpOracles?.find((oracle) => oracle.name === name);
      if (!definition) throw new Error(`Oracle is not registered: ${name}`);
      if (this.restrictWebOrigins && !isAllowedMcpApiUrl(definition.url, this.config.surfaces.web?.apiOrigins)) throw new Error(`MCP oracle ${name} must use loopback or an explicitly configured API origin`);
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
    const integration = this.reconnaissanceInputs.has(input) ? undefined : this.integration;
    const integrationSetup = this.preparedSessionInputs.has(input) ? undefined : integration?.setup;
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
    const integrationPreflight = integration?.preflight;
    const integrationPostSetupCheck = integration?.postSetupCheck;
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
      sessionId: input.sessionId,
      ...(input.sessionId && this.interactiveWebSessions.get(input.sessionId)?.preparation
        ? { preparedSession: { sessionId: input.sessionId, preparationRunId: this.interactiveWebSessions.get(input.sessionId)!.preparation!.runId } } : {}),
      sessionCaptureRunId: input.sessionId ? this.interactiveWebSessions.get(input.sessionId)?.network?.runId : undefined,
      preflight,
      postSetupCheck,
      postRunCheck: integration?.postRunCheck,
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
      integration: integration ? { name: integration.name, version: integration.version } : undefined,
      setup: [
        ...(integrationSetup ? [{ setup: integrationSetup, policy: integration?.setupPolicy }] : []),
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
    if (!planning.baseUrl || !planning.model) throw new PlannerConfigurationError("Configure planning.baseUrl and planning.model in the test workspace .proofkit/config.yaml; planning.apiKeyEnv optionally names the API key environment variable");
    if (this.restrictWebOrigins && !isLoopback(new URL(planning.baseUrl).hostname)) throw new Error("MCP planner endpoint must use loopback");
    const apiKey = planning.apiKeyEnv ? process.env[planning.apiKeyEnv] : undefined;
    if (planning.apiKeyEnv && !apiKey) throw new Error(`Planner API key environment variable is missing: ${planning.apiKeyEnv}`);
    return new OpenAICompatiblePlannerProvider({ baseUrl: planning.baseUrl, model: planning.model, apiKey, timeoutMs: planning.timeoutMs });
  }

  private createAdapter(input: LocalRunInput, runId: string, benchmarkHar?: BenchmarkHarOptions): SurfaceAdapter {
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
    const interactiveSession = this.interactiveSessionInputs.get(input);
    return new WebAdapter({
      ...(interactiveSession ? { taskSession: { session: interactiveSession, runId } }
        : benchmarkHar ? this.benchmarkCapture?.webTask
        ? { taskSession: { session: this.benchmarkCapture.webTask, runId: benchmarkHar.runId } }
        : { benchmarkHar } : {}),
      baseUrl: input.url ?? this.config.surfaces.web?.baseUrl,
      cdpUrl: input.cdp ?? this.config.surfaces.web?.cdpUrl,
      targetUrlPrefix: this.config.surfaces.web?.targetUrlPrefix,
      targetTitleContains: this.config.surfaces.web?.targetTitleContains,
      screenshotMaskSelectors: this.config.surfaces.web?.screenshotMaskSelectors,
      routePatterns: input.coverageRouteTargets?.filter((target) => target.kind === "web").map((target) => target.path),
      headless: !input.headful,
      executablePath: this.config.surfaces.web?.executablePath ?? process.env.PROOFKIT_BROWSER_PATH,
      ...(this.config.run.recordVideo ? { recordVideo: {
        directory: resolve(this.evidenceDir, runId, "recording-tmp"),
        path: resolve(this.evidenceDir, runId, "artifacts", "recording.webm"),
        budget: this.config.run.videoBudget,
      } } : {}),
    });
  }

  private validateWebOrigins(charter: TestCharter, input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const urls = [{ value: input.url, api: false }, ...charter.actions.flatMap((action) => action.kind === "goto" ? [{ value: action.url, api: false }]
      : action.kind === "captureResponse" ? [{ value: action.response.url, api: true }] : [])];
    for (const { value, api } of urls) {
      if (!value) continue;
      const parsed = new URL(value);
      if (isAllowedMcpWebUrl(value, this.config.surfaces.web?.baseUrl)) continue;
      if (api && isAllowedMcpApiUrl(value, this.config.surfaces.web?.apiOrigins)) continue;
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

function actionTargetSelectorForReplan(action: Action): string | undefined {
  if (action.kind === "click" || action.kind === "fill" || action.kind === "press" || action.kind === "selectOption"
    || action.kind === "selectOptions" || action.kind === "setChecked" || action.kind === "setInputFiles") return action.selector;
  if (action.kind === "captureResponse") return action.trigger.selector;
  return undefined;
}

function replaceActionTarget(action: Action, selector: string, expectedTarget?: SurfaceTargetExpectation): Action {
  if (action.kind === "click" || action.kind === "fill" || action.kind === "press" || action.kind === "selectOption"
    || action.kind === "selectOptions" || action.kind === "setChecked" || action.kind === "setInputFiles") return { ...action, selector, observationId: expectedTarget?.observationId, ...(expectedTarget ? { expectedTarget } : {}) };
  if (action.kind === "captureResponse") return { ...action, trigger: { ...action.trigger, selector, observationId: expectedTarget?.observationId, ...(expectedTarget ? { expectedTarget } : {}) } };
  throw new Error(`Action ${action.kind} cannot be replanned by selector approval`);
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
