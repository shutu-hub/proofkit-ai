import { createRunId, EvidenceStore } from "@proofkit/evidence";
import { z } from "zod";

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
  RunSummary,
  SurfaceSnapshot,
  TestCharter,
} from "@proofkit/contracts";

export type AdapterEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export interface SurfaceAdapter {
  readonly name: string;
  connect(): Promise<void>;
  discover(): Promise<SurfaceSnapshot>;
  snapshot(): Promise<SurfaceSnapshot>;
  act(action: Action): Promise<ActionReceipt>;
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

export type IntegrationSetup = (context: {
  runId: string;
  signal: AbortSignal;
  emit: (event: Omit<RunEvent, "runId">) => Promise<void>;
}) => Promise<(() => void | Promise<void>) | undefined>;

export type ProjectIntegration = {
  name: string;
  version?: string;
  capabilities?: CapabilityDefinition<any, any>[];
  oracles?: BusinessOracle[];
  setup?: IntegrationSetup;
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

export type ExecutionOptions = {
  projectRoot?: string;
  workspaceRoot?: string;
  evidenceDir?: string;
  runId?: string;
  oracles?: BusinessOracle[];
  capabilities?: CapabilityDefinition<any, any>[];
  environment?: "test" | "staging" | "local";
  allowCapabilityWrites?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  integration?: { name: string; version?: string };
  setup?: IntegrationSetup;
};

export class ExecutionRunner {
  private readonly store: EvidenceStore;
  private readonly adapter: SurfaceAdapter;
  private readonly oracles: BusinessOracle[];
  private readonly capabilities: Map<string, CapabilityDefinition<any, any>>;
  private readonly environment: "test" | "staging" | "local";
  private readonly allowCapabilityWrites: boolean;
  private readonly setup?: ExecutionOptions["setup"];
  private readonly signal?: AbortSignal;
  private readonly timeoutMs?: number;
  private readonly integration?: { name: string; version?: string };
  private readonly projectRoot?: string;
  private readonly workspaceRoot?: string;

  constructor(adapter: SurfaceAdapter, options: ExecutionOptions = {}) {
    this.adapter = adapter;
    this.store = new EvidenceStore(options.evidenceDir ?? ".proofkit/runs");
    this.oracles = options.oracles ?? [];
    if (new Set(this.oracles.map((oracle) => oracle.name)).size !== this.oracles.length) throw new Error("Duplicate oracle name");
    this.capabilities = new Map((options.capabilities ?? []).map((capability) => [capability.name, capability]));
    if (this.capabilities.size !== (options.capabilities ?? []).length) throw new Error("Duplicate capability name");
    this.environment = options.environment ?? "test";
    this.allowCapabilityWrites = options.allowCapabilityWrites ?? false;
    this.setup = options.setup;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
    this.integration = options.integration;
    this.projectRoot = options.projectRoot;
    this.workspaceRoot = options.workspaceRoot;
  }

  async run(charter: TestCharter, runId = createRunId()): Promise<RunSummary> {
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
    let cleanupSetup: () => void | Promise<void> = () => {};
    const pendingEvents: Promise<void>[] = [];
    try {
      throwIfAborted(signal);
      if (this.setup) {
        cleanupSetup = await withAbort(this.setup({
          runId,
          signal,
          emit: (event) => this.emit({ ...event, runId }),
        }), signal, "Project setup") ?? (() => {});
      }
      await withAbort(this.adapter.connect(), signal, "Adapter connect");
      unsubscribe = await withAbort(this.adapter.subscribeEvents((event) => {
        pendingEvents.push(this.emit({ runId, timestamp: new Date().toISOString(), type: "adapter.event", payload: { adapter: this.adapter.name, eventType: event.type, ...event.payload } }));
      }), signal, "Adapter event subscription");
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
            const receipt = await withAbort(this.adapter.act(action), signal, `${stepId} action`);
            step.receipt = receipt;
            const afterSnapshot = await withAbort(this.adapter.snapshot(), signal, `${stepId} snapshot`);
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
          summary.artifacts.push(...step.artifacts);
        } catch (error) {
          const cause = toError(error);
          step.status = cause instanceof BlockedError ? "blocked" : "failed";
          step.error = cause.message;
          executionError = cause;
          summary.findings.push(`${stepId}: ${cause.message}`);
        }
        summary.steps.push(step);
        await this.store.writeSummary(summary);
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "step.completed", stepId, payload: { status: step.status, error: step.error } });
        if (step.status !== "passed") break;
      }

      if (!executionError) {
        for (const [index, assertion] of charter.assertions.entries()) {
          throwIfAborted(signal);
          const result = await withAbort(this.adapter.assert(assertion), signal, `Assertion ${index + 1}`);
          summary.assertions.push(result);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "assertion.completed", payload: { index, ...result } });
        }
        for (const oracle of this.oracles) {
          throwIfAborted(signal);
          const result = await withAbort(oracle.check({ runId, charter, steps: summary.steps, assertions: summary.assertions, signal }), signal, `Oracle ${oracle.name}`);
          const artifact = await this.store.writeJson(runId, `oracle-${summary.oracles.length + 1}`, result);
          result.evidence.push(artifact);
          summary.artifacts.push(artifact);
          summary.oracles.push(result);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "oracle.completed", payload: result });
        }
      }
    } catch (error) {
      executionError = toError(error);
      summary.findings.push(executionError.message);
    } finally {
      try { await unsubscribe(); } catch (error) { executionError ??= toError(error); summary.findings.push(`unsubscribe failed: ${toError(error).message}`); }
      try { await this.adapter.close(); } catch (error) { executionError ??= toError(error); summary.findings.push(`adapter close failed: ${toError(error).message}`); }
      await Promise.all(pendingEvents);
      try { await cleanupSetup(); } catch (error) { executionError ??= toError(error); summary.findings.push(`runtime cleanup failed: ${toError(error).message}`); }
      if (timeout) clearTimeout(timeout);
      detachSignal();
    }

    summary.verdict = executionError
      ? executionError instanceof BlockedError ? "blocked" : executionError instanceof CancelledError || executionError instanceof RunTimeoutError ? "cancelled" : "failed"
      : charter.assertions.length === 0 && this.oracles.length === 0
        ? "inconclusive"
        : summary.assertions.some((result) => !result.passed) || summary.oracles.some((result) => result.passed === false)
          ? "failed"
          : summary.oracles.some((result) => result.passed === null) ? "inconclusive" : "passed";
    if (summary.verdict === "inconclusive") summary.findings.push(
      charter.assertions.length === 0 && this.oracles.length === 0
        ? "No executable assertion or business oracle was declared."
        : "A business oracle did not observe a terminal state within its deadline.",
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
    throw new Error(`${label} failed: ${toError(error).message}`);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type { ActionReceipt, AssertionResult, OracleResult, RunSummary, SurfaceSnapshot };
