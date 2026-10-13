import { createRunId, EvidenceStore, LocalExecutionOwnership, type LocalExecutionLease } from "@proofkit/evidence";
import { hasIncompleteIntegrationCleanup, IntegrationCheckResultSchema, OracleResultSchema, ResponseObservationSchema, RuntimeFindingSchema, RuntimeQualityPolicySchema, TargetBindingSchema, type IntegrationSetupPolicy, type RuntimeFinding } from "@proofkit/contracts";
import { z } from "zod";
import { InputFileError, inputFileFacts, resolveInputFiles, sameInputFileFacts, type InputFileFact, type SurfaceActionContext } from "./input-files.js";
import { IntegrationLifecycle, releaseLateIntegration, validateSetupPolicy, type IntegrationRecoveryContext, type IntegrationSetup, type IntegrationSetupEntry } from "./integration-lifecycle.js";
export { IntegrationLifecycle } from "./integration-lifecycle.js";
export type { IntegrationRecoveryContext } from "./integration-lifecycle.js";
export type { IntegrationSetup, IntegrationSetupEntry, IntegrationSetupHandle, IntegrationSetupContext, IntegrationCleanupContext } from "./integration-lifecycle.js";
export type { SurfaceActionContext, ResolvedInputFile, InputFileFact } from "./input-files.js";
export { resolveInputFiles, sameInputFileFacts } from "./input-files.js";

// Project integrations receive this schema runtime through the loader. This
// avoids forcing every project that adds `.proofkit/integration.mjs` to add a
// hidden zod dependency of its own.
export { z } from "zod";
import type {
  Action,
  ActionReceipt,
  Assertion,
  AssertionResult,
  OracleResult,
  RouteCoverageTarget,
  RunEvent,
  RuntimeQualityPolicy,
  RunSummary,
  SurfaceSnapshot,
  TargetBinding,
  TestCharter,
} from "@proofkit/contracts";

export type AdapterEvent = {
  type: string;
  payload: Record<string, unknown>;
  /** Preserves events captured before the runner subscribes after adapter connection. */
  timestamp?: string;
};

