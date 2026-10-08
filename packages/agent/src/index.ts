import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FindingSchema,
  DiagnosisSchema,
  FailureBoundarySchema,
  MissionPlanSchema,
  MissionExecutionProfileSchema,
  MissionPolicySchema,
  ObservationSchema,
  RepairSuggestionSchema,
  TaskNodeSchema,
  TestMissionSchema,
  ToolCallSchema,
  type Finding,
  type Diagnosis,
  type FailureBoundary,
  type MissionPlan,
  type MissionExecutionProfile,
  type MissionPolicy,
  type MissionStatus,
  type Observation,
  type RepairSuggestion,
  type TaskNode,
  type TestMission,
  type ToolCall,
  type Verdict,
} from "@proofkit/contracts";
export { analyzeRun, type FailureAnalysis, type FailureAnalyzerInput } from "./failure-analyzer.js";

export type MissionToolResult = {
  output?: unknown;
  observations?: Observation[];
  evidence?: TestMission["evidence"];
  findings?: Finding[];
  diagnosis?: Diagnosis;
  firstFailure?: FailureBoundary;
  repairSuggestions?: RepairSuggestion[];
  verdict?: Verdict;
};

export type MissionToolContext = {
  mission: TestMission;
  task: TaskNode;
  signal: AbortSignal;
};

export type MissionTool<Input = unknown> = {
  name: string;
  description: string;
  sideEffect: "none" | "read" | "write";
  environments: Array<MissionPolicy["environment"]>;
  timeoutMs: number;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType;
  execute(input: Input, context: MissionToolContext): Promise<MissionToolResult>;
};

export type MissionPlanInput = {
  intent: string;
  projectRoot: string;
  surface: TestMission["surface"];
  policy: MissionPolicy;
  charter?: TestMission["charter"];
};

export interface MissionPlanner {
  plan(input: MissionPlanInput): Promise<MissionPlan>;
}

function executionProfile(level: MissionPolicy["level"], surface: TestMission["surface"]): MissionExecutionProfile {
  const surfaceMatrix = level === "release" && (surface === "web" || surface === "electron")
    ? [surface, surface === "web" ? "electron" : "web"] as TestMission["surface"][]
    : [surface];
  return MissionExecutionProfileSchema.parse({
    surfaceMatrix,
    negativeCases: level === "quick"
      ? []
      : level === "core"
        ? ["关键权限或输入边界"]
        : ["权限边界", "无效输入", "重试与恢复", "重复提交与幂等"],
    requireBusinessOracle: level !== "quick",
    requireReplay: level === "release",
    requireNegativeCases: false,
    minimumEvidence: level === "quick" ? 1 : level === "core" ? 2 : 3,
  });
}

export class DeterministicMissionPlanner implements MissionPlanner {
  async plan(input: MissionPlanInput): Promise<MissionPlan> {
    const now = new Date().toISOString();
    const planId = `plan-${randomUUID().slice(0, 12)}`;
    const profile = executionProfile(input.policy.level, input.surface);
    const primaryTasks = profile.surfaceMatrix.map((surface) => {
      const taskId = surface === input.surface ? "execute-charter" : `execute-charter-${surface}`;
      return TaskNodeSchema.parse({
        taskId,
        title: `${surface} 执行确定性测试步骤`,
        objective: input.intent,
        tool: "surface.run-charter",
        input: input.charter ? { charter: input.charter, adapter: surface } : { adapter: surface },
        dependsOn: ["reconnaissance"],
        maxAttempts: 1,
      });
    });
    const replayTasks = profile.requireReplay ? profile.surfaceMatrix.map((surface) => {
      const taskId = surface === input.surface ? "replay-charter" : `replay-charter-${surface}`;
      const primaryTaskId = surface === input.surface ? "execute-charter" : `execute-charter-${surface}`;
      return TaskNodeSchema.parse({
        taskId,
        title: `${surface} 回放测试并确认结果可重复`,
        objective: "重新执行同一 Charter，确认通过结果不是一次性偶然状态。",
        tool: "surface.replay-charter",
        input: { adapter: surface },
        dependsOn: [primaryTaskId],
        maxAttempts: 1,
      });
    }) : [];
    const verificationDependencies = profile.requireReplay
      ? replayTasks.map((task) => task.taskId)
      : primaryTasks.map((task) => task.taskId);
    const tasks: TaskNode[] = [
      TaskNodeSchema.parse({
        taskId: "reconnaissance",
        title: "熟悉项目和运行表面",
        objective: "确认项目入口、运行环境和当前可观察表面。",
        tool: "project.discover",
        input: {},
        maxAttempts: 1,
      }),
      ...primaryTasks,
      ...replayTasks,
      TaskNodeSchema.parse({
        taskId: "verify-result",
        title: "验证业务终态和证据完整性",
        objective: "确认测试结果有独立验证和可追溯证据。",
        tool: "mission.verify",
        input: {},
        dependsOn: verificationDependencies,
        maxAttempts: 1,
      }),
    ];
    return MissionPlanSchema.parse({
      planId,
      version: "1",
      generatedBy: "deterministic-mission-planner-v1",
      graph: { tasks, terminalTaskIds: ["verify-result"] },
      successCriteria: ["所有任务完成", "业务结果有独立证据", "未发现已确认的高严重度缺陷"],
      level: input.policy.level,
      executionProfile: profile,
      assumptions: [
        `test-level=${input.policy.level}`,
        `surface=${input.surface}`,
        `environment=${input.policy.environment}`,
        input.policy.requireEvidence ? "evidence-required" : "evidence-optional",
      ],
      createdAt: now,
    });
  }
}

