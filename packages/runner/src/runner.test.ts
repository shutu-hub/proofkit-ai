import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import { CancelledError, ExecutionRunner, type AdapterEvent, type SurfaceAdapter } from "./index.js";

class FakeAdapter implements SurfaceAdapter {
  readonly name = "fake";
  private ready = false;
  async connect(): Promise<void> {}
  async discover(): Promise<SurfaceSnapshot> { return this.snapshot(); }
  async snapshot(): Promise<SurfaceSnapshot> { return { capturedAt: new Date().toISOString(), url: "http://fixture", text: this.ready ? "Ready" : "Idle", metadata: {} }; }
  async act(action: Action): Promise<ActionReceipt> {
    if (action.kind === "click") this.ready = true;
    return { actionId: action.kind, kind: action.kind, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, metadata: {} };
  }
  async assert(assertion: Assertion): Promise<AssertionResult> {
    const passed = assertion.kind === "text-visible" && this.ready && assertion.text === "Ready";
    return { assertion, passed, message: passed ? "ready" : "not ready", evidence: [] };
  }
  async capture(): Promise<Uint8Array | undefined> { return undefined; }
  async subscribeEvents(_listener: (event: AdapterEvent) => void): Promise<() => void> { return () => {}; }
  async close(): Promise<void> {}
}

class SlowAdapter extends FakeAdapter {
  override async act(action: Action): Promise<ActionReceipt> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return super.act(action);
  }
}

