import { createRunId, EvidenceStore } from "@proofkit/evidence";
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
  inputSchema: Record<string, unknown>;
  execute(input: Input): Promise<{ output: Output; evidence?: string[] }>;
};

export class BlockedError extends Error {
  override readonly name = "BlockedError";
}

export type ExecutionOptions = {
  evidenceDir?: string;
  runId?: string;
  oracles?: BusinessOracle[];
};

export class ExecutionRunner {
  private readonly store: EvidenceStore;
  private readonly adapter: SurfaceAdapter;
  private readonly oracles: BusinessOracle[];

  constructor(adapter: SurfaceAdapter, options: ExecutionOptions = {}) {
    this.adapter = adapter;
    this.store = new EvidenceStore(options.evidenceDir ?? ".proofkit/runs");
    this.oracles = options.oracles ?? [];
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
    const pendingEvents: Promise<void>[] = [];
    try {
      await this.adapter.connect();
      unsubscribe = await this.adapter.subscribeEvents((event) => {
        pendingEvents.push(this.emit({ runId, timestamp: new Date().toISOString(), type: "adapter.event", payload: { adapter: this.adapter.name, eventType: event.type, ...event.payload } }));
      });
      for (const [index, action] of charter.actions.entries()) {
        const stepId = `step-${String(index + 1).padStart(3, "0")}`;
        await this.emit({ runId, timestamp: new Date().toISOString(), type: "step.started", stepId, payload: { action } });
        const step: RunSummary["steps"][number] = { stepId, action, status: "passed", artifacts: [] };
        try {
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
    }

    summary.verdict = executionError
      ? executionError instanceof BlockedError ? "blocked" : "failed"
      : charter.assertions.length === 0 && this.oracles.length === 0
        ? "inconclusive"
        : [...summary.assertions, ...summary.oracles].every((result) => result.passed) ? "passed" : "failed";
    if (summary.verdict === "inconclusive") summary.findings.push("No executable business oracle was declared.");
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
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { ActionReceipt, AssertionResult, OracleResult, RunSummary, SurfaceSnapshot };