export interface SurfaceAdapter {
  readonly name: string;
  readonly supportsFileInputs?: boolean;
  readonly supportsResponseCapture?: boolean;
  connect(): Promise<void>;
  discover(): Promise<SurfaceSnapshot>;
  snapshot(): Promise<SurfaceSnapshot>;
  act(action: Action, context?: SurfaceActionContext): Promise<ActionReceipt>;
  assert(assertion: Assertion): Promise<AssertionResult>;
  capture(label: string): Promise<Uint8Array | undefined>;
  subscribeEvents(listener: (event: AdapterEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}

export type BusinessOracle = {
  name: string;
  check(context: {
    runId: string;
    charter: TestCharter;
    steps: RunSummary["steps"];
    assertions: AssertionResult[];
    signal?: AbortSignal;
  }): Promise<OracleResult>;
};

export type IntegrationPreflightResult = {
  passed: boolean;
  message: string;
  evidence?: Record<string, string | number | boolean | null>;
};

export type IntegrationPreflight = (context: {
  runId: string;
  charter: TestCharter;
  environment: "test" | "staging" | "local";
  projectRoot?: string;
  workspaceRoot?: string;
  signal: AbortSignal;
}) => Promise<IntegrationPreflightResult>;

/** Explicitly read-only connector check, callable before Mission creation. */
export type IntegrationReadinessCheck = (context: {
  charter: TestCharter;
  environment: "test" | "staging" | "local";
  projectRoot: string;
  workspaceRoot: string;
  signal: AbortSignal;
}) => Promise<IntegrationPreflightResult & { issues?: Array<{ code: string; guidance: string }> }>;

export type ProjectIntegration = {
  name: string;
  version?: string;
  capabilities?: CapabilityDefinition<any, any>[];
  oracles?: BusinessOracle[];
  readiness?: IntegrationReadinessCheck;
  preflight?: IntegrationPreflight;
  postSetupCheck?: IntegrationPreflight;
  postRunCheck?: IntegrationPreflight;
  setup?: IntegrationSetup;
  setupPolicy?: IntegrationSetupPolicy;
  /** Trusted connector reopens resources by their persisted scope; must not replay product actions. */
  recover?: (context: IntegrationRecoveryContext) => Promise<import("@proofkit/contracts").IntegrationResourceCleanup[]>;
};

export type CapabilityDefinition<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  sideEffect: "none" | "read" | "write";
  environments: Array<"test" | "staging" | "local">;
  timeoutMs: number;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute(input: Input, context: { runId: string; signal: AbortSignal }): Promise<Output>;
  evidence(output: Output): Record<string, string | number | boolean | null>;
};

export class BlockedError extends Error {
  override readonly name = "BlockedError";
}

export class CancelledError extends Error {
  override readonly name = "CancelledError";
}

export class RunTimeoutError extends Error {
  override readonly name = "RunTimeoutError";
}

/** A known local attachment conflict may be reported without using an arbitrary lease exception message. */
export class TargetLeaseConflictError extends Error {
  override readonly name = "TargetLeaseConflictError";
  constructor(target: "shared" | "cdp") {
    super(target === "cdp"
      ? "Another Run controls this configured CDP target; retry after it completes."
      : "Another Run controls this configured CDP or WebDriver target; retry after it completes.");
  }
}

/** Stable selector diagnostics contain only counts or control kind, never locator text. */
export class AmbiguousSurfaceTargetError extends Error {
  override readonly name = "AmbiguousSurfaceTargetError";
  constructor(count: number) {
    super(`Action selector matched ${Number.isSafeInteger(count) && count >= 0 ? count : "multiple"} elements; refine the test selector.`);
  }
}

export class InvalidFileInputControlError extends Error {
  override readonly name = "InvalidFileInputControlError";
  constructor() { super("Selected control is not an input[type=file]."); }
}

/** Missing or ambiguous observation is not proof of a product defect. */
export class InconclusiveError extends Error {
  override readonly name = "InconclusiveError";
  constructor(readonly code: string, message: string) { super(message); }
}

export type ExecutionOptions = {
  projectRoot?: string;
  workspaceRoot?: string;
  evidenceDir?: string;
  runId?: string;
  replayOfRunId?: string;
  oracles?: BusinessOracle[];
  capabilities?: CapabilityDefinition<any, any>[];
  environment?: "test" | "staging" | "local";
  allowCapabilityWrites?: boolean;
  allowSetupWrites?: boolean;
  allowFileUploads?: boolean;
  /** Saved facts from the source Run; absent or changed bytes must block a replay. */
  expectedInputFiles?: Record<string, InputFileFact[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
  integration?: { name: string; version?: string };
  preflight?: IntegrationPreflight;
  /** Trusted host check after setup handles are registered, before browser attachment. */
  postSetupCheck?: IntegrationPreflight;
  /** Trusted connector check before surface cleanup; failures invalidate product attribution. */
  postRunCheck?: IntegrationPreflight;
  setup?: IntegrationSetup | Array<IntegrationSetup | IntegrationSetupEntry>;
  setupPolicy?: IntegrationSetupPolicy;
  targetBinding?: (signal: AbortSignal) => Promise<TargetBinding>;
  /** Electron CDP process source association, independent of its HTTP page server. */
  applicationBinding?: (signal: AbortSignal) => Promise<TargetBinding>;
  targetBindingPolicy?: "record" | "block-different";
  targetBindingRecheckAfterSetup?: boolean;
  /** Optional host-owned lease held across setup, surface actions and late cleanup. */
  executionLease?: (signal: AbortSignal) => Promise<LocalExecutionLease | undefined>;
  /** Resolve a target created by setup, then hold its lease before adapter attachment. */
  attachmentLease?: (signal: AbortSignal) => Promise<LocalExecutionLease | undefined>;
  /** Classify adapter runtime signals without conflating them with business truth. */
  runtimeQuality?: z.input<typeof RuntimeQualityPolicySchema>;
  /** Bounded route declarations used to project event URLs without path IDs. */
  urlEvidenceTargets?: RouteCoverageTarget[];
  /** The configured Web/Electron HTTP application origin for Web route patterns. */
  webEvidenceOrigin?: string;
};

export class ExecutionRunner {
  private readonly store: EvidenceStore;
  private readonly adapter: SurfaceAdapter;
  private readonly oracles: BusinessOracle[];
  private readonly capabilities: Map<string, CapabilityDefinition<any, any>>;
  private readonly environment: "test" | "staging" | "local";
  private readonly allowCapabilityWrites: boolean;
  private readonly allowSetupWrites: boolean;
  private readonly allowFileUploads: boolean;
  private readonly expectedInputFiles?: Record<string, InputFileFact[]>;
  private readonly replayOfRunId?: string;
  private readonly setups: IntegrationSetupEntry[];
  private readonly targetBinding?: ExecutionOptions["targetBinding"];
  private readonly applicationBinding?: ExecutionOptions["applicationBinding"];
  private readonly targetBindingPolicy: NonNullable<ExecutionOptions["targetBindingPolicy"]>;
  private readonly targetBindingRecheckAfterSetup: boolean;
  private readonly executionLease?: ExecutionOptions["executionLease"];
  private readonly attachmentLease?: ExecutionOptions["attachmentLease"];
  private readonly signal?: AbortSignal;
  private readonly timeoutMs?: number;
  private readonly integration?: { name: string; version?: string };
  private readonly preflight?: IntegrationPreflight;
  private readonly postSetupCheck?: IntegrationPreflight;
  private readonly postRunCheck?: IntegrationPreflight;
  private readonly projectRoot?: string;
  private readonly workspaceRoot?: string;
  private readonly runtimeQuality: RuntimeQualityPolicy;
  private readonly runtimeAllowPatterns: RegExp[];
  private readonly runtimeIgnorePatterns: RegExp[];
  private readonly runtimeBlockConsolePatterns: RegExp[];
  private readonly urlEvidenceTargets: RouteCoverageTarget[];
  private readonly webEvidenceOrigin?: string;

  constructor(adapter: SurfaceAdapter, options: ExecutionOptions = {}) {
    this.adapter = adapter;
    this.store = new EvidenceStore(options.evidenceDir ?? ".proofkit/runs");
    this.oracles = options.oracles ?? [];
    if (new Set(this.oracles.map((oracle) => oracle.name)).size !== this.oracles.length) throw new Error("Duplicate oracle name");
    this.capabilities = new Map((options.capabilities ?? []).map((capability) => [capability.name, capability]));
    if (this.capabilities.size !== (options.capabilities ?? []).length) throw new Error("Duplicate capability name");
    this.environment = options.environment ?? "test";
    this.allowCapabilityWrites = options.allowCapabilityWrites ?? false;
    this.allowSetupWrites = options.allowSetupWrites ?? this.allowCapabilityWrites;
    this.allowFileUploads = options.allowFileUploads ?? false;
    this.expectedInputFiles = options.expectedInputFiles;
    this.replayOfRunId = options.replayOfRunId;
    const setups = options.setup ? Array.isArray(options.setup) ? options.setup : [{ setup: options.setup, policy: options.setupPolicy }] : [];
    this.setups = setups.map((entry) => {
      const value = typeof entry === "function" ? { setup: entry } : entry;
      return { setup: value.setup, ...(value.policy ? { policy: validateSetupPolicy(value.policy) } : {}) };
    });
    this.targetBinding = options.targetBinding;
    this.applicationBinding = options.applicationBinding;
    this.targetBindingPolicy = options.targetBindingPolicy ?? "block-different";
    this.targetBindingRecheckAfterSetup = options.targetBindingRecheckAfterSetup ?? false;
    this.executionLease = options.executionLease;
    this.attachmentLease = options.attachmentLease;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
    this.integration = options.integration ? { name: options.integration.name, version: options.integration.version } : undefined;
    this.urlEvidenceTargets = options.urlEvidenceTargets ?? [];
    this.webEvidenceOrigin = options.webEvidenceOrigin;
    this.preflight = options.preflight;
    this.postSetupCheck = options.postSetupCheck;
    this.postRunCheck = options.postRunCheck;
    this.projectRoot = options.projectRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.runtimeQuality = RuntimeQualityPolicySchema.parse(options.runtimeQuality ?? {});
    this.runtimeAllowPatterns = compilePatterns(this.runtimeQuality.allowUrlPatterns, "allowUrlPatterns");
    this.runtimeIgnorePatterns = compilePatterns(this.runtimeQuality.ignoreUrlPatterns, "ignoreUrlPatterns");
    this.runtimeBlockConsolePatterns = compilePatterns(this.runtimeQuality.blockConsolePatterns, "blockConsolePatterns");
  }

  async run(charter: TestCharter, runId = createRunId()): Promise<RunSummary> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    const lease = await new LocalExecutionOwnership(this.store.rootDir, "run").acquire(runId);
    if (!lease) throw new Error(`Run ${runId} is active; its resources cannot be acquired twice`);
    const integrationLifecycle = new IntegrationLifecycle(runId, this.store, {
      projectRoot: this.projectRoot, workspaceRoot: this.workspaceRoot, integration: this.integration, environment: this.environment,
    });
    const scopeLeases: LocalExecutionLease[] = [];
    const pendingAcquisitions = new Set<Promise<unknown>>();
    const trackAcquisition = (pending: Promise<unknown>) => {
      pendingAcquisitions.add(pending);
      void pending.then(() => pendingAcquisitions.delete(pending), () => pendingAcquisitions.delete(pending));
    };
    const releaseLeases = async () => {
      const leases = [...scopeLeases].reverse();
      const settled = await Promise.allSettled([...leases.map((scopeLease) => scopeLease.release()), lease.release()]);
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failure) throw failure.reason;
    };
    try { return await this.executeRun(charter, runId, integrationLifecycle,
      (acquired) => { scopeLeases.push(acquired); }, trackAcquisition); }
    finally {
      if (integrationLifecycle.hasPendingCleanup || pendingAcquisitions.size > 0) {
        void Promise.allSettled([integrationLifecycle.whenCleanupSettles(), ...pendingAcquisitions]).then(releaseLeases).catch(() => {});
      }
      else await releaseLeases();
    }
  }

