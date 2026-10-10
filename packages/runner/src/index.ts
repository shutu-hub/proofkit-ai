import { createRunId, EvidenceStore, LocalExecutionOwnership } from "@proofkit/evidence";
import { hasIncompleteIntegrationCleanup, OracleResultSchema, ResponseObservationSchema, RuntimeFindingSchema, RuntimeQualityPolicySchema, TargetBindingSchema, type IntegrationSetupPolicy, type RuntimeFinding } from "@proofkit/contracts";
import { z } from "zod";
import { inputFileFacts, resolveInputFiles, sameInputFileFacts, type InputFileFact, type SurfaceActionContext } from "./input-files.js";
import { IntegrationLifecycle, releaseLateIntegration, validateSetupPolicy, type IntegrationRecoveryContext, type IntegrationSetup, type IntegrationSetupEntry } from "./integration-lifecycle.js";
export { IntegrationLifecycle } from "./integration-lifecycle.js";
export type { IntegrationRecoveryContext } from "./integration-lifecycle.js";
export type { IntegrationSetup, IntegrationSetupEntry, IntegrationSetupHandle, IntegrationSetupContext, IntegrationCleanupContext } from "./integration-lifecycle.js";
export type { SurfaceActionContext, ResolvedInputFile, InputFileFact } from "./input-files.js";
export { sameInputFileFacts } from "./input-files.js";

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

