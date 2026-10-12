import { describe, expect, it } from "vitest";
import { TestMissionSchema, type MissionTaskStatus, type TestMission } from "@proofkit/contracts";
import { auditMissionAgentTrace } from "./mission-agent-trace-audit.js";

function mission(taskStatus: MissionTaskStatus, stepStatus: "running" | "succeeded" | "failed" | "blocked" | "cancelled",
  callStatus: "started" | "succeeded" | "failed" | "blocked" | "cancelled"): TestMission {
  const startedAt = "2026-10-12T00:00:00.000Z";
  const endedAt = "2026-10-12T00:00:01.000Z";
  return TestMissionSchema.parse({
    missionId: "mission-trace-audit",
    intent: "audit execution receipts",
    projectRoot: "/source",
    surface: "web",
    policy: {},
    status: taskStatus === "running" ? "running" : taskStatus === "failed" ? "failed"
      : taskStatus === "blocked" ? "blocked" : "completed",
    verdict: taskStatus === "failed" ? "failed" : taskStatus === "blocked" ? "blocked" : "passed",
    plan: {
      planId: "plan-trace-audit",
      version: "1",
      generatedBy: "test",
      graph: {
        tasks: [{ taskId: "run", title: "Run", objective: "Run a test", tool: "test.run",
          input: {}, status: taskStatus, attempts: 1, maxAttempts: 1 }],
        terminalTaskIds: ["run"],
      },
      createdAt: startedAt,
    },
    agentSteps: [{ agentStepId: "step-1", sequence: 1, taskId: "run", phase: "execute", tool: "test.run",
      decision: "Run the ready task", input: {}, status: stepStatus, startedAt,
      ...(stepStatus === "running" ? {} : { endedAt }), toolCallIds: ["call-1"], observationIds: [], evidence: [] }],
    toolCalls: [{ toolCallId: "call-1", taskId: "run", tool: "test.run", sideEffect: "none", attempt: 1,
      input: {}, status: callStatus, startedAt, ...(callStatus === "started" ? {} : { endedAt }), evidence: [] }],
    createdAt: startedAt,
    updatedAt: endedAt,
  });
}

describe("Mission Agent trace task-state audit", () => {
  it("rejects task terminal states that disagree with the latest receipts", () => {
    const result = auditMissionAgentTrace(mission("failed", "succeeded", "succeeded"));

    expect(result.status).toBe("incomplete");
    expect(result.issues).toContain("Task run status disagrees with its final AgentStep and ToolCall receipt.");
  });

  it("accepts an evidenced business failure where the tool invocation itself succeeded", () => {
    const result = auditMissionAgentTrace(mission("failed", "failed", "succeeded"));

    expect(result.status).toBe("complete");
    expect(result.issues).toEqual([]);
  });

  it("accepts an active task only while its final step and call are both running", () => {
    expect(auditMissionAgentTrace(mission("running", "running", "started")).status).toBe("complete");
    expect(auditMissionAgentTrace(mission("running", "succeeded", "succeeded")).status).toBe("incomplete");
  });
});
