import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import { AmbiguousSurfaceTargetError, CancelledError, ExecutionRunner, type AdapterEvent, type SurfaceAdapter } from "./index.js";

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

class EventAdapter extends FakeAdapter {
  constructor(private readonly events: AdapterEvent[]) { super(); }

  override async subscribeEvents(listener: (event: AdapterEvent) => void): Promise<() => void> {
    for (const event of this.events) listener(event);
    return () => {};
  }
}

class SlowAdapter extends FakeAdapter {
  override async act(action: Action): Promise<ActionReceipt> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return super.act(action);
  }
}

describe("ExecutionRunner", () => {
  it("does not substitute a page overview for an unsupported or invalid targeted read", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-text-read-"));
    for (const variant of ["unsupported", "invalid", "wrong-source", "wrong-window"] as const) {
      const adapter = new FakeAdapter() as FakeAdapter & { readText?: SurfaceAdapter["readText"] };
      if (variant !== "unsupported") adapter.readText = async () => ({ capturedAt: new Date().toISOString(), text: "abc", metadata: {},
        textRead: { scope: "rendered-main-frame-region", text: "abc", sourceSha256: variant === "wrong-source" ? "b".repeat(64) : "a".repeat(64),
          offset: variant === "wrong-window" ? 1 : 0, limit: 3, totalChars: 5, returnedChars: 3, nextOffset: variant === "invalid" ? null : variant === "wrong-window" ? 4 : 3 } });
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
        intent: "read a pinned region", level: "quick", mode: "deterministic", preconditions: [],
        actions: [{ kind: "observe", readText: { selector: "#results", offset: 0, limit: 3, expectedSourceSha256: "a".repeat(64) } }],
        assertions: [], sideEffectPolicy: "deny", metadata: {},
      });
      expect(summary.verdict).toBe("inconclusive");
      expect(summary.steps[0]?.afterSnapshot).toBeUndefined();
      const path = summary.steps[0]!.artifacts.find((path) => path.endsWith("response-gap.json"))!;
      expect(JSON.parse(await readFile(join(root, path), "utf8")).code).toBe(variant === "unsupported" ? "surface-text-read-unsupported" : "surface-text-read-unverified");
    }
  });

  it("records a valid targeted observation without treating it as product acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-text-read-"));
    const adapter = new FakeAdapter() as FakeAdapter & { readText: NonNullable<SurfaceAdapter["readText"]> };
    adapter.readText = async () => ({ capturedAt: new Date().toISOString(), text: "abc", metadata: {}, textRead: {
      scope: "rendered-main-frame-region", text: "abc", sourceSha256: "a".repeat(64), offset: 0, limit: 3, totalChars: 5, returnedChars: 3, nextOffset: 3,
    } });
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
      intent: "read only", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe", readText: { selector: "#results", offset: 0, limit: 3 } }],
      assertions: [], sideEffectPolicy: "deny", metadata: {},
    });
    expect(summary.steps[0]?.status).toBe("passed");
    expect(summary.steps[0]?.afterSnapshot?.textRead?.nextOffset).toBe(3);
    expect(summary.verdict).toBe("inconclusive");
  });

  it("blocks native form mutations before connecting when writes are denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-native-policy-"));
    for (const action of [{ kind: "selectOption", selector: "#status", option: { label: "Complete" } },
      { kind: "selectOptions", selector: "#statuses", options: [] },
      { kind: "setChecked", selector: "#enabled", checked: true }] as Action[]) {
      const adapter = new FakeAdapter();
      const connect = vi.spyOn(adapter, "connect");
      const act = vi.spyOn(adapter, "act");
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
        intent: "deny native form writes", level: "quick", mode: "deterministic", preconditions: [], actions: [action],
        assertions: [], sideEffectPolicy: "deny", metadata: {},
      });
      expect(summary.verdict).toBe("blocked");
      expect(connect).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
    }
  });
  it("resolves fill values only at execution and replays with the current environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-fill-env-"));
    const envName = "PROOFKIT_TEST_FILL_SECRET";
    const previous = process.env[envName];
    const seen: string[] = [];
    const adapter = () => {
      const instance = new FakeAdapter();
      instance.act = async (action) => {
        if (action.kind === "fill") seen.push(typeof action.value === "string" ? action.value : "unresolved");
        return { actionId: action.kind, kind: action.kind, startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(), durationMs: 0, metadata: {} };
      };
      return instance;
    };
    const charter = { intent: "fill a test credential", level: "quick" as const, mode: "deterministic" as const,
      preconditions: [], actions: [{ kind: "fill" as const, selector: "#password", value: { env: envName } }],
      assertions: [], sideEffectPolicy: "allow" as const, metadata: {} };
    try {
      process.env[envName] = "first-runtime-secret";
      const first = await new ExecutionRunner(adapter(), { evidenceDir: root }).run(charter, "fill-env-first");
      expect(first.steps[0]?.status).toBe("passed");
      expect(seen).toEqual(["first-runtime-secret"]);
      const saved = await readFile(join(root, "fill-env-first", "run.json"), "utf8");
      const events = await readFile(join(root, "fill-env-first", "events.jsonl"), "utf8");
      expect(saved + events).not.toContain("first-runtime-secret");
      expect(JSON.parse(saved).execution).toEqual({ adapter: "fake" });
      expect(JSON.parse(saved).charter.actions[0].value).toEqual({ env: envName });

      process.env[envName] = "second-runtime-secret";
      const replay = await new ExecutionRunner(adapter(), { evidenceDir: root, replayOfRunId: "fill-env-first" }).run(JSON.parse(saved).charter, "fill-env-replay");
      expect(replay.steps[0]?.status).toBe("passed");
      expect(replay.execution).toEqual({ adapter: "fake", replayOfRunId: "fill-env-first" });
      expect(seen).toEqual(["first-runtime-secret", "second-runtime-secret"]);
      expect(await readFile(join(root, "fill-env-replay", "run.json"), "utf8")).not.toContain("second-runtime-secret");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("blocks a missing fill environment variable before connecting a surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-fill-missing-"));
    const envName = "PROOFKIT_TEST_FILL_MISSING";
    const previous = process.env[envName];
    delete process.env[envName];
    const adapter = new FakeAdapter();
    let connected = false;
    adapter.connect = async () => { connected = true; };
    try {
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
        intent: "fill a required credential", level: "quick", mode: "deterministic", preconditions: [],
        actions: [{ kind: "fill", selector: "#password", value: { env: envName } }],
        assertions: [], sideEffectPolicy: "allow", metadata: {},
      }, "fill-env-missing");
      expect(summary.verdict).toBe("blocked");
      expect(connected).toBe(false);
      expect(summary.findings).toContain(`Required fill environment variables are unset or empty: ${envName}`);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("redacts an environment-provided fill value from adapter failure evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-fill-error-"));
    const envName = "PROOFKIT_TEST_FILL_ERROR";
    const previous = process.env[envName];
    const secret = "error-runtime-secret";
    const privateErrorText = "candidate-email=private@example.invalid token=secret-credential";
    process.env[envName] = secret;
    const adapter = new FakeAdapter();
    adapter.act = async () => { throw new Error(`Adapter failed while handling ${secret}: ${privateErrorText}`); };
    try {
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
        intent: "check error evidence", level: "quick", mode: "deterministic", preconditions: [],
        actions: [{ kind: "fill", selector: "#password", value: { env: envName } }],
        assertions: [], sideEffectPolicy: "allow", metadata: {},
      }, "fill-env-error");
      expect(summary.verdict).toBe("inconclusive");
      expect(summary.steps[0]?.error).toContain("step-001 action failed without a verified result");
      expect(summary.steps[0]?.artifacts).toContain("fill-env-error/artifacts/step-001-response-gap.json");
      const persisted = JSON.stringify(summary)
        + await readFile(join(root, "fill-env-error", "events.jsonl"), "utf8")
        + await readFile(join(root, "fill-env-error", "run.json"), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain(privateErrorText);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("classifies an action timeout without copying the adapter error", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-action-timeout-"));
    const adapter = new FakeAdapter();
    adapter.act = async () => {
      const error = new Error("private selector and page content");
      error.name = "TimeoutError";
      throw error;
    };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
      intent: "inspect timeout evidence", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#target" }], assertions: [], sideEffectPolicy: "allow", metadata: {},
    }, "action-timeout");
    const gap = summary.steps[0]!.artifacts.find((path) => path.endsWith("response-gap.json"))!;
    const saved = await readFile(join(root, gap), "utf8");
    expect(JSON.parse(saved).code).toBe("runner-action-timeout");
    expect(summary.steps[0]?.failureCode).toBe("runner-action-timeout");
    expect(summary.verdict).toBe("inconclusive");
    expect(JSON.stringify(summary) + saved).not.toContain("private selector and page content");
  });

  it("returns a stable code for an ambiguous action selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-ambiguous-"));
    const adapter = new FakeAdapter();
    adapter.act = async () => { throw new AmbiguousSurfaceTargetError(4); };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
      intent: "inspect target", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: ".item" }], assertions: [], sideEffectPolicy: "allow", metadata: {},
    }, "target-ambiguous");
    expect(summary.steps[0]?.failureCode).toBe("surface-target-ambiguous");
    expect(summary.steps[0]?.status).toBe("failed");
  });

  it("keeps preflight exception text out of Run evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preflight-error-"));
    const privateErrorText = "candidate-email=private@example.invalid token=secret-credential";
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      preflight: async () => { throw new Error(`Preflight reader failed: ${privateErrorText}`); },
    }).run({ intent: "check isolated environment", level: "quick", mode: "deterministic",
      preconditions: [], actions: [{ kind: "observe" }], assertions: [],
      sideEffectPolicy: "deny", metadata: {},
    }, "preflight-error-run");
    expect(summary.verdict).toBe("blocked");
    expect(summary.findings).toContain("Integration preflight failed before it returned a verified result; inspect trusted local diagnostics.");
    const persisted = JSON.stringify(summary)
      + await readFile(join(root, "preflight-error-run", "events.jsonl"), "utf8")
      + await readFile(join(root, "preflight-error-run", "run.json"), "utf8")
      + await readFile(join(root, "preflight-error-run", "report.html"), "utf8");
    expect(persisted).not.toContain(privateErrorText);
  });

  it("keeps capture and close exception text out of Run evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-adapter-error-"));
    const privateErrorText = "candidate-email=private@example.invalid token=secret-credential";
    const adapter = new FakeAdapter();
    adapter.capture = async () => { throw new Error(`Capture failed: ${privateErrorText}`); };
    adapter.close = async () => { throw new Error(`Close failed: ${privateErrorText}`); };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root }).run({
      intent: "check capture failure", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "allow", metadata: {},
    }, "adapter-error-run");
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.findings).toContain("Adapter close failed; inspect trusted local diagnostics.");
    expect(summary.findings.some((item) => item.includes("screenshot unavailable"))).toBe(true);
    const persisted = JSON.stringify(summary)
      + await readFile(join(root, "adapter-error-run", "events.jsonl"), "utf8")
      + await readFile(join(root, "adapter-error-run", "run.json"), "utf8")
      + await readFile(join(root, "adapter-error-run", "report.html"), "utf8");
    expect(persisted).not.toContain(privateErrorText);
  });

  it("preserves cancellation while a fill action uses a runtime environment value", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-fill-timeout-"));
    const envName = "PROOFKIT_TEST_FILL_TIMEOUT";
    const previous = process.env[envName];
    process.env[envName] = "timeout-runtime-secret";
    try {
      const summary = await new ExecutionRunner(new SlowAdapter(), { evidenceDir: root, timeoutMs: 10 }).run({
        intent: "cancel a slow credential fill", level: "quick", mode: "deterministic", preconditions: [],
        actions: [{ kind: "fill", selector: "#password", value: { env: envName } }],
        assertions: [], sideEffectPolicy: "allow", metadata: {},
      }, "fill-env-timeout");
      expect(summary.verdict).toBe("cancelled");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("blocks a different source checkout before connecting and retains process evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-mismatch-"));
    const adapter = new FakeAdapter();
    let connected = false;
    let setupEntered = false;
    let preflightEntered = false;
    adapter.connect = async () => { connected = true; };
    const summary = await new ExecutionRunner(adapter, {
      evidenceDir: root,
      preflight: async () => { preflightEntered = true; return { passed: true, message: "ready" }; },
      setup: async () => { setupEntered = true; return undefined; },
      targetBinding: async () => ({
        status: "different-project", method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
        observedProjectRoot: "D:/tmp/aihr-hotfix", targetOrigin: "http://localhost:5174", processId: 12,
        reason: "The target port belongs to another checkout.", observedAt: new Date().toISOString(),
      }),
    }).run({ intent: "check source target", level: "quick", mode: "deterministic", preconditions: [], actions: [],
      assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {},
    }, "target-mismatch-run");

    expect(connected).toBe(false);
    expect(setupEntered).toBe(false);
    expect(preflightEntered).toBe(false);
    expect(summary.verdict).toBe("blocked");
    expect(summary.targetBinding?.status).toBe("different-project");
    expect(summary.artifacts).toContain("target-mismatch-run/artifacts/target-binding.json");
    expect(await readFile(join(root, "target-mismatch-run", "events.jsonl"), "utf8")).toContain("target.binding");
  });

  it("rechecks after managed startup before connecting to a changed target", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-change-"));
    const adapter = new FakeAdapter();
    let connected = false;
    let checks = 0;
    adapter.connect = async () => { connected = true; };
    const summary = await new ExecutionRunner(adapter, {
      evidenceDir: root,
      setup: async () => undefined,
      targetBindingRecheckAfterSetup: true,
      targetBinding: async () => ({
        status: ++checks === 1 ? "unverified" : "different-project",
        method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
        observedProjectRoot: checks === 1 ? undefined : "D:/tmp/aihr-hotfix",
        targetOrigin: "http://localhost:5174", reason: "Listener changed during startup.",
        observedAt: new Date().toISOString(),
      }),
    }).run({ intent: "check managed startup", level: "quick", mode: "deterministic", preconditions: [], actions: [],
      assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {},
    }, "target-change-run");

    expect(checks).toBe(2);
    expect(connected).toBe(false);
    expect(summary.verdict).toBe("blocked");
    expect(summary.artifacts).toContain("target-change-run/artifacts/target-binding-after-setup.json");
  });

  it("blocks a foreign application selected by the final attachment lease before connecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-attachment-binding-"));
    const adapter = new FakeAdapter();
    let connected = false;
    let released = false;
    let finalTarget = false;
    adapter.connect = async () => { connected = true; };
    const matching = { status: "matching-process-path" as const, method: "windows-listener-process" as const,
      expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/code/AIHR",
      targetOrigin: "http://localhost:5174", processId: 12,
      reason: "Page server matches.", observedAt: new Date().toISOString() };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root,
      targetBinding: async () => matching,
      applicationBinding: async () => finalTarget
        ? { ...matching, status: "different-project", observedProjectRoot: "D:/tmp/other",
          targetOrigin: "http://localhost:9333", processId: 30, reason: "Pinned application belongs to another checkout." }
        : { ...matching, targetOrigin: "http://localhost:9222", processId: 20 },
      attachmentLease: async () => { finalTarget = true; return { release: async () => { released = true; } }; },
    }).run({ intent: "Check final Electron application", level: "quick", mode: "deterministic",
      preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {} }, "foreign-pinned-application-run");
    expect(connected).toBe(false);
    expect(released).toBe(true);
    expect(summary).toMatchObject({ verdict: "blocked", applicationBinding: {
      status: "different-project", targetOrigin: "http://localhost:9333" } });
    expect(summary.artifacts).toContain("foreign-pinned-application-run/artifacts/application-binding-before-attachment.json");
  });

  it("requires one known listener throughout a core Run while keeping quick checks short", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-continuity-"));
    const charter = (level: "quick" | "core") => ({ intent: "Check a stable target", level, mode: "deterministic" as const,
      preconditions: [], actions: [{ kind: "click" as const, selector: "#ready" }],
      assertions: [{ kind: "text-visible" as const, text: "Ready" }], sideEffectPolicy: "allow" as const, metadata: {} });
    for (const [name, finalPid, expectedVerdict, expectedContinuity] of [
      ["stable", 12, "passed", "stable"],
      ["replaced", 13, "inconclusive", "changed"],
    ] as const) {
      let checks = 0;
      const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, targetBinding: async () => ({
        status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
        observedProjectRoot: "D:/code/AIHR", targetOrigin: "http://localhost:5174", processId: ++checks === 1 ? 12 : finalPid,
        reason: "Listener process path matches the source checkout.", observedAt: new Date().toISOString(),
      }) }).run(charter("core"), `target-${name}`);
      expect(checks).toBe(2);
      expect(summary).toMatchObject({ verdict: expectedVerdict, targetContinuity: expectedContinuity,
        targetBinding: { processId: 12 }, targetBindingAfterRun: { processId: finalPid } });
      expect(summary.artifacts).toContain(`target-${name}/artifacts/target-binding-after-run.json`);
      if (name === "replaced") expect(summary.findings).toContain("Target listener changed or could not be verified after this Run.");
    }
    let quickChecks = 0;
    const quick = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, targetBinding: async () => ({
      status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
      observedProjectRoot: "D:/code/AIHR", targetOrigin: "http://localhost:5174", processId: ++quickChecks,
      reason: "Listener process path matches the source checkout.", observedAt: new Date().toISOString(),
    }) }).run(charter("quick"), "target-quick");
    expect(quick.verdict).toBe("passed");
    expect(quickChecks).toBe(1);
    expect(quick.targetBindingAfterRun).toBeUndefined();
  });

  it("withdraws a product result when a connector endpoint changes before surface cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-continuity-"));
    for (const productPassed of [true, false]) {
      const runId = productPassed ? "gateway-product-pass" : "gateway-product-failure";
      const adapter = new FakeAdapter();
      let closed = false;
      adapter.close = async () => { closed = true; };
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root,
        oracles: [{ name: "business-terminal", async check() { return {
          name: "business-terminal", passed: productPassed, message: "independent business reader",
          evidence: ['{"terminal":true}'], observedAt: new Date().toISOString(),
        }; } }],
        postRunCheck: async () => {
          expect(closed).toBe(false);
          return { passed: false, message: "Gateway listener changed.", evidence: { gatewayContinuity: "changed" } };
        },
      }).run({ intent: "verify business state", level: "core", mode: "deterministic", preconditions: [],
        actions: [], assertions: [], oracles: ["business-terminal"], sideEffectPolicy: "deny", metadata: {},
      }, runId);
      expect(summary).toMatchObject({ verdict: "inconclusive", integrationPostRunCheck: {
        passed: false, evidence: { gatewayContinuity: "changed" },
      } });
      expect(summary.oracles[0]?.passed).toBe(productPassed);
      expect(summary.artifacts).toContain(`${runId}/artifacts/post-run-check.json`);
      expect(JSON.parse(await readFile(join(root, runId, "artifacts", "post-run-check.json"), "utf8")))
        .toMatchObject({ passed: false, evidence: { gatewayContinuity: "changed" } });
      expect(closed).toBe(true);
    }
  });

  it("keeps a post-run connector exception out of saved evidence and the product verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-post-run-error-"));
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root,
      oracles: [{ name: "business-terminal", async check() { return {
        name: "business-terminal", passed: true, message: "independent business reader",
        evidence: ['{"terminal":true}'], observedAt: new Date().toISOString(),
      }; } }],
      postRunCheck: async () => { throw new Error("private gateway token must not persist"); },
    }).run({ intent: "verify business state", level: "core", mode: "deterministic", preconditions: [],
      actions: [], assertions: [], oracles: ["business-terminal"], sideEffectPolicy: "deny", metadata: {},
    }, "gateway-post-run-error");
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.findings.join(" ")).toContain("Integration endpoint could not be checked after this Run.");
    expect(await readFile(join(root, "gateway-post-run-error", "run.json"), "utf8"))
      .not.toContain("private gateway token");
  });

  it("checks an Electron application listener separately from its HTTP page listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-application-binding-"));
    let applicationChecks = 0;
    const binding = (origin: string, processId: number) => ({ status: "matching-process-path" as const,
      method: "windows-listener-process" as const, expectedProjectRoot: "D:/code/AIHR",
      observedProjectRoot: "D:/code/AIHR", targetOrigin: origin, processId,
      reason: "Listener process path matches the source checkout.", observedAt: new Date().toISOString() });
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root,
      targetBinding: async () => binding("http://localhost:5174", 12),
      applicationBinding: async () => binding("http://localhost:9222", ++applicationChecks === 1 ? 20 : 21),
    }).run({ intent: "Check desktop application", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "allow", metadata: {} }, "application-change-run");
    expect(summary).toMatchObject({ verdict: "inconclusive", targetContinuity: "stable",
      applicationContinuity: "changed", applicationBinding: { processId: 20 }, applicationBindingAfterRun: { processId: 21 } });
    expect(summary.artifacts).toContain("application-change-run/artifacts/application-binding-after-run.json");
  });

  it("blocks a foreign Electron application before attaching to its page", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-foreign-application-"));
    const adapter = new FakeAdapter();
    let connected = false;
    adapter.connect = async () => { connected = true; };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root,
      targetBinding: async () => ({ status: "matching-process-path", method: "windows-listener-process",
        expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/code/AIHR", targetOrigin: "http://localhost:5174",
        processId: 12, reason: "Page server matches.", observedAt: new Date().toISOString() }),
      applicationBinding: async () => ({ status: "different-project", method: "windows-listener-process",
        expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/tmp/other",
        targetOrigin: "http://localhost:9222", processId: 20,
        reason: "Application belongs to another checkout.", observedAt: new Date().toISOString() }),
    }).run({ intent: "Check desktop application", level: "quick", mode: "deterministic", preconditions: [],
      actions: [], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {} },
    "foreign-application-run");
    expect(connected).toBe(false);
    expect(summary).toMatchObject({ verdict: "blocked", targetBinding: { status: "matching-process-path" },
      applicationBinding: { status: "different-project" } });
  });

  it("keeps a core Run inconclusive if the known target cannot be reidentified", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-unverified-"));
    let checks = 0;
    const summary = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, targetBinding: async () => ({
      status: ++checks === 1 ? "matching-process-path" : "unverified",
      method: checks === 1 ? "windows-listener-process" : "unavailable", expectedProjectRoot: "D:/code/AIHR",
      ...(checks === 1 ? { observedProjectRoot: "D:/code/AIHR", processId: 12 } : {}),
      targetOrigin: "http://localhost:5174", reason: "Point-in-time listener check.", observedAt: new Date().toISOString(),
    }) }).run({ intent: "Check target", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "allow", metadata: {} }, "target-unverified");
    expect(summary).toMatchObject({ verdict: "inconclusive", targetContinuity: "unverified" });
    expect(summary.findings).toContain("Target listener changed or could not be verified after this Run.");

    checks = 0;
    const unavailable = await new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, targetBinding: async () => {
      if (++checks === 2) throw new Error("Listener probe failed");
      return { status: "matching-process-path" as const, method: "windows-listener-process" as const,
        expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/code/AIHR",
        targetOrigin: "http://localhost:5174", processId: 12,
        reason: "Listener process path matches the source checkout.", observedAt: new Date().toISOString() };
    } }).run({ intent: "Check target", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "allow", metadata: {} }, "target-probe-error");
    expect(unavailable).toMatchObject({ verdict: "inconclusive", targetContinuity: "unverified" });
    expect(unavailable.findings).toContain("Target listener could not be checked after this Run.");
  });

  it("rechecks the listener before surface cleanup when an assertion throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-assertion-error-"));
    for (const [name, finalPid, expectedVerdict, expectedContinuity] of [
      ["stable", 12, "inconclusive", "stable"],
      ["replaced", 13, "inconclusive", "changed"],
    ] as const) {
      let checks = 0;
      let checksAtClose = 0;
      const adapter = new FakeAdapter();
      adapter.assert = async () => { throw new Error("Assertion adapter failed"); };
      adapter.close = async () => { checksAtClose = checks; };
      const summary = await new ExecutionRunner(adapter, { evidenceDir: root, targetBinding: async () => ({
        status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
        observedProjectRoot: "D:/code/AIHR", targetOrigin: "http://localhost:5174",
        processId: ++checks === 1 ? 12 : finalPid, reason: "Observed listener", observedAt: new Date().toISOString(),
      }) }).run({ intent: "Check target after assertion error", level: "core", mode: "deterministic", preconditions: [],
        actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
        sideEffectPolicy: "allow", metadata: {} }, `target-assertion-${name}`);
      expect(checksAtClose).toBe(2);
      expect(summary).toMatchObject({ verdict: expectedVerdict, targetContinuity: expectedContinuity });
      expect(summary.findings).toContain("Assertion 1 failed without a verified result; inspect trusted local diagnostics.");
      expect(summary.artifacts).toContain(`target-assertion-${name}/artifacts/target-binding-after-run.json`);
      const report = await readFile(join(root, `target-assertion-${name}`, "report.html"), "utf8");
      expect(report).toContain(`Continuity: ${expectedContinuity}`);
      expect(report).toContain('href="artifacts/target-binding-after-run.json"');
    }
  });

  it("does not pass a Run whose final listener probe reaches the Run deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-probe-timeout-"));
    let checks = 0;
    let finalProbeStarted!: () => void;
    const finalProbe = new Promise<void>((resolve) => { finalProbeStarted = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = new ExecutionRunner(new FakeAdapter(), { evidenceDir: root, timeoutMs: 50,
        targetBinding: async () => {
          if (++checks === 2) {
            finalProbeStarted();
            return new Promise(() => {});
          }
          return { status: "matching-process-path" as const, method: "windows-listener-process" as const,
            expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/code/AIHR",
            targetOrigin: "http://localhost:5174", processId: 12,
            reason: "Observed listener", observedAt: new Date().toISOString() };
        },
      }).run({ intent: "Check target until deadline", level: "core", mode: "deterministic", preconditions: [],
        actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
        sideEffectPolicy: "allow", metadata: {} }, "target-probe-timeout");
      await finalProbe;
      await vi.advanceTimersByTimeAsync(50);
      const summary = await run;
      expect(checks).toBe(2);
      expect(summary).toMatchObject({ verdict: "cancelled", targetContinuity: "unverified" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a changed target inconclusive even when runtime policy would fail a console signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-runtime-priority-"));
    let checks = 0;
    const adapter = new EventAdapter([{ type: "console", payload: {
      level: "error", text: "Renderer error", url: "http://fixture/",
    } }]);
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, runtimeQuality: { mode: "fail" },
      targetBinding: async () => ({ status: "matching-process-path", method: "windows-listener-process",
        expectedProjectRoot: "D:/code/AIHR", observedProjectRoot: "D:/code/AIHR",
        targetOrigin: "http://localhost:5174", processId: ++checks === 1 ? 12 : 13,
        reason: "Observed listener", observedAt: new Date().toISOString() }),
    }).run({ intent: "Check renderer against one target", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "allow", metadata: {} }, "target-runtime-priority");
    expect(summary).toMatchObject({ verdict: "inconclusive", targetContinuity: "changed", runtimeHealth: "failed" });
    expect(summary.runtimeFindings).toHaveLength(1);
  });

  it("can record a different checkout without blocking an explicitly scoped diagnostic run", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-target-record-"));
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      targetBindingPolicy: "record",
      targetBinding: async () => ({
        status: "different-project", method: "windows-listener-process", expectedProjectRoot: "D:/code/AIHR",
        observedProjectRoot: "D:/tmp/aihr-hotfix", targetOrigin: "http://localhost:5174", processId: 12,
        reason: "The target port belongs to another checkout.", observedAt: new Date().toISOString(),
      }),
    }).run({ intent: "diagnose another checkout", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "target-record-run");

    expect(summary.verdict).toBe("passed");
    expect(summary.targetBinding?.status).toBe("different-project");
  });

  it("blocks a surface failure when a configured authentication console signal invalidates the test environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-auth-blocker-"));
    const adapter = new EventAdapter([{ type: "console", payload: {
      level: "error",
      text: "AuthRequiredError: login expired\nAuthorization: Bearer private-token\nrequest http://user:password@fixture/api/resume?token=private#candidate",
      url: "http://fixture/",
    } }]);
    const runner = new ExecutionRunner(adapter, { evidenceDir: root, runtimeQuality: { blockConsolePatterns: ["AuthRequiredError"] } });
    const summary = await runner.run({
      intent: "check authenticated page", level: "quick", mode: "deterministic", preconditions: [], actions: [],
      assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {},
    }, "auth-blocker-run");

    expect(summary.assertions[0]?.passed).toBe(false);
    expect(summary.verdict).toBe("blocked");
    expect(summary.runtimeFindings?.[0]).toMatchObject({ category: "environment", status: "confirmed", affectsVerdict: true });
    expect(summary.runtimeFindings?.[0]?.message).toBe("AuthRequiredError: login expired");
    const events = await readFile(join(root, "auth-blocker-run", "events.jsonl"), "utf8");
    expect(events).toContain("AuthRequiredError");
    expect(events).not.toMatch(/private-token|user:password|token=private|candidate/);
    expect(await readFile(join(root, "auth-blocker-run", "run.json"), "utf8")).not.toContain("private-token");
  });

  it("honors an explicit environment blocker even when ordinary runtime classification is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-auth-ignore-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "console", payload: { level: "log", text: "AuthRequiredError", url: "http://fixture/app" } },
    ]), { evidenceDir: root, runtimeQuality: { mode: "ignore", blockConsolePatterns: ["AuthRequiredError"] } }).run({
      intent: "check login", level: "quick", mode: "deterministic", preconditions: [], actions: [],
      assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {},
    }, "auth-ignore-run");

    expect(summary.verdict).toBe("blocked");
    expect(summary.runtimeFindings).toHaveLength(1);
    expect(summary.runtimeHealth).toBe("failed");
  });

  it("keeps an independently evidenced business failure above an environment console blocker", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-auth-business-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "console", payload: { level: "error", text: "AuthRequiredError", url: "http://fixture/app" } },
    ]), {
      evidenceDir: root,
      runtimeQuality: { blockConsolePatterns: ["AuthRequiredError"] },
      oracles: [{ name: "binding", check: async () => ({
        name: "binding", passed: false, message: "resume bound to wrong candidate",
        evidence: [JSON.stringify({ candidateMatches: false })],
      }) }],
    }).run({
      intent: "check binding", level: "core", mode: "deterministic", preconditions: [], actions: [],
      assertions: [], oracles: ["binding"], sideEffectPolicy: "deny", metadata: {},
    }, "auth-business-run");

    expect(summary.verdict).toBe("failed");
    expect(summary.oracles[0]?.sourceEvidenceCount).toBe(1);
    expect(summary.runtimeFindings?.[0]?.status).toBe("confirmed");
  });

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
    let executionLeaseHeld = false;
    const summaryPromise = new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root, signal: controller.signal,
      executionLease: async () => {
        executionLeaseHeld = true;
        return { release: async () => { executionLeaseHeld = false; } };
      },
      setup: async () => { setupStarted(); await finish; return () => { lateCleanup(); }; },
    }).run({ intent: "expire setup grace", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, "expired-setup");
    await started;
    controller.abort(new CancelledError("stop setup"));
    const summary = await summaryPromise;
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings.some((finding) => finding.includes("resources may still be active"))).toBe(true);
    expect(executionLeaseHeld).toBe(true);
    finishSetup();
    await cleaned;
    const until = Date.now() + 1_000;
    while (executionLeaseHeld && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executionLeaseHeld).toBe(false);
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
    expect(summary.assertions[0]?.evidence).toEqual(["run-test/artifacts/assertion-001-snapshot.json"]);
    expect(summary.assertions[0]?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.artifacts).toContain("run-test/artifacts/assertion-001-snapshot.json");
    expect(await readFile(join(root, "run-test", "artifacts", "assertion-001-snapshot.json"), "utf8")).toContain("Ready");
    expect(await readFile(join(root, "run-test", "report.html"), "utf8")).toContain('href="artifacts/assertion-001-snapshot.json"');
    expect(await readFile(join(root, "run-test", "events.jsonl"), "utf8")).toContain("run.completed");
  });

  it("keeps a failed assertion inconclusive when only an earlier step has evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-assertion-gap-"));
    class LostAssertionEvidenceAdapter extends FakeAdapter {
      private snapshots = 0;
      override async snapshot(): Promise<SurfaceSnapshot> {
        if (++this.snapshots > 2) throw new Error("page detached before assertion observation");
        return super.snapshot();
      }
      override async assert(assertion: Assertion): Promise<AssertionResult> {
        return { assertion, passed: false, message: "not visible", evidence: ["assertion-gap/artifacts/step-001-after.json"] };
      }
    }
    const summary = await new ExecutionRunner(new LostAssertionEvidenceAdapter(), { evidenceDir: root }).run({
      intent: "check current page", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "assertion-gap");
    expect(summary.steps[0]?.artifacts).toContain("assertion-gap/artifacts/step-001-after.json");
    expect(summary.assertions[0]?.evidence).toEqual([]);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.findings).toContainEqual(expect.stringContaining("no contemporaneous saved observation"));
  });

  it("records runtime signals without changing a passing business run", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-record-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "console", payload: { level: "error", text: "renderer failed", url: "http://fixture/app" } },
      { type: "pageerror", payload: { message: "uncaught error", url: "http://fixture/app" } },
      { type: "response", payload: { method: "GET", status: 500, url: "http://fixture/api/resume" } },
    ]), {
      evidenceDir: root,
      runtimeQuality: {
        mode: "record",
        pageErrors: true,
        requestFailures: false,
        consoleLevels: ["error"],
        failedResponses: { enabled: true, include4xx: false },
        allowUrlPatterns: [],
        ignoreUrlPatterns: [],
      },
    }).run({
      intent: "runtime diagnostics",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "runtime-record");

    expect(summary.verdict).toBe("passed");
    expect(summary.runtimeHealth).toBe("failed");
    expect(summary.runtimeFindings).toHaveLength(3);
    expect(summary.artifacts).toContain("runtime-record/artifacts/runtime-findings.json");
    const events = await readFile(join(root, "runtime-record", "events.jsonl"), "utf8");
    expect(events).toContain('"type":"adapter.event"');
    expect(events).toContain('"type":"finding.created"');
    expect(await readFile(join(root, "runtime-record", "report.html"), "utf8")).toContain("Runtime health");
  });

  it("rejects invalid runtime URL filters before a run starts", () => {
    expect(() => new ExecutionRunner(new FakeAdapter(), {
      runtimeQuality: {
        mode: "fail", pageErrors: true, requestFailures: false, consoleLevels: ["error"],
        failedResponses: { enabled: true, include4xx: false }, allowUrlPatterns: ["["], ignoreUrlPatterns: [],
      },
    })).toThrow("Invalid runtime allowUrlPatterns[0] regular expression");
  });

  it("rejects invalid environment blocker patterns before a run starts", () => {
    expect(() => new ExecutionRunner(new FakeAdapter(), {
      runtimeQuality: { blockConsolePatterns: ["["] },
    })).toThrow("Invalid runtime blockConsolePatterns[0] regular expression");
  });

  it("classifies only matching URLs when a runtime allow list is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-allow-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "pageerror", payload: { message: "unknown page" } },
      { type: "pageerror", payload: { message: "other page", url: "http://other/app" } },
      { type: "pageerror", payload: { message: "target page", url: "http://fixture/app" } },
    ]), {
      evidenceDir: root,
      runtimeQuality: {
        mode: "record", pageErrors: true, requestFailures: false, consoleLevels: ["error"],
        failedResponses: { enabled: true, include4xx: false }, allowUrlPatterns: ["^http://fixture/"], ignoreUrlPatterns: [],
      },
    }).run({
      intent: "runtime allow list", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "runtime-allow");
    expect(summary.verdict).toBe("passed");
    expect(summary.runtimeFindings?.map((item) => item.message)).toEqual(["target page"]);
  });

  it("redacts undeclared URL paths as well as credentials and query data from runtime evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-url-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "response", payload: { method: "GET", status: 500, url: "http://user:password@fixture/api/resume?token=private#candidate" } },
    ]), { evidenceDir: root }).run({
      intent: "runtime URL redaction", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "runtime-url");
    const events = await readFile(join(root, "runtime-url", "events.jsonl"), "utf8");
    expect(summary.runtimeFindings?.[0]?.url).toBe("http://fixture/__redacted__");
    expect(events).toContain("http://fixture/__redacted__");
    expect(events).toContain('"urlPathEvidence":"redacted"');
    expect(events).not.toContain("/api/resume");
    expect(events).not.toMatch(/password|private|candidate/);
  });

  it("records declared route patterns while classifying the original runtime URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-pattern-"));
    const privateId = "private-candidate-123";
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "pageerror", payload: {
        message: `Failed at http://fixture/resumes/${privateId}?token=private`,
        url: `http://fixture/resumes/${privateId}?token=private`,
      } },
      { type: "response", payload: {
        method: "GET", status: 500, url: `http://fixture/api/v1/resumes/${privateId}?token=private`,
      } },
      { type: "pageerror", payload: { message: "ignore another ID", url: "http://fixture/other/private-456" } },
    ]), {
      evidenceDir: root,
      webEvidenceOrigin: "http://fixture",
      urlEvidenceTargets: [
        { kind: "web", path: "/resumes/:id" },
        { kind: "api", method: "GET", origin: "http://fixture", path: "/api/v1/resumes/:id" },
      ],
      runtimeQuality: { allowUrlPatterns: [privateId] },
    }).run({
      intent: "runtime route projection", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "runtime-pattern");

    expect(summary.runtimeFindings?.map((finding) => finding.url)).toEqual([
      "http://fixture/resumes/:id", "http://fixture/api/v1/resumes/:id",
    ]);
    const saved = await readFile(join(root, "runtime-pattern", "run.json"), "utf8");
    const events = await readFile(join(root, "runtime-pattern", "events.jsonl"), "utf8");
    expect(saved + events).not.toMatch(/private-candidate-123|private-456|token=private/);
    expect(events).toContain("Failed at http://fixture/resumes/:id");
    expect(events).toContain("http://fixture/api/v1/resumes/:id");
    expect(events).toContain("http://fixture/__redacted__");
    expect(events).toContain('"urlPathEvidence":"declared"');
  });

  it("does not present an ambiguous route match as observed coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-ambiguous-"));
    await new ExecutionRunner(new EventAdapter([
      { type: "response", payload: { method: "GET", status: 500, url: "http://fixture/resumes/private-123" } },
    ]), {
      evidenceDir: root,
      webEvidenceOrigin: "http://fixture",
      urlEvidenceTargets: [
        { kind: "web", path: "/resumes/:id" },
        { kind: "web", path: "/:section/:id" },
      ],
    }).run({
      intent: "ambiguous route", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {},
    }, "runtime-ambiguous");
    const events = await readFile(join(root, "runtime-ambiguous", "events.jsonl"), "utf8");
    expect(events).toContain('"url":"http://fixture/__redacted__","urlPathEvidence":"redacted"');
    expect(events).not.toContain("private-123");
  });

  it("can fail a run on configured runtime signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-fail-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "response", payload: { method: "GET", status: 500, url: "http://fixture/api/resume" } },
    ]), {
      evidenceDir: root,
      runtimeQuality: {
        mode: "fail",
        pageErrors: true,
        requestFailures: false,
        consoleLevels: ["error"],
        failedResponses: { enabled: true, include4xx: false },
        allowUrlPatterns: [],
        ignoreUrlPatterns: [],
      },
    }).run({
      intent: "runtime failure",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "runtime-fail");

    expect(summary.verdict).toBe("failed");
    expect(summary.runtimeFindings?.[0]?.affectsVerdict).toBe(true);
  });

  it("keeps raw adapter events while ignoring runtime classification", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-runtime-ignore-"));
    const summary = await new ExecutionRunner(new EventAdapter([
      { type: "console", payload: { level: "error", text: "ignored", url: "http://fixture/app" } },
    ]), {
      evidenceDir: root,
      runtimeQuality: {
        mode: "ignore",
        pageErrors: true,
        requestFailures: false,
        consoleLevels: ["error"],
        failedResponses: { enabled: true, include4xx: false },
        allowUrlPatterns: [],
        ignoreUrlPatterns: [],
      },
    }).run({
      intent: "ignore runtime",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "click", selector: "#ready" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "runtime-ignore");

    expect(summary.verdict).toBe("passed");
    expect(summary.runtimeHealth).toBe("ignored");
    expect(summary.runtimeFindings).toEqual([]);
    expect(await readFile(join(root, "runtime-ignore", "events.jsonl"), "utf8")).toContain('"eventType":"console"');
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
    expect(summary.oracles[0]?.sourceEvidenceCount).toBe(0);
    expect(await readFile(join(root, "capability-run", "report.html"), "utf8")).toContain("oracle-1.json");
  });

  it("persists Oracle source facts separately from the verdict report", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-facts-"));
    const facts = { state: "failed", candidateId: "opaque-123" };
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      oracles: [{ name: "resume-terminal", check: async () => ({ name: "resume-terminal", passed: false, message: "incorrect binding", evidence: [JSON.stringify(facts)] }) }],
    }).run({ intent: "check resume facts", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], oracles: ["resume-terminal"], sideEffectPolicy: "deny", metadata: {} }, "facts-run");

    const oracle = summary.oracles[0]!;
    expect(oracle.verificationKind).toBe("business");
    expect(oracle.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(oracle.sourceEvidenceCount).toBe(1);
    expect(oracle.sourceEvidenceArtifacts).toEqual(["facts-run/artifacts/oracle-1-source.json"]);
    expect(oracle.evidence).toEqual(["facts-run/artifacts/oracle-1-source.json", "facts-run/artifacts/oracle-1.json"]);
    expect(JSON.parse(await readFile(join(root, "facts-run", "artifacts", "oracle-1-source.json"), "utf8"))).toMatchObject({ facts: [facts] });
    const report = await readFile(join(root, "facts-run", "artifacts", "oracle-1.json"), "utf8");
    expect(report).not.toContain("opaque-123");
    expect(report).toContain("oracle-1-source.json");
  });

  it("does not accept a business oracle result with a different registered name", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-name-"));
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      oracles: [{ name: "resume-terminal", check: async () => ({ name: "unrelated", passed: true, message: "complete", evidence: [JSON.stringify({ status: "complete" })] }) }],
    }).run({ intent: "check resume", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], oracles: ["resume-terminal"], sideEffectPolicy: "deny", metadata: {} }, "mismatched-oracle-run");
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.oracles).toHaveLength(0);
    expect(summary.findings.some((finding) => finding.includes("Business Oracle 1 could not establish a result"))).toBe(true);
  });

  it("treats a business Oracle reader exception as inconclusive without persisting private source data", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-reader-"));
    const marker = "PRIVATE_RESUME_CONTACT_24680";
    const summary = await new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      oracles: [{ name: "resume-terminal", check: async () => { throw new Error(`gateway unavailable: ${marker}`); } }],
    }).run({ intent: "check resume", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], oracles: ["resume-terminal"], sideEffectPolicy: "deny", metadata: {} }, "reader-error-run");
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.oracles).toHaveLength(0);
    const persisted = JSON.stringify(summary) + await readFile(join(root, "reader-error-run", "events.jsonl"), "utf8");
    expect(persisted).toContain("Business Oracle 1 could not establish a result");
    expect(persisted).not.toContain(marker);
  });

  it("preserves cancellation while a business Oracle is still reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-cancel-"));
    const controller = new AbortController();
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    const running = new ExecutionRunner(new FakeAdapter(), {
      evidenceDir: root,
      signal: controller.signal,
      oracles: [{ name: "resume-terminal", check: async () => { reading(); return new Promise<never>(() => {}); } }],
    }).run({ intent: "check resume", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], oracles: ["resume-terminal"], sideEffectPolicy: "deny", metadata: {} }, "oracle-cancel-run");
    await entered;
    controller.abort(new CancelledError("cancelled during Oracle read"));
    const summary = await running;
    expect(summary.verdict).toBe("cancelled");
    expect(summary.oracles).toHaveLength(0);
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
