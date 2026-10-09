import { z } from "zod";

export const VerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RunModeSchema = z.enum(["deterministic", "guided", "explore"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const SideEffectPolicySchema = z.enum(["deny", "confirm", "allow"]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

/** Controls the breadth and evidence gate of an AI-directed test mission. */
export const TestLevelSchema = z.enum(["quick", "core", "release"]);
export type TestLevel = z.infer<typeof TestLevelSchema>;

export const TestLevelSelectionSchema = z.object({
  requested: TestLevelSchema.optional(),
  resolved: TestLevelSchema,
  source: z.enum(["explicit", "inferred", "default"]),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type TestLevelSelection = z.infer<typeof TestLevelSelectionSchema>;

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), url: z.string().url() }),
  z.object({ kind: z.literal("click"), selector: z.string().min(1) }),
  z.object({ kind: z.literal("fill"), selector: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal("press"), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ kind: z.literal("waitForText"), text: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("screenshot"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("capability"), name: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ kind: z.literal("observe") }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("url-matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("title-contains"), text: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * A declared negative or recovery scenario. The scenario is intentionally
 * explicit: ProofKit never invents destructive actions from a category label.
 * Its assertions/oracles describe the expected safe rejection or recovery.
 */
export const NegativeCaseSchema = z.object({
  caseId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().min(1),
  actions: z.array(ActionSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
  oracles: z.array(z.string().min(1)).default([]),
  /** The run outcome that this negative/recovery scenario expects. */
  expectedVerdict: VerdictSchema.optional(),
  sideEffectPolicy: SideEffectPolicySchema.default("deny"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type NegativeCase = z.infer<typeof NegativeCaseSchema>;

export const TestCharterSchema = z.object({
  intent: z.string().min(1),
  level: TestLevelSchema.default("core"),
  levelSelection: TestLevelSelectionSchema.optional(),
  mode: RunModeSchema.default("guided"),
  preconditions: z.array(z.string()).default([]),
  actions: z.array(ActionSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
  oracles: z.array(z.string().min(1)).optional(),
  // Optional for backward compatibility with existing charters. The planner
  // normalizes an omitted value to an empty list before creating tasks.
  negativeCases: z.array(NegativeCaseSchema).optional(),
  sideEffectPolicy: SideEffectPolicySchema.default("confirm"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type TestCharter = z.infer<typeof TestCharterSchema>;

export const SurfaceSnapshotSchema = z.object({
  capturedAt: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;

export const ActionReceiptSchema = z.object({
  actionId: z.string(),
  kind: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().nonnegative(),
  urlBefore: z.string().optional(),
  urlAfter: z.string().optional(),
  titleAfter: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

export const AssertionResultSchema = z.object({
  assertion: AssertionSchema,
  passed: z.boolean(),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const OracleResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean().nullable(),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
  /** Optional repository hints supplied by a trusted project integration. */
  sourceLocations: z.array(z.string().min(1)).optional(),
  observedAt: z.string().optional(),
});
export type OracleResult = z.infer<typeof OracleResultSchema>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  action: ActionSchema,
  status: z.enum(["passed", "failed", "blocked"]),
  receipt: ActionReceiptSchema.optional(),
  beforeSnapshot: SurfaceSnapshotSchema.optional(),
  afterSnapshot: SurfaceSnapshotSchema.optional(),
  artifacts: z.array(z.string()).default([]),
  capabilityOutput: z.unknown().optional(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const RunSummarySchema = z.object({
  runId: z.string(),
  projectRoot: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: z.enum(["running", "completed"]),
  verdict: VerdictSchema.optional(),
  charter: TestCharterSchema,
  steps: z.array(StepResultSchema).default([]),
  assertions: z.array(AssertionResultSchema).default([]),
  oracles: z.array(OracleResultSchema).default([]),
  artifacts: z.array(z.string()).default([]),
  findings: z.array(z.string()).default([]),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export type RunEvent = {
  runId: string;
  timestamp: string;
  type:
    | "run.started"
    | "run.completed"
    | "step.started"
    | "step.completed"
    | "assertion.completed"
    | "oracle.completed"
    | "adapter.event"
    | "artifact.created"
    | "finding.created";
  stepId?: string;
  payload: Record<string, unknown>;
};

export const ProjectMapSchema = z.object({
  root: z.string(),
  packageManager: z.string().optional(),
  packageName: z.string().optional(),
  scripts: z.record(z.string(), z.string()).default({}),
  workspaces: z.array(z.string()).default([]),
  packages: z.array(z.object({
    path: z.string(),
    name: z.string().optional(),
    scripts: z.record(z.string(), z.string()).default({}),
  })).default([]),
  detected: z.object({
    electron: z.boolean(),
    web: z.boolean(),
    backend: z.boolean(),
  }),
  /** Bounded path-level signals used to plan tests without changing the source project. */
  inventory: z.object({
    filesScanned: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    source: z.enum(["git", "filesystem"]).default("filesystem"),
    sourceFiles: z.number().int().nonnegative().default(0),
    testFiles: z.number().int().nonnegative().default(0),
    configFiles: z.number().int().nonnegative().default(0),
    testFrameworks: z.array(z.string().min(1)).default([]),
    entryPoints: z.array(z.object({
      kind: z.enum(["web", "electron", "backend", "test", "script"]),
      path: z.string().min(1),
      reason: z.string().min(1),
    })).default([]),
    routeHints: z.array(z.object({
      kind: z.enum(["web", "api"]),
      path: z.string().min(1),
      source: z.string().min(1),
      line: z.number().int().positive(),
    })).default([]),
  }).default({}),
  generatedAt: z.string(),
});
export type ProjectMap = z.infer<typeof ProjectMapSchema>;

export const ProofkitConfigSchema = z.object({
  project: z.object({
    root: z.string().default("."),
    start: z.string().optional(),
    cwd: z.string().optional(),
    stop: z.string().optional(),
    health: z.array(z.union([
      z.string(),
      z.object({ url: z.string().url(), expectedStatus: z.number().int().min(100).max(599).default(200) }),
    ])).default([]),
    startupTimeoutMs: z.number().int().positive().default(60_000),
  }).default({}),
  surfaces: z.object({
    web: z.object({
      baseUrl: z.string().url().optional(),
      cdpUrl: z.string().url().optional(),
      executablePath: z.string().min(1).optional(),
    }).optional(),
    electron: z.object({
      cdpUrl: z.string().optional(),
      devtoolsActivePort: z.string().optional(),
    }).optional(),
    mobile: z.object({
      serverUrl: z.string().url().default("http://127.0.0.1:4723"),
      platformName: z.string().min(1).optional(),
      deviceName: z.string().min(1).optional(),
      automationName: z.string().min(1).optional(),
      app: z.string().min(1).optional(),
      appPackage: z.string().min(1).optional(),
      appActivity: z.string().min(1).optional(),
      noReset: z.boolean().optional(),
      capabilities: z.record(z.string(), z.unknown()).default({}),
    }).optional(),
  }).default({}),
  planning: z.object({
    provider: z.enum(["deterministic", "openai-compatible"]).default("deterministic"),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  }).default({}),
  integration: z.object({
    path: z.string().min(1).optional(),
  }).default({}),
  run: z.object({
    timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  }).default({}),
  oracles: z.array(z.object({
    name: z.string().min(1),
    url: z.string().url(),
    query: z.record(z.discriminatedUnion("source", [
      z.object({ source: z.literal("runId") }),
      z.object({ source: z.literal("step"), stepId: z.string().regex(/^step-\d{3}$/), field: z.string().min(1) }),
    ])).default({}),
    statusPointer: z.string().startsWith("/"),
    successValues: z.array(z.string().min(1)).min(1),
    failureValues: z.array(z.string().min(1)).default([]),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    intervalMs: z.number().int().positive().default(500),
    deadlineMs: z.number().int().positive().default(30_000),
  })).default([]),
  policies: z.object({
    environment: z.enum(["test", "staging", "local"]).default("test"),
    sideEffects: SideEffectPolicySchema.default("confirm"),
    saveSensitivePayloads: z.boolean().default(false),
  }).default({}),
});
export type ProofkitConfig = z.infer<typeof ProofkitConfigSchema>;

// Mission contracts are deliberately independent from the surface adapter.
// The same task graph can drive Web, Electron, mobile or API tools.
export const MissionSurfaceSchema = z.enum(["web", "electron", "mobile", "api"]);
export type MissionSurface = z.infer<typeof MissionSurfaceSchema>;

/** The execution obligations selected by the test level. */
export const MissionExecutionProfileSchema = z.object({
  surfaceMatrix: z.array(MissionSurfaceSchema).min(1).default(["web"]),
  negativeCases: z.array(z.string().min(1)).default([]),
  declaredNegativeCases: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).default([]),
  requireBusinessOracle: z.boolean().default(false),
  requireReplay: z.boolean().default(false),
  requireNegativeCases: z.boolean().default(false),
  minimumEvidence: z.number().int().positive().default(1),
});
export type MissionExecutionProfile = z.infer<typeof MissionExecutionProfileSchema>;

export const MissionStatusSchema = z.enum([
  "draft",
  "planned",
  "awaiting-approval",
  "approved",
  "running",
  "paused",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionTaskStatusSchema = z.enum(["pending", "ready", "running", "passed", "failed", "blocked", "skipped"]);
export type MissionTaskStatus = z.infer<typeof MissionTaskStatusSchema>;

export const MissionPolicySchema = z.object({
  level: TestLevelSchema.default("core"),
  environment: z.enum(["test", "staging", "local"]).default("test"),
  sideEffectPolicy: SideEffectPolicySchema.default("confirm"),
  requireApproval: z.boolean().default(true),
  requireEvidence: z.boolean().default(true),
  maxSteps: z.number().int().positive().max(10_000).default(100),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
});
export type MissionPolicy = z.infer<typeof MissionPolicySchema>;

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  kind: z.enum(["screenshot", "snapshot", "network", "console", "process", "api", "business", "log", "report", "other"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  description: z.string().min(1).optional(),
  capturedAt: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  source: z.enum(["surface", "network", "console", "process", "api", "business", "evidence", "planner"]),
  kind: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(EvidenceRefSchema).default([]),
  observedAt: z.string(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const ToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  taskId: z.string().min(1),
  tool: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  input: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["started", "succeeded", "failed", "blocked", "cancelled"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * A durable control-loop step. AgentStep records the agent's decision and
 * lifecycle around a task; ToolCall records the concrete registered tool
 * invocation that implements that decision.
 */
export const AgentStepSchema = z.object({
  agentStepId: z.string().min(1),
  sequence: z.number().int().positive(),
  taskId: z.string().min(1),
  phase: z.enum(["execute", "recover", "verify"]).default("execute"),
  tool: z.string().min(1),
  decision: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["running", "succeeded", "failed", "blocked", "cancelled"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  toolCallIds: z.array(z.string().min(1)).default([]),
  observationIds: z.array(z.string().min(1)).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const FindingSchema = z.object({
  findingId: z.string().min(1),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  category: z.enum(["product", "test", "environment", "security", "performance", "unknown"]),
  status: z.enum(["confirmed", "suspected", "unverified"]),
  title: z.string().min(1),
  message: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).default([]),
  createdAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DiagnosisSchema = z.object({
  diagnosisId: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  likelyOwner: z.string().min(1).optional(),
  sourceLocations: z.array(z.string()).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  createdAt: z.string(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const RepairSuggestionSchema = z.object({
  suggestionId: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  changes: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema).default([]),
  status: z.enum(["proposed", "accepted", "rejected", "verified"]).default("proposed"),
});
export type RepairSuggestion = z.infer<typeof RepairSuggestionSchema>;

// The first failure is the earliest observable boundary that explains why a
// mission could not satisfy its success criteria. It is intentionally kept
// separate from Finding so a test failure cannot be mistaken for a product
// defect without an independent oracle or assertion evidence.
export const FailureBoundarySchema = z.object({
  kind: z.enum(["surface-action", "assertion", "business-oracle", "environment", "evidence"]),
  message: z.string().min(1),
  stepId: z.string().optional(),
  oracleName: z.string().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  observedAt: z.string(),
});
export type FailureBoundary = z.infer<typeof FailureBoundarySchema>;

export const TaskNodeSchema = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().min(1),
  objective: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  status: MissionTaskStatusSchema.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().max(10).default(1),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskNodeSchema).min(1),
  terminalTaskIds: z.array(z.string()).default([]),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const MissionPlanSchema = z.object({
  planId: z.string().min(1),
  version: z.string().min(1),
  generatedBy: z.string().min(1),
  graph: TaskGraphSchema,
  successCriteria: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  level: TestLevelSchema.default("core"),
  executionProfile: MissionExecutionProfileSchema.default({
    surfaceMatrix: ["web"],
    negativeCases: [],
    declaredNegativeCases: [],
    requireBusinessOracle: false,
    requireReplay: false,
    requireNegativeCases: false,
    minimumEvidence: 1,
  }),
  createdAt: z.string(),
});
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

export const TestMissionSchema = z.object({
  missionId: z.string().min(1),
  intent: z.string().min(1),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  surface: MissionSurfaceSchema,
  level: TestLevelSchema.default("core"),
  levelSelection: TestLevelSelectionSchema.optional(),
  policy: MissionPolicySchema,
  status: MissionStatusSchema,
  verdict: VerdictSchema.optional(),
  charter: TestCharterSchema.optional(),
  plan: MissionPlanSchema,
  agentSteps: z.array(AgentStepSchema).default([]),
  toolCalls: z.array(ToolCallSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  firstFailure: FailureBoundarySchema.optional(),
  diagnosis: DiagnosisSchema.optional(),
  repairSuggestions: z.array(RepairSuggestionSchema).default([]),
  currentTaskId: z.string().optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestMission = z.infer<typeof TestMissionSchema>;