export type ProjectIntegration = {
  name: string;
  version?: string;
  capabilities?: CapabilityDefinition<any, any>[];
  oracles?: BusinessOracle[];
  preflight?: IntegrationPreflight;
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
  setup?: IntegrationSetup | Array<IntegrationSetup | IntegrationSetupEntry>;
  setupPolicy?: IntegrationSetupPolicy;
  targetBinding?: (signal: AbortSignal) => Promise<TargetBinding>;
  targetBindingPolicy?: "record" | "block-different";
  targetBindingRecheckAfterSetup?: boolean;
  /** Classify adapter runtime signals without conflating them with business truth. */
  runtimeQuality?: z.input<typeof RuntimeQualityPolicySchema>;
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
  private readonly setups: IntegrationSetupEntry[];
  private readonly targetBinding?: ExecutionOptions["targetBinding"];
  private readonly targetBindingPolicy: NonNullable<ExecutionOptions["targetBindingPolicy"]>;
  private readonly targetBindingRecheckAfterSetup: boolean;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs?: number;
  private readonly integration?: { name: string; version?: string };
  private readonly preflight?: IntegrationPreflight;
  private readonly projectRoot?: string;
  private readonly workspaceRoot?: string;
  private readonly runtimeQuality: RuntimeQualityPolicy;
  private readonly runtimeAllowPatterns: RegExp[];
  private readonly runtimeIgnorePatterns: RegExp[];
  private readonly runtimeBlockConsolePatterns: RegExp[];

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
    const setups = options.setup ? Array.isArray(options.setup) ? options.setup : [{ setup: options.setup, policy: options.setupPolicy }] : [];
    this.setups = setups.map((entry) => {
      const value = typeof entry === "function" ? { setup: entry } : entry;
      return { setup: value.setup, ...(value.policy ? { policy: validateSetupPolicy(value.policy) } : {}) };
    });
    this.targetBinding = options.targetBinding;
    this.targetBindingPolicy = options.targetBindingPolicy ?? "block-different";
    this.targetBindingRecheckAfterSetup = options.targetBindingRecheckAfterSetup ?? false;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
    this.integration = options.integration ? { name: options.integration.name, version: options.integration.version } : undefined;
    this.preflight = options.preflight;
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
    try { return await this.executeRun(charter, runId, integrationLifecycle); }
    finally {
      if (integrationLifecycle.hasPendingCleanup) void integrationLifecycle.whenCleanupSettles().then(() => lease.release()).catch(() => {});
      else await lease.release();
    }
  }

  private async executeRun(charter: TestCharter, runId: string, integrationLifecycle: IntegrationLifecycle): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const summary: RunSummary = {
      runId,
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
    let unsubscribe: () => void | Promise<void> = () => {};
    const pendingEvents: Promise<void>[] = [];
    const inspectAndRecordTarget = async (phase: "before-setup" | "after-setup") => {
      if (!this.targetBinding) return;
      const binding = TargetBindingSchema.parse(await withAbort(this.targetBinding(signal), signal, "Target binding inspection"));
      summary.targetBinding = binding;
      const artifact = await this.store.writeJson(runId, phase === "before-setup" ? "target-binding" : "target-binding-after-setup", binding);
      summary.artifacts.push(artifact);
      await this.emit({ runId, timestamp: binding.observedAt, type: "target.binding", payload: {
        phase, status: binding.status, method: binding.method, targetOrigin: binding.targetOrigin,
        expectedProjectRoot: binding.expectedProjectRoot, observedProjectRoot: binding.observedProjectRoot,
        evidence: artifact,
      } });
      if (binding.status === "different-project" && this.targetBindingPolicy === "block-different") {
        throw new BlockedError(`Target process belongs to another Git checkout: ${binding.observedProjectRoot}`);
      }
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
      if (charter.actions.some((action) => action.kind === "captureResponse")) {
        if (charter.sideEffectPolicy !== "allow") throw new BlockedError("Response capture triggers require sideEffectPolicy=allow");
        if (!this.adapter.supportsResponseCapture) throw new BlockedError(`Response capture is not supported by the ${this.adapter.name} adapter`);
      }
      if (charter.actions.some((action) => action.kind === "setInputFiles")) {
        if (charter.sideEffectPolicy !== "allow" || !this.allowFileUploads) throw new BlockedError("File selection requires sideEffectPolicy=allow and runner allowFileUploads");
        if (!this.adapter.supportsFileInputs) throw new BlockedError(`File selection is not supported by the ${this.adapter.name} adapter`);
      }
      await inspectAndRecordTarget("before-setup");
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
          throw new BlockedError(`Integration preflight error: ${toError(error).message}`);
        }
        const artifact = await this.store.writeJson(runId, "preflight", result);
        summary.artifacts.push(artifact);
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "artifact.created", payload: { path: artifact, kind: "preflight", passed: result.passed } });
        if (!result.passed) throw new BlockedError(`Integration preflight failed: ${result.message}`);
      }
      for (const { setup, policy } of this.setups) {
        throwIfAborted(signal);
        integrationLifecycle.begin(policy);
        let handle: Awaited<ReturnType<IntegrationSetup>>;
        try {
          handle = await withResourceAbort(Promise.resolve().then(() => setup({
            runId, charter, environment: this.environment, projectRoot: this.projectRoot, workspaceRoot: this.workspaceRoot,
            signal, emit: (event) => this.emit({ ...event, runId }),
          })), signal, "Project setup", (lateHandle) => releaseLateIntegration(lateHandle, runId));
        } catch (error) { integrationLifecycle.acquisitionFailed(); throw error; }
        const setupArtifact = await integrationLifecycle.register(handle, policy);
        if (setupArtifact) {
          summary.artifacts.push(setupArtifact);
          await this.store.writeSummary(summary);
        }
        throwIfAborted(signal);
      }
      if (this.targetBindingRecheckAfterSetup) await inspectAndRecordTarget("after-setup");
      await withResourceAbort(this.adapter.connect(), signal, "Adapter connect", () => this.adapter.close());
      throwIfAborted(signal);
      unsubscribe = await withResourceAbort(this.adapter.subscribeEvents((event) => {
        pendingEvents.push(this.recordAdapterEvent(runId, event, summary));
      }), signal, "Adapter event subscription", async (release) => { await release(); });
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
                throw new BlockedError(toError(error).message);
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
            let receipt: ActionReceipt;
            try {
              receipt = await withAbort(this.adapter.act(runtimeAction, actionContext), signal, `${stepId} action`);
            } catch (error) {
              if (signal.aborted) throw error;
              if (action.kind === "fill" && typeof action.value !== "string" && runtimeAction.kind === "fill" && typeof runtimeAction.value === "string") {
                throw new Error(toError(error).message.replaceAll(runtimeAction.value, "[REDACTED_FILL_VALUE]"));
              }
              throw error;
            }
            if (action.kind === "captureResponse") {
              const result = ResponseObservationSchema.safeParse(receipt.metadata.response);
              if (!result.success || result.data.name !== action.name || result.data.url !== new URL(action.response.url).href
                || result.data.method !== action.response.method || !action.response.statuses.includes(result.data.status)
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
              summary.findings.push(`${stepId}: screenshot unavailable (${toError(error).message})`);
            }
          }
        } catch (error) {
          const cause = toError(error);
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
          const label = `assertion-${String(index + 1).padStart(3, "0")}`;
          const proof: string[] = [];
          try {
            const snapshot = await withAbort(this.adapter.snapshot(), signal, `Assertion ${index + 1} snapshot`);
            proof.push(await this.store.writeJson(runId, `${label}-snapshot`, snapshot));
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            summary.findings.push(`${label}: contemporaneous snapshot unavailable (${toError(error).message})`);
          }
          try {
            const screenshot = await withAbort(this.adapter.capture(`${label}.png`), signal, `Assertion ${index + 1} capture`);
            if (screenshot) proof.push(await this.store.writeBuffer(runId, `${label}.png`, screenshot));
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            summary.findings.push(`${label}: contemporaneous screenshot unavailable (${toError(error).message})`);
          }
          // Adapter-supplied paths may refer to an earlier step. Only artifacts
          // captured by this Runner after this assertion can confirm its result.
          const recordedResult: AssertionResult = { ...result, evidence: proof };
          summary.assertions.push(recordedResult);
          summary.artifacts.push(...proof);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "assertion.completed", payload: { index, ...recordedResult } });
        }
        for (const oracle of this.oracles) {
          throwIfAborted(signal);
          const result = OracleResultSchema.parse(await withAbort(oracle.check({ runId, charter, steps: summary.steps, assertions: summary.assertions, signal }), signal, `Oracle ${oracle.name}`));
          if (result.name !== oracle.name) throw new Error(`Oracle ${oracle.name} returned a result for ${result.name}`);
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
      executionError = toError(error);
      summary.findings.push(executionError.message);
    } finally {
      try { await unsubscribe(); } catch (error) { executionError ??= toError(error); summary.findings.push(`unsubscribe failed: ${toError(error).message}`); }
      try { await this.adapter.close(); } catch (error) { executionError ??= toError(error); summary.findings.push(`adapter close failed: ${toError(error).message}`); }
      await Promise.all(pendingEvents);
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
        executionError ??= toError(error);
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
    const independentBusinessFailure = summary.oracles.some((oracle) => oracle.passed === false && (oracle.sourceEvidenceCount ?? 0) > 0);
    summary.verdict = environmentBlocked && !independentBusinessFailure
      ? "blocked"
      : this.runtimeQuality.mode === "fail"
      && (summary.runtimeFindings ?? []).length > 0
      && (baseVerdict === "passed" || baseVerdict === "inconclusive")
      ? "failed"
      : baseVerdict;
    if (hasIncompleteIntegrationCleanup(summary.integrationCleanup) && summary.verdict === "passed") summary.verdict = "blocked";
    if (summary.verdict === "blocked" && environmentBlocked) summary.findings.push("Configured runtime environment blocker was observed; inspect runtime-findings.json.");
    if (summary.verdict === "inconclusive") summary.findings.push(
      executionError instanceof InconclusiveError ? executionError.message : charter.assertions.length === 0 && this.oracles.length === 0
        ? "No executable assertion or business oracle was declared."
        : summary.assertions.some((result) => result.evidence.length === 0)
          ? "A surface assertion has no contemporaneous saved observation; its result cannot establish product correctness."
        : "A business oracle could not establish its result; inspect its saved report for reader access, transport and terminal-state gaps.",
    );
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
    const safeEvent = { ...event, payload: sanitizeAdapterEventPayload(event.payload) };
    const payload = { adapter: this.adapter.name, eventType: safeEvent.type, ...safeEvent.payload };
    await this.emit({ runId, timestamp, type: "adapter.event", payload });
    const finding = this.runtimeFinding(runId, safeEvent, timestamp);
    if (!finding) return;
    (summary.runtimeFindings ??= []).push(finding);
    await this.emit({ runId, timestamp, type: "finding.created", payload: { finding } });
  }

  private runtimeFinding(runId: string, event: AdapterEvent, observedAt: string): RuntimeFinding | undefined {
    const payload = event.payload;
    const environmentBlocker = event.type === "console" && typeof payload.text === "string"
      && this.runtimeBlockConsolePatterns.some((pattern) => pattern.test(payload.text as string));
    if (this.runtimeQuality.mode === "ignore" && !environmentBlocker) return undefined;
    const url = typeof payload.url === "string" && payload.url.length > 0 ? payload.url : undefined;
    if (!matchesRuntimeUrl(url, this.runtimeAllowPatterns, this.runtimeIgnorePatterns)) return undefined;

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

function sanitizeAdapterEventPayload(payload: AdapterEvent["payload"]): AdapterEvent["payload"] {
  const sanitized = { ...payload };
  for (const key of ["text", "message", "errorText"] as const) {
    if (typeof sanitized[key] === "string") sanitized[key] = sanitizeDiagnosticText(sanitized[key]);
  }
  if (typeof payload.url !== "string") return sanitized;
  try {
    const url = new URL(payload.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return { ...sanitized, url: url.toString() };
  } catch {
    return { ...sanitized, url: "[invalid URL]" };
  }
}

/** Browser diagnostics are untrusted free text, so persist only bounded, scrubbed context. */
function sanitizeDiagnosticText(value: string): string {
  const limit = 4_096;
  let text = value.slice(0, limit);
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[URL REDACTED]";
    }
  });
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
  return z.object({
    passed: z.boolean(),
    message: z.string().min(1),
    evidence: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  }).parse(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
    if (error instanceof InconclusiveError) throw error;
    throw new Error(`${label} failed: ${toError(error).message}`);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Resource acquisition can finish after cancellation. Wait briefly for its
// cleanup handle; if it arrives later, release it without claiming cleanup.
async function withResourceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string, releaseLate: (value: T) => Promise<void>): Promise<T> {
  const graceMs = 5_000;
  let graceExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const owned = promise.then(async (value) => {
    if (graceExpired) await releaseLate(value);
    return value;
  });
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
    throw new Error(`${label} failed: ${toError(error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type { ActionReceipt, AssertionResult, OracleResult, RunSummary, SurfaceSnapshot };