  private async executeRun(charter: TestCharter, runId: string, integrationLifecycle: IntegrationLifecycle,
    retainLease: (lease: LocalExecutionLease) => void,
    trackAcquisition: (pending: Promise<unknown>) => void): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const summary: RunSummary = {
      runId,
      execution: { adapter: this.adapter.name, ...(this.replayOfRunId ? { replayOfRunId: this.replayOfRunId } : {}) },
      projectRoot: this.projectRoot,
      workspaceRoot: this.workspaceRoot,
      startedAt,
      status: "running",
      charter,
      steps: [],
      assertions: [],
      oracles: [],
      runtimeHealth: "passed",
      runtimeFindings: [],
      artifacts: [],
      findings: [],
    };
    await this.store.startRun(summary);
    await this.emit({ runId, timestamp: startedAt, type: "run.started", payload: { adapter: this.adapter.name, ...(this.integration ? { integration: this.integration } : {}) } });

    const controller = new AbortController();
    const detachSignal = relayAbort(this.signal, controller);
    const timeout = this.timeoutMs === undefined ? undefined : setTimeout(() => {
      controller.abort(new RunTimeoutError(`Run exceeded the ${this.timeoutMs}ms deadline`));
    }, this.timeoutMs);
    const signal = controller.signal;
    let executionError: Error | undefined;
    let surfaceAttached = false;
    let unsubscribe: () => void | Promise<void> = () => {};
    let pendingEvents = Promise.resolve();
    let eventEvidenceFailed = false;
    const inspectAndRecordTarget = async (phase: "before-setup" | "after-setup" | "before-attachment" | "after-run"): Promise<TargetBinding | undefined> => {
      if (!this.targetBinding) return undefined;
      const binding = TargetBindingSchema.parse(await withAbort(this.targetBinding(signal), signal, "Target binding inspection"));
      if (phase === "after-run") summary.targetBindingAfterRun = binding;
      else summary.targetBinding = binding;
      const artifact = await this.store.writeJson(runId, phase === "before-setup" ? "target-binding" : `target-binding-${phase}`, binding);
      summary.artifacts.push(artifact);
      await this.emit({ runId, timestamp: binding.observedAt, type: "target.binding", payload: {
        phase, status: binding.status, method: binding.method, targetOrigin: binding.targetOrigin,
        expectedProjectRoot: binding.expectedProjectRoot, observedProjectRoot: binding.observedProjectRoot,
        evidence: artifact,
      } });
      if (phase !== "after-run" && binding.status === "different-project" && this.targetBindingPolicy === "block-different") {
        throw new BlockedError(`Target process belongs to another Git checkout: ${binding.observedProjectRoot}`);
      }
      return binding;
    };
    const inspectAndRecordApplication = async (phase: "before-setup" | "after-setup" | "before-attachment" | "after-run"): Promise<TargetBinding | undefined> => {
      if (!this.applicationBinding) return undefined;
      const binding = TargetBindingSchema.parse(await withAbort(this.applicationBinding(signal), signal, "Application binding inspection"));
      if (phase === "after-run") summary.applicationBindingAfterRun = binding;
      else summary.applicationBinding = binding;
      const artifact = await this.store.writeJson(runId, phase === "before-setup" ? "application-binding" : `application-binding-${phase}`, binding);
      summary.artifacts.push(artifact);
      await this.emit({ runId, timestamp: binding.observedAt, type: "target.binding", payload: {
        role: "application", phase, status: binding.status, method: binding.method, targetOrigin: binding.targetOrigin,
        expectedProjectRoot: binding.expectedProjectRoot, observedProjectRoot: binding.observedProjectRoot, evidence: artifact,
      } });
      if (phase !== "after-run" && binding.status === "different-project" && this.targetBindingPolicy === "block-different") {
        throw new BlockedError(`Application process belongs to another Git checkout: ${binding.observedProjectRoot}`);
      }
      return binding;
    };
    try {
      throwIfAborted(signal);
      for (const { policy } of this.setups) {
        if (policy && !policy.environments.includes(this.environment)) throw new BlockedError("Integration setup is not allowed in this environment");
        if (policy?.sideEffect === "write" && (charter.sideEffectPolicy !== "allow" || !this.allowSetupWrites)) {
          throw new BlockedError("Write setup requires sideEffectPolicy=allow and operator write permission");
        }
      }
      assertFillEnvironment(charter.actions);
      if (charter.actions.some((action) => action.kind === "selectOption" || action.kind === "selectOptions" || action.kind === "setChecked") && charter.sideEffectPolicy !== "allow") {
        throw new BlockedError("Native form actions require sideEffectPolicy=allow");
      }
      if (charter.actions.some((action) => action.kind === "captureResponse")) {
        if (charter.sideEffectPolicy !== "allow") throw new BlockedError("Response capture triggers require sideEffectPolicy=allow");
        if (!this.adapter.supportsResponseCapture) throw new BlockedError(`Response capture is not supported by the ${this.adapter.name} adapter`);
      }
      if (charter.actions.some((action) => action.kind === "setInputFiles")) {
        if (charter.sideEffectPolicy !== "allow" || !this.allowFileUploads) throw new BlockedError("File selection requires sideEffectPolicy=allow and runner allowFileUploads");
        if (!this.adapter.supportsFileInputs) throw new BlockedError(`File selection is not supported by the ${this.adapter.name} adapter`);
      }
      await inspectAndRecordTarget("before-setup");
      await inspectAndRecordApplication("before-setup");
      if (this.preflight) {
        let result: IntegrationPreflightResult;
        try {
          result = preflightResult(await withAbort(this.preflight({
            runId,
            charter,
            environment: this.environment,
            projectRoot: this.projectRoot,
            workspaceRoot: this.workspaceRoot,
            signal,
          }), signal, "Integration preflight"));
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          throw new BlockedError("Integration preflight failed before it returned a verified result; inspect trusted local diagnostics.");
        }
        const artifact = await this.store.writeJson(runId, "preflight", result);
        summary.artifacts.push(artifact);
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "artifact.created", payload: { path: artifact, kind: "preflight", passed: result.passed } });
        if (!result.passed) throw new BlockedError(`Integration preflight failed: ${result.message}`);
      }
      if (this.executionLease) {
        let acquired: LocalExecutionLease | undefined;
        try {
          acquired = await withResourceAbort(this.executionLease(signal), signal, "Workspace execution lease",
            async (lateLease) => { await lateLease?.release(); }, trackAcquisition);
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          if (error instanceof TargetLeaseConflictError) throw new BlockedError(error.message);
          throw new BlockedError("Workspace execution lease could not be acquired; inspect trusted local diagnostics.");
        }
        if (!acquired) throw new BlockedError("Another Run is active in this test workspace; retry after it completes.");
        retainLease(acquired);
      }
      for (const { setup, policy } of this.setups) {
        throwIfAborted(signal);
        integrationLifecycle.begin(policy);
        let handle: Awaited<ReturnType<IntegrationSetup>>;
        try {
          handle = await withResourceAbort(Promise.resolve().then(() => setup({
            runId, charter, environment: this.environment, projectRoot: this.projectRoot, workspaceRoot: this.workspaceRoot,
            signal, emit: (event) => this.emit({ ...event, runId }),
          })), signal, "Project setup", (lateHandle) => releaseLateIntegration(lateHandle, runId), trackAcquisition);
        } catch (error) { integrationLifecycle.acquisitionFailed(); throw error; }
        const setupArtifact = await integrationLifecycle.register(handle, policy);
        if (setupArtifact) {
          summary.artifacts.push(setupArtifact);
          await this.store.writeSummary(summary);
        }
        throwIfAborted(signal);
      }
      if (this.postSetupCheck) {
        let result: IntegrationPreflightResult;
        try {
          result = preflightResult(await withAbort(this.postSetupCheck({
            runId, charter, environment: this.environment, projectRoot: this.projectRoot,
            workspaceRoot: this.workspaceRoot, signal,
          }), signal, "Post-setup check"));
        } catch {
          if (signal.aborted) throw abortReason(signal);
          throw new BlockedError("Post-setup environment check could not establish a verified result.");
        }
        const artifact = await this.store.writeJson(runId, "post-setup-check", result);
        summary.artifacts.push(artifact);
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "artifact.created",
          payload: { path: artifact, kind: "post-setup-check", passed: result.passed } });
        if (!result.passed) throw new BlockedError(`Post-setup environment check failed: ${result.message}`);
      }
      if (this.targetBindingRecheckAfterSetup) {
        await inspectAndRecordTarget("after-setup");
        await inspectAndRecordApplication("after-setup");
      }
      if (this.attachmentLease) {
        let acquired: LocalExecutionLease | undefined;
        try {
          acquired = await withResourceAbort(this.attachmentLease(signal), signal, "Attachment target lease",
            async (lateLease) => { await lateLease?.release(); }, trackAcquisition);
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          throw new BlockedError("Attachment target lease could not be acquired; inspect trusted local diagnostics.");
        }
        if (!acquired) throw new BlockedError("Another Run controls this configured attachment target; retry after it completes.");
        retainLease(acquired);
        // A port file can change after setup checks. Bind evidence to the
        // endpoint that the attachment lease has actually pinned.
        await inspectAndRecordTarget("before-attachment");
        await inspectAndRecordApplication("before-attachment");
      }
      await withResourceAbort(this.adapter.connect(), signal, "Adapter connect", () => this.adapter.close(), trackAcquisition);
      surfaceAttached = true;
      throwIfAborted(signal);
      unsubscribe = await withResourceAbort(this.adapter.subscribeEvents((event) => {
        pendingEvents = pendingEvents.then(() => this.recordAdapterEvent(runId, event, summary)).catch(() => {
          eventEvidenceFailed = true;
        });
      }), signal, "Adapter event subscription", async (release) => { await release(); }, trackAcquisition);
      throwIfAborted(signal);
      for (const [index, action] of charter.actions.entries()) {
        throwIfAborted(signal);
        const stepId = `step-${String(index + 1).padStart(3, "0")}`;
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "step.started", stepId, payload: { action } });
        const step: RunSummary["steps"][number] = { stepId, action, status: "passed", artifacts: [] };
        try {
          if (action.kind === "capability") {
            const { output, receipt } = await this.executeCapability(action, charter, runId, signal);
            step.receipt = receipt;
            step.capabilityOutput = output;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-capability`, { name: action.name, output }));
          } else {
            const beforeSnapshot = await withAbort(this.adapter.snapshot(), signal, `${stepId} snapshot`);
            step.beforeSnapshot = beforeSnapshot;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-before`, beforeSnapshot));
            const runtimeAction = resolveRuntimeAction(action);
            let actionContext: SurfaceActionContext = { signal };
            if (action.kind === "setInputFiles") {
              if (this.expectedInputFiles) step.replayInputMatched = false;
              try {
                actionContext.inputFiles = await withAbort(resolveInputFiles(this.workspaceRoot, action.files, signal), signal, `${stepId} fixture read`);
              } catch (error) {
                if (signal.aborted) throw error;
                throw new BlockedError(error instanceof InputFileError
                  ? error.message : "File fixture could not be read; inspect the external test workspace.");
              }
              const files = inputFileFacts(actionContext.inputFiles!);
              step.inputFiles = files;
              const artifact = await this.store.writeJson(runId, `${stepId}-input-files`, { files });
              step.artifacts.push(artifact);
              await this.emit({ runId, timestamp: new Date().toISOString(), type: "artifact.created", stepId, payload: { path: artifact, kind: "input-files", files } });
              if (this.expectedInputFiles) {
                const expected = this.expectedInputFiles[stepId];
                if (!expected?.length || !sameInputFileFacts(expected, files)) {
                  throw new BlockedError("Replay fixture facts are missing or changed; create a new Mission for different test inputs");
                }
                step.replayInputMatched = true;
              }
            }
            const receipt = await withAbort(this.adapter.act(runtimeAction, actionContext), signal, `${stepId} action`);
            if (action.kind === "captureResponse") {
              const result = ResponseObservationSchema.safeParse(receipt.metadata.response);
              if (!result.success || result.data.name !== action.name || result.data.url !== new URL(action.response.url).href
                || result.data.method !== action.response.method || !action.response.statuses.includes(result.data.status)
                || (action.followUp ? result.data.followUp === undefined : result.data.followUp !== undefined)
                || Object.keys(result.data.fields).length !== Object.keys(action.response.fields).length
                || Object.entries(action.response.fields).some(([name, field]) => {
                  const value = result.data.fields[name];
                  return field.type === "id" ? typeof value !== "string" || !/^[1-9]\d{0,127}$/.test(value) : typeof value !== field.type;
                })) throw new InconclusiveError("missing-response-facts", "Adapter did not return valid facts for this response capture");
              step.response = result.data;
              step.receipt = { ...receipt, metadata: { adapter: this.adapter.name, response: result.data } };
              const artifact = await this.store.writeJson(runId, `${stepId}-response`, result.data);
              step.artifacts.push(artifact);
              await this.emit({ runId, timestamp: result.data.capturedAt, type: "artifact.created", stepId, payload: { path: artifact, kind: "response-observation" } });
            } else {
              step.receipt = actionContext.inputFiles
                ? { ...receipt, metadata: { ...receipt.metadata, inputFiles: inputFileFacts(actionContext.inputFiles) } }
                : receipt;
            }
            const afterSnapshot = await withAbort(action.kind === "observe" ? this.adapter.discover() : this.adapter.snapshot(), signal, `${stepId} snapshot`);
            step.afterSnapshot = afterSnapshot;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-after`, afterSnapshot));
            try {
              const screenshot = await withAbort(this.adapter.capture(`${stepId}.png`), signal, `${stepId} capture`);
              if (screenshot) step.artifacts.push(await this.store.writeBuffer(runId, `${stepId}.png`, screenshot));
            } catch (error) {
              if (signal.aborted) throw abortReason(signal);
              summary.findings.push(`${stepId}: screenshot unavailable; inspect trusted local diagnostics.`);
            }
          }
        } catch (error) {
          const cause = safeRunError(error);
          step.status = cause instanceof BlockedError ? "blocked" : "failed";
          step.error = cause.message;
          if (cause instanceof InconclusiveError) step.artifacts.push(await this.store.writeJson(runId, `${stepId}-response-gap`, { code: cause.code, message: cause.message }));
          executionError = cause;
          summary.findings.push(`${stepId}: ${cause.message}`);
        }
        summary.artifacts.push(...step.artifacts);
        summary.steps.push(step);
        await this.store.writeSummary(summary);
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "step.completed", stepId, payload: { status: step.status, error: step.error } });
        if (step.status !== "passed") break;
      }

      if (!executionError) {
        for (const [index, assertion] of charter.assertions.entries()) {
          throwIfAborted(signal);
          const result = await withAbort(this.adapter.assert(assertion), signal, `Assertion ${index + 1}`);
          const recordedAt = new Date().toISOString();
          const label = `assertion-${String(index + 1).padStart(3, "0")}`;
          const proof: string[] = [];
          try {
            const snapshot = await withAbort(this.adapter.snapshot(), signal, `Assertion ${index + 1} snapshot`);
            proof.push(await this.store.writeJson(runId, `${label}-snapshot`, snapshot));
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            summary.findings.push(`${label}: contemporaneous snapshot unavailable; inspect trusted local diagnostics.`);
          }
          try {
            const screenshot = await withAbort(this.adapter.capture(`${label}.png`), signal, `Assertion ${index + 1} capture`);
            if (screenshot) proof.push(await this.store.writeBuffer(runId, `${label}.png`, screenshot));
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            summary.findings.push(`${label}: contemporaneous screenshot unavailable; inspect trusted local diagnostics.`);
          }
          // Adapter-supplied paths may refer to an earlier step. Only artifacts
          // captured by this Runner after this assertion can confirm its result.
          const recordedResult: AssertionResult = { ...result, evidence: proof, recordedAt };
          summary.assertions.push(recordedResult);
          summary.artifacts.push(...proof);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "assertion.completed", payload: { index, ...recordedResult } });
        }
        for (const oracle of this.oracles) {
          throwIfAborted(signal);
          let parsedResult: OracleResult;
          try {
            parsedResult = OracleResultSchema.parse(await withAbort(oracle.check({ runId, charter, steps: summary.steps, assertions: summary.assertions, signal }), signal, `Oracle ${oracle.name}`));
            if (parsedResult.name !== oracle.name) throw new Error("Oracle result name mismatch");
          } catch {
            if (signal.aborted) throw abortReason(signal);
            // A reader error or invalid connector result cannot establish a product
            // failure. Connector exceptions may contain response bodies or secrets.
            throw new InconclusiveError("oracle-unavailable", `Business Oracle ${summary.oracles.length + 1} could not establish a result; inspect its reader and connector.`);
          }
          const recordedAt = new Date().toISOString();
          // Older project connectors omit the field. Persist an explicit kind
          // for every new Run while keeping their existing business semantics.
          const result: OracleResult = { ...parsedResult, verificationKind: parsedResult.verificationKind ?? "business", recordedAt };
          const sourceFacts = result.evidence.filter((item) => item.trim().length > 0).map((item) => {
            try { return JSON.parse(item) as unknown; } catch { return item; }
          });
          const sourceEvidenceCount = sourceFacts.length;
          const index = summary.oracles.length + 1;
          const sourceEvidenceArtifacts = sourceEvidenceCount > 0
            ? [await this.store.writeJson(runId, `oracle-${index}-source`, { oracle: result.name, facts: sourceFacts })]
            : [];
          const report = { ...result, evidence: sourceEvidenceArtifacts, sourceEvidenceCount, sourceEvidenceArtifacts };
          const artifact = await this.store.writeJson(runId, `oracle-${index}`, report);
          const recordedResult: OracleResult = { ...report, evidence: [...sourceEvidenceArtifacts, artifact] };
          summary.artifacts.push(...sourceEvidenceArtifacts);
          summary.artifacts.push(artifact);
          summary.oracles.push(recordedResult);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "oracle.completed", payload: recordedResult });
        }
      }
    } catch (error) {
      executionError = safeRunError(error);
      summary.findings.push(executionError.message);
    } finally {
      // Check before closing the surface even when an assertion or Oracle
      // threw. A changed target cannot support a claimed product failure.
      if (surfaceAttached && charter.level !== "quick" && summary.targetBinding?.processId) {
        if (signal.aborted) summary.targetContinuity = "unverified";
        else {
          try {
            summary.targetContinuity = compareTargetContinuity(summary.targetBinding, await inspectAndRecordTarget("after-run"));
            if (summary.targetContinuity !== "stable") {
              const gap = new InconclusiveError("target-continuity-unverified", "Target listener changed or could not be verified after this Run.");
              summary.findings.push(gap.message);
              if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
            }
          } catch {
            summary.targetContinuity = "unverified";
            if (!signal.aborted) {
              const gap = new InconclusiveError("target-continuity-unavailable", "Target listener could not be checked after this Run.");
              summary.findings.push(gap.message);
              if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
            }
          }
        }
      }
      if (surfaceAttached && charter.level !== "quick" && summary.applicationBinding?.processId) {
        if (signal.aborted) summary.applicationContinuity = "unverified";
        else {
          try {
            summary.applicationContinuity = compareTargetContinuity(summary.applicationBinding, await inspectAndRecordApplication("after-run"));
            if (summary.applicationContinuity !== "stable") {
              const gap = new InconclusiveError("application-continuity-unverified", "Application listener changed or could not be verified after this Run.");
              summary.findings.push(gap.message);
              if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
            }
          } catch {
            summary.applicationContinuity = "unverified";
            if (!signal.aborted) {
              const gap = new InconclusiveError("application-continuity-unavailable", "Application listener could not be checked after this Run.");
              summary.findings.push(gap.message);
              if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
            }
          }
        }
      }
      if (surfaceAttached && this.postRunCheck && !signal.aborted) {
        try {
          const result = IntegrationCheckResultSchema.parse(await withAbort(this.postRunCheck({
            runId, charter, environment: this.environment, projectRoot: this.projectRoot,
            workspaceRoot: this.workspaceRoot, signal,
          }), signal, "Integration post-run check"));
          summary.integrationPostRunCheck = result;
          const artifact = await this.store.writeJson(runId, "post-run-check", result);
          summary.artifacts.push(artifact);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "artifact.created",
            payload: { path: artifact, kind: "post-run-check", passed: result.passed } });
          if (!result.passed) {
            const gap = new InconclusiveError("integration-post-run-check-failed", "Integration endpoint continuity changed or could not be verified after this Run.");
            summary.findings.push(gap.message);
            if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
          }
        } catch {
          if (!signal.aborted) {
            const gap = new InconclusiveError("integration-post-run-check-unavailable", "Integration endpoint could not be checked after this Run.");
            summary.integrationPostRunCheck = { passed: false, message: gap.message,
              evidence: { checkStatus: "unavailable" } };
            try {
              const artifact = await this.store.writeJson(runId, "post-run-check", summary.integrationPostRunCheck);
              if (!summary.artifacts.includes(artifact)) summary.artifacts.push(artifact);
            } catch { /* The saved Run fact still prevents product attribution. */ }
            summary.findings.push(gap.message);
            if (mayReplaceWithContinuityGap(executionError)) executionError = gap;
          }
        }
      }
      try { await unsubscribe(); } catch (error) { executionError ??= safeRunError(error); summary.findings.push("Adapter event subscription cleanup failed; inspect trusted local diagnostics."); }
      try { await this.adapter.close(); } catch (error) { executionError ??= safeRunError(error); summary.findings.push("Adapter close failed; inspect trusted local diagnostics."); }
      await pendingEvents;
      if (eventEvidenceFailed) {
        summary.findings.push("Adapter runtime event evidence could not be saved; inspect trusted local diagnostics.");
        executionError ??= new InconclusiveError("runtime-evidence-unavailable", "Adapter runtime event evidence is incomplete.");
      }
      if ((summary.runtimeFindings ?? []).length > 0) {
        const artifact = await this.store.writeJson(runId, "runtime-findings", summary.runtimeFindings ?? []);
        summary.artifacts.push(artifact);
      }
      try {
        summary.integrationCleanup = await integrationLifecycle.finish();
        if (summary.integrationCleanup.artifact) summary.artifacts.push(summary.integrationCleanup.artifact);
        if (hasIncompleteIntegrationCleanup(summary.integrationCleanup)) summary.findings.push("Integration cleanup was not established; inspect integration-cleanup.json. Resources may still be active.");
      } catch (error) {
        summary.integrationCleanup = { status: "unverified", declaredResources: 0, verifiedResources: 0 };
        summary.findings.push("Integration cleanup evidence could not be saved; resources may still be active.");
        executionError ??= safeRunError(error);
      }
      if (signal.aborted) {
        executionError = abortReason(signal);
        if (!summary.findings.includes(executionError.message)) summary.findings.push(executionError.message);
      }
      if (timeout) clearTimeout(timeout);
      detachSignal();
    }

    const baseVerdict = executionError
      ? executionError instanceof BlockedError ? "blocked" : executionError instanceof CancelledError || executionError instanceof RunTimeoutError ? "cancelled" : executionError instanceof InconclusiveError ? "inconclusive" : "failed"
      : charter.assertions.length === 0 && this.oracles.length === 0
        ? "inconclusive"
        : summary.assertions.some((result) => !result.passed && result.evidence.length > 0) || summary.oracles.some((result) => result.passed === false)
          ? "failed"
          : summary.assertions.some((result) => result.evidence.length === 0) || summary.oracles.some((result) => result.passed === null) ? "inconclusive" : "passed";
    summary.runtimeHealth = this.runtimeQuality.mode === "ignore" && (summary.runtimeFindings ?? []).length === 0
      ? "ignored"
      : (summary.runtimeFindings ?? []).length > 0 ? "failed" : "passed";
    const environmentBlocked = (summary.runtimeFindings ?? []).some((finding) => finding.category === "environment" && finding.status === "confirmed" && finding.affectsVerdict);
    const independentBusinessFailure = summary.oracles.some((oracle) => oracle.verificationKind !== "http-contract"
      && oracle.passed === false && (oracle.sourceEvidenceCount ?? 0) > 0);
    const targetContinuityGap = summary.targetContinuity === "changed" || summary.targetContinuity === "unverified"
      || summary.applicationContinuity === "changed" || summary.applicationContinuity === "unverified"
      || summary.integrationPostRunCheck?.passed === false;
    summary.verdict = environmentBlocked && !independentBusinessFailure
      ? "blocked"
      : targetContinuityGap && baseVerdict !== "blocked" && baseVerdict !== "cancelled"
      ? "inconclusive"
      : this.runtimeQuality.mode === "fail"
      && (summary.runtimeFindings ?? []).length > 0
      && (baseVerdict === "passed" || baseVerdict === "inconclusive")
      ? "failed"
      : baseVerdict;
    if (hasIncompleteIntegrationCleanup(summary.integrationCleanup) && summary.verdict === "passed") summary.verdict = "blocked";
    if (summary.verdict === "blocked" && environmentBlocked) summary.findings.push("Configured runtime environment blocker was observed; inspect runtime-findings.json.");
    if (summary.verdict === "inconclusive") {
      const reason = executionError instanceof InconclusiveError ? executionError.message : charter.assertions.length === 0 && this.oracles.length === 0
        ? "No executable assertion or business oracle was declared."
        : summary.assertions.some((result) => result.evidence.length === 0)
          ? "A surface assertion has no contemporaneous saved observation; its result cannot establish product correctness."
          : "A business oracle could not establish its result; inspect its saved report for reader access, transport and terminal-state gaps.";
      if (!summary.findings.includes(reason)) summary.findings.push(reason);
    }
    summary.status = "completed";
    summary.endedAt = new Date().toISOString();
    await this.store.writeSummary(summary);
    await this.emit({ runId, timestamp: summary.endedAt, type: "run.completed", payload: { verdict: summary.verdict } });
    await this.store.writeReport(summary);
    return summary;
  }

  private async emit(event: RunEvent): Promise<void> {
    await this.store.appendEvent(event);
  }

  private async recordAdapterEvent(runId: string, event: AdapterEvent, summary: RunSummary): Promise<void> {
    const timestamp = event.timestamp ?? new Date().toISOString();
    const safeEvent = { ...event, payload: sanitizeAdapterEventPayload(event.payload, this.urlEvidenceTargets, this.webEvidenceOrigin) };
    const payload = { adapter: this.adapter.name, eventType: safeEvent.type, ...safeEvent.payload };
    await this.emit({ runId, timestamp, type: "adapter.event", payload });
    const finding = this.runtimeFinding(runId, event, safeEvent, timestamp);
    if (!finding) return;
    (summary.runtimeFindings ??= []).push(finding);
    await this.emit({ runId, timestamp, type: "finding.created", payload: { finding } });
  }

  private runtimeFinding(runId: string, rawEvent: AdapterEvent, event: AdapterEvent, observedAt: string): RuntimeFinding | undefined {
    const payload = event.payload;
    const environmentBlocker = rawEvent.type === "console" && typeof rawEvent.payload.text === "string"
      && this.runtimeBlockConsolePatterns.some((pattern) => pattern.test(rawEvent.payload.text as string));
    if (this.runtimeQuality.mode === "ignore" && !environmentBlocker) return undefined;
    const url = typeof payload.url === "string" && payload.url.length > 0 ? payload.url : undefined;
    const rawUrl = typeof rawEvent.payload.url === "string" ? rawEvent.payload.url : undefined;
    if (!matchesRuntimeUrl(rawUrl, this.runtimeAllowPatterns, this.runtimeIgnorePatterns)) return undefined;

    let severity: RuntimeFinding["severity"];
    let message: string;
    let statusCode: number | undefined;
    let consoleLevel: string | undefined;
    if (event.type === "console") {
      consoleLevel = typeof payload.level === "string" ? payload.level.toLowerCase() : "log";
      if (!environmentBlocker && !matchesConsoleLevel(consoleLevel, this.runtimeQuality.consoleLevels)) return undefined;
      severity = consoleLevel === "error" || consoleLevel === "assert" ? "high" : consoleLevel === "warn" || consoleLevel === "warning" ? "medium" : "low";
      message = typeof payload.text === "string" && payload.text.length > 0 ? summarizeRuntimeMessage(payload.text) : "Browser console reported a runtime message.";
    } else if (event.type === "pageerror") {
      if (!this.runtimeQuality.pageErrors) return undefined;
      severity = "high";
      message = typeof payload.message === "string" && payload.message.length > 0 ? summarizeRuntimeMessage(payload.message) : "Page reported a runtime error.";
    } else if (event.type === "response") {
      if (!this.runtimeQuality.failedResponses.enabled) return undefined;
      statusCode = typeof payload.status === "number" ? payload.status : undefined;
      if (statusCode === undefined || statusCode < 400 || statusCode >= 600) return undefined;
      if (statusCode < 500 && !this.runtimeQuality.failedResponses.include4xx) return undefined;
      severity = statusCode >= 500 ? "high" : "medium";
      message = `HTTP response failed with status ${statusCode}${url ? `: ${url}` : ""}`;
    } else if (event.type === "requestfailed") {
      if (!this.runtimeQuality.requestFailures) return undefined;
      const errorText = typeof payload.errorText === "string" ? payload.errorText : "request failed";
      severity = "medium";
      message = summarizeRuntimeMessage(url ? `Request failed for ${url}: ${errorText}` : `Request failed: ${errorText}`);
    } else {
      return undefined;
    }
    return RuntimeFindingSchema.parse({
      findingId: `runtime-${runId}-${summarySafeId(event.type)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: event.type,
      category: "environment",
      status: environmentBlocker ? "confirmed" : "suspected",
      severity,
      message,
      eventType: event.type,
      ...(url ? { url } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(consoleLevel ? { consoleLevel } : {}),
      affectsVerdict: environmentBlocker || this.runtimeQuality.mode === "fail",
      evidence: [`${runId}/events.jsonl`],
      observedAt,
    });
  }

  private async executeCapability(action: Extract<Action, { kind: "capability" }>, charter: TestCharter, runId: string, parentSignal: AbortSignal): Promise<{ output: unknown; receipt: ActionReceipt }> {
    const capability = this.capabilities.get(action.name);
    if (!capability) throw new BlockedError(`Capability is not registered: ${action.name}`);
    if (!capability.environments.includes(this.environment)) throw new BlockedError(`Capability ${action.name} is not allowed in ${this.environment}`);
    if (capability.sideEffect === "write" && charter.sideEffectPolicy !== "allow") {
      throw new BlockedError(`Capability ${action.name} requires sideEffectPolicy=allow`);
    }
    if (capability.sideEffect === "write" && !this.allowCapabilityWrites) {
      throw new BlockedError(`Capability ${action.name} requires runner allowCapabilityWrites`);
    }
    if (charter.sideEffectPolicy === "deny" && capability.sideEffect !== "none" && capability.sideEffect !== "read") {
      throw new BlockedError(`Capability ${action.name} is denied by the charter`);
    }
    const input = capability.inputSchema.parse(action.input);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const controller = new AbortController();
    const detachSignal = relayAbort(parentSignal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => controller.abort(new Error(`Capability ${action.name} timed out`)), capability.timeoutMs);
      const output = await withAbort(capability.execute(input, { runId, signal: controller.signal }), controller.signal, `Capability ${action.name}`);
      const validated = capability.outputSchema.parse(output);
      const evidence = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(capability.evidence(validated));
      return {
        output: evidence,
        receipt: { actionId: `${action.name}-${started}`, kind: "capability", startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, metadata: { name: action.name } },
      };
    } finally {
      if (timer) clearTimeout(timer);
      detachSignal();
    }
  }
}

