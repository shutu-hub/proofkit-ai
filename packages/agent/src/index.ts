import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { MissionOwnership, type MissionExecutionLease } from "./mission-ownership.js";
import {
  FindingSchema,
  AgentStepSchema,
  DiagnosisSchema,
  FailureBoundarySchema,
  MissionPlanSchema,
  MissionExecutionProfileSchema,
  MissionPolicySchema,
  ObservationSchema,
  PlanningQualitySchema,
  PlanningCoverageSchema,
  RepairSuggestionSchema,
  TaskNodeSchema,
  TestMissionSchema,
  ToolCallSchema,
  suiteChecks,
  type Finding,
  type AgentStep,
  type Diagnosis,
  type FailureBoundary,
  type MissionPlan,
  type MissionExecutionProfile,
  type MissionPolicy,
  type PlanningQuality,
  type MissionStatus,
  type Observation,
  type RepairSuggestion,
  type TaskNode,
  type TestMission,
  type TestSuite,
  type TestLevelSelection,
  type ToolCall,
  type Verdict,
} from "@proofkit/contracts";
export { analyzeRun, selectEvidencedBusinessFailure, type FailureAnalysis, type FailureAnalyzerInput } from "./failure-analyzer.js";

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
  /** Stable only while this tool's implementation and execution context are compatible for crash retry. */
  recoveryKey?: string;
  environments: Array<MissionPolicy["environment"]>;
  timeoutMs: number;
  /** Time allowed for an aborted tool to close resources and return evidence. */
  cancellationGraceMs?: number;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType;
  execute(input: Input, context: MissionToolContext): Promise<MissionToolResult>;
};

export type MissionPlanInput = {
  intent: string;
  projectRoot: string;
  workspaceRoot?: string;
  surface: TestMission["surface"];
  policy: MissionPolicy;
  charter?: TestMission["charter"];
  suite?: TestSuite;
  workflowInventory?: TestMission["workflowInventory"];
  workflowInventoryInspection?: TestMission["workflowInventoryInspection"];
  workflowReview?: TestMission["workflowReview"];
  workflowReviewAdmission?: TestMission["workflowReviewAdmission"];
  levelSelection?: TestLevelSelection;
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
    collectAllResults: level === "release",
    negativeCases: level === "quick"
      ? []
      : level === "core"
        ? ["关键权限或输入边界"]
        : ["权限边界", "无效输入", "重试与恢复", "重复提交与幂等"],
    declaredNegativeCases: [],
    requireBusinessOracle: level !== "quick",
    requireReplay: level === "release",
    requireNegativeCases: false,
    minimumEvidence: level === "quick" ? 1 : level === "core" ? 2 : 3,
  });
}

function planningQuality(input: MissionPlanInput, source?: PlanningQuality["source"]): PlanningQuality {
  if (input.charter) {
    const resolvedSource = source ?? (typeof input.charter.metadata.catalogId === "string"
      ? "catalog" : input.charter.planning?.source ?? "deterministic");
    return PlanningQualitySchema.parse({ ...(input.charter.planning ?? {}), source: resolvedSource });
  }
  if (input.suite) {
    const qualities = input.suite.charters.map((item) => PlanningQualitySchema.parse(item.charter.planning ?? {}));
    const coverages = qualities.flatMap((item) => item.coverage ? [item.coverage] : []);
    const coverage = coverages.find((item) => item.requested === "project") ?? coverages[0];
    return PlanningQualitySchema.parse({
      source: source ?? "catalog",
      confidence: qualities.length === 0 ? 0 : Math.min(...qualities.map((item) => item.confidence)),
      assumptions: [...new Set(qualities.flatMap((item) => item.assumptions))],
      missingInputs: [...new Set(qualities.flatMap((item) => item.missingInputs))],
      evidenceGaps: [...new Set(qualities.flatMap((item) => item.evidenceGaps))],
      ...(coverage ? { coverage: PlanningCoverageSchema.parse({ ...coverage,
        inventory: coverages.some((item) => item.inventory === "partial") ? "partial"
          : coverages.some((item) => item.inventory === "not-scanned") ? "not-scanned" : "bounded",
        gaps: [...new Set(coverages.flatMap((item) => item.gaps))],
      }) } : {}),
    });
  }
  return PlanningQualitySchema.parse({ source: source ?? "deterministic", confidence: 0, missingInputs: ["validated Test Charter"] });
}

