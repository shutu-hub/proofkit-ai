import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeterministicMissionPlanner, InMemoryMissionToolRegistry, JsonMissionStore, MissionAgent } from "./index.js";

describe("MissionAgent", () => {
  it("requires approval and resumes a task graph through registered tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("discover"); return { observations: [] }; } },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("run"); return { verdict: "passed" as const }; } },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("verify"); return { verdict: "passed" as const }; } },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "check login", projectRoot: root, surface: "web" });
    expect(created.status).toBe("awaiting-approval");
    await expect(agent.run(created.missionId)).rejects.toThrow("cannot run");
    await agent.approve(created.missionId);
    const completed = await agent.run(created.missionId);
    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(calls).toEqual(["discover", "run", "verify"]);
    expect(completed.revision).toBeGreaterThan(3);
  });

  it("blocks an unregistered or disallowed tool with a finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-"));
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools: new InMemoryMissionToolRegistry() });
    const created = await agent.create({ intent: "safe", projectRoot: root, surface: "electron", policy: { requireApproval: false } });
    const result = await agent.run(created.missionId);
    expect(result.status).toBe("blocked");
    expect(result.findings[0]?.message).toContain("not registered");
  });

  it("rejects a charter when its level disagrees with the mission policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-level-policy-"));
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools: new InMemoryMissionToolRegistry() });
    await expect(agent.create({
      intent: "check login",
      projectRoot: root,
      surface: "web",
      charter: {
        intent: "check login",
        level: "core",
        mode: "deterministic",
        preconditions: [],
        actions: [],
        assertions: [{ kind: "text-visible", text: "ready" }],
        sideEffectPolicy: "deny",
        metadata: {},
      },
      policy: { level: "quick" },
    })).rejects.toThrow("Mission policy level quick does not match charter level core");
  });

  it("persists one suspected finding when a tool throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-"));
    const tools = new InMemoryMissionToolRegistry([
      {
        name: "project.discover",
        description: "discover",
        sideEffect: "none",
        environments: ["test"],
        timeoutMs: 1000,
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("fixture surface is unavailable");
        },
      },
    ]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({ intent: "surface failure", projectRoot: root, surface: "web", policy: { requireApproval: false } });
    const result = await agent.run(created.missionId);

    expect(result.status).toBe("failed");
    expect(result.verdict).toBe("failed");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe("failed");
    expect(result.toolCalls[0]?.error).toContain("fixture surface is unavailable");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.status).toBe("suspected");
    expect(result.findings[0]?.message).toContain("fixture surface is unavailable");
  });

  it("recovers an interrupted read task when an attempt remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-recovery-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("discover"); return {}; } },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async () => { calls.push("run"); return { verdict: "passed" as const }; } },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("verify"); return { verdict: "passed" as const }; } },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "recover safe mission", projectRoot: root, surface: "web", policy: { requireApproval: false } });
    const interrupted = await agent.load(created.missionId);
    interrupted.status = "running";
    interrupted.currentTaskId = "reconnaissance";
    interrupted.plan.graph.tasks = interrupted.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 }
      : task);
    interrupted.toolCalls = [{
      toolCallId: "tool-stale",
      taskId: "reconnaissance",
      tool: "project.discover",
      attempt: 1,
      input: {},
      status: "started",
      evidence: [],
      startedAt: new Date(Date.now() - 10).toISOString(),
    }];
    await store.save(interrupted);

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["discover", "run", "verify"]);
    expect(result.findings.some((item) => item.title.includes("Recovered interrupted task"))).toBe(true);
    expect(result.toolCalls.find((call) => call.toolCallId === "tool-stale")?.status).toBe("cancelled");
    expect(result.toolCalls.filter((call) => call.status === "succeeded")).toHaveLength(3);
    expect(result.toolCalls.find((call) => call.taskId === "reconnaissance" && call.status === "succeeded")?.attempt).toBe(2);
  });

  it("blocks an interrupted side-effecting task instead of replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-recovery-write-"));
    const store = new JsonMissionStore(root);
    const tools = new InMemoryMissionToolRegistry([
      { name: "write.operation", description: "write", sideEffect: "write", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async () => ({ verdict: "passed" as const }) },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "recover write mission", projectRoot: root, surface: "web", policy: { requireApproval: false, sideEffectPolicy: "allow" } });
    const interrupted = await agent.load(created.missionId);
    interrupted.status = "running";
    interrupted.currentTaskId = "reconnaissance";
    interrupted.plan.graph.tasks = interrupted.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, tool: "write.operation", status: "running" as const, attempts: 1, maxAttempts: 2 }
      : task);
    await store.save(interrupted);

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("blocked");
    expect(result.verdict).toBe("blocked");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.findings.some((item) => item.message.includes("side effect"))).toBe(true);
  });

  it.each([
    ["quick", 3, ["web"], false],
    ["core", 3, ["electron"], false],
    ["release", 6, ["web", "electron"], true],
  ] as const)("builds the %s execution graph", async (level, taskCount, surfaces, requiresReplay) => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-level-graph-"));
    const planner = new DeterministicMissionPlanner();
    const plan = await planner.plan({
      intent: `${level} fixture`,
      projectRoot: root,
      surface: level === "core" ? "electron" : "web",
      policy: { level, environment: "test", sideEffectPolicy: "deny", requireApproval: true, requireEvidence: true, maxSteps: 100, timeoutMs: 30_000 },
    });

    expect(plan.graph.tasks).toHaveLength(taskCount);
    expect(plan.executionProfile.surfaceMatrix).toEqual(surfaces);
    expect(plan.executionProfile.requireReplay).toBe(requiresReplay);
    const verify = plan.graph.tasks.find((task) => task.taskId === "verify-result");
    expect(verify?.dependsOn).toEqual(requiresReplay
      ? ["replay-charter", "replay-charter-electron"]
      : ["execute-charter"]);
  });
});