function compilePatterns(patterns: string[], label: string): RegExp[] {
  return patterns.map((pattern, index) => {
    try { return new RegExp(pattern); }
    catch { throw new Error(`Invalid runtime ${label}[${index}] regular expression`); }
  });
}

function sanitizeAdapterEventPayload(payload: AdapterEvent["payload"], targets: readonly RouteCoverageTarget[], webOrigin?: string): AdapterEvent["payload"] {
  const sanitized = { ...payload };
  const safeUrl = (value: string) => projectEvidenceUrl(value, targets, webOrigin).value;
  for (const key of ["text", "message", "errorText"] as const) {
    if (typeof sanitized[key] === "string") sanitized[key] = sanitizeDiagnosticText(sanitized[key], safeUrl);
  }
  if (typeof payload.url !== "string") return sanitized;
  const projection = projectEvidenceUrl(payload.url, targets, webOrigin);
  return { ...sanitized, url: projection.value, urlPathEvidence: projection.pathEvidence };
}

/** Keep an exact declared route pattern, otherwise retain only the origin. */
function projectEvidenceUrl(value: string, targets: readonly RouteCoverageTarget[], webOrigin?: string): {
  value: string;
  pathEvidence: "declared" | "redacted" | "root";
} {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return { value: "data:[CONTENT REDACTED]", pathEvidence: "redacted" };
    if (url.protocol === "blob:") return { value: "blob:[CONTENT REDACTED]", pathEvidence: "redacted" };
    if (url.protocol === "file:") return { value: "file:[PATH REDACTED]", pathEvidence: "redacted" };
    if (url.protocol !== "http:" && url.protocol !== "https:") return { value: "[URL REDACTED]", pathEvidence: "redacted" };
    const matches = [...new Set(targets.filter((target) =>
      (target.kind === "api" ? target.origin === url.origin : webOrigin === url.origin)
      && routePathMatches(target.path, url.pathname)).map((target) => target.path))];
    if (matches.length === 1) return { value: `${url.origin}${matches[0]}`, pathEvidence: "declared" };
    if (url.pathname === "/") return { value: `${url.origin}/`, pathEvidence: "root" };
    return { value: `${url.origin}/__redacted__`, pathEvidence: "redacted" };
  } catch {
    return { value: "[invalid URL]", pathEvidence: "redacted" };
  }
}