export interface MissionStore {
  save(mission: TestMission): Promise<void>;
  load(missionId: string): Promise<TestMission>;
}

export class JsonMissionStore implements MissionStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async save(mission: TestMission): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(join(this.rootDir, `${safeMissionId(mission.missionId)}.json`), `${JSON.stringify(mission, null, 2)}\n`, "utf8");
  }

  async load(missionId: string): Promise<TestMission> {
    const source = await readFile(join(this.rootDir, `${safeMissionId(missionId)}.json`), "utf8");
    return TestMissionSchema.parse(JSON.parse(source));
  }
}

export type MissionToolRegistry = {
  get(name: string): MissionTool | undefined;
  list(): MissionTool[];
};

export class InMemoryMissionToolRegistry implements MissionToolRegistry {
  private readonly tools = new Map<string, MissionTool>();

  constructor(tools: MissionTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: MissionTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate mission tool: ${tool.name}`);
    if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0) throw new Error(`Mission tool timeout must be positive: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): MissionTool | undefined {
    return this.tools.get(name);
  }

  list(): MissionTool[] {
    return [...this.tools.values()];
  }
}

export type MissionCreateInput = Omit<MissionPlanInput, "policy"> & {
  policy?: Partial<MissionPolicy>;
};

export type MissionRunOptions = {
  signal?: AbortSignal;
  approve?: boolean;
};

export class MissionAgent {
  private readonly store: MissionStore;
  private readonly tools: MissionToolRegistry;
  private readonly planner: MissionPlanner;

  constructor(options: { store: MissionStore; tools: MissionToolRegistry; planner?: MissionPlanner }) {
    this.store = options.store;
    this.tools = options.tools;
    this.planner = options.planner ?? new DeterministicMissionPlanner();
  }

  async create(input: MissionCreateInput): Promise<TestMission> {
    const policy = MissionPolicySchema.parse(input.policy ?? {});
    if (input.charter && input.charter.level !== policy.level) {
      throw new Error(`Mission policy level ${policy.level} does not match charter level ${input.charter.level}`);
    }
    const plan = await this.planner.plan({ ...input, policy });
    const now = new Date().toISOString();
    const mission = TestMissionSchema.parse({
      missionId: `mission-${randomUUID().slice(0, 12)}`,
      intent: input.intent,
      projectRoot: input.projectRoot,
      surface: input.surface,
      level: policy.level,
      levelSelection: input.charter?.levelSelection,
      policy,
      status: policy.requireApproval ? "awaiting-approval" : "approved",
      charter: input.charter,
      plan,
      createdAt: now,
      updatedAt: now,
    });
    await this.store.save(mission);
    return mission;
  }

  async load(missionId: string): Promise<TestMission> {
    return this.store.load(validateMissionId(missionId));
  }

  async approve(missionId: string): Promise<TestMission> {
    const mission = await this.load(missionId);
    if (mission.status !== "awaiting-approval" && mission.status !== "planned") {
      throw new Error(`Mission cannot be approved from status ${mission.status}`);
    }
    return this.save({ ...mission, status: "approved" });
  }

