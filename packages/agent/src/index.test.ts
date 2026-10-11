import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TestSuiteSchema } from "@proofkit/contracts";
import { DeterministicMissionPlanner, InMemoryMissionToolRegistry, JsonMissionStore, MissionAgent } from "./index.js";

describe("JsonMissionStore", () => {
  it("keeps every read complete while a mission is repeatedly replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-atomic-mission-"));
    const store = new JsonMissionStore(root);
    const agent = new MissionAgent({ store, tools: new InMemoryMissionToolRegistry() });
    const created = await agent.create({ intent: "verify atomic mission storage", projectRoot: root, surface: "web" });
    const intent = "business evidence ".repeat(2_048);
    await store.save({ ...created, intent });

    const writer = async () => {
      for (let revision = 1; revision <= 100; revision += 1) {
        await store.save({ ...created, intent, revision });
      }
    };
    const reader = async () => {
      for (let count = 0; count < 150; count += 1) {
        const mission = await store.load(created.missionId);
        expect(mission.missionId).toBe(created.missionId);
        expect(mission.intent).toBe(intent);
      }
    };

    await Promise.all([writer(), reader(), reader(), reader()]);
    expect((await store.load(created.missionId)).revision).toBe(100);
    expect(await readdir(root)).toEqual([`${created.missionId}.json`]);
  }, 15_000);
});

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
    expect(completed.agentSteps).toHaveLength(3);
    expect(completed.agentSteps.map((step) => step.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(completed.agentSteps.map((step) => step.phase)).toEqual(["execute", "execute", "verify"]);
    expect(completed.agentSteps.every((step) => step.toolCallIds.length === 1)).toBe(true);
  });

  it("does not pass a mission whose remaining tasks cannot run", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-stalled-graph-"));
    const store = new JsonMissionStore(root);
    const agent = new MissionAgent({ store, tools: new InMemoryMissionToolRegistry() });
    const created = await agent.create({ intent: "verify workflow", projectRoot: root, surface: "web", policy: { requireApproval: false } });
    const persisted = await agent.load(created.missionId);
    persisted.plan.graph.tasks = persisted.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, status: "skipped" as const }
      : task);
    await store.save(persisted);

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("blocked");
    expect(result.verdict).toBe("blocked");
    expect(result.findings.some((finding) => finding.title === "Mission task graph stalled")).toBe(true);
  });

  it("rejects an invalid custom planner graph before persisting a mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-invalid-plan-"));
    const agent = new MissionAgent({
      store: new JsonMissionStore(root),
      tools: new InMemoryMissionToolRegistry(),
      planner: {
        async plan(input) {
          const valid = await new DeterministicMissionPlanner().plan(input);
          return {
            ...valid,
            graph: {
              ...valid.graph,
              tasks: valid.graph.tasks.map((task) => task.taskId === "execute-charter"
                ? { ...task, dependsOn: ["verify-result"] }
                : task),
            },
          };
        },
      },
    });

    await expect(agent.create({ intent: "verify workflow", projectRoot: root, surface: "web" })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves a cancelled tool verdict in the AgentStep and mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-cancelled-verdict-"));
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({}) },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async () => ({ verdict: "cancelled" as const }) },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
    ]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({ intent: "cancelled surface", projectRoot: root, surface: "web", policy: { requireApproval: false } });

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("cancelled");
    expect(result.verdict).toBe("cancelled");
    expect(result.agentSteps.find((step) => step.taskId === "execute-charter")).toMatchObject({
      phase: "execute",
      status: "cancelled",
    });
    expect(result.plan.graph.tasks.find((task) => task.taskId === "execute-charter")?.status).toBe("blocked");
  });

  it("enforces the mission-wide timeout and records an environment finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-timeout-"));
    const tools = new InMemoryMissionToolRegistry([
      {
        name: "project.discover",
        description: "slow discover",
        sideEffect: "none",
        environments: ["test"],
        timeoutMs: 1_000,
        inputSchema: z.object({}),
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {};
        },
      },
    ]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({
      intent: "timeout mission",
      projectRoot: root,
      surface: "web",
      policy: { requireApproval: false, timeoutMs: 20 },
    });

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("cancelled");
    expect(result.verdict).toBe("cancelled");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Mission timed out", category: "environment" }),
    ]));
    expect(result.firstFailure).toMatchObject({ kind: "environment", message: expect.stringContaining("total timeout") });
    // A short total deadline can expire while CI is persisting the Mission,
    // before the first tool starts. A started tool must still close cancelled.
    if (result.toolCalls.length > 0) {
      expect(result.toolCalls[0]?.status).toBe("cancelled");
      expect(result.agentSteps[0]?.status).toBe("cancelled");
    } else {
      expect(result.agentSteps).toHaveLength(0);
    }
  });

  it("keeps the first execution deadline across recovery and excludes approval wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-durable-deadline-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", recoveryKey: "fixture-discover-v1", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("discover"); return {}; } },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}).passthrough(), execute: async () => { calls.push("run"); return { verdict: "passed" as const }; } },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("verify"); return { verdict: "passed" as const }; } },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "bounded mission", projectRoot: root, surface: "web",
      policy: { timeoutMs: 10_000, maxSteps: 3 } });
    await store.save({ ...created, createdAt: new Date(Date.now() - 60_000).toISOString() });
    await agent.approve(created.missionId);
    const completed = await agent.run(created.missionId);
    expect(completed.status).toBe("completed");
    expect(completed.executionStartedAt).toBeDefined();
    expect(Date.parse(completed.executionStartedAt!)).toBeGreaterThan(Date.now() - 10_000);
    expect(Date.parse(completed.executionDeadlineAt!) - Date.parse(completed.executionStartedAt!)).toBe(10_000);
    expect(calls).toEqual(["discover", "run", "verify"]);

    const expired = await agent.create({ intent: "expired mission", projectRoot: root, surface: "web",
      policy: { requireApproval: false, timeoutMs: 1_000 } });
    const previousStart = new Date(Date.now() - 5_000).toISOString();
    const previousDeadline = new Date(Date.now() - 4_000).toISOString();
    await store.save({ ...expired, status: "running", executionStartedAt: previousStart,
      executionDeadlineAt: previousDeadline });
    const result = await agent.run(expired.missionId);
    expect(result).toMatchObject({ status: "cancelled", verdict: "cancelled",
      executionStartedAt: previousStart, executionDeadlineAt: previousDeadline });
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mission timed out" })]));
    expect(result.agentSteps).toHaveLength(0);
    expect(calls).toEqual(["discover", "run", "verify"]);

    const interrupted = await agent.create({ intent: "expired interrupted read", projectRoot: root, surface: "web",
      policy: { requireApproval: false, timeoutMs: 1_000 } });
    const runningTask = interrupted.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 } : task);
    await store.save({ ...interrupted, status: "running", currentTaskId: "reconnaissance",
      executionStartedAt: previousStart, executionDeadlineAt: previousDeadline,
      plan: { ...interrupted.plan, graph: { ...interrupted.plan.graph, tasks: runningTask } },
      toolCalls: [{ toolCallId: "stale-read", taskId: "reconnaissance", tool: "project.discover", sideEffect: "none", recoveryKey: "fixture-discover-v1", attempt: 1,
        input: {}, status: "started", startedAt: previousStart, evidence: [] }] });
    const interruptedResult = await agent.run(interrupted.missionId);
    expect(interruptedResult.verdict).toBe("cancelled");
    expect(interruptedResult.toolCalls[0]?.status).toBe("cancelled");
    expect(interruptedResult.agentSteps[0]?.status).toBe("cancelled");
    expect(interruptedResult.findings.map((finding) => finding.message).join(" ")).not.toContain("will retry");
    expect(calls).toEqual(["discover", "run", "verify"]);

    const legacy = await agent.create({ intent: "legacy running mission", projectRoot: root, surface: "web",
      policy: { requireApproval: false, timeoutMs: 1_000 } });
    await store.save({ ...legacy, status: "running", updatedAt: new Date(Date.now() - 5_000).toISOString() });
    const legacyResult = await agent.run(legacy.missionId);
    expect(legacyResult.verdict).toBe("cancelled");
    expect(Date.parse(legacyResult.executionDeadlineAt!)).toBeLessThan(Date.now());
    expect(calls).toEqual(["discover", "run", "verify"]);
  });

  it("counts already saved Agent steps against the Mission step limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-durable-step-limit-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("discover"); return {}; } },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}).passthrough(), execute: async () => { calls.push("run"); return { verdict: "passed" as const }; } },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("verify"); return { verdict: "passed" as const }; } },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "limit across restart", projectRoot: root, surface: "web",
      policy: { requireApproval: false, maxSteps: 2 } });
    const now = new Date().toISOString();
    const tasks = created.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, status: "passed" as const, attempts: 1 } : task);
    await store.save({ ...created, status: "running", plan: { ...created.plan, graph: { ...created.plan.graph, tasks } },
      agentSteps: [{ agentStepId: "prior-step", sequence: 1, taskId: "reconnaissance", phase: "execute", tool: "project.discover",
        decision: "prior completed task", input: {}, status: "succeeded", startedAt: now, endedAt: now, toolCallIds: [], observationIds: [], evidence: [] }] });
    const result = await agent.run(created.missionId);
    expect(result.verdict).toBe("blocked");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Agent step limit reached" })]));
    expect(calls).toEqual(["run"]);
    expect(result.agentSteps).toHaveLength(2);
  });

  it("does not invoke a tool when cancellation arrives during input validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-pre-tool-cancel-"));
    const controller = new AbortController();
    let invocations = 0;
    const tools = new InMemoryMissionToolRegistry([{
      name: "project.discover", description: "discover", sideEffect: "write", environments: ["test"],
      timeoutMs: 1000,
      inputSchema: z.object({}).transform((input) => {
        controller.abort(new Error("cancel during input validation"));
        return input;
      }),
      execute: async () => {
        invocations++;
        return {};
      },
    }]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({
      intent: "cancel before tool execution", projectRoot: root, surface: "web",
      policy: { requireApproval: false, sideEffectPolicy: "allow" },
    });

    const result = await agent.run(created.missionId, { signal: controller.signal });

    expect(invocations).toBe(0);
    expect(result.status).toBe("cancelled");
    expect(result.verdict).toBe("cancelled");
    expect(result.plan.graph.tasks[0]?.status).toBe("blocked");
    expect(result.toolCalls[0]).toMatchObject({ status: "cancelled", endedAt: expect.any(String) });
    expect(result.agentSteps[0]).toMatchObject({ status: "cancelled", endedAt: expect.any(String) });
    expect(result.currentTaskId).toBeUndefined();
  });

  it("bounds cleanup waiting and reports resources that may remain active", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-cleanup-timeout-"));
    const controller = new AbortController();
    const tools = new InMemoryMissionToolRegistry([{
      name: "project.discover", description: "unresponsive tool", sideEffect: "none", environments: ["test"],
      timeoutMs: 1_000, cancellationGraceMs: 10, inputSchema: z.object({}),
      execute: () => {
        controller.abort(new Error("User cancelled"));
        return new Promise(() => {});
      },
    }]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({ intent: "cancel unresponsive tool", projectRoot: root, surface: "web", policy: { requireApproval: false } });
    const result = await agent.run(created.missionId, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(result.toolCalls[0]?.status).toBe("cancelled");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Tool cleanup did not finish", category: "environment", message: expect.stringContaining("resources may still be active") }),
    ]));
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
    const privateErrorText = "candidate-email=private@example.invalid token=secret-credential";
    const tools = new InMemoryMissionToolRegistry([
      {
        name: "project.discover",
        description: "discover",
        sideEffect: "none",
        environments: ["test"],
        timeoutMs: 1000,
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error(`fixture surface is unavailable: ${privateErrorText}`);
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
    expect(result.toolCalls[0]?.error).toContain("failed without a verified result");
    expect(result.agentSteps[0]).toMatchObject({ status: "failed", endedAt: expect.any(String) });
    expect(result.currentTaskId).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.status).toBe("suspected");
    expect(result.findings[0]?.message).toContain("failed without a verified result");
    expect(result.firstFailure).toMatchObject({ kind: "environment", stepId: "reconnaissance", evidence: [] });
    expect(JSON.stringify(result)).not.toContain(privateErrorText);
    expect(await readFile(join(root, `${created.missionId}.json`), "utf8")).not.toContain(privateErrorText);
  });

  it("settles a thrown suite tool call without starting another workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-suite-tool-error-"));
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({}) },
      { name: "surface.run-charter", description: "run", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async (_input, context) => {
        calls.push(context.task.taskId);
        if (context.task.taskId === "execute-charter") throw new Error("first workflow could not start");
        return { verdict: "passed" as const };
      } },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => {
        calls.push("verify-result");
        return { verdict: "passed" as const };
      } },
    ]);
    const planner = {
      async plan(input: Parameters<DeterministicMissionPlanner["plan"]>[0]) {
        const base = await new DeterministicMissionPlanner().plan(input);
        const primary = base.graph.tasks.find((task) => task.taskId === "execute-charter")!;
        return {
          ...base,
          executionProfile: { ...base.executionProfile, collectAllResults: true },
          graph: {
            ...base.graph,
            tasks: [
              ...base.graph.tasks.filter((task) => task.taskId !== "verify-result"),
              { ...primary, taskId: "execute-other" },
              { ...base.graph.tasks.find((task) => task.taskId === "verify-result")!, dependsOn: ["execute-charter", "execute-other"], dependencyMode: "settled" as const },
            ],
          },
        };
      },
    };
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools, planner });
    const created = await agent.create({ intent: "verify independent workflows", projectRoot: root, surface: "web", policy: { requireApproval: false } });

    const result = await agent.run(created.missionId);

    expect(calls).toEqual(["execute-charter"]);
    expect(result.status).toBe("failed");
    expect(result.verdict).toBe("failed");
    expect(result.plan.graph.tasks.find((task) => task.taskId === "execute-charter")?.status).toBe("failed");
    expect(result.plan.graph.tasks.find((task) => task.taskId === "execute-other")?.status).toBe("pending");
    expect(result.agentSteps.find((step) => step.taskId === "execute-charter")).toMatchObject({ status: "failed", endedAt: expect.any(String) });
    expect(result.toolCalls.find((call) => call.taskId === "execute-charter")).toMatchObject({ status: "failed", endedAt: expect.any(String) });
    expect(result.agentSteps.every((step) => step.status !== "running")).toBe(true);
    expect(result.currentTaskId).toBeUndefined();
  });

  it("classifies a tool-only timeout as an environment block", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-tool-timeout-"));
    const tools = new InMemoryMissionToolRegistry([{
      name: "project.discover", description: "slow discover", sideEffect: "none", environments: ["test"],
      timeoutMs: 10, cancellationGraceMs: 100, inputSchema: z.object({}),
      execute: async (_input, context) => {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    }]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({ intent: "timeout one tool", projectRoot: root, surface: "web", policy: { requireApproval: false, timeoutMs: 1000 } });

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("blocked");
    expect(result.verdict).toBe("blocked");
    expect(result.plan.graph.tasks[0]?.status).toBe("blocked");
    expect(result.toolCalls[0]).toMatchObject({ status: "blocked", endedAt: expect.any(String) });
    expect(result.agentSteps[0]).toMatchObject({ status: "blocked", endedAt: expect.any(String) });
    expect(result.currentTaskId).toBeUndefined();
    expect(result.firstFailure).toMatchObject({ kind: "environment", message: expect.stringContaining("timed out") });
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mission tool timed out: project.discover", category: "environment" })]));
  });

  it("recovers an interrupted read task when an attempt remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-recovery-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", recoveryKey: "fixture-discover-v1", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => { calls.push("discover"); return {}; } },
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
      sideEffect: "none",
      recoveryKey: "fixture-discover-v1",
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
    expect(result.agentSteps.find((step) => step.taskId === "reconnaissance" && step.status === "cancelled")).toBeDefined();
    expect(result.agentSteps.filter((step) => step.taskId === "reconnaissance" && step.status === "succeeded")).toHaveLength(1);
    expect(result.agentSteps.find((step) => step.taskId === "reconnaissance" && step.status === "succeeded")?.phase).toBe("recover");
  });

  it.each([
    ["side-effect declaration", { recoveryKey: "fixture-discover-v1" }],
    ["recovery key", { sideEffect: "none" }],
  ] as const)("does not infer safe replay from a legacy receipt without its %s", async (_label, recorded) => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-legacy-recovery-"));
    const store = new JsonMissionStore(root);
    let calls = 0;
    const tools = new InMemoryMissionToolRegistry([{ name: "project.discover", description: "discover",
      sideEffect: "none", recoveryKey: "fixture-discover-v1", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}),
      execute: async () => { calls++; return {}; } }]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({ intent: "recover legacy mission", projectRoot: root, surface: "web",
      policy: { requireApproval: false } });
    const interrupted = await agent.load(created.missionId);
    interrupted.status = "running";
    interrupted.currentTaskId = "reconnaissance";
    interrupted.plan.graph.tasks = interrupted.plan.graph.tasks.map((task) => task.taskId === "reconnaissance"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 } : task);
    interrupted.toolCalls = [{ toolCallId: "legacy-start", taskId: "reconnaissance", tool: "project.discover",
      ...recorded, attempt: 1, input: {}, status: "started", evidence: [], startedAt: new Date().toISOString() }];
    await store.save(interrupted);

    const result = await agent.run(created.missionId);
    expect(result.status).toBe("blocked");
    expect(result.toolCalls[0]).toMatchObject({ toolCallId: "legacy-start", status: "cancelled" });
    expect(result.plan.graph.tasks.find((task) => task.taskId === "reconnaissance")?.attempts).toBe(1);
    expect(calls).toBe(0);
  });

  it("blocks an interrupted side-effecting task instead of replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-recovery-write-"));
    const store = new JsonMissionStore(root);
    const tools = new InMemoryMissionToolRegistry([
      { name: "write.operation", description: "write", sideEffect: "write", recoveryKey: "fixture-write-v1", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
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
    interrupted.toolCalls = [{ toolCallId: "tool-stale-write", taskId: "reconnaissance", tool: "write.operation",
      sideEffect: "write", recoveryKey: "fixture-write-v1", attempt: 1, input: {}, status: "started", evidence: [], startedAt: new Date().toISOString() }];
    await store.save(interrupted);

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("blocked");
    expect(result.verdict).toBe("blocked");
    expect(result.toolCalls).toMatchObject([expect.objectContaining({ toolCallId: "tool-stale-write", sideEffect: "write", status: "cancelled" })]);
    expect(result.agentSteps[0]?.status).toBe("blocked");
    expect(result.findings.some((item) => item.message.includes("automatic recovery is disabled"))).toBe(true);
  });

  it("does not automatically replay an interrupted negative case with side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-recovery-write-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      {
        name: "surface.run-negative-charter",
        description: "negative run",
        sideEffect: "read",
        recoveryKey: "fixture-negative-v1",
        environments: ["test"],
        timeoutMs: 1000,
        inputSchema: z.object({}).passthrough(),
        execute: async () => { calls.push("negative"); return { verdict: "passed" as const }; },
      },
      {
        name: "mission.verify",
        description: "verify",
        sideEffect: "none",
        environments: ["test"],
        timeoutMs: 1000,
        inputSchema: z.object({}),
        execute: async () => ({ verdict: "passed" as const }),
      },
    ]);
    const agent = new MissionAgent({ store, tools });
    const created = await agent.create({
      intent: "recover duplicate upload test",
      projectRoot: root,
      surface: "web",
      policy: { requireApproval: false },
      charter: {
        intent: "recover duplicate upload test",
        level: "core",
        mode: "deterministic",
        preconditions: [],
        actions: [],
        assertions: [{ kind: "text-visible", text: "Ready" }],
        sideEffectPolicy: "confirm",
        metadata: {},
        negativeCases: [{
          caseId: "duplicate-upload",
          title: "重复上传",
          actions: [{ kind: "click", selector: "#upload" }],
          assertions: [{ kind: "text-visible", text: "Already exists" }],
          oracles: [],
          sideEffectPolicy: "confirm",
          metadata: {},
        }],
      },
    });
    const interrupted = await agent.load(created.missionId);
    interrupted.status = "running";
    interrupted.currentTaskId = "negative-duplicate-upload";
    interrupted.plan.graph.tasks = interrupted.plan.graph.tasks.map((task) => task.taskId === "negative-duplicate-upload"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 }
      : { ...task, status: "passed" as const, attempts: 1 });
    const negativeTask = interrupted.plan.graph.tasks.find((task) => task.taskId === "negative-duplicate-upload")!;
    interrupted.toolCalls = [{ toolCallId: "negative-start", taskId: negativeTask.taskId, tool: negativeTask.tool,
      charterId: negativeTask.charterId, sideEffect: "read", recoveryKey: "fixture-negative-v1", attempt: 1, input: negativeTask.input,
      status: "started", evidence: [], startedAt: new Date().toISOString() }];
    await store.save(interrupted);

    const result = await agent.run(created.missionId);

    expect(result.status).toBe("blocked");
    expect(result.verdict).toBe("blocked");
    expect(calls).toEqual([]);
    expect(result.findings.some((item) => item.message.includes("side effect"))).toBe(true);
  });

  it("uses the interrupted suite task's own Charter policy for recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-suite-recovery-"));
    const store = new JsonMissionStore(root);
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({}) },
      { name: "surface.run-charter", description: "run", sideEffect: "read", recoveryKey: "fixture-surface-v1", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async (_input, context) => { calls.push(context.task.taskId); return { verdict: "passed" as const }; } },
      { name: "surface.replay-charter", description: "replay", sideEffect: "read", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}).passthrough(), execute: async () => ({ verdict: "passed" as const }) },
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000, inputSchema: z.object({}), execute: async () => ({ verdict: "passed" as const }) },
    ]);
    const agent = new MissionAgent({ store, tools });
    const suite = TestSuiteSchema.parse({
      suiteId: "release-critical", level: "release", surfaces: ["web", "electron"],
      charters: [
        { charterId: "safe", charter: { intent: "safe workflow", level: "release", assertions: [{ kind: "text-visible", text: "safe" }], sideEffectPolicy: "deny" } },
        { charterId: "write", charter: { intent: "write workflow", level: "release", assertions: [{ kind: "text-visible", text: "write" }], sideEffectPolicy: "allow" } },
      ],
    });
    const create = () => agent.create({ intent: "release suite", projectRoot: root, surface: "web", suite, policy: { level: "release", sideEffectPolicy: "allow", requireApproval: false } });

    const safeMission = await create();
    const safeInterrupted = await agent.load(safeMission.missionId);
    safeInterrupted.status = "running";
    safeInterrupted.currentTaskId = "execute-safe-web";
    safeInterrupted.plan.graph.tasks = safeInterrupted.plan.graph.tasks.map((task) => task.taskId === "execute-safe-web"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 }
      : task.taskId === "reconnaissance" ? { ...task, status: "passed" as const, attempts: 1 } : task);
    const safeTask = safeInterrupted.plan.graph.tasks.find((task) => task.taskId === "execute-safe-web")!;
    safeInterrupted.toolCalls = [{ toolCallId: "safe-start", taskId: safeTask.taskId, tool: safeTask.tool,
      charterId: safeTask.charterId, sideEffect: "read", recoveryKey: "fixture-surface-v1", attempt: 1, input: safeTask.input,
      status: "started", evidence: [], startedAt: new Date().toISOString() }];
    await store.save(safeInterrupted);
    const recovered = await agent.run(safeMission.missionId);
    expect(recovered.status).toBe("completed");
    expect(recovered.plan.graph.tasks.find((task) => task.taskId === "execute-safe-web")?.attempts).toBe(2);
    expect(recovered.agentSteps.some((step) => step.taskId === "execute-safe-web" && step.phase === "recover" && step.status === "succeeded")).toBe(true);
    expect(calls).toContain("execute-safe-web");

    calls.length = 0;
    const writeMission = await create();
    const writeInterrupted = await agent.load(writeMission.missionId);
    writeInterrupted.status = "running";
    writeInterrupted.currentTaskId = "execute-write-web";
    writeInterrupted.plan.graph.tasks = writeInterrupted.plan.graph.tasks.map((task) => task.taskId === "execute-write-web"
      ? { ...task, status: "running" as const, attempts: 1, maxAttempts: 2 }
      : task.taskId === "reconnaissance" ? { ...task, status: "passed" as const, attempts: 1 } : task);
    const writeTask = writeInterrupted.plan.graph.tasks.find((task) => task.taskId === "execute-write-web")!;
    writeInterrupted.toolCalls = [{ toolCallId: "write-start", taskId: writeTask.taskId, tool: writeTask.tool,
      charterId: writeTask.charterId, sideEffect: "read", recoveryKey: "fixture-surface-v1", attempt: 1, input: writeTask.input,
      status: "started", evidence: [], startedAt: new Date().toISOString() }];
    await store.save(writeInterrupted);
    const blocked = await agent.run(writeMission.missionId);
    expect(blocked.status).toBe("blocked");
    expect(blocked.findings.some((item) => item.message.includes("side effect"))).toBe(true);
    expect(calls).toEqual([]);
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
    expect(plan.executionProfile.collectAllResults).toBe(requiresReplay);
    const verify = plan.graph.tasks.find((task) => task.taskId === "verify-result");
    expect(verify?.dependsOn).toEqual(requiresReplay
      ? ["replay-charter", "replay-charter-electron"]
      : ["execute-charter"]);
  });

  it("preserves model planning provenance and labels curated Charters as catalog plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-planning-source-"));
    const planner = new DeterministicMissionPlanner();
    const input = {
      intent: "verify a core workflow", projectRoot: root, surface: "web" as const,
      policy: { level: "core" as const, environment: "test" as const, sideEffectPolicy: "deny" as const, requireApproval: true, requireEvidence: true, maxSteps: 100, timeoutMs: 30_000 },
      charter: {
        intent: "verify a core workflow", level: "core" as const, mode: "guided" as const,
        preconditions: [], actions: [{ kind: "observe" as const }], assertions: [{ kind: "text-visible" as const, text: "ready" }],
        oracles: ["workflow-terminal"], sideEffectPolicy: "deny" as const, metadata: {},
        planning: { source: "model" as const, confidence: 0.55, assumptions: [], missingInputs: [], evidenceGaps: [] },
      },
    };
    expect((await planner.plan(input)).planning).toMatchObject({ source: "model", confidence: 0.55 });
    expect((await planner.plan({ ...input, charter: { ...input.charter, metadata: { catalogId: "core-workflow" } } })).planning)
      .toMatchObject({ source: "catalog", confidence: 0.55 });
  });

  it("turns explicitly declared negative cases into auditable tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-plan-"));
    const planner = new DeterministicMissionPlanner();
    const plan = await planner.plan({
      intent: "check duplicate resume upload",
      projectRoot: root,
      surface: "web",
      policy: { level: "core", environment: "test", sideEffectPolicy: "deny", requireApproval: true, requireEvidence: true, maxSteps: 100, timeoutMs: 30_000 },
      charter: {
        intent: "check duplicate resume upload",
        level: "core",
        mode: "deterministic",
        preconditions: [],
        actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Ready" }],
        sideEffectPolicy: "deny",
        metadata: {},
        negativeCases: [{
          caseId: "duplicate-upload",
          title: "重复上传应被拒绝",
          actions: [{ kind: "click", selector: "#upload" }],
          assertions: [{ kind: "text-visible", text: "Already exists" }],
          oracles: ["duplicate-upload-rejected"],
          sideEffectPolicy: "deny",
          metadata: { severity: "high" },
        }],
      },
    });

    expect(plan.executionProfile.declaredNegativeCases).toEqual(["duplicate-upload"]);
    expect(plan.executionProfile.requireNegativeCases).toBe(true);
    expect(plan.executionProfile.collectAllResults).toBe(true);
    expect(plan.graph.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: "negative-duplicate-upload",
        tool: "surface.run-negative-charter",
        input: expect.objectContaining({ negativeCase: expect.objectContaining({ caseId: "duplicate-upload" }) }),
        dependsOn: ["execute-charter"],
      }),
    ]));
    expect(plan.graph.tasks.find((task) => task.taskId === "verify-result")?.dependsOn).toEqual([
      "execute-charter",
      "negative-duplicate-upload",
    ]);
  });

  it("finishes declared release replay and negative cases after one evidenced run fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-release-collect-"));
    const calls: string[] = [];
    const tools = new InMemoryMissionToolRegistry([
      { name: "project.discover", description: "discover", sideEffect: "none", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("reconnaissance"); return {}; } },
      ...["surface.run-charter", "surface.replay-charter", "surface.run-negative-charter"].map((name) => ({
        name, description: name, sideEffect: "read" as const, environments: ["test" as const], timeoutMs: 1000,
        inputSchema: z.object({}).passthrough(),
        execute: async (_input: unknown, context: { task: { taskId: string } }) => {
          calls.push(context.task.taskId);
          return { verdict: context.task.taskId === "execute-charter" ? "failed" as const : "passed" as const };
        },
      })),
      { name: "mission.verify", description: "verify", sideEffect: "none", environments: ["test"], timeoutMs: 1000,
        inputSchema: z.object({}), execute: async () => { calls.push("verify-result"); return { verdict: "passed" as const }; } },
    ]);
    const agent = new MissionAgent({ store: new JsonMissionStore(root), tools });
    const created = await agent.create({
      intent: "release one workflow across Web and Electron", projectRoot: root, surface: "web",
      policy: { level: "release", requireApproval: false },
      charter: {
        intent: "release one workflow", level: "release", mode: "deterministic", preconditions: [], actions: [],
        assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["business-terminal"], sideEffectPolicy: "deny", metadata: {},
        negativeCases: [{ caseId: "duplicate", title: "Duplicate attempt", actions: [],
          assertions: [{ kind: "text-visible", text: "Duplicate" }], oracles: ["business-duplicate"], sideEffectPolicy: "deny", metadata: {} }],
      },
    });
    const result = await agent.run(created.missionId);
    expect(result.status).toBe("failed");
    expect(result.verdict).toBe("failed");
    expect(calls).toEqual(["reconnaissance", "execute-charter", "execute-charter-electron",
      "replay-charter", "replay-charter-electron", "negative-duplicate", "negative-electron-duplicate", "verify-result"]);
    expect(result.plan.graph.tasks.filter((task) => task.status === "pending")).toHaveLength(0);
    expect(result.plan.graph.tasks.find((task) => task.taskId === "execute-charter")?.status).toBe("failed");
  });

  it("rejects duplicate negative case identifiers before task creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-duplicate-"));
    const planner = new DeterministicMissionPlanner();
    await expect(planner.plan({
      intent: "duplicate negative cases",
      projectRoot: root,
      surface: "web",
      policy: { level: "core", environment: "test", sideEffectPolicy: "deny", requireApproval: true, requireEvidence: true, maxSteps: 100, timeoutMs: 30_000 },
      charter: {
        intent: "duplicate negative cases",
        level: "core",
        mode: "deterministic",
        preconditions: [],
        actions: [],
        assertions: [],
        sideEffectPolicy: "deny",
        metadata: {},
        negativeCases: [
          { caseId: "same", title: "first", actions: [], assertions: [], oracles: [], sideEffectPolicy: "deny", metadata: {} },
          { caseId: "same", title: "second", actions: [], assertions: [], oracles: [], sideEffectPolicy: "deny", metadata: {} },
        ],
      },
    })).rejects.toThrow("duplicate negative case IDs");
  });
});
