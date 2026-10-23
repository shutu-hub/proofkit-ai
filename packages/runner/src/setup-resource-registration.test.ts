import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore, LocalExecutionOwnership } from "@proofkit/evidence";
import type { IntegrationSetupContext, IntegrationSetupHandle, SurfaceAdapter } from "./index.js";
import { ExecutionRunner } from "./index.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const charter = { intent: "Provision isolated data and verify the page", level: "quick" as const, mode: "deterministic" as const,
  sideEffectPolicy: "allow" as const, preconditions: [], actions: [{ kind: "observe" as const }], assertions: [{ kind: "text-visible" as const, text: "Ready" }], metadata: {} };
const surface = (): SurfaceAdapter => ({ name: "fixture", connect: vi.fn(async () => {}), discover: async () => ({ capturedAt: new Date().toISOString(), text: "Ready", metadata: {} }),
  snapshot: async () => ({ capturedAt: new Date().toISOString(), text: "Ready", metadata: {} }),
  act: async (action) => ({ actionId: "observe", kind: action.kind, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, metadata: {} }),
  assert: async (assertion) => ({ assertion, passed: true, message: "Ready", evidence: [] }), capture: async () => undefined, subscribeEvents: async () => () => {}, close: async () => {} });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "proofkit-early-resource-")); roots.push(root); return root; }
const policy = { sideEffect: "write" as const, environments: ["test" as const], cleanupTimeoutMs: 1000 };
function owned(runId: string, cleanup: IntegrationSetupHandle["cleanup"] = async () => [{ resourceId: "scope", status: "removed" as const, evidence: { status: 404 },
  readback: { reader: "fixture.get", scope: runId, exists: false, observedAt: new Date().toISOString() } }]): IntegrationSetupHandle {
  return { resources: [{ resourceId: "scope", kind: "test-scope", scope: runId, evidence: { owner: runId } }], cleanup };
}