function routePathMatches(pattern: string, observed: string): boolean {
  const expected = pattern.split("/");
  const actual = observed.split("/");
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index]);
}

/** Browser diagnostics are untrusted free text, so persist only bounded, scrubbed context. */
function sanitizeDiagnosticText(value: string, safeUrl: (value: string) => string): string {
  const limit = 4_096;
  let text = value.slice(0, limit);
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, safeUrl);
  text = text.replace(/\b(?:data:|blob:|file:)[^\s"'<>]+/gi, "[URL REDACTED]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?key|api[_-]?key|phone|mobile)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  text = text.replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]");
  return value.length > limit ? `${text}… [truncated]` : text;
}

function summarizeRuntimeMessage(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() || "Runtime diagnostic was recorded.";
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
}

function matchesRuntimeUrl(url: string | undefined, allow: RegExp[], ignore: RegExp[]): boolean {
  if (!url) return allow.length === 0;
  if (allow.length > 0) return allow.some((pattern) => pattern.test(url));
  return !ignore.some((pattern) => pattern.test(url));
}

function matchesConsoleLevel(level: string, configured: string[]): boolean {
  const normalized = level.toLowerCase();
  return configured.some((item) => {
    const expected = item.toLowerCase();
    return expected === normalized
      || (expected === "warn" && normalized === "warning")
      || (expected === "warning" && normalized === "warn");
  });
}

function summarySafeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "event";
}

function preflightResult(value: IntegrationPreflightResult): IntegrationPreflightResult {
  return IntegrationCheckResultSchema.parse(value);
}

function safeRunError(error: unknown): Error {
  if (error instanceof BlockedError || error instanceof CancelledError || error instanceof RunTimeoutError
    || error instanceof InconclusiveError
    || error instanceof AmbiguousSurfaceTargetError || error instanceof InvalidFileInputControlError) return error;
  return new InconclusiveError("runner-operation-unverified",
    "Run operation failed without a verified result; inspect trusted local diagnostics.");
}

function assertFillEnvironment(actions: readonly Action[]): void {
  const names = actions.flatMap((action) => action.kind === "fill" && typeof action.value !== "string" ? [action.value.env] : []);
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new BlockedError(`Required fill environment variables are unset or empty: ${[...new Set(missing)].join(", ")}`);
}

function resolveRuntimeAction(action: Action): Action {
  if (action.kind !== "fill" || typeof action.value === "string") return action;
  const value = process.env[action.value.env];
  if (!value) throw new BlockedError(`Required fill environment variable is unset or empty: ${action.value.env}`);
  return { ...action, value };
}

function compareTargetContinuity(before: TargetBinding, after?: TargetBinding): NonNullable<RunSummary["targetContinuity"]> {
  if (!after || before.status === "unverified" || after.status === "unverified"
    || !before.processId || !after.processId || !before.targetOrigin || !after.targetOrigin
    || !before.observedProjectRoot || !after.observedProjectRoot) return "unverified";
  const root = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  return before.processId === after.processId && before.status === after.status
    && before.targetOrigin === after.targetOrigin && root(before.observedProjectRoot) === root(after.observedProjectRoot)
    ? "stable" : "changed";
}

