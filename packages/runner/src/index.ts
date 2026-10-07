import { createRunId, EvidenceStore } from "@proofkit/evidence";
import { z } from "zod";
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
  }): Promise<OracleResult>;
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

export type ExecutionOptions = {
  evidenceDir?: string;
  runId?: string;
  oracles?: BusinessOracle[];
  capabilities?: CapabilityDefinition<any, any>[];
  environment?: "test" | "staging" | "local";
  allowCapabilityWrites?: boolean;
  setup?: (context: {
    runId: string;
    emit: (event: Omit<RunEvent, "runId">) => Promise<void>;
  }) => Promise<(() => void | Promise<void>) | undefined>;
};

export class ExecutionRunner {
  private readonly store: EvidenceStore;
  private readonly adapter: SurfaceAdapter;
  private readonly oracles: BusinessOracle[];
  private readonly capabilities: Map<string, CapabilityDefinition<any, any>>;
  private readonly environment: "test" | "staging" | "local";
  private readonly allowCapabilityWrites: boolean;
  private readonly setup?: ExecutionOptions["setup"];

  constructor(adapter: SurfaceAdapter, options: ExecutionOptions = {}) {
    this.adapter = adapter;
    this.store = new EvidenceStore(options.evidenceDir ?? ".proofkit/runs");
    this.oracles = options.oracles ?? [];
    this.capabilities = new Map((options.capabilities ?? []).map((capability) => [capability.name, capability]));
    if (this.capabilities.size !== (options.capabilities ?? []).length) throw new Error("Duplicate capability name");
    this.environment = options.environment ?? "test";
    this.allowCapabilityWrites = options.allowCapabilityWrites ?? false;
    this.setup = options.setup;
  }

  async run(charter: TestCharter, runId = createRunId()): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const summary: RunSummary = {
      runId,
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
    await this.emit({ runId, timestamp: startedAt, type: "run.started", payload: { adapter: this.adapter.name } });

    let executionError: Error | undefined;
    let unsubscribe: () => void | Promise<void> = () => {};
    let cleanupSetup: () => void | Promise<void> = () => {};
    const pendingEvents: Promise<void>[] = [];
    try {
      if (this.setup) {
        cleanupSetup = await this.setup({
          runId,
          emit: (event) => this.emit({ ...event, runId }),
        }) ?? (() => {});
      }
      await this.adapter.connect();
      unsubscribe = await this.adapter.subscribeEvents((event) => {
        pendingEvents.push(this.emit({ runId, timestamp: new Date().toISOString(), type: "adapter.event", payload: { adapter: this.adapter.name, eventType: event.type, ...event.payload } }));
      });
      for (const [index, action] of charter.actions.entries()) {
        const stepId = `step-${String(index + 1).padStart(3, "0")}`;
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "step.started", stepId, payload: { action } });
        const step: RunSummary["steps"][number] = { stepId, action, status: "passed", artifacts: [] };
        try {
          if (action.kind === "capability") {
            const { output, receipt } = await this.executeCapability(action, charter, runId);
            step.receipt = receipt;
            step.capabilityOutput = output;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-capability`, { name: action.name, output }));
          } else {
            const beforeSnapshot = await this.adapter.snapshot();
            step.beforeSnapshot = beforeSnapshot;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-before`, beforeSnapshot));
            const receipt = await this.adapter.act(action);
            step.receipt = receipt;
            const afterSnapshot = await this.adapter.snapshot();
            step.afterSnapshot = afterSnapshot;
            step.artifacts.push(await this.store.writeJson(runId, `${stepId}-after`, afterSnapshot));
            try {
              const screenshot = await this.adapter.capture(`${stepId}.png`);
              if (screenshot) step.artifacts.push(await this.store.writeBuffer(runId, `${stepId}.png`, screenshot));
            } catch (error) {
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
          const result = await this.adapter.assert(assertion);
          summary.assertions.push(result);
          await this.emit({ runId, timestamp: new Date().toISOString(), type: "assertion.completed", payload: { index, ...result } });
        }
        for (const oracle of this.oracles) {
          const result = await oracle.check({ runId, charter, steps: summary.steps, assertions: summary.assertions });
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
      try { await unsubscribe(); } catch (error) { summary.findings.push(`unsubscribe failed: ${toError(error).message}`); }
      try { await this.adapter.close(); } catch (error) { summary.findings.push(`adapter close failed: ${toError(error).message}`); }
      await Promise.all(pendingEvents);
      try { await cleanupSetup(); } catch (error) { summary.findings.push(`runtime cleanup failed: ${toError(error).message}`); }
    }

    summary.verdict = executionError
      ? executionError instanceof BlockedError ? "blocked" : "failed"
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

  private async executeCapability(action: Extract<Action, { kind: "capability" }>, charter: TestCharter, runId: string): Promise<{ output: unknown; receipt: ActionReceipt }> {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        capability.execute(input, { runId, signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Capability ${action.name} timed out`)); }, capability.timeoutMs); }),
      ]);
      const validated = capability.outputSchema.parse(output);
      const evidence = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(capability.evidence(validated));
      return {
        output: evidence,
        receipt: { actionId: `${action.name}-${started}`, kind: "capability", startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, metadata: { name: action.name } },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { ActionReceipt, AssertionResult, OracleResult, RunSummary, SurfaceSnapshot };
