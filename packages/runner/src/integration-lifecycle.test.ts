import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action, Assertion, IntegrationResourceCleanup, TestCharter } from "@proofkit/contracts";
import { CancelledError, ExecutionRunner, type ExecutionOptions, type IntegrationSetupHandle, type SurfaceAdapter } from "./index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const charter: TestCharter = {
  intent: "verify isolated resource lifecycle", level: "quick", mode: "deterministic", preconditions: [],
  actions: [{ kind: "click", selector: "#ready" }], assertions: [{ kind: "text-visible", text: "ready" }],
  sideEffectPolicy: "allow", metadata: {},
};
function adapter(act?: (action: Action) => Promise<any>): SurfaceAdapter {
  return {
    name: "fixture", connect: async () => {}, discover: async () => ({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} }),
    snapshot: async () => ({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} }),
    act: act ?? (async (action: Action) => ({ actionId: "1", kind: action.kind, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, metadata: {} })),
    assert: async (assertion: Assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }),
    capture: async () => undefined, subscribeEvents: async () => () => {}, close: async () => {},
  };
}
async function options(): Promise<ExecutionOptions> {
  const root = await mkdtemp(join(tmpdir(), "proofkit-resource-lifecycle-")); roots.push(root);
  return { evidenceDir: root, environment: "local", allowCapabilityWrites: true, setupPolicy: { sideEffect: "write", environments: ["local"], cleanupTimeoutMs: 100 } };
}
function handle(runId: string, cleanup: IntegrationSetupHandle["cleanup"]): IntegrationSetupHandle {
  return { resources: [{ resourceId: "tenant", kind: "test-tenant", scope: runId, evidence: { owner: runId } }], cleanup };
}
function removed(runId: string): IntegrationResourceCleanup[] {
  return [{ resourceId: "tenant", status: "removed", evidence: { statusCode: 404 }, readback: { reader: "fixture.get", scope: runId, observedAt: new Date().toISOString(), exists: false } }];
}