function mayReplaceWithContinuityGap(error?: Error): boolean {
  return !error || !(error instanceof BlockedError || error instanceof CancelledError
    || error instanceof RunTimeoutError || error instanceof InconclusiveError);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  return new CancelledError("Run was cancelled");
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const onAbort = () => target.abort((source as AbortSignal & { reason?: unknown }).reason);
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof InconclusiveError || error instanceof InputFileError
      || error instanceof AmbiguousSurfaceTargetError || error instanceof InvalidFileInputControlError) throw error;
    throw new InconclusiveError("runner-operation-unverified",
      `${label} failed without a verified result; inspect trusted local diagnostics.`);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Resource acquisition can finish after cancellation. Wait briefly for its
// cleanup handle; if it arrives later, release it without claiming cleanup.
async function withResourceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string,
  releaseLate: (value: T) => Promise<void>, trackPending?: (pending: Promise<unknown>) => void): Promise<T> {
  const graceMs = 5_000;
  let graceExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const owned = promise.then(async (value) => {
    if (graceExpired) await releaseLate(value);
    return value;
  });
  trackPending?.(owned);
  try {
    return await new Promise<T>((resolve, reject) => {
      owned.then(resolve, reject);
      onAbort = () => {
        timer = setTimeout(() => {
          graceExpired = true;
          reject(new CancelledError(`${abortReason(signal).message}; ${label} did not settle within its ${graceMs}ms cleanup grace period; resources may still be active.`));
        }, graceMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  } catch (error) {
    if (graceExpired) throw error;
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof TargetLeaseConflictError) throw error;
    throw new InconclusiveError("runner-operation-unverified",
      `${label} failed without a verified result; inspect trusted local diagnostics.`);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type { ActionReceipt, AssertionResult, OracleResult, RunSummary, SurfaceSnapshot };