  async run(missionId: string, options: MissionRunOptions = {}): Promise<TestMission> {
    let mission = await this.load(missionId);
    if (mission.status === "awaiting-approval" && options.approve) mission = await this.approve(missionId);
    if (mission.status !== "approved" && mission.status !== "paused" && mission.status !== "running") {
      throw new Error(`Mission cannot run from status ${mission.status}`);
    }
    mission = await this.save({ ...mission, status: "running" });
    const controller = new AbortController();
    const detach = relayAbort(options.signal, controller);
    try {
      for (let step = 0; step < mission.policy.maxSteps; step++) {
        throwIfAborted(controller.signal);
        const current = await this.load(mission.missionId);
        const next = nextReadyTask(current);
        if (!next) {
          const blocked = current.plan.graph.tasks.some((task) => task.status === "blocked");
          const failed = current.plan.graph.tasks.some((task) => task.status === "failed");
          const terminal: MissionStatus = blocked ? "blocked" : failed ? "failed" : "completed";
          const verdict = blocked ? "blocked" : failed ? "failed" : current.verdict ?? "passed";
          return this.save({ ...current, status: terminal, verdict });
        }
        mission = await this.executeTask(current, next, controller.signal);
        if (mission.status === "failed" || mission.status === "blocked" || mission.status === "cancelled") return mission;
      }
      return this.save({ ...mission, status: "blocked", verdict: "blocked", findings: [...mission.findings, finding("agent-step-limit", "medium", "test", "Agent step limit reached", "Mission exceeded its configured maxSteps.")] });
    } catch (error) {
      if (controller.signal.aborted) {
        return this.save({ ...mission, status: "cancelled", verdict: "cancelled", findings: [...mission.findings, finding("mission-cancelled", "info", "environment", "Mission cancelled", toError(error).message)] });
      }
      const cause = toError(error);
      const current = await this.load(mission.missionId).catch(() => mission);
      return this.save({
        ...current,
        status: "failed",
        verdict: "failed",
        findings: [...current.findings, finding("mission-system-failure", "high", "test", "Mission execution failed", cause.message, "suspected")],
      });
    } finally {
      detach();
    }
  }

