import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { LocalExecutionOwnership } from "@proofkit/evidence";
import type { SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";
import { acquireCdpTarget, sharedTargetIdentity } from "./execution-scope.js";

const state = vi.hoisted(() => ({ connected: 0, pinned: [] as string[], holdFirst: true, entered: () => {},
  release: Promise.resolve(), releaseFirst: () => {} }));
vi.mock("@proofkit/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@proofkit/adapters")>();
  class Adapter implements SurfaceAdapter {
    readonly name = "fixture";
    pinCdpUrl(cdpUrl: string) { state.pinned.push(cdpUrl); }
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
  return { ...actual, WebAdapter: Adapter, ElectronAdapter: Adapter, MobileAdapter: Adapter };
});

const roots: string[] = [];
afterEach(async () => {
  state.releaseFirst();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  state.connected = 0;
  state.pinned = [];
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

it("blocks separate workspaces that attach to the same CDP endpoint", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-target-lease-"));
  roots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "target-lease-fixture" }));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const config = (cdpUrl: string) => ProofkitConfigSchema.parse({ surfaces: { web: { cdpUrl } } });
  const first = new LocalRunnerService({ root, workspaceRoot: join(base, "one"), config: config(`http://localhost:${port}/json/version`) });
  const second = new LocalRunnerService({ root, workspaceRoot: join(base, "two"), config: config(`ws://127.0.0.1:${port}/devtools/browser/id`) });
  const independent = new LocalRunnerService({ root, workspaceRoot: join(base, "three"), config: config(`http://127.0.0.1:${port + 1}`) });
  const entered = new Promise<void>((resolve) => { state.entered = resolve; });
  state.release = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
  const charter = TestCharterSchema.parse({ intent: "Check shared CDP target isolation", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  try {
    const active = await first.start({ charter, adapter: "web" });
    await entered;
    const contender = await second.start({ charter, adapter: "web" });
    const blocked = await second.wait(contender.runId);
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.findings.join(" ")).toContain("configured CDP or WebDriver target");
    expect(state.connected).toBe(1);
    const otherTarget = await independent.start({ charter, adapter: "web" });
    expect((await independent.wait(otherTarget.runId)).verdict).toBe("passed");
    state.releaseFirst();
    expect((await first.wait(active.runId)).verdict).toBe("passed");
  } finally { state.releaseFirst(); }
  const retry = await second.start({ charter, adapter: "web" });
  expect((await second.wait(retry.runId)).verdict).toBe("passed");
}, 20_000);

it("normalizes loopback CDP aliases and scopes mobile targets to their WebDriver server", () => {
  const config = ProofkitConfigSchema.parse({});
  expect(sharedTargetIdentity("web", { cdp: "http://localhost:9222/json/version" }, config))
    .toBe(sharedTargetIdentity("electron", { cdp: "ws://127.0.0.1:9222/devtools/browser/id" }, config));
  expect(sharedTargetIdentity("web", { url: "http://127.0.0.1:5173" }, config)).toBeUndefined();
  expect(sharedTargetIdentity("mobile", { mobileServer: "http://localhost:4723/wd/hub" }, config))
    .toBe(sharedTargetIdentity("mobile", { mobileServer: "http://127.0.0.1:4723/" }, config));
});

