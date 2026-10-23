import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { MissionAgent } from "@proofkit/agent";
import type { SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const adapterState = vi.hoisted(() => ({ connected: 0 }));
vi.mock("@proofkit/adapters", () => {
  class Adapter implements SurfaceAdapter {
    readonly name = "fixture";
    async connect() { adapterState.connected++; }
    async discover() { return this.snapshot(); }
    async snapshot() { return { capturedAt: new Date().toISOString(), text: "ready", metadata: {} }; }
    async act(): Promise<never> { throw new Error("No action expected"); }
    async assert(assertion: Parameters<SurfaceAdapter["assert"]>[0]) { return { assertion, passed: true, message: "ready", evidence: [] }; }
    async capture() { return undefined; }
    async subscribeEvents() { return () => {}; }
    async close() { /* no-op */ }
  }
  return { WebAdapter: Adapter, ElectronAdapter: Adapter, MobileAdapter: Adapter };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  adapterState.connected = 0;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Local Runner Mission ownership", () => {
  it("reads the final Mission after checking that its execution owner has released", async () => {
    const base = await mkdtemp(join(tmpdir(), "proofkit-owner-snapshot-")); roots.push(base);
    const service = new LocalRunnerService({ root: base, workspaceRoot: base });
    const mission = await service.createMission({ intent: "Verify final owner snapshot", surface: "web", charter: TestCharterSchema.parse({
      intent: "Verify final owner snapshot", level: "quick", actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" }) });
    let ownerChecked = false;
    vi.spyOn(MissionAgent.prototype, "load").mockImplementation(async () => ({ ...mission, status: ownerChecked ? "completed" : "running", verdict: "passed" }));
    vi.spyOn(MissionAgent.prototype, "isRunning").mockImplementation(async () => { ownerChecked = true; return false; });
    expect(await service.missionStatus(mission.missionId)).toMatchObject({ running: false, mission: { status: "completed", verdict: "passed" } });
    ownerChecked = false;
    expect(await service.missionEvidence(mission.missionId)).toMatchObject({ running: false, status: "completed" });
  });

  it("joins a Mission owned by another service without repeating the surface run, then cancels it remotely", async () => {
    const base = await mkdtemp(join(tmpdir(), "proofkit-service-owner-"));
    roots.push(base);
    const root = join(base, "source");
    const workspaceRoot = join(base, "workspace");
    await mkdir(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ownership-fixture" }));
    const observing = deferred();
    const firstOracle = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      observing.resolve();
      await new Promise<void>((_, reject) => {
        const abort = () => reject(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      return { name: "terminal", passed: true, message: "complete", evidence: [], observedAt: new Date().toISOString() };
    });
    const secondOracle = vi.fn(async () => ({ name: "terminal", passed: true, message: "complete", evidence: [], observedAt: new Date().toISOString() }));
    const first = new LocalRunnerService({ root, workspaceRoot, integration: { name: "owner", oracles: [{ name: "terminal", check: firstOracle }] } });
    const second = new LocalRunnerService({ root, workspaceRoot, integration: { name: "contender", oracles: [{ name: "terminal", check: secondOracle }] } });
    const observer = new LocalRunnerService({ root, workspaceRoot });
    const charter = TestCharterSchema.parse({ intent: "Verify one service executes the workflow", level: "core", actions: [], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["terminal"], sideEffectPolicy: "deny" });
    const mission = await first.createMission({ intent: charter.intent, charter, surface: "web" });
    await first.startMission(mission.missionId, { approve: true });
    await observing.promise;

    expect((await second.missionStatus(mission.missionId)).running).toBe(true);
    expect((await second.missionEvidence(mission.missionId)).running).toBe(true);
    let observerSettled = false;
    const observedFinal = observer.waitMission(mission.missionId).then((result) => { observerSettled = true; return result; });
    const joined = await second.startMission(mission.missionId);
    expect(joined.running).toBe(true);
    expect(firstOracle).toHaveBeenCalledTimes(1);
    expect(secondOracle).not.toHaveBeenCalled();
    expect(adapterState.connected).toBe(1);
    expect(observerSettled).toBe(false);

    const cancelled = await second.cancelMission(mission.missionId, "Cancelled by another runner");
    expect(cancelled.mission.status).toBe("cancelled");
    expect((await first.waitMission(mission.missionId)).status).toBe("cancelled");
    expect((await second.waitMission(mission.missionId)).status).toBe("cancelled");
    expect((await observedFinal).status).toBe("cancelled");
    expect((await second.missionStatus(mission.missionId)).running).toBe(false);
    expect(secondOracle).not.toHaveBeenCalled();
    expect(adapterState.connected).toBe(1);
  }, 20_000);
});