describe("integration resource lifecycle", () => {
  it("creates a unique loopback resource and verifies removal with an independent GET", async () => {
    const resources = new Set<string>();
    const server = createServer((request, response) => {
      const key = request.url!;
      if (request.method === "POST") { resources.add(key); response.writeHead(201).end(); }
      else if (request.method === "DELETE") { resources.delete(key); response.writeHead(204).end(); }
      else response.writeHead(resources.has(key) ? 200 : 404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const configuration = await options();
    configuration.setup = async ({ runId, environment, charter: plan }) => {
      expect(environment).toBe("local"); expect(plan.intent).toBe(charter.intent);
      const url = `http://127.0.0.1:${address.port}/tenants/${runId}`;
      expect((await fetch(url, { method: "POST" })).status).toBe(201);
      return handle(runId, async ({ signal }) => {
        expect(signal.aborted).toBe(false);
        await fetch(url, { method: "DELETE", signal });
        const observation = await fetch(url, { signal });
        return [{ resourceId: "tenant", status: observation.status === 404 ? "removed" : "retained", evidence: { statusCode: observation.status, secret: "must-be-redacted" },
          readback: { reader: "fixture.get", scope: runId, observedAt: new Date().toISOString(), exists: observation.status !== 404 } }];
      });
    };
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "isolated-tenant");
    expect(summary.verdict).toBe("passed");
    expect(summary.integrationCleanup).toMatchObject({ status: "verified", declaredResources: 1, verifiedResources: 1 });
    expect(resources.size).toBe(0);
    const evidence = await readFile(join(configuration.evidenceDir!, summary.integrationCleanup!.artifact!), "utf8");
    expect(JSON.parse(evidence).observations[0].readback.exists).toBe(false);
    expect(evidence).not.toContain("must-be-redacted");
    const setup = JSON.parse(await readFile(join(configuration.evidenceDir!, "isolated-tenant/artifacts/integration-setup.json"), "utf8"));
    expect(setup.resources[0].scope).toBe("isolated-tenant");
  });

  it.each(["no-readback", "foreign-scope", "stale-readback", "missing", "duplicate", "foreign-resource", "retained"] as const)("rejects %s cleanup evidence after a passing test", async (kind) => {
    const configuration = await options();
    configuration.setup = async ({ runId }) => handle(runId, async () => {
      const observations = removed(runId);
      if (kind === "no-readback") delete observations[0]!.readback;
      if (kind === "foreign-scope") observations[0]!.readback!.scope = "another-run";
      if (kind === "stale-readback") observations[0]!.readback!.observedAt = "2020-01-01T00:00:00.000Z";
      if (kind === "missing") return [];
      if (kind === "duplicate") observations.push(observations[0]!);
      if (kind === "foreign-resource") observations.push({ ...observations[0]!, resourceId: "foreign" });
      if (kind === "retained") { observations[0]!.status = "retained"; observations[0]!.readback!.exists = true; }
      return observations;
    });
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, `cleanup-${kind}`);
    expect(summary.verdict).toBe("blocked");
    expect(summary.integrationCleanup?.status).toBe(kind === "retained" ? "failed" : "unverified");
    expect(summary.artifacts).toContain(summary.integrationCleanup?.artifact);
  });

  it("aborts hung cleanup at its deadline and does not certify late completion", async () => {
    const configuration = await options();
    let cleanupSignal: AbortSignal | undefined;
    let finish!: (value: IntegrationResourceCleanup[]) => void;
    configuration.setup = async ({ runId }) => handle(runId, async ({ signal }) => { cleanupSignal = signal; return new Promise((resolve) => { finish = resolve; }); });
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "hung-cleanup");
    expect(summary.verdict).toBe("blocked"); expect(cleanupSignal?.aborted).toBe(true);
    expect(summary.integrationCleanup?.status).toBe("unverified");
    finish(removed("hung-cleanup"));
    expect(JSON.parse(await readFile(join(configuration.evidenceDir!, "hung-cleanup/run.json"), "utf8")).integrationCleanup.status).toBe("unverified");
  });

  it("keeps cleanup ownership when a later setup fails", async () => {
    const configuration = await options();
    const calls: string[] = [];
    configuration.setup = [
      { policy: configuration.setupPolicy, setup: async ({ runId }) => handle(runId, async () => { calls.push("tenant"); return removed(runId); }) },
      async () => { throw new Error("application startup failed"); },
    ];
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "partial-setup");
    expect(calls).toEqual(["tenant"]); expect(summary.verdict).toBe("failed");
    expect(summary.integrationCleanup).toMatchObject({ status: "unverified", declaredResources: 1, verifiedResources: 1 });
  });

  it("attempts cleanup for invalid registration without persisting invalid metadata", async () => {
    const configuration = await options(); let cleaned = false;
    configuration.setup = async () => ({ resources: [{ resourceId: "invalid/resource", kind: "tenant", scope: "x", evidence: { content: "invalid-metadata-must-not-leak" } }], cleanup: async () => { cleaned = true; return []; } });
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "invalid-resource");
    expect(cleaned).toBe(true); expect(summary.integrationCleanup?.status).toBe("unverified");
    expect(await readFile(join(configuration.evidenceDir!, summary.integrationCleanup!.artifact!), "utf8")).not.toContain("invalid-metadata-must-not-leak");
  });

  it.each([false, true])("releases resources in reverse order and continues after a cleanup error (%s)", async (throws) => {
    const configuration = await options();
    const calls: string[] = [];
    configuration.setup = ["tenant", "worker"].map((resourceId) => ({
      policy: configuration.setupPolicy,
      setup: async ({ runId }) => ({
        resources: [{ resourceId, kind: "fixture", scope: runId, evidence: {} }],
        cleanup: async () => {
          calls.push(resourceId);
          if (throws && resourceId === "worker") throw new Error("cleanup failed");
          return removed(runId).map((item) => ({ ...item, resourceId }));
        },
      }),
    }));
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, `reverse-cleanup-${throws}`);
    expect(calls).toEqual(["worker", "tenant"]);
    expect(summary.integrationCleanup).toMatchObject({ status: throws ? "failed" : "verified", declaredResources: 2, verifiedResources: throws ? 1 : 2 });
    expect(summary.verdict).toBe(throws ? "blocked" : "passed");
  });

  it("rejects a readback taken in an earlier cleanup stage before this handle was released", async () => {
    const configuration = await options();
    configuration.setupPolicy!.cleanupTimeoutMs = 1000;
    let earlierReadback: string;
    configuration.setup = ["tenant", "worker"].map((resourceId) => ({
      policy: configuration.setupPolicy,
      setup: async ({ runId }) => ({
        resources: [{ resourceId, kind: "fixture", scope: runId, evidence: {} }],
        cleanup: async () => {
          const result = removed(runId).map((item) => ({ ...item, resourceId }));
          if (resourceId === "worker") {
            earlierReadback = result[0]!.readback!.observedAt;
            await new Promise((resolve) => setTimeout(resolve, 15));
          } else result[0]!.readback!.observedAt = earlierReadback;
          return result;
        },
      }),
    }));
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "earlier-stage-readback");
    expect(summary.integrationCleanup).toMatchObject({ status: "unverified", declaredResources: 2, verifiedResources: 1 });
    expect(summary.verdict).toBe("blocked");
  });

  it("uses a fresh cleanup signal after Run cancellation", async () => {
    const configuration = await options(); const controller = new AbortController(); configuration.signal = controller.signal;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let cleaned = false;
    configuration.setup = async ({ runId }) => handle(runId, async ({ signal }) => { expect(signal.aborted).toBe(false); cleaned = true; return removed(runId); });
    const running = new ExecutionRunner(adapter(async () => { entered(); return new Promise(() => {}); }), configuration).run(charter, "cancel-cleanup");
    await started; controller.abort(new CancelledError("stop test"));
    const summary = await running;
    expect(summary.verdict).toBe("cancelled"); expect(cleaned).toBe(true); expect(summary.integrationCleanup?.status).toBe("verified");
  });

  it.each(["charter", "operator", "environment"] as const)("blocks write setup without %s permission before acquiring resources", async (denied) => {
    const configuration = await options(); let called = false;
    configuration.setup = async ({ runId }) => { called = true; return handle(runId, async () => removed(runId)); };
    if (denied === "operator") configuration.allowCapabilityWrites = false;
    if (denied === "environment") configuration.environment = "test";
    const summary = await new ExecutionRunner(adapter(), configuration).run({ ...charter, sideEffectPolicy: denied === "charter" ? "deny" : "allow" }, `denied-${denied}`);
    expect(called).toBe(false); expect(summary.verdict).toBe("blocked"); expect(summary.integrationCleanup?.status).toBe("not-required");
  });

  it("keeps legacy cleanup compatible and explicitly uncertified", async () => {
    const configuration = await options(); delete configuration.setupPolicy;
    let cleaned = false; configuration.setup = async () => () => { cleaned = true; };
    const summary = await new ExecutionRunner(adapter(), configuration).run(charter, "legacy-cleanup");
    expect(summary.verdict).toBe("passed"); expect(cleaned).toBe(true); expect(summary.integrationCleanup?.status).toBe("completed");
  });
});