describe("ExecutionRunner", () => {
  it("retains a setup cleanup handle that arrives after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-late-setup-"));
    const controller = new AbortController();
    let setupStarted!: () => void;
    let finishSetup!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSetup = resolve; });
    let connected = false;
    let cleaned = false;
    let settled = false;
    const adapter = new FakeAdapter();
    adapter.connect = async () => { connected = true; };
    const running = new ExecutionRunner(adapter, { evidenceDir: root, signal: controller.signal, setup: async () => {
      setupStarted();
      await finish;
      return async () => { cleaned = true; };
    } }).run({ intent: "cancel setup", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "late-setup").then((result) => { settled = true; return result; });
    await started;
    controller.abort(new CancelledError("stop setup"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishSetup();
    const summary = await running;
    expect(summary.verdict).toBe("cancelled");
    expect(cleaned).toBe(true);
    expect(connected).toBe(false);
  });

  it("waits for an in-flight connection before closing its acquired resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-late-connect-"));
    const controller = new AbortController();
    let connectionStarted!: () => void;
    let finishConnection!: () => void;
    const started = new Promise<void>((resolve) => { connectionStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishConnection = resolve; });
    let acquired = false;
    let subscribed = false;
    const adapter = new FakeAdapter();
    adapter.connect = async () => { connectionStarted(); await finish; acquired = true; };
    adapter.subscribeEvents = async () => { subscribed = true; return () => {}; };
    adapter.close = async () => { acquired = false; };
    const running = new ExecutionRunner(adapter, { evidenceDir: root, signal: controller.signal }).run({ intent: "cancel connect", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "late-connect");
    await started;
    controller.abort(new CancelledError("stop connect"));
    finishConnection();
    const summary = await running;
    expect(summary.verdict).toBe("cancelled");
    expect(acquired).toBe(false);
    expect(subscribed).toBe(false);
  });

  it("releases an event subscription that arrives after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-late-subscription-"));
    const controller = new AbortController();
    let subscriptionStarted!: () => void;
    let finishSubscription!: () => void;
    const started = new Promise<void>((resolve) => { subscriptionStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSubscription = resolve; });
    let released = false;
    let acted = false;
    const adapter = new FakeAdapter();
    adapter.subscribeEvents = async () => {
      subscriptionStarted();
      await finish;
      return () => { released = true; };
    };
    adapter.act = async (action) => { acted = true; return FakeAdapter.prototype.act.call(adapter, action); };
    const running = new ExecutionRunner(adapter, { evidenceDir: root, signal: controller.signal }).run({
      intent: "cancel subscription", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [], sideEffectPolicy: "deny", metadata: {},
    }, "late-subscription");
    await started;
    controller.abort(new CancelledError("stop subscription"));
    finishSubscription();
    const summary = await running;
    expect(summary.verdict).toBe("cancelled");
    expect(released).toBe(true);
    expect(acted).toBe(false);
  });

  it("keeps cancellation as the verdict when setup rejects after the abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-aborted-setup-"));
    const controller = new AbortController();
    let setupStarted!: () => void;
    let finishSetup!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSetup = resolve; });
    const summaryPromise = new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root, signal: controller.signal,
      setup: async () => { setupStarted(); await finish; throw new Error("setup observed abort"); },
    }).run({ intent: "abort setup", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "aborted-setup");
    await started;
    controller.abort(new CancelledError("stop setup"));
    finishSetup();
    const summary = await summaryPromise;
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings).toContain("stop setup");
  });

  it("reports an unsettled acquisition and releases its handle when it eventually arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-expired-setup-"));
    const controller = new AbortController();
    let setupStarted!: () => void;
    let finishSetup!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSetup = resolve; });
    let lateCleanup!: () => void;
    const cleaned = new Promise<void>((resolve) => { lateCleanup = resolve; });
    const summaryPromise = new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root, signal: controller.signal,
      setup: async () => { setupStarted(); await finish; return () => { lateCleanup(); }; },
    }).run({ intent: "expire setup grace", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "expired-setup");
    await started;
    controller.abort(new CancelledError("stop setup"));
    const summary = await summaryPromise;
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings.some((finding) => finding.includes("resources may still be active"))).toBe(true);
    finishSetup();
    await cleaned;
  }, 10_000);

  it("records steps and passes an independent assertion", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runner-"));
    const charter = {
      intent: "执行测试",
      level: "core" as const,
      mode: "guided" as const,
      preconditions: [],
      actions: [{ kind: "observe" as const }, { kind: "click" as const, selector: "#ready" }],
      assertions: [{ kind: "text-visible" as const, text: "Ready" }],
      sideEffectPolicy: "confirm" as const,
      metadata: {},
    };
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root }).run(charter, "run-test");
    expect(summary.verdict).toBe("passed");
    expect(summary.steps).toHaveLength(2);
    expect(await readFile(join(root, "run-test", "events.jsonl"), "utf8")).toContain("run.completed");
  });

  it("executes a registered read capability and records its evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capability-"));
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      capabilities: [{
        name: "readWorkflow",
        description: "Read an opaque workflow state",
        sideEffect: "read",
        environments: ["test"],
        timeoutMs: 1_000,
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ status: z.literal("complete") }),
        execute: async () => ({ status: "complete" as const }),
        evidence: (output) => ({ status: output.status }),
      }],
      oracles: [{ name: "workflow", check: async ({ steps }) => ({ name: "workflow", passed: (steps[0]?.capabilityOutput as { status?: string } | undefined)?.status === "complete", message: "workflow complete", evidence: [] }) }],
    }).run({ intent: "check workflow", level: "core", mode: "deterministic", preconditions: [], actions: [{ kind: "capability", name: "readWorkflow", input: { id: "opaque-1" } }], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "capability-run");
    expect(summary.verdict).toBe("passed");
    expect(summary.steps[0]?.artifacts[0]).toBe("capability-run/artifacts/step-001-capability.json");
    expect(summary.oracles[0]?.evidence).toContain("capability-run/artifacts/oracle-1.json");
    expect(await readFile(join(root, "capability-run", "report.html"), "utf8")).toContain("oracle-1.json");
  });

  it("blocks an unregistered capability before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capability-"));
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root }).run({ intent: "check workflow", level: "core", mode: "deterministic", preconditions: [], actions: [{ kind: "capability", name: "unknown", input: {} }], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "blocked-run");
    expect(summary.verdict).toBe("blocked");
    expect(summary.steps[0]?.error).toContain("not registered");
  });

  it("runs integration preflight before connecting the adapter and preserves its evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preflight-"));
    let connected = false;
    const adapter = new FakeAdapter();
    adapter.connect = async () => { connected = true; };
    const summary = await new ExecutionRunner(adapter, {
      evidenceDir: root,
      integration: { name: "fixture", version: "1" },
      preflight: async () => ({ passed: false, message: "test environment is not isolated", evidence: { environment: "test", isolated: false } }),
    }).run({ intent: "preflight", level: "core", mode: "deterministic", preconditions: [], actions: [{ kind: "observe" }], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "preflight-run");
    expect(summary.verdict).toBe("blocked");
    expect(connected).toBe(false);
    expect(summary.artifacts).toContain("preflight-run/artifacts/preflight.json");
    expect(await readFile(join(root, "preflight-run", "artifacts", "preflight.json"), "utf8")).toContain("not isolated");
  });

  it("requires a runner-level opt-in for write capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-capability-"));
    let called = false;
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, capabilities: [{
      name: "seedFixture", description: "Create a test fixture", sideEffect: "write", environments: ["test"], timeoutMs: 1_000,
      inputSchema: z.object({}), outputSchema: z.object({ id: z.string() }),
      execute: async () => { called = true; return { id: "fixture" }; }, evidence: (output) => ({ id: output.id }),
    }] }).run({ intent: "seed", level: "core", mode: "guided", preconditions: [], actions: [{ kind: "capability", name: "seedFixture", input: {} }], assertions: [], sideEffectPolicy: "allow", metadata: {} }, "write-run");
    expect(summary.verdict).toBe("blocked");
    expect(called).toBe(false);
  });

  it("turns a total run deadline into a cancelled verdict and still closes the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-timeout-"));
    let closed = false;
    let cleaned = false;
    const adapter = new SlowAdapter();
    adapter.close = async () => { closed = true; };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, timeoutMs: 10, setup: async () => async () => { cleaned = true; } }).run({
      intent: "deadline",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "click", selector: "#slow" }],
      assertions: [],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "timeout-run");
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings.some((finding) => finding.includes("deadline"))).toBe(true);
    expect(closed).toBe(true);
    expect(cleaned).toBe(true);
  });

  it("propagates external cancellation to a capability and runs cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cancel-"));
    const controller = new AbortController();
    let cleaned = false;
    let signalCapabilityStart!: () => void;
    const capabilityStarted = new Promise<void>((resolve) => { signalCapabilityStart = resolve; });
    const promise = new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      signal: controller.signal,
      capabilities: [{
        name: "slowCapability",
        description: "Wait for cancellation",
        sideEffect: "read",
        environments: ["test"],
        timeoutMs: 1_000,
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: async (_input, context) => {
          signalCapabilityStart();
          await new Promise<void>((resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
            setTimeout(resolve, 500);
          });
          return { ok: true };
        },
        evidence: (output) => ({ ok: output.ok }),
      }],
      setup: async () => async () => { cleaned = true; },
    }).run({
      intent: "cancel",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "capability", name: "slowCapability", input: {} }],
      assertions: [],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "cancel-run");
    await capabilityStarted;
    controller.abort(new CancelledError("user stop"));
    const summary = await promise;
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings.some((finding) => finding.includes("user stop"))).toBe(true);
    expect(cleaned).toBe(true);
  });
});