it("blocks different Electron port files pointing to the same CDP target", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-electron-target-"));
  roots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "electron-target-fixture" }));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const firstFile = join(base, "first-port");
  const secondFile = join(base, "second-port");
  await Promise.all([writeFile(firstFile, `${port}\n`), writeFile(secondFile, `${port}\n`)]);
  const config = (file: string) => ProofkitConfigSchema.parse({ surfaces: { electron: { devtoolsActivePort: file } } });
  const first = new LocalRunnerService({ root, workspaceRoot: join(base, "one"), config: config(firstFile) });
  const secondSetup = vi.fn(async () => () => {});
  const second = new LocalRunnerService({ root, workspaceRoot: join(base, "two"), config: config(secondFile),
    integration: { name: "blocked-setup", setup: secondSetup } });
  const explicit = new LocalRunnerService({ root, workspaceRoot: join(base, "explicit"),
    config: ProofkitConfigSchema.parse({ surfaces: { web: { cdpUrl: `http://localhost:${port}` } } }) });
  const entered = new Promise<void>((resolve) => { state.entered = resolve; });
  state.release = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
  const charter = TestCharterSchema.parse({ intent: "Check Electron port-file target isolation", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  try {
    const active = await first.start({ charter, adapter: "electron" });
    await entered;
    const contender = await second.start({ charter, adapter: "electron" });
    expect((await second.wait(contender.runId)).verdict).toBe("blocked");
    const explicitContender = await explicit.start({ charter, adapter: "web" });
    expect((await explicit.wait(explicitContender.runId)).verdict).toBe("blocked");
    expect(state.connected).toBe(1);
    expect(secondSetup).not.toHaveBeenCalled();
    expect(state.pinned).toEqual([`http://127.0.0.1:${port}`]);
    state.releaseFirst();
    expect((await first.wait(active.runId)).verdict).toBe("passed");
  } finally { state.releaseFirst(); }
  const retry = await second.start({ charter, adapter: "electron" });
  expect((await second.wait(retry.runId)).verdict).toBe("passed");
  expect(state.pinned).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
}, 20_000);

it("resolves a port file created by setup before attaching Electron", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-electron-startup-"));
  roots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "electron-startup-fixture" }));
  const file = join(base, "started-port");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const config = ProofkitConfigSchema.parse({ surfaces: { electron: { devtoolsActivePort: file } } });
  const runner = new LocalRunnerService({ root, workspaceRoot: join(base, "workspace"), config, integration: {
    name: "start-electron-fixture", setupPolicy: { sideEffect: "read", environments: ["test"], cleanupTimeoutMs: 1000 },
    setup: async () => { await writeFile(file, `${port}\n`); return () => {}; },
  } });
  state.holdFirst = false;
  const charter = TestCharterSchema.parse({ intent: "Check started Electron target", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  const started = await runner.start({ charter, adapter: "electron" });
  expect((await runner.wait(started.runId)).verdict).toBe("passed");
  expect(state.pinned).toEqual([`http://127.0.0.1:${port}`]);
});

it("pins a port changed by setup and releases both endpoint leases", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-electron-rotation-"));
  roots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "electron-rotation-fixture" }));
  const file = join(base, "rotated-port");
  const oldPort = 30_000 + Math.floor(Math.random() * 10_000);
  const newPort = oldPort + 10_000;
  await writeFile(file, `${oldPort}\n`);
  const config = ProofkitConfigSchema.parse({ surfaces: { electron: { devtoolsActivePort: file } } });
  const runner = new LocalRunnerService({ root, workspaceRoot: join(base, "workspace"), config, integration: {
    name: "rotate-electron-fixture", setupPolicy: { sideEffect: "read", environments: ["test"], cleanupTimeoutMs: 1000 },
    setup: async () => { await writeFile(file, `${newPort}\n`); return () => {}; },
  } });
  state.holdFirst = false;
  const charter = TestCharterSchema.parse({ intent: "Check rotated Electron target", level: "quick",
    actions: [{ kind: "waitForText", text: "ready" }],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });
  const started = await runner.start({ charter, adapter: "electron" });
  expect((await runner.wait(started.runId)).verdict).toBe("passed");
  expect(state.pinned).toEqual([`http://127.0.0.1:${newPort}`]);
  const oldLease = await acquireCdpTarget(`http://127.0.0.1:${oldPort}`);
  const newLease = await acquireCdpTarget(`http://127.0.0.1:${newPort}`);
  try {
    expect(oldLease).toBeDefined();
    expect(newLease).toBeDefined();
  } finally { await Promise.all([oldLease?.release(), newLease?.release()]); }
});
