import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema, type TestMission } from "@proofkit/contracts";
import type { SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService, type LocalAdapterName } from "./index.js";

const adapterState = vi.hoisted(() => ({ connected: 0, closed: 0 }));

vi.mock("@proofkit/adapters", () => {
  class Adapter implements SurfaceAdapter {
    readonly name: string = "fixture";
    async connect() { adapterState.connected++; }
    async discover() { return this.snapshot(); }
    async snapshot() { return { capturedAt: new Date().toISOString(), text: "ready", metadata: {} }; }
    async act(): Promise<never> { throw new Error("Not used by the cancellation fixture"); }
    async assert(assertion: Parameters<SurfaceAdapter["assert"]>[0]) { return { assertion, passed: true, message: "ready", evidence: [] }; }
    async capture() { return undefined; }
    async subscribeEvents() { return () => {}; }
    async close() { adapterState.closed++; }
  }
  return { WebAdapter: Adapter, ElectronAdapter: Adapter, MobileAdapter: Adapter };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  adapterState.connected = 0;
  adapterState.closed = 0;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { surface?: LocalAdapterName; level?: "core" | "release"; timeoutMs?: number; pendingRun?: number; delayedCleanup?: boolean; negativeCase?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "proofkit-cancel-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cancellation-fixture" }));
  const observing = deferred<{ runId: string; signal: AbortSignal }>();
  const cleanupEntered = deferred<void>();
  const finishCleanup = deferred<void>();
  let checks = 0;
  let cleaned = 0;
  const service = new LocalRunnerService({
    root, workspaceRoot,
    config: ProofkitConfigSchema.parse({ run: { timeoutMs: 30_000 } }),
    integration: {
      name: "cancellation-fixture",
      setup: async () => async () => {
        if (checks === (options.pendingRun ?? 1)) {
          cleanupEntered.resolve();
          if (options.delayedCleanup) await finishCleanup.promise;
        }
        cleaned++;
      },
      oracles: [{
        name: "terminal",
        async check({ runId, signal }) {
          if (++checks === (options.pendingRun ?? 1)) {
            if (!signal) throw new Error("Missing execution signal");
            observing.resolve({ runId, signal });
            await new Promise<void>((_, reject) => {
              const abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          }
          return { name: "terminal", passed: true, message: "complete", evidence: [], observedAt: new Date().toISOString() };
        },
      }],
    },
  });
  const charter = TestCharterSchema.parse({
    intent: "Verify cancellation of a business workflow", level: options.level ?? "core",
    actions: [], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["terminal"], sideEffectPolicy: "deny",
    negativeCases: options.negativeCase ? [{ caseId: "duplicate", title: "Duplicate submission", actions: [], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["terminal"], sideEffectPolicy: "deny" }] : [],
  });
  const mission = await service.createMission({
    intent: charter.intent, charter, surface: options.surface ?? "web", policy: { timeoutMs: options.timeoutMs ?? 10_000 },
  });
  await service.startMission(mission.missionId, { approve: true });
  return { service, mission, observing, cleanupEntered, finishCleanup, root, cleaned: () => cleaned };
}

async function assertCancelledEvidence(service: LocalRunnerService, mission: TestMission, runId: string) {
  expect(mission.status).toBe("cancelled");
  expect(mission.verdict).toBe("cancelled");
  expect((await service.wait(runId)).verdict).toBe("cancelled");
  expect((await service.status(runId)).status).toBe("completed");
  const observation = mission.observations.find((item) => item.data.runId === runId);
  expect(observation?.data.verdict).toBe("cancelled");
  const step = mission.agentSteps.find((item) => item.status === "cancelled");
  expect(step?.evidence.some((item) => item.kind === "report")).toBe(true);
  expect(mission.toolCalls.find((item) => item.status === "cancelled")?.evidence.length).toBeGreaterThan(0);
  for (const evidence of observation?.evidence ?? []) await readFile(evidence.path);
  const report = mission.evidence.find((item) => item.kind === "report" && item.path.includes(runId));
  expect(await readFile(report!.path, "utf8")).toContain("cancelled");
}

describe("Mission cancellation through Local Runner", () => {
  it.each(["web", "electron", "mobile"] as const)("cancels the %s run and waits for cleanup before closing the Mission", async (surface) => {
    const state = await fixture({ surface, delayedCleanup: true });
    const { runId, signal } = await state.observing.promise;
    let settled = false;
    const cancellation = state.service.cancelMission(state.mission.missionId).then((result) => { settled = true; return result; });
    await state.cleanupEntered.promise;
    expect(signal.aborted).toBe(true);
    expect(adapterState.closed).toBe(1);
    expect(settled).toBe(false);
    expect((await state.service.missionStatus(state.mission.missionId)).running).toBe(true);
    state.finishCleanup.resolve();
    const result = await cancellation;
    expect(state.cleaned()).toBe(1);
    await assertCancelledEvidence(state.service, result.mission, runId);
    expect(await readdir(state.root)).toEqual(["package.json"]);
  });

  it("propagates the Mission deadline to the business observer and preserves its run report", async () => {
    const state = await fixture({ timeoutMs: 1_000 });
    const { runId, signal } = await state.observing.promise;
    const result = await state.service.waitMission(state.mission.missionId);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toContain("total timeout");
    expect(state.cleaned()).toBe(1);
    expect(adapterState.closed).toBe(1);
    expect(result.firstFailure).toMatchObject({ kind: "environment", message: expect.stringContaining("total timeout") });
    expect(result.findings.some((item) => item.title === "Mission timed out")).toBe(true);
    await assertCancelledEvidence(state.service, result, runId);
  });

  it.each([
    { name: "replay", level: "release" as const, pendingRun: 3 },
    { name: "negative", level: "core" as const, pendingRun: 2, negativeCase: true },
  ])("cancels the $name run using the same lifecycle", async (options) => {
    const state = await fixture(options);
    const { runId, signal } = await state.observing.promise;
    const result = await state.service.cancelMission(state.mission.missionId);
    expect(signal.aborted).toBe(true);
    expect(state.cleaned()).toBe(options.pendingRun);
    expect(adapterState.closed).toBe(options.pendingRun);
    expect(result.mission.observations.find((item) => item.data.runId === runId)?.data.runKind).toBe(options.name);
    await assertCancelledEvidence(state.service, result.mission, runId);
  });

  it("does not enter setup or connect when the caller signal is already aborted", async () => {
    const base = await mkdtemp(join(tmpdir(), "proofkit-pre-abort-"));
    roots.push(base);
    const setup = vi.fn();
    const preflight = vi.fn();
    const service = new LocalRunnerService({ root: base, workspaceRoot: base, integration: { name: "pre-abort", setup, preflight } });
    const controller = new AbortController();
    controller.abort(new Error("Parent already stopped"));
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const started = await service.start({ charter: TestCharterSchema.parse({ intent: "pre-aborted", actions: [], assertions: [] }), signal: controller.signal });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("cancelled");
    expect(summary.findings).toContain("Parent already stopped");
    expect(preflight).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(adapterState.connected).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
