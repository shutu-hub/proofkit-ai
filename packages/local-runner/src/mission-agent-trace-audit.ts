import { isDeepStrictEqual } from "node:util";
import { MissionAgentTraceAuditSchema, type AgentStep, type MissionAgentTraceAudit, type Observation, type TestMission, type ToolCall } from "@proofkit/contracts";

const MAX_TRACE_ITEMS = 20_000;
const RUN_TOOLS: Record<string, string> = {
  primary: "surface.run-charter",
  replay: "surface.replay-charter",
  negative: "surface.run-negative-charter",
};

/** Rebuild ownership from saved receipts; the saved Mission verdict is not an input to a successful audit. */
export function auditMissionAgentTrace(mission: TestMission): MissionAgentTraceAudit {
  const issues: string[] = [];
  let omittedIssues = 0;
  let status: MissionAgentTraceAudit["status"] = "complete";
  const issue = (message: string, kind: "incomplete" | "unverified" = "incomplete") => {
    if (kind === "incomplete" || status === "complete") status = kind;
    if (issues.length < 20) issues.push(message);
    else omittedIssues++;
  };
  const { agentSteps: steps, toolCalls: calls, observations } = mission;
  if (steps.length > MAX_TRACE_ITEMS || calls.length > MAX_TRACE_ITEMS || observations.length > MAX_TRACE_ITEMS) {
    issue("Agent trace exceeds the bounded audit limit; the remaining receipts cannot be verified.", "unverified");
    return MissionAgentTraceAuditSchema.parse({ status, checkedSteps: 0, checkedCalls: 0,
      checkedObservations: 0, issues, omittedIssues });
  }
  if (steps.length === 0 && calls.length === 0 && mission.plan.graph.tasks.some((task) => task.attempts > 0)) {
    issue("Executed tasks have no saved AgentStep or ToolCall receipts; this legacy trace is unverified.", "unverified");
  }

  const tasks = new Map(mission.plan.graph.tasks.map((task) => [task.taskId, task]));
  const callById = new Map<string, ToolCall>();
  const observationById = new Map<string, Observation>();
  const callOwner = new Map<string, AgentStep>();
  const callOwnerCounts = new Map<string, number>();
  const observationOwnerCounts = new Map<string, number>();
  const callsByTask = new Map<string, ToolCall[]>();
  const stepsByTask = new Map<string, AgentStep[]>();
  const stepIds = new Set<string>();
  for (const call of calls) {
    if (callById.has(call.toolCallId)) issue(`Duplicate ToolCall ID ${call.toolCallId}.`);
    callById.set(call.toolCallId, call);
    const taskCalls = callsByTask.get(call.taskId) ?? [];
    taskCalls.push(call);
    callsByTask.set(call.taskId, taskCalls);
    const task = tasks.get(call.taskId);
    if (!task || call.tool !== task.tool || call.charterId !== task.charterId
      || !isDeepStrictEqual(call.input, task.input)) issue(`ToolCall ${call.toolCallId} does not match its declared task, tool, Charter or input.`);
    if (call.attempt > (task?.attempts ?? 0)) issue(`ToolCall ${call.toolCallId} exceeds its task attempt count.`);
    if (isTerminal(mission) && call.status === "started") issue(`ToolCall ${call.toolCallId} is still started in a terminal Mission.`);
    if (call.status !== "started" && !call.endedAt) issue(`ToolCall ${call.toolCallId} has no terminal timestamp.`);
  }
  for (const observation of observations) {
    if (observationById.has(observation.observationId)) issue(`Duplicate Observation ID ${observation.observationId}.`);
    observationById.set(observation.observationId, observation);
  }
  for (const [index, step] of steps.entries()) {
    if (step.sequence !== index + 1) issue(`AgentStep ${step.agentStepId} has an invalid sequence.`);
    if (stepIds.has(step.agentStepId)) issue(`Duplicate AgentStep ID ${step.agentStepId}.`);
    stepIds.add(step.agentStepId);
    const taskSteps = stepsByTask.get(step.taskId) ?? [];
    taskSteps.push(step);
    stepsByTask.set(step.taskId, taskSteps);
    const task = tasks.get(step.taskId);
    if (!task || step.tool !== task.tool || step.charterId !== task.charterId
      || !isDeepStrictEqual(step.input, task.input)) issue(`AgentStep ${step.agentStepId} does not match its declared task, tool, Charter or input.`);
    if (isTerminal(mission) && step.status === "running") issue(`AgentStep ${step.agentStepId} is still running in a terminal Mission.`);
    if (step.status !== "running" && !step.endedAt) issue(`AgentStep ${step.agentStepId} has no terminal timestamp.`);
    if (step.toolCallIds.length !== 1) {
      issue(`AgentStep ${step.agentStepId} has no unique ToolCall receipt.`, "unverified");
    }
    for (const callId of step.toolCallIds) {
      callOwner.set(callId, step);
      callOwnerCounts.set(callId, (callOwnerCounts.get(callId) ?? 0) + 1);
      const call = callById.get(callId);
      if (!call) { issue(`AgentStep ${step.agentStepId} references missing ToolCall ${callId}.`, "unverified"); continue; }
      if (call.taskId !== step.taskId || call.tool !== step.tool || call.charterId !== step.charterId
        || call.startedAt !== step.startedAt || !isDeepStrictEqual(call.input, step.input)
        || !isDeepStrictEqual(call.evidence, step.evidence)) {
        issue(`AgentStep ${step.agentStepId} does not own matching ToolCall ${callId}.`);
      }
      if (step.status === "succeeded" && call.status !== "succeeded"
        || step.status === "running" && call.status !== "started"
        || step.status === "cancelled" && !["cancelled", "succeeded"].includes(call.status)
        || step.status === "blocked" && !["blocked", "cancelled", "succeeded"].includes(call.status)
        || step.status === "failed" && !["failed", "succeeded"].includes(call.status)) {
        issue(`AgentStep ${step.agentStepId} status disagrees with ToolCall ${callId}.`);
      }
    }
    for (const observationId of step.observationIds) {
      observationOwnerCounts.set(observationId, (observationOwnerCounts.get(observationId) ?? 0) + 1);
      const observation = observationById.get(observationId);
      if (!observation) { issue(`AgentStep ${step.agentStepId} references missing Observation ${observationId}.`, "unverified"); continue; }
      if (observation.kind === "surface.run") auditRunObservation(step, task, observation, issue);
    }
  }
  for (const call of calls) {
    if (callOwnerCounts.get(call.toolCallId) !== 1) issue(`ToolCall ${call.toolCallId} must belong to exactly one AgentStep.`);
  }
  for (const observation of observations) {
    if (observationOwnerCounts.get(observation.observationId) !== 1) {
      issue(`Observation ${observation.observationId} must belong to exactly one AgentStep.`, "unverified");
    }
  }
  for (const task of tasks.values()) {
    const taskCalls = callsByTask.get(task.taskId) ?? [];
    const taskSteps = stepsByTask.get(task.taskId) ?? [];
    if (taskCalls.length !== task.attempts || taskSteps.length !== task.attempts) {
      issue(`Task ${task.taskId} has ${task.attempts} attempts but ${taskSteps.length} AgentSteps and ${taskCalls.length} ToolCalls.`, "unverified");
    }
    const attempts = new Set(taskCalls.map((call) => call.attempt));
    if (attempts.size !== taskCalls.length || taskCalls.some((call) => call.attempt < 1 || call.attempt > task.attempts)) {
      issue(`Task ${task.taskId} has duplicated or invalid ToolCall attempts.`);
    }
    for (const [index, step] of taskSteps.entries()) {
      const call = step.toolCallIds.length === 1 ? callById.get(step.toolCallIds[0]!) : undefined;
      if (call && call.attempt !== index + 1) issue(`AgentStep ${step.agentStepId} is linked to the wrong task attempt.`);
    }
    if (task.status === "passed") {
      const finalCall = taskCalls.find((call) => call.attempt === task.attempts);
      const finalStep = finalCall ? callOwner.get(finalCall.toolCallId) : undefined;
      if (!finalCall || !finalStep) {
        issue(`Passed task ${task.taskId} has no final AgentStep and ToolCall receipts.`, "unverified");
      } else if (finalCall.status !== "succeeded" || finalStep.status !== "succeeded"
        || !isDeepStrictEqual(task.output, finalStep.output)) {
        issue(`Passed task ${task.taskId} lacks a matching successful final AgentStep and ToolCall.`);
      }
    }
  }
  return MissionAgentTraceAuditSchema.parse({ status, checkedSteps: steps.length, checkedCalls: calls.length,
    checkedObservations: observations.length, issues, omittedIssues });
}

function auditRunObservation(
  step: AgentStep,
  task: TestMission["plan"]["graph"]["tasks"][number] | undefined,
  observation: Observation,
  issue: (message: string) => void,
): void {
  const runKind = observation.data.runKind ?? "primary";
  const output = step.output && typeof step.output === "object" && !Array.isArray(step.output)
    ? step.output as Record<string, unknown> : undefined;
  const expectedCharterId = task?.charterId ?? (typeof task?.input.charterId === "string" ? task.input.charterId : undefined);
  if (step.tool !== RUN_TOOLS[String(runKind)] || !task || observation.data.surface !== task.input.adapter
    || observation.charterId !== expectedCharterId && task.charterId !== undefined
    || typeof observation.data.runId !== "string" || output?.runId !== observation.data.runId
    || !isDeepStrictEqual(observation.evidence, step.evidence)) {
    issue(`Run Observation ${observation.observationId} does not belong to its AgentStep execution.`);
  }
}

function isTerminal(mission: TestMission): boolean {
  return ["completed", "failed", "blocked", "cancelled"].includes(mission.status);
}