  private async executeTask(mission: TestMission, task: TaskNode, signal: AbortSignal): Promise<TestMission> {
    const tool = this.tools.get(task.tool);
    const startedAt = new Date().toISOString();
    const toolCallId = `tool-${randomUUID().slice(0, 12)}`;
    const runningTask = { ...task, status: "running" as const, attempts: task.attempts + 1 };
    const startedMission = await this.save(updateTask(mission, runningTask, { currentTaskId: task.taskId }));
    if (!tool) {
      return this.save(failTask(startedMission, task.taskId, toolCallId, startedAt, `Mission tool is not registered: ${task.tool}`, "blocked"));
    }
    if (!tool.environments.includes(mission.policy.environment)) {
      return this.save(failTask(startedMission, task.taskId, toolCallId, startedAt, `Mission tool ${tool.name} is not allowed in ${mission.policy.environment}`, "blocked"));
    }
    if (tool.sideEffect === "write" && mission.policy.sideEffectPolicy !== "allow") {
      return this.save(failTask(startedMission, task.taskId, toolCallId, startedAt, `Mission tool ${tool.name} requires sideEffectPolicy=allow`, "blocked"));
    }
    const toolController = new AbortController();
    const detach = relayAbort(signal, toolController);
    const timeout = setTimeout(() => toolController.abort(new Error(`Mission tool ${tool.name} timed out`)), tool.timeoutMs);
    try {
      const input = tool.inputSchema.parse(task.input);
      const result = await raceAbort(tool.execute(input, { mission: startedMission, task: runningTask, signal: toolController.signal }), toolController.signal);
      const output = tool.outputSchema ? tool.outputSchema.parse(result.output) : result.output;
      const finishedAt = new Date().toISOString();
      const call = ToolCallSchema.parse({ toolCallId, taskId: task.taskId, tool: tool.name, input: task.input, status: "succeeded", startedAt, endedAt: finishedAt, durationMs: Date.now() - Date.parse(startedAt), evidence: result.evidence ?? [] });
      const failedVerdict = result.verdict === "failed" || result.verdict === "blocked" || result.verdict === "cancelled";
      const taskStatus = failedVerdict ? result.verdict === "blocked" ? "blocked" : "failed" : "passed";
      const taskUpdate = updateTask(startedMission, { ...runningTask, status: taskStatus, output, ...(failedVerdict ? { error: `Tool returned verdict ${result.verdict}` } : {}) }, { currentTaskId: undefined });
      return this.save({
        ...taskUpdate,
        toolCalls: [...startedMission.toolCalls, call],
        observations: [...startedMission.observations, ...(result.observations ?? []).map((item) => ObservationSchema.parse(item))],
        evidence: [...startedMission.evidence, ...(result.evidence ?? [])],
        findings: [...startedMission.findings, ...(result.findings ?? []).map((item) => FindingSchema.parse(item))],
        ...(result.firstFailure ? { firstFailure: FailureBoundarySchema.parse(result.firstFailure) } : {}),
        ...(result.diagnosis ? { diagnosis: DiagnosisSchema.parse(result.diagnosis) } : {}),
        repairSuggestions: [...startedMission.repairSuggestions, ...(result.repairSuggestions ?? []).map((item) => RepairSuggestionSchema.parse(item))],
        verdict: result.verdict,
        ...(failedVerdict ? { status: taskStatus === "blocked" ? "blocked" : "failed" } : {}),
      });
    } catch (error) {
      const cause = toError(error);
      const cancelled = toolController.signal.aborted && signal.aborted;
      const status = cancelled ? "cancelled" : "failed";
      const call = ToolCallSchema.parse({ toolCallId, taskId: task.taskId, tool: tool.name, input: task.input, status, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), error: cause.message });
      const failedTask = updateTask(startedMission, { ...runningTask, status: status === "cancelled" ? "blocked" : "failed", error: cause.message }, { currentTaskId: task.taskId });
      return this.save({
        ...failedTask,
        toolCalls: [...startedMission.toolCalls, call],
        findings: [...startedMission.findings, finding(`task-${task.taskId}`, status === "cancelled" ? "info" : "medium", status === "cancelled" ? "environment" : "test", `Task ${task.taskId} did not complete`, cause.message, status === "cancelled" ? "confirmed" : "suspected")],
        status: status === "cancelled" ? "cancelled" : "failed",
        verdict: status === "cancelled" ? "cancelled" : "failed",
      });
    } finally {
      clearTimeout(timeout);
      detach();
    }
  }

  private async save(mission: TestMission): Promise<TestMission> {
    const next = TestMissionSchema.parse({ ...mission, revision: mission.revision + 1, updatedAt: new Date().toISOString() });
    await this.store.save(next);
    return next;
  }
}

function nextReadyTask(mission: TestMission): TaskNode | undefined {
  const completed = new Set(mission.plan.graph.tasks.filter((task) => task.status === "passed").map((task) => task.taskId));
  return mission.plan.graph.tasks.find((task) => (task.status === "pending" || task.status === "ready") && task.dependsOn.every((dependency) => completed.has(dependency)));
}

function updateTask(mission: TestMission, task: TaskNode, options: { currentTaskId?: string }): TestMission {
  return { ...mission, currentTaskId: options.currentTaskId, plan: { ...mission.plan, graph: { ...mission.plan.graph, tasks: mission.plan.graph.tasks.map((candidate) => candidate.taskId === task.taskId ? TaskNodeSchema.parse(task) : candidate) } } };
}

function failTask(mission: TestMission, taskId: string, toolCallId: string, startedAt: string, error: string, status: "blocked" | "failed"): TestMission {
  const task = mission.plan.graph.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const nextTask = { ...task, status, error } as TaskNode;
  const call = ToolCallSchema.parse({ toolCallId, taskId, tool: task.tool, input: task.input, status, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), error });
  return { ...updateTask(mission, nextTask, { currentTaskId: taskId }), status: status === "blocked" ? "blocked" : "failed", verdict: status === "blocked" ? "blocked" : "failed", toolCalls: [...mission.toolCalls, call], findings: [...mission.findings, finding(`task-${taskId}`, status === "blocked" ? "high" : "medium", status === "blocked" ? "environment" : "product", `Task ${taskId} did not complete`, error)] };
}

function finding(id: string, severity: Finding["severity"], category: Finding["category"], title: string, message: string, status: Finding["status"] = "confirmed"): Finding {
  return FindingSchema.parse({ findingId: id, severity, category, status, title, message, createdAt: new Date().toISOString() });
}

function safeMissionId(value: string): string {
  return validateMissionId(value);
}

function validateMissionId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid mission id");
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Mission cancelled");
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const onAbort = () => target.abort(source.reason);
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Mission tool cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
