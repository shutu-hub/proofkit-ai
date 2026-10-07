import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import { ExecutionRunner, type AdapterEvent, type SurfaceAdapter } from "./index.js";

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

describe("ExecutionRunner", () => {
  it("records steps and passes an independent assertion", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runner-"));
    const charter = {
      intent: "执行测试",
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
});
