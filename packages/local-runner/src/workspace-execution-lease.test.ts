import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { LocalExecutionOwnership } from "@proofkit/evidence";
import type { SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const state = vi.hoisted(() => ({ connected: 0, holdFirst: true, entered: () => {},
  release: Promise.resolve(), releaseFirst: () => {} }));
vi.mock("@proofkit/adapters", () => {
  class Adapter implements SurfaceAdapter {
    readonly name = "fixture";
    async connect() { state.connected++; }
    async discover() { return this.snapshot(); }
    async snapshot() { return { capturedAt: new Date().toISOString(), text: "ready", metadata: {} }; }
    async act(action: Parameters<SurfaceAdapter["act"]>[0]) {
      if (state.holdFirst) {
        state.holdFirst = false;
        state.entered();
        await state.release;
      }
      const at = new Date().toISOString();
      return { actionId: "wait", kind: action.kind, startedAt: at, endedAt: at, durationMs: 0, metadata: {} };
    }
    async assert(assertion: Parameters<SurfaceAdapter["assert"]>[0]) {
      return { assertion, passed: true, message: "ready", evidence: [] };
    }
    async capture() { return new Uint8Array([1]); }
    async subscribeEvents() { return () => {}; }
    async close() { /* no-op */ }
  }
  return { WebAdapter: Adapter, ElectronAdapter: Adapter, MobileAdapter: Adapter };
});

const roots: string[] = [];
afterEach(async () => {
  state.releaseFirst();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  state.connected = 0;
  state.holdFirst = true;
  state.entered = () => {};
  state.release = Promise.resolve();
  state.releaseFirst = () => {};
});

it("blocks a second Run in the same workspace before surface attachment, then releases the lease", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-workspace-lease-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "lease-fixture" }));
  const entered = new Promise<void>((resolve) => { state.entered = resolve; });
  state.release = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
  const charter = TestCharterSchema.parse({ intent: "Check workspace isolation", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  const first = new LocalRunnerService({ root, workspaceRoot });
  const second = new LocalRunnerService({ root, workspaceRoot });

  const active = await first.start({ charter, adapter: "web" });
  await entered;
  expect(state.connected).toBe(1);
  const contender = await second.start({ charter, adapter: "electron" });
  const blocked = await second.wait(contender.runId);
  expect(blocked.verdict).toBe("blocked");
  expect(blocked.findings).toContain("Another Run is active in this test workspace; retry after it completes.");
  expect(state.connected).toBe(1);

  state.releaseFirst();
  expect((await first.wait(active.runId)).verdict).toBe("passed");
  const next = await second.start({ charter, adapter: "electron" });
  expect((await second.wait(next.runId)).verdict).toBe("passed");
  expect(state.connected).toBe(2);
}, 20_000);

it("retains the workspace lease while a timed-out cleanup is still active", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-pending-lease-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pending-lease-fixture" }));
  state.holdFirst = false;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  const charter = TestCharterSchema.parse({ intent: "Check pending cleanup isolation", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  const first = new LocalRunnerService({ root, workspaceRoot, integration: {
    name: "pending-cleanup",
    setupPolicy: { sideEffect: "read", environments: ["test"], cleanupTimeoutMs: 100 },
    setup: async () => async () => { await cleanup; },
  } });
  const second = new LocalRunnerService({ root, workspaceRoot });
  const ownership = new LocalExecutionOwnership(workspaceRoot, "workspace");
  try {
    const active = await first.start({ charter, adapter: "web" });
    expect((await first.wait(active.runId)).verdict).toBe("blocked");
    expect(await ownership.isActive("exclusive")).toBe(true);
    const contender = await second.start({ charter, adapter: "electron" });
    expect((await second.wait(contender.runId)).verdict).toBe("blocked");
    expect(state.connected).toBe(1);
  } finally { finishCleanup(); }
  const until = Date.now() + 2_000;
  while (await ownership.isActive("exclusive") && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await ownership.isActive("exclusive")).toBe(false);
  const next = await second.start({ charter, adapter: "electron" });
  expect((await second.wait(next.runId)).verdict).toBe("passed");
}, 20_000);