export class DeterministicMissionPlanner implements MissionPlanner {
  async plan(input: MissionPlanInput): Promise<MissionPlan> {
    if (input.suite) return this.planSuite(input, input.suite);
    const now = new Date().toISOString();
    const planId = `plan-${randomUUID().slice(0, 12)}`;
    const profile = executionProfile(input.policy.level, input.surface);
    const negativeCases = input.charter?.negativeCases ?? [];
    const negativeCaseIds = negativeCases.map((negativeCase) => negativeCase.caseId);
    if (new Set(negativeCaseIds).size !== negativeCaseIds.length) {
      throw new Error("Charter contains duplicate negative case IDs");
    }
    profile.declaredNegativeCases = negativeCaseIds;
    profile.requireNegativeCases = negativeCases.length > 0;
    profile.collectAllResults ||= negativeCases.length > 0;
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
        dependencyMode: "settled",
        maxAttempts: 1,
      });
    }) : [];
    const negativeTasks = profile.surfaceMatrix.flatMap((surface) => negativeCases.map((negativeCase) => {
      const taskId = surface === input.surface
        ? `negative-${negativeCase.caseId}`
        : `negative-${surface}-${negativeCase.caseId}`;
      const primaryTaskId = surface === input.surface ? "execute-charter" : `execute-charter-${surface}`;
      return TaskNodeSchema.parse({
        taskId,
        title: `${surface} 负向场景：${negativeCase.title}`,
        objective: `验证负向场景 ${negativeCase.title} 按预期拒绝或恢复，并保存独立证据。`,
        tool: "surface.run-negative-charter",
        input: { negativeCase, adapter: surface },
        dependsOn: [primaryTaskId],
        dependencyMode: "settled",
        maxAttempts: 1,
      });
    }));
    const verificationDependencies = profile.requireReplay
      ? [...replayTasks.map((task) => task.taskId), ...negativeTasks.map((task) => task.taskId)]
      : [...primaryTasks.map((task) => task.taskId), ...negativeTasks.map((task) => task.taskId)];
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
      ...negativeTasks,
      TaskNodeSchema.parse({
        taskId: "verify-result",
        title: "验证业务终态和证据完整性",
        objective: "确认测试结果有独立验证和可追溯证据。",
        tool: "mission.verify",
        input: {},
        dependsOn: verificationDependencies,
        dependencyMode: profile.collectAllResults ? "settled" : "passed",
        maxAttempts: 1,
      }),
    ];
    return MissionPlanSchema.parse({
      planId,
      version: "1",
      generatedBy: "deterministic-mission-planner-v1",
      graph: { tasks, terminalTaskIds: ["verify-result"] },
      successCriteria: ["所有任务完成", "业务结果有独立证据", "未发现已确认的高严重度缺陷"],
      planning: planningQuality(input),
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

  private planSuite(input: MissionPlanInput, suite: TestSuite): MissionPlan {
    if (input.policy.level !== suite.level) throw new Error("Mission level must match the test suite");
    if (!suite.surfaces.includes(input.surface as typeof suite.surfaces[number])) throw new Error("The selected surface is not in the test suite");
    const now = new Date().toISOString();
    const checks = suiteChecks(suite);
    const negativeCases = checks.flatMap(({ charter }) => charter.negativeCases ?? []);
    const profile = MissionExecutionProfileSchema.parse({
      surfaceMatrix: suite.surfaces,
      suiteId: suite.suiteId,
      charterIds: suite.charters.map((item) => item.charterId),
      collectAllResults: true,
      negativeCases: suite.level === "quick" ? [] : suite.level === "core" ? ["关键权限或输入边界"] : ["权限边界", "无效输入", "重试与恢复", "重复提交与幂等"],
      declaredNegativeCases: negativeCases.map((item) => item.caseId),
      requireBusinessOracle: suite.level !== "quick",
      requireReplay: suite.level === "release",
      requireNegativeCases: negativeCases.length > 0,
      minimumEvidence: suite.level === "quick" ? 1 : suite.level === "core" ? 2 : 3,
    });
    const primaryTasks = checks.map(({ charterId, charter, surface }) => TaskNodeSchema.parse({
      taskId: `execute-${charterId}-${surface}`,
      charterId,
      title: `${charterId} · ${surface} 主运行`,
      objective: charter.intent,
      tool: "surface.run-charter",
      input: { charterId, adapter: surface },
      dependsOn: ["reconnaissance"],
      maxAttempts: 1,
    }));
    const replayTasks = profile.requireReplay ? checks.map(({ charterId, surface }) => TaskNodeSchema.parse({
      taskId: `replay-${charterId}-${surface}`,
      charterId,
      title: `${charterId} · ${surface} 回放`,
      objective: "重复执行同一业务流程并保存独立证据。",
      tool: "surface.replay-charter",
      input: { charterId, adapter: surface },
      dependsOn: [`execute-${charterId}-${surface}`],
      dependencyMode: "settled",
      maxAttempts: 1,
    })) : [];
    const negativeTasks = checks.flatMap(({ charterId, charter, surface }) => (charter.negativeCases ?? []).map((negativeCase) => TaskNodeSchema.parse({
      taskId: `negative-${charterId}-${surface}-${negativeCase.caseId}`,
      charterId,
      title: `${charterId} · ${surface} 负向场景：${negativeCase.title}`,
      objective: `验证 ${negativeCase.title} 的预期结果。`,
      tool: "surface.run-negative-charter",
      input: { charterId, negativeCase, adapter: surface },
      dependsOn: [`execute-${charterId}-${surface}`],
      dependencyMode: "settled",
      maxAttempts: 1,
    })));
    const tasks: TaskNode[] = [
      TaskNodeSchema.parse({ taskId: "reconnaissance", title: "熟悉项目和运行表面", objective: "确认项目入口和当前可观察表面。", tool: "project.discover", input: {}, maxAttempts: 1 }),
      ...primaryTasks,
      ...replayTasks,
      ...negativeTasks,
      TaskNodeSchema.parse({
        taskId: "verify-result",
        title: "逐流程验证证据与结果",
        objective: "独立校验每个 Charter、表面和运行类型的业务结果。",
        tool: "mission.verify",
        input: {},
        dependsOn: [...(profile.requireReplay ? replayTasks : primaryTasks), ...negativeTasks].map((task) => task.taskId),
        dependencyMode: "settled",
        maxAttempts: 1,
      }),
    ];
    return MissionPlanSchema.parse({
      planId: `plan-${randomUUID().slice(0, 12)}`,
      version: "1",
      generatedBy: suite.origin === "workflow-inventory" ? "deterministic-workflow-planner-v1" : "deterministic-suite-planner-v1",
      graph: { tasks, terminalTaskIds: ["verify-result"] },
      successCriteria: suite.level === "quick"
        ? ["逐流程主运行完成", "每个流程及表面有页面断言和可追溯证据", "明确报告业务终态和全项目覆盖未验证"]
        : ["逐流程主运行和所需回放完成", "每个流程及表面有独立业务事实", "明确报告未通过和未覆盖范围"],
      planning: planningQuality(input, suite.origin === "workflow-inventory" ? "workflow-inventory" : "catalog"),
      level: suite.level,
      executionProfile: profile,
      assumptions: [`suite=${suite.suiteId}`, `environment=${input.policy.environment}`, `surfaces=${suite.surfaces.join(",")}`],
      createdAt: now,
    });
  }
}

export interface MissionStore {
  create(mission: TestMission): Promise<void>;
  save(mission: TestMission): Promise<void>;
  load(missionId: string): Promise<TestMission>;
  acquireExecution(missionId: string, onCancel?: (reason: string) => void): Promise<MissionExecutionLease | undefined>;
  isExecutionActive(missionId: string): Promise<boolean>;
  cancelExecution(missionId: string, reason: string): Promise<boolean>;
}

export class JsonMissionStore implements MissionStore {
  readonly rootDir: string;
  private readonly ownership: MissionOwnership;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.ownership = new MissionOwnership(this.rootDir);
  }

  acquireExecution(missionId: string, onCancel?: (reason: string) => void): Promise<MissionExecutionLease | undefined> {
    return this.ownership.acquire(safeMissionId(missionId), onCancel);
  }

  isExecutionActive(missionId: string): Promise<boolean> {
    return this.ownership.isActive(safeMissionId(missionId));
  }

  cancelExecution(missionId: string, reason: string): Promise<boolean> {
    return this.ownership.cancel(safeMissionId(missionId), reason);
  }

  async create(mission: TestMission): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const missionId = safeMissionId(mission.missionId);
    const target = join(this.rootDir, `${missionId}.json`);
    const temporary = join(this.rootDir, `.${missionId}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(`${JSON.stringify(mission, null, 2)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await link(temporary, target); // Atomic create without overwriting a previously persisted replay slot.
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async save(mission: TestMission): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const missionId = safeMissionId(mission.missionId);
    const target = join(this.rootDir, `${missionId}.json`);
    const temporary = join(this.rootDir, `.${missionId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(mission, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await replaceMissionFile(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async load(missionId: string): Promise<TestMission> {
    const source = await readFile(join(this.rootDir, `${safeMissionId(missionId)}.json`), "utf8");
    return TestMissionSchema.parse(JSON.parse(source));
  }
}

async function replaceMissionFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 49 || !["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5 * (attempt + 1), 50)));
    }
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
  replayOfMissionId?: string;
  repeatSeries?: TestMission["repeatSeries"];
};

export type MissionRunOptions = {
  signal?: AbortSignal;
  approve?: boolean;
};

export class MissionAlreadyRunningError extends Error {
  constructor(missionId: string) {
    super(`Mission ${missionId} is already executing in another runner`);
    this.name = "MissionAlreadyRunningError";
  }
}

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
    if (input.repeatSeries && !input.replayOfMissionId) throw new Error("A repeat-series slot must name its replay source Mission");
    let policy = MissionPolicySchema.parse(input.policy ?? {});
    if (input.charter && input.suite) throw new Error("A mission cannot contain both a Charter and a suite");
    if (input.charter && input.charter.level !== policy.level) {
      throw new Error(`Mission policy level ${policy.level} does not match charter level ${input.charter.level}`);
    }
    if (input.suite && input.suite.level !== policy.level) throw new Error("Mission policy level must match the suite level");
    const plan = await this.planner.plan({ ...input, policy });
    if (input.policy?.maxSteps === undefined && plan.graph.tasks.length > policy.maxSteps) {
      policy = MissionPolicySchema.parse({ ...policy, maxSteps: plan.graph.tasks.length });
    }
    const now = new Date().toISOString();
    const mission = TestMissionSchema.parse({
      missionId: input.repeatSeries ? `mission-${input.repeatSeries.seriesId}-${input.repeatSeries.ordinal}` : `mission-${randomUUID().slice(0, 12)}`,
      replayOfMissionId: input.replayOfMissionId,
      repeatSeries: input.repeatSeries,
      intent: input.intent,
      projectRoot: input.projectRoot,
      workspaceRoot: input.workspaceRoot,
      surface: input.surface,
      level: policy.level,
      levelSelection: input.levelSelection ?? input.charter?.levelSelection,
      policy,
      status: policy.requireApproval ? "awaiting-approval" : "approved",
      charter: input.charter,
      suite: input.suite,
      workflowInventory: input.workflowInventory,
      workflowInventoryInspection: input.workflowInventoryInspection,
      workflowReview: input.workflowReview,
      workflowReviewAdmission: input.workflowReviewAdmission,
      plan,
      createdAt: now,
      updatedAt: now,
    });
    await this.store.create(mission);
    return mission;
  }

  async load(missionId: string): Promise<TestMission> {
    return this.store.load(validateMissionId(missionId));
  }

  async approve(missionId: string): Promise<TestMission> {
    const safeId = validateMissionId(missionId);
    const lease = await this.store.acquireExecution(safeId);
    if (!lease) throw new MissionAlreadyRunningError(safeId);
    try {
      const mission = await this.load(safeId);
      if (mission.status !== "awaiting-approval" && mission.status !== "planned") {
        throw new Error(`Mission cannot be approved from status ${mission.status}`);
      }
      return this.save({ ...mission, status: "approved" });
    } finally {
      await lease.release();
    }
  }

  async run(missionId: string, options: MissionRunOptions = {}): Promise<TestMission> {
    const safeId = validateMissionId(missionId);
    const remoteController = new AbortController();
    const lease = await this.store.acquireExecution(safeId, (reason) => remoteController.abort(new Error(reason)));
    if (!lease) throw new MissionAlreadyRunningError(safeId);
    try {
      return await this.runOwned(safeId, options, remoteController.signal);
    } finally {
      await lease.release();
    }
  }

  async isRunning(missionId: string): Promise<boolean> {
    return this.store.isExecutionActive(validateMissionId(missionId));
  }

  async cancel(missionId: string, reason: string): Promise<boolean> {
    return this.store.cancelExecution(validateMissionId(missionId), reason);
  }

  async waitUntilIdle(missionId: string): Promise<TestMission> {
    const safeId = validateMissionId(missionId);
    while (await this.store.isExecutionActive(safeId)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.load(safeId);
  }

  private async runOwned(missionId: string, options: MissionRunOptions, remoteSignal: AbortSignal): Promise<TestMission> {
    let mission = await this.load(missionId);
    if (mission.status === "awaiting-approval" && options.approve) mission = await this.save({ ...mission, status: "approved" });
    if (mission.status !== "approved" && mission.status !== "paused" && mission.status !== "running") {
      throw new Error(`Mission cannot run from status ${mission.status}`);
    }
    const executionStartedAt = mission.executionStartedAt ?? inferExecutionStart(mission);
    const executionDeadlineAt = mission.executionDeadlineAt
      ?? new Date(Date.parse(executionStartedAt) + mission.policy.timeoutMs).toISOString();
    mission = await this.save({ ...mission, executionStartedAt, executionDeadlineAt });
    const controller = new AbortController();
    const detach = relayAbort(options.signal, controller);
    const detachRemote = relayAbort(remoteSignal, controller);
    const remainingMs = Date.parse(executionDeadlineAt) - Date.now();
    const timeout = remainingMs > 0
      ? setTimeout(() => controller.abort(new MissionTimeoutError(mission.policy.timeoutMs)), remainingMs)
      : undefined;
    if (remainingMs <= 0) controller.abort(new MissionTimeoutError(mission.policy.timeoutMs));
    try {
      const recovery = await this.recoverInterruptedTasks(mission, controller.signal);
      mission = recovery.mission;
      const recoveryTaskIds = recovery.retryTaskIds;
      if (mission.status === "blocked" || mission.status === "cancelled" || mission.status === "failed") return mission;
      throwIfAborted(controller.signal);
      mission = await this.save({ ...mission, status: "running" });
      for (let step = Math.max(mission.agentSteps.length, mission.toolCalls.length); ; step++) {
        throwIfAborted(controller.signal);
        const current = await this.load(mission.missionId);
        const next = nextReadyTask(current);
        if (!next) {
          const blocked = current.plan.graph.tasks.some((task) => task.status === "blocked");
          const failed = current.plan.graph.tasks.some((task) => task.status === "failed");
          const unfinished = current.plan.graph.tasks.filter((task) => task.status !== "passed");
          if (!blocked && !failed && unfinished.length > 0) {
            const message = `No task is ready while these tasks remain unfinished: ${unfinished.map((task) => `${task.taskId} (${task.status})`).join(", ")}`;
            return this.save({
              ...current,
              status: "blocked",
              verdict: "blocked",
              firstFailure: current.firstFailure ?? FailureBoundarySchema.parse({ kind: "evidence", message, evidence: current.evidence.slice(0, 4), observedAt: new Date().toISOString() }),
              findings: [...current.findings, finding("agent-graph-stalled", "high", "test", "Mission task graph stalled", message)],
            });
          }
          const terminal: MissionStatus = blocked ? "blocked" : failed ? "failed" : "completed";
          const verdict = blocked ? "blocked" : failed ? "failed" : current.verdict ?? "passed";
          return this.save({ ...current, status: terminal, verdict });
        }
        if (step >= mission.policy.maxSteps) {
          return this.save({ ...current, status: "blocked", verdict: "blocked", findings: [...current.findings, finding("agent-step-limit", "medium", "test", "Agent step limit reached", "Mission exceeded its configured maxSteps across all execution attempts.")] });
        }
        const phase = recoveryTaskIds.has(next.taskId) ? "recover" : undefined;
        mission = await this.executeTask(current, next, controller.signal, phase);
        recoveryTaskIds.delete(next.taskId);
        if (mission.status === "failed" || mission.status === "blocked" || mission.status === "cancelled") return mission;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = isMissionTimeout(controller.signal.reason);
        const reason = timedOut ? controller.signal.reason.message : "Mission cancelled before execution completed.";
        return this.save({
          ...mission,
          status: "cancelled",
          verdict: "cancelled",
          findings: [...mission.findings, finding(
            timedOut ? "mission-timeout" : "mission-cancelled",
            timedOut ? "medium" : "info",
            "environment",
            timedOut ? "Mission timed out" : "Mission cancelled",
            reason,
          )],
          ...(timedOut && !mission.firstFailure ? { firstFailure: timeoutBoundary(reason) } : {}),
        });
      }
      const current = await this.load(mission.missionId).catch(() => mission);
      return this.save({
        ...current,
        status: "failed",
        verdict: "failed",
        findings: [...current.findings, finding("mission-system-failure", "high", "test", "Mission execution failed", "Mission execution stopped before a complete tool receipt was saved. Inspect trusted local diagnostics.", "suspected")],
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      detach();
      detachRemote();
    }
  }

  /**
   * Recover a mission that was persisted while a task was running.
   *
   * A process crash can happen after the task has been marked `running` but
   * before its tool call has produced a terminal receipt. Replaying a write
   * operation blindly could duplicate user data or trigger an external side
   * effect twice, so only side-effect-free tasks are automatically retried.
   */
  private async recoverInterruptedTasks(mission: TestMission, signal: AbortSignal): Promise<{ mission: TestMission; retryTaskIds: Set<string> }> {
    const runningTasks = mission.plan.graph.tasks.filter((task) => task.status === "running");
    if (runningTasks.length === 0) return { mission, retryTaskIds: new Set() };

    let recovered = mission;
    const retryTaskIds = new Set<string>();
    for (const task of runningTasks) {
      const tool = this.tools.get(task.tool);
      const safe = tool !== undefined && isSafeToRecover(mission, task, tool);
      if (safe && task.attempts < task.maxAttempts && signal.aborted) {
        const timedOut = isMissionTimeout(signal.reason);
        const reason = timedOut
          ? "Mission deadline expired before the interrupted task could be retried."
          : "Mission was cancelled before the interrupted task could be retried.";
        recovered = updateTask(recovered, { ...task, status: "blocked", error: reason },
          { currentTaskId: recovered.currentTaskId === task.taskId ? undefined : recovered.currentTaskId });
        recovered = {
          ...recovered,
          toolCalls: closeStartedCalls(recovered.toolCalls, task.taskId, reason),
          agentSteps: closeInterruptedAgentSteps(recovered.agentSteps, task, reason, "cancelled"),
          status: "cancelled",
          verdict: "cancelled",
          ...(timedOut && !recovered.firstFailure ? { firstFailure: timeoutBoundary(reason) } : {}),
          findings: [...recovered.findings, finding(timedOut ? "mission-timeout" : "mission-cancelled",
            timedOut ? "medium" : "info", "environment", timedOut ? "Mission timed out" : "Mission cancelled", reason)],
        };
        continue;
      }
      if (safe && task.attempts < task.maxAttempts) {
        const reason = `The previous process stopped while task ${task.taskId} was running; a safe retry is being scheduled.`;
        const nextTask = { ...task, status: "pending" as const, error: undefined };
        recovered = updateTask(recovered, nextTask, { currentTaskId: recovered.currentTaskId === task.taskId ? undefined : recovered.currentTaskId });
        recovered = {
          ...recovered,
          toolCalls: closeStartedCalls(recovered.toolCalls, task.taskId, reason),
          agentSteps: closeInterruptedAgentSteps(recovered.agentSteps, task, reason, "cancelled"),
          findings: [...recovered.findings, finding(
            `mission-recovered-${task.taskId}-${task.attempts}`,
            "info",
            "environment",
            `Recovered interrupted task ${task.taskId}`,
            `${reason} ProofKit will retry it (attempt ${task.attempts + 1} of ${task.maxAttempts}).`,
            "confirmed",
          )],
        };
        retryTaskIds.add(task.taskId);
        continue;
      }

      const reason = tool === undefined
        ? `Mission tool ${task.tool} is no longer registered; the interrupted task cannot be resumed safely.`
        : task.attempts >= task.maxAttempts
          ? `Task ${task.taskId} already used all ${task.maxAttempts} allowed attempts before the process stopped.`
          : `Task ${task.taskId} may have produced a side effect or lacks an unchanged tool recovery key and safe invocation receipt; automatic recovery is disabled and requires review.`;
      const blockedTask = { ...task, status: "blocked" as const, error: reason };
      recovered = updateTask(recovered, blockedTask, { currentTaskId: recovered.currentTaskId === task.taskId ? undefined : recovered.currentTaskId });
      recovered = {
        ...recovered,
        toolCalls: closeStartedCalls(recovered.toolCalls, task.taskId, reason),
        agentSteps: closeInterruptedAgentSteps(recovered.agentSteps, task, reason, "blocked"),
        status: "blocked",
        verdict: "blocked",
        findings: [...recovered.findings, finding(
          `mission-recovery-blocked-${task.taskId}`,
          "high",
          "environment",
          `Interrupted task requires review: ${task.taskId}`,
          reason,
          "confirmed",
        )],
      };
    }
    return { mission: await this.save(recovered), retryTaskIds };
  }

  private async executeTask(mission: TestMission, task: TaskNode, signal: AbortSignal, phase?: AgentStep["phase"]): Promise<TestMission> {
    const tool = this.tools.get(task.tool);
    const startedAt = new Date().toISOString();
    const toolCallId = `tool-${randomUUID().slice(0, 12)}`;
    const agentStepId = `agent-step-${randomUUID().slice(0, 12)}`;
    const runningTask = { ...task, status: "running" as const, attempts: task.attempts + 1 };
    const startedCall = ToolCallSchema.parse({
      toolCallId,
      taskId: task.taskId,
      charterId: task.charterId,
      tool: tool?.name ?? task.tool,
      sideEffect: tool?.sideEffect,
      recoveryKey: tool?.recoveryKey,
      attempt: runningTask.attempts,
      input: task.input,
      status: "started",
      startedAt,
    });
    const startedStep = AgentStepSchema.parse({
      agentStepId,
      sequence: mission.agentSteps.length + 1,
      taskId: task.taskId,
      charterId: task.charterId,
      phase: phase ?? agentStepPhase(task),
      tool: tool?.name ?? task.tool,
      decision: `选择依赖已满足的任务 ${task.taskId} 并调用已注册工具。`,
      input: task.input,
      status: "running",
      startedAt,
      toolCallIds: [toolCallId],
    });
    const startedMission = await this.save({
      ...updateTask(mission, runningTask, { currentTaskId: task.taskId }),
      agentSteps: [...mission.agentSteps, startedStep],
      toolCalls: [...mission.toolCalls, startedCall],
    });
    if (!tool) {
      return this.save(failTask(startedMission, task.taskId, toolCallId, agentStepId, startedAt, `Mission tool is not registered: ${task.tool}`, "blocked"));
    }
    if (!tool.environments.includes(mission.policy.environment)) {
      return this.save(failTask(startedMission, task.taskId, toolCallId, agentStepId, startedAt, `Mission tool ${tool.name} is not allowed in ${mission.policy.environment}`, "blocked"));
    }
    if (tool.sideEffect === "write" && mission.policy.sideEffectPolicy !== "allow") {
      return this.save(failTask(startedMission, task.taskId, toolCallId, agentStepId, startedAt, `Mission tool ${tool.name} requires sideEffectPolicy=allow`, "blocked"));
    }
    const toolController = new AbortController();
    const detach = relayAbort(signal, toolController);
    const timeout = setTimeout(() => toolController.abort(new MissionToolTimeoutError(tool.name)), tool.timeoutMs);
    let cancelledResult: MissionToolResult | undefined;
    try {
      const input = tool.inputSchema.parse(task.input);
      // Cancellation can arrive while the started receipt is being saved or
      // while a trusted schema validates input. Do not invoke the tool then.
      throwIfAborted(toolController.signal);
      const result = await raceAbort(tool.execute(input, { mission: startedMission, task: runningTask, signal: toolController.signal }), toolController.signal, tool.cancellationGraceMs);
      if (toolController.signal.aborted) {
        cancelledResult = result;
        throwIfAborted(toolController.signal);
      }
      const output = tool.outputSchema ? tool.outputSchema.parse(result.output) : result.output;
      const finishedAt = new Date().toISOString();
      const call = ToolCallSchema.parse({ toolCallId, taskId: task.taskId, charterId: task.charterId, tool: tool.name, sideEffect: tool.sideEffect, recoveryKey: tool.recoveryKey, attempt: runningTask.attempts, input: task.input, status: "succeeded", startedAt, endedAt: finishedAt, durationMs: Date.now() - Date.parse(startedAt), evidence: result.evidence ?? [] });
      const failedVerdict = result.verdict === "failed" || result.verdict === "blocked" || result.verdict === "cancelled";
      const stepStatus = result.verdict === "blocked"
        ? "blocked"
        : result.verdict === "cancelled"
          ? "cancelled"
          : result.verdict === "failed"
            ? "failed"
            : "succeeded";
      const taskStatus = result.verdict === "blocked" || result.verdict === "cancelled"
        ? "blocked"
        : result.verdict === "failed"
          ? "failed"
          : "passed";
      const agentStep = completeAgentStep(startedMission.agentSteps, agentStepId, {
        status: stepStatus,
        endedAt: finishedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        output,
        observationIds: (result.observations ?? []).map((item) => item.observationId),
        evidence: result.evidence ?? [],
        ...(failedVerdict ? { error: `Tool returned verdict ${result.verdict}` } : {}),
      });
      const taskUpdate = updateTask(startedMission, { ...runningTask, status: taskStatus, output, ...(failedVerdict ? { error: `Tool returned verdict ${result.verdict}` } : {}) }, { currentTaskId: undefined });
      return this.save({
        ...taskUpdate,
        agentSteps: replaceAgentStep(startedMission.agentSteps, agentStep),
        toolCalls: replaceToolCall(startedMission.toolCalls, call),
        observations: [...startedMission.observations, ...(result.observations ?? []).map((item) => ObservationSchema.parse(item))],
        evidence: [...startedMission.evidence, ...(result.evidence ?? [])],
        findings: [...startedMission.findings, ...(result.findings ?? []).map((item) => FindingSchema.parse(item))],
        ...(!startedMission.firstFailure && result.firstFailure ? { firstFailure: FailureBoundarySchema.parse(result.firstFailure) } : {}),
        ...(result.diagnosis ? { diagnosis: DiagnosisSchema.parse(result.diagnosis) } : {}),
        repairSuggestions: [...startedMission.repairSuggestions, ...(result.repairSuggestions ?? []).map((item) => RepairSuggestionSchema.parse(item))],
        verdict: startedMission.verdict === "failed" && result.verdict === "passed" ? "failed" : result.verdict,
        ...(failedVerdict ? { status: taskStatus === "blocked" ? result.verdict === "cancelled" ? "cancelled" : "blocked" : startedMission.plan.executionProfile.collectAllResults ? "running" : "failed" } : {}),
      });
    } catch (error) {
      const cause = toError(error);
      const cancelled = toolController.signal.aborted && signal.aborted;
      const toolTimedOut = !cancelled && isMissionToolTimeout(toolController.signal.reason);
      const status = cancelled ? "cancelled" : toolTimedOut ? "blocked" : "failed";
      const missionTimedOut = cancelled && isMissionTimeout(signal.reason);
      const cleanupUnsettled = cause instanceof ToolCleanupTimeoutError;
      const safeError = missionTimedOut ? signal.reason.message
        : cancelled ? `Mission tool ${tool.name} was cancelled before completion.`
          : toolTimedOut ? `Mission tool ${tool.name} timed out.`
            : `Mission tool ${tool.name} failed without a verified result; inspect trusted local diagnostics.`;
      const detail = cleanupUnsettled ? `${safeError} Tool cleanup did not finish; resources may still be active.` : safeError;
      const call = ToolCallSchema.parse({ toolCallId, taskId: task.taskId, charterId: task.charterId, tool: tool.name, sideEffect: tool.sideEffect, recoveryKey: tool.recoveryKey, attempt: runningTask.attempts, input: task.input, status, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), error: detail, evidence: cancelledResult?.evidence ?? [] });
      const agentStep = completeAgentStep(startedMission.agentSteps, agentStepId, {
        status,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        error: detail,
        output: cancelledResult?.output,
        observationIds: (cancelledResult?.observations ?? []).map((item) => item.observationId),
        evidence: cancelledResult?.evidence ?? [],
      });
      const failedTask = updateTask(startedMission, { ...runningTask, status: status === "failed" ? "failed" : "blocked", error: detail }, { currentTaskId: undefined });
      return this.save({
        ...failedTask,
        agentSteps: replaceAgentStep(startedMission.agentSteps, agentStep),
        toolCalls: replaceToolCall(startedMission.toolCalls, call),
        observations: [...startedMission.observations, ...(cancelledResult?.observations ?? []).map((item) => ObservationSchema.parse(item))],
        evidence: [...startedMission.evidence, ...(cancelledResult?.evidence ?? [])],
        findings: [...startedMission.findings, finding(
          missionTimedOut ? "mission-timeout" : toolTimedOut ? `tool-timeout-${task.taskId}` : `task-${task.taskId}`,
          missionTimedOut ? "medium" : toolTimedOut ? "high" : status === "cancelled" ? "info" : "medium",
          status === "cancelled" || toolTimedOut ? "environment" : "test",
          missionTimedOut ? "Mission timed out" : toolTimedOut ? `Mission tool timed out: ${tool.name}` : `Task ${task.taskId} did not complete`,
          detail,
          status === "cancelled" || toolTimedOut ? "confirmed" : "suspected",
        ), ...(cancelledResult?.findings ?? []).map((item) => FindingSchema.parse(item)), ...(cleanupUnsettled ? [finding(
          `cleanup-${task.taskId}`, "high", "environment", "Tool cleanup did not finish", detail,
        )] : [])],
        ...((status !== "cancelled" || missionTimedOut) && !startedMission.firstFailure ? { firstFailure: FailureBoundarySchema.parse({
          kind: "environment", stepId: task.taskId, message: detail, evidence: [], observedAt: new Date().toISOString(),
        }) } : {}),
        status,
        verdict: status === "cancelled" ? "cancelled" : toolTimedOut ? "blocked" : "failed",
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
  const settled = new Set(mission.plan.graph.tasks.filter((task) => task.status === "passed" || task.status === "failed" || task.status === "blocked" || task.status === "skipped").map((task) => task.taskId));
  return mission.plan.graph.tasks.find((task) => (task.status === "pending" || task.status === "ready") && task.dependsOn.every((dependency) => task.dependencyMode === "settled" ? settled.has(dependency) : completed.has(dependency)));
}

function agentStepPhase(task: TaskNode): AgentStep["phase"] {
  return task.tool === "mission.verify" ? "verify" : "execute";
}

function updateTask(mission: TestMission, task: TaskNode, options: { currentTaskId?: string }): TestMission {
  return { ...mission, currentTaskId: options.currentTaskId, plan: { ...mission.plan, graph: { ...mission.plan.graph, tasks: mission.plan.graph.tasks.map((candidate) => candidate.taskId === task.taskId ? TaskNodeSchema.parse(task) : candidate) } } };
}

function failTask(mission: TestMission, taskId: string, toolCallId: string, agentStepId: string, startedAt: string, error: string, status: "blocked" | "failed"): TestMission {
  const task = mission.plan.graph.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const nextTask = { ...task, status, error } as TaskNode;
  const startedCall = mission.toolCalls.find((candidate) => candidate.toolCallId === toolCallId);
  const call = ToolCallSchema.parse({ toolCallId, taskId, charterId: task.charterId, tool: task.tool, sideEffect: startedCall?.sideEffect,
    recoveryKey: startedCall?.recoveryKey, attempt: task.attempts, input: task.input, status, startedAt,
    endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), error });
  const agentStep = completeAgentStep(mission.agentSteps, agentStepId, { status, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), error });
  return { ...updateTask(mission, nextTask, { currentTaskId: undefined }), status: status === "blocked" ? "blocked" : "failed", verdict: status === "blocked" ? "blocked" : "failed", agentSteps: replaceAgentStep(mission.agentSteps, agentStep), toolCalls: replaceToolCall(mission.toolCalls, call), findings: [...mission.findings, finding(`task-${taskId}`, status === "blocked" ? "high" : "medium", status === "blocked" ? "environment" : "product", `Task ${taskId} did not complete`, error)] };
}

function replaceToolCall(calls: ToolCall[], next: ToolCall): ToolCall[] {
  const index = calls.findIndex((call) => call.toolCallId === next.toolCallId);
  if (index < 0) return [...calls, next];
  return calls.map((call, current) => current === index ? next : call);
}

function closeStartedCalls(calls: ToolCall[], taskId: string, reason: string): ToolCall[] {
  const endedAt = new Date().toISOString();
  return calls.map((call) => {
    if (call.taskId !== taskId || call.status !== "started") return call;
    return ToolCallSchema.parse({
      ...call,
      status: "cancelled",
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(call.startedAt)),
      error: reason,
    });
  });
}

function replaceAgentStep(steps: AgentStep[], next: AgentStep): AgentStep[] {
  const index = steps.findIndex((step) => step.agentStepId === next.agentStepId);
  if (index < 0) return [...steps, next];
  return steps.map((step, current) => current === index ? next : step);
}

function completeAgentStep(steps: AgentStep[], agentStepId: string, update: Partial<AgentStep>): AgentStep {
  const current = steps.find((step) => step.agentStepId === agentStepId);
  if (!current) throw new Error(`Agent step not found: ${agentStepId}`);
  return AgentStepSchema.parse({ ...current, ...update });
}

function closeInterruptedAgentSteps(steps: AgentStep[], task: TaskNode, reason: string, status: "cancelled" | "blocked"): AgentStep[] {
  const endedAt = new Date().toISOString();
  const matching = steps.some((step) => step.taskId === task.taskId && step.status === "running");
  const closed = steps.map((step) => step.taskId !== task.taskId || step.status !== "running"
    ? step
    : AgentStepSchema.parse({ ...step, status, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(step.startedAt)), error: reason }));
  if (matching) return closed;
  return [...closed, AgentStepSchema.parse({
    agentStepId: `agent-step-recovered-${task.taskId}-${task.attempts}`,
    sequence: closed.length + 1,
    taskId: task.taskId,
    charterId: task.charterId,
    phase: "recover",
    tool: task.tool,
    decision: `恢复任务 ${task.taskId} 时发现旧状态没有代理步骤记录，补写中断审计记录。`,
    input: task.input,
    status,
    startedAt: endedAt,
    endedAt,
    durationMs: 0,
    error: reason,
  })];
}

function isSafeToRecover(mission: TestMission, task: TaskNode, tool: MissionTool): boolean {
  const receipts = mission.toolCalls.filter((call) => call.taskId === task.taskId && call.attempt === task.attempts && call.status === "started");
  if (receipts.length !== 1 || tool.sideEffect === "write") return false;
  const receipt = receipts[0]!;
  // A changed registration, missing legacy declaration or changed task input
  // cannot establish that replaying the interrupted attempt is side-effect-free.
  if (!tool.recoveryKey || receipt.recoveryKey !== tool.recoveryKey
    || receipt.sideEffect !== tool.sideEffect || receipt.tool !== task.tool
    || receipt.charterId !== task.charterId || !isDeepStrictEqual(receipt.input, task.input)) return false;
  const charterId = task.charterId ?? (typeof task.input.charterId === "string" ? task.input.charterId : undefined);
  const charter = mission.suite
    ? mission.suite.charters.find((item) => item.charterId === charterId)?.charter
    : mission.charter;
  if ((task.tool === "surface.run-charter" || task.tool === "surface.replay-charter") && charter?.sideEffectPolicy !== "deny") return false;
  if (task.tool === "surface.run-negative-charter") {
    const input = task.input as { negativeCase?: { caseId?: unknown; sideEffectPolicy?: unknown } };
    const caseId = typeof input.negativeCase?.caseId === "string" ? input.negativeCase.caseId : undefined;
    const declared = charter?.negativeCases?.find((negativeCase) => negativeCase.caseId === caseId);
    // A negative case can contain a capability or a UI operation with a
    // product side effect. Only an explicitly deny-policy case is eligible
    // for automatic replay after a process interruption.
    if (!declared || declared.sideEffectPolicy !== "deny" || input.negativeCase?.sideEffectPolicy !== "deny") return false;
  }
  return true;
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

class MissionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Mission exceeded its total timeout of ${timeoutMs}ms`);
    this.name = "MissionTimeoutError";
  }
}

class MissionToolTimeoutError extends Error {
  constructor(toolName: string) {
    super(`Mission tool ${toolName} timed out`);
    this.name = "MissionToolTimeoutError";
  }
}

function isMissionToolTimeout(reason: unknown): reason is MissionToolTimeoutError {
  return reason instanceof MissionToolTimeoutError;
}

function isMissionTimeout(reason: unknown): reason is MissionTimeoutError {
  return reason instanceof MissionTimeoutError || (reason instanceof Error && reason.name === "MissionTimeoutError");
}

function timeoutBoundary(message: string): FailureBoundary {
  return FailureBoundarySchema.parse({
    kind: "environment",
    message,
    evidence: [],
    observedAt: new Date().toISOString(),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Mission cancelled");
}

function inferExecutionStart(mission: TestMission): string {
  if (mission.status === "approved" && mission.agentSteps.length === 0 && mission.toolCalls.length === 0) {
    return new Date().toISOString();
  }
  // Legacy running Missions did not persist a deadline. Their earliest attempt
  // bounds recovery; an approval wait must not be used as execution time.
  const attempts = [...mission.agentSteps.map((step) => step.startedAt), ...mission.toolCalls.map((call) => call.startedAt)]
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  const start = attempts.length > 0 ? Math.min(...attempts) : Date.parse(mission.updatedAt);
  return new Date(Number.isFinite(start) ? start : 0).toISOString();
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const onAbort = () => target.abort(source.reason);
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

class ToolCleanupTimeoutError extends Error {
  constructor(graceMs: number) {
    super(`Aborted tool did not settle within its ${graceMs}ms cleanup grace period; resources may still be active.`);
    this.name = "ToolCleanupTimeoutError";
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, graceMs?: number): Promise<T> {
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      promise.then(resolve, reject);
      onAbort = () => {
        if (graceMs !== undefined) timer = setTimeout(() => reject(new ToolCleanupTimeoutError(graceMs)), graceMs);
        else reject(signal.reason instanceof Error ? signal.reason : new Error("Mission tool cancelled"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