describe("setup early resource registration", () => {
  it("persists a recoverable journal before provisioning and retains it if later setup fails", async () => {
    const root = await fixture(); const adapter = surface(); let cleaned = 0;
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async ({ runId, registerResources }) => {
        const handle = owned(runId); const original = handle.cleanup; handle.cleanup = async (context) => { cleaned++; return original(context); };
        await registerResources!(handle);
        const journal = JSON.parse(await readFile(join(root, runId, "artifacts/integration-setup.json"), "utf8"));
        expect(journal.resources).toEqual(handle.resources);
        const events = await readFile(join(root, runId, "events.jsonl"), "utf8"); expect(events).toContain("integration-setup.json");
        throw new Error("Second acquisition failed");
      } }).run(charter, "early-failure");
    expect(adapter.connect).not.toHaveBeenCalled(); expect(cleaned).toBe(1);
    expect(summary.integrationCleanup).toMatchObject({ status: "unverified", declaredResources: 1, verifiedResources: 1 });
    expect(summary.artifacts).toContain("early-failure/artifacts/integration-setup.json");
  });

  it.each([false, true])("does not register or clean the same handle twice when returned=%s", async (returned) => {
    const root = await fixture(); let cleaned = 0;
    const summary = await new ExecutionRunner(surface(), { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async ({ runId, registerResources }) => { const handle = owned(runId); const cleanup = handle.cleanup;
        handle.cleanup = async (context) => { cleaned++; return cleanup(context); }; await registerResources!(handle); if (returned) return handle; },
    }).run(charter, "early-success");
    expect(cleaned).toBe(1); expect(summary.verdict).toBe("passed");
    expect(summary.integrationCleanup).toMatchObject({ status: "verified", declaredResources: 1, verifiedResources: 1 });
    expect(summary.artifacts.filter((artifact) => artifact.endsWith("integration-setup.json"))).toHaveLength(1);
  });

  it("rejects an escaped registration callback after setup closes without rewriting its journal", async () => {
    const root = await fixture(); let saved: IntegrationSetupContext | undefined;
    await new ExecutionRunner(surface(), { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async (context) => { saved = context; const handle = owned(context.runId); await context.registerResources!(handle); },
    }).run(charter, "closed-registration");
    const before = await readFile(join(root, "closed-registration/artifacts/integration-setup.json"));
    await expect(saved!.registerResources!(owned("closed-registration"))).rejects.toThrow("closed");
    expect(await readFile(join(root, "closed-registration/artifacts/integration-setup.json"))).toEqual(before);
  });

  it("retains an honest unknown cleanup result and releases a resource created after cancellation grace", async () => {
    const root = await fixture(); const controller = new AbortController();
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
    let exists = false; let cleanups = 0;
    const running = new ExecutionRunner(surface(), { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy, signal: controller.signal,
      setup: async ({ runId, registerResources }) => {
        const handle = owned(runId); const cleanup = handle.cleanup;
        handle.cleanup = async (context) => { cleanups++; exists = false; return cleanup(context); };
        await registerResources!(handle); entered(); await gate; exists = true; throw new Error("Late setup failed after a write");
      },
    }).run(charter, "late-checkpoint");
    await ready; controller.abort(new Error("Stop setup"));
    try {
      const summary = await running;
      expect(summary.integrationCleanup?.status).toBe("unverified"); expect(cleanups).toBe(1);
      const ownership = new LocalExecutionOwnership(root, "run");
      expect(await ownership.isActive("late-checkpoint")).toBe(true);
      await expect(new ExecutionRunner(surface(), { evidenceDir: root }).run(charter, "late-checkpoint")).rejects.toThrow("active");
      const original = await readFile(join(root, "late-checkpoint/run.json"));
      resume();
      await vi.waitFor(() => { expect(cleanups).toBe(2); expect(exists).toBe(false); });
      await vi.waitFor(async () => { expect(await ownership.isActive("late-checkpoint")).toBe(false); });
      expect(await readFile(join(root, "late-checkpoint/run.json"))).toEqual(original);
    } finally { resume(); await running; }
  }, 10000);

  it("does not start a second registration even if the connector catches that rejection", async () => {
    const root = await fixture();
    const summary = await new ExecutionRunner(surface(), { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async ({ runId, registerResources }) => {
        const handle = owned(runId); await registerResources!(handle);
        await expect(registerResources!(handle)).rejects.toThrow("once per setup");
      },
    }).run(charter, "single-registration");
    expect(summary.integrationCleanup).toMatchObject({ status: "verified", declaredResources: 1 });
  });

  it("does not let provisioning proceed when registration persistence fails, but retains the cleanup handle", async () => {
    const root = await fixture(); const adapter = surface(); let provisioned = false; let cleaned = 0;
    vi.spyOn(EvidenceStore.prototype, "writeJsonAtomic").mockRejectedValue(new Error("Synthetic journal write failure"));
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async ({ runId, registerResources }) => {
        const handle = owned(runId); const cleanup = handle.cleanup;
        handle.cleanup = async (context) => { cleaned++; return cleanup(context); };
        await registerResources!(handle); provisioned = true;
      },
    }).run(charter, "registration-disk-failure");
    expect(provisioned).toBe(false); expect(cleaned).toBe(1); expect(adapter.connect).not.toHaveBeenCalled();
    expect(summary.integrationCleanup?.status).toBe("unverified");
    expect(summary.verdict).not.toBe("passed");
  });

  it("waits for a started registration even if the connector forgets to await the callback", async () => {
    const root = await fixture(); let journalReadyBeforeConnect = false;
    const adapter = surface();
    adapter.connect = async () => {
      const bytes = await readFile(join(root, "unawaited-registration/artifacts/integration-setup.json"), "utf8");
      journalReadyBeforeConnect = JSON.parse(bytes).resources.length === 1;
    };
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, allowSetupWrites: true, setupPolicy: policy,
      setup: async ({ runId, registerResources }) => { void registerResources!(owned(runId)); },
    }).run(charter, "unawaited-registration");
    expect(journalReadyBeforeConnect).toBe(true); expect(summary.integrationCleanup?.status).toBe("verified");
    expect(summary.verdict).toBe("passed");
  });

  it("does not allow a read-only setup to register write resource ownership", async () => {
    const root = await fixture(); const adapter = surface();
    const summary = await new ExecutionRunner(adapter, { evidenceDir: root, setupPolicy: { ...policy, sideEffect: "read" },
      setup: async ({ runId, registerResources }) => { await registerResources!(owned(runId)); },
    }).run({ ...charter, sideEffectPolicy: "deny" }, "read-only-registration");
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(await readdir(join(root, summary.runId, "artifacts"))).not.toContain("integration-setup.json");
  });
});
