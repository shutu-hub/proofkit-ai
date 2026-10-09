import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryMissionToolRegistry, JsonMissionStore, MissionAgent, MissionAlreadyRunningError } from "./index.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited(child);
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registry(discover = vi.fn(async () => ({}))) {
  return { discover, tools: new InMemoryMissionToolRegistry([
    { name: "project.discover", description: "discover", sideEffect: "none" as const, environments: ["test" as const], timeoutMs: 30_000, inputSchema: z.object({}), execute: discover },
    { name: "surface.run-charter", description: "run", sideEffect: "read" as const, environments: ["test" as const], timeoutMs: 30_000, inputSchema: z.object({}).passthrough(), execute: async () => ({ verdict: "passed" as const }) },
    { name: "mission.verify", description: "verify", sideEffect: "none" as const, environments: ["test" as const], timeoutMs: 30_000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
  ]) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-ownership-"));
  roots.push(root);
  const store = new JsonMissionStore(root);
  const parent = registry();
  const agent = new MissionAgent({ store, tools: parent.tools });
  const mission = await agent.create({ intent: "Verify one owner per Mission", projectRoot: root, surface: "web", policy: { requireApproval: false } });
  const editable = await store.load(mission.missionId);
  editable.plan.graph.tasks = editable.plan.graph.tasks.map((task) => task.taskId === "reconnaissance" ? { ...task, maxAttempts: 2 } : task);
  await store.save(editable);
  return { root, store, agent, mission, parent };
}

function startChild(root: string, missionId: string): ChildProcessWithoutNullStreams {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "index.js")).href;
  const script = `
    import { MissionAgent, JsonMissionStore, InMemoryMissionToolRegistry } from ${JSON.stringify(moduleUrl)};
    import { z } from "zod";
    const [root, missionId] = process.argv.slice(1);
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "wait", sideEffect: "none", environments: ["test"], timeoutMs: 30000, inputSchema: z.object({}), execute: async (_input, { signal }) => {
        process.stdout.write("TOOL_RUNNING\\n");
        await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          process.stdin.once("data", resolve);
        });
        return {};
      } },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 30000, inputSchema: z.object({}).passthrough(), execute: async () => ({ verdict: "passed" }) },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 30000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" }) },
    ]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const result = await agent.run(missionId);
    process.stdout.write("FINISHED:" + result.status + "\\n");
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root, missionId], { cwd: process.cwd(), stdio: "pipe" });
  children.push(child);
  return child;
}

function outputContains(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => finish(new Error(`Child did not print ${expected}: ${output} ${errors}`)), 10_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) finish();
    };
    const onError = (chunk: Buffer) => { errors += chunk.toString("utf8"); };
    const onExit = (code: number | null) => finish(new Error(`Child exited ${code} before ${expected}: ${output} ${errors}`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onError);
    child.once("exit", onExit);
  });
}

function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("cross-process Mission ownership", () => {
  it("rejects a second executor and routes cancellation to the owner process", async () => {
    const state = await fixture();
    const child = startChild(state.root, state.mission.missionId);
    await outputContains(child, "TOOL_RUNNING");
    expect(await state.agent.isRunning(state.mission.missionId)).toBe(true);
    await expect(state.agent.run(state.mission.missionId)).rejects.toBeInstanceOf(MissionAlreadyRunningError);
    await expect(state.agent.approve(state.mission.missionId)).rejects.toBeInstanceOf(MissionAlreadyRunningError);
    expect(state.parent.discover).not.toHaveBeenCalled();
    expect(await state.agent.cancel(state.mission.missionId, "Cancelled from another process")).toBe(true);
    const final = await state.agent.waitUntilIdle(state.mission.missionId);
    expect(final.status).toBe("cancelled");
    expect(final.plan.graph.tasks.find((task) => task.taskId === "reconnaissance")?.attempts).toBe(1);
    await exited(child);
  }, 20_000);

  it("releases ownership after a process crash and recovers only the safe task", async () => {
    const state = await fixture();
    const child = startChild(state.root, state.mission.missionId);
    await outputContains(child, "TOOL_RUNNING");
    child.kill();
    await exited(child);
    expect(await state.agent.isRunning(state.mission.missionId)).toBe(false);
    const final = await state.agent.run(state.mission.missionId);
    expect(final.status).toBe("completed");
    expect(final.plan.graph.tasks.find((task) => task.taskId === "reconnaissance")?.attempts).toBe(2);
    expect(final.findings.some((finding) => finding.title.includes("Recovered interrupted task"))).toBe(true);
    expect(state.parent.discover).toHaveBeenCalledTimes(1);
  }, 20_000);
});
