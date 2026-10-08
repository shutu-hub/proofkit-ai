import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryMissionToolRegistry, JsonMissionStore, MissionAgent } from "./index.js";

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
});
