import { z } from "zod";

export const VerdictSchema = z.enum(["passed", "failed", "blocked", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RunModeSchema = z.enum(["deterministic", "guided", "explore"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const SideEffectPolicySchema = z.enum(["deny", "confirm", "allow"]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), url: z.string().url() }),
  z.object({ kind: z.literal("click"), selector: z.string().min(1) }),
  z.object({ kind: z.literal("fill"), selector: z.string().min(1), value: z.string() }),
  z.object({ kind: z.literal("press"), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ kind: z.literal("waitForText"), text: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("screenshot"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("observe") }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("url-matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("title-contains"), text: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export const TestCharterSchema = z.object({
  intent: z.string().min(1),
  mode: RunModeSchema.default("guided"),
  preconditions: z.array(z.string()).default([]),
  actions: z.array(ActionSchema).default([]),
  assertions: z.array(AssertionSchema).default([]),
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
  passed: z.boolean(),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
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
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const RunSummarySchema = z.object({
  runId: z.string(),
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
    web: z.object({ baseUrl: z.string().url().optional() }).optional(),
    electron: z.object({
      cdpUrl: z.string().optional(),
      devtoolsActivePort: z.string().optional(),
    }).optional(),
  }).default({}),
  policies: z.object({
    environment: z.enum(["test", "staging", "local"]).default("test"),
    sideEffects: SideEffectPolicySchema.default("confirm"),
    saveSensitivePayloads: z.boolean().default(false),
  }).default({}),
});
export type ProofkitConfig = z.infer<typeof ProofkitConfigSchema>;
