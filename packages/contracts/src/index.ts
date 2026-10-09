import { z } from "zod";

export const VerdictSchema = z.enum(["passed", "failed", "blocked", "cancelled", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RunModeSchema = z.enum(["deterministic", "guided", "explore"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const SideEffectPolicySchema = z.enum(["deny", "confirm", "allow"]);
export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;

/** Persist an environment variable name, never its runtime value, for credential fields. */
export const FillValueSchema = z.union([
  z.string(),
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
]);

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
  z.object({ kind: z.literal("fill"), selector: z.string().min(1), value: FillValueSchema }),
  z.object({ kind: z.literal("press"), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ kind: z.literal("waitForText"), text: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("screenshot"), name: z.string().min(1).optional() }),
  z.object({ kind: z.literal("capability"), name: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ kind: z.literal("observe") }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("text-not-visible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("url-matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("title-contains"), text: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

/** An absence check alone cannot establish that the intended page or flow loaded. */
export function hasPositiveSurfaceAssertion(assertions: readonly Assertion[]): boolean {
  return assertions.some((assertion) => assertion.kind !== "text-not-visible");
}

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

/**
 * Structured planning metadata. These fields describe what the planner knows
 * and what it still needs; they are deliberately separate from execution
 * evidence so a confident-sounding model response cannot masquerade as proof.
 */
export const TestCoverageSchema = z.enum(["declared", "project"]);
export type TestCoverage = z.infer<typeof TestCoverageSchema>;
/** Static discovery is not evidence of complete business workflow coverage. */
export const PlanningCoverageSchema = z.object({
  requested: TestCoverageSchema,
  source: z.enum(["explicit", "inferred", "default"]),
  reason: z.string().min(1),
  inventory: z.enum(["not-scanned", "bounded", "partial"]),
  workflowCoverage: z.literal("unmeasured"),
  gaps: z.array(z.string().min(1)).default([]),
});
export type PlanningCoverage = z.infer<typeof PlanningCoverageSchema>;

export const PlanningQualitySchema = z.object({
  source: z.enum(["catalog", "deterministic", "model", "submitted"]).default("deterministic"),
  confidence: z.number().min(0).max(1).default(0),
  assumptions: z.array(z.string().min(1)).default([]),
  missingInputs: z.array(z.string().min(1)).default([]),
  evidenceGaps: z.array(z.string().min(1)).default([]),
  coverage: PlanningCoverageSchema.optional(),
});
export type PlanningQuality = z.infer<typeof PlanningQualitySchema>;
export function normalizePlanningQuality(value?: PlanningQuality): PlanningQuality {
  return PlanningQualitySchema.parse(value ?? {});
}

export const TestCharterSchema = z.object({
  intent: z.string().min(1),
  level: TestLevelSchema.default("core"),
  levelSelection: TestLevelSelectionSchema.optional(),
  planning: PlanningQualitySchema.optional(),
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
/** Existing workspace Charters may omit planning metadata. New plans populate it explicitly. */
export type TestCharter = z.infer<typeof TestCharterSchema>;

export const SurfaceControlSchema = z.object({
  tag: z.string().min(1),
  role: z.string().min(1),
  name: z.string().max(120).optional(),
  selector: z.string().min(1).optional(),
  selectorKind: z.enum(["test-id", "id", "role"]).optional(),
  disabled: z.boolean(),
});
export type SurfaceControl = z.infer<typeof SurfaceControlSchema>;

export const SurfaceSnapshotSchema = z.object({
  capturedAt: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  controls: z.array(SurfaceControlSchema).max(60).optional(),
  controlsTruncated: z.boolean().optional(),
  frameCount: z.number().int().positive().optional(),
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
  /** Evidence supplied by the Oracle before ProofKit adds its own result artifact. */
  sourceEvidenceCount: z.number().int().nonnegative().optional(),
  /** Run-scoped artifacts containing the Oracle's observed source facts, separate from its verdict report. */
  sourceEvidenceArtifacts: z.array(z.string()).optional(),
  /** Optional repository hints supplied by a trusted project integration. */
  sourceLocations: z.array(z.string().min(1)).optional(),
  observedAt: z.string().optional(),
});
export type OracleResult = z.infer<typeof OracleResultSchema>;

export const RuntimeFindingSchema = z.object({
  findingId: z.string().min(1),
  kind: z.enum(["console", "pageerror", "response", "requestfailed"]),
  category: z.enum(["product", "environment", "test", "unknown"]),
  status: z.enum(["confirmed", "suspected", "unverified"]),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  message: z.string().min(1),
  eventType: z.string().min(1),
  url: z.string().optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  consoleLevel: z.string().optional(),
  affectsVerdict: z.boolean().default(false),
  evidence: z.array(z.string()).default([]),
  observedAt: z.string(),
});
export type RuntimeFinding = z.infer<typeof RuntimeFindingSchema>;

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

/** A process-path association is useful evidence, but does not attest served bytes. */
export const TargetBindingSchema = z.object({
  status: z.enum(["matching-process-path", "different-project", "unverified"]),
  method: z.enum(["windows-listener-process", "unavailable"]),
  expectedProjectRoot: z.string().min(1),
  targetOrigin: z.string().url().optional(),
  observedProjectRoot: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  reason: z.string().min(1),
  observedAt: z.string(),
});
export type TargetBinding = z.infer<typeof TargetBindingSchema>;

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
  /** Runtime signals are kept separate from surface assertions and business facts. */
  // Optional on read so older run.json files remain valid. New runs always write both fields.
  runtimeHealth: z.enum(["passed", "failed", "ignored"]).optional(),
  runtimeFindings: z.array(RuntimeFindingSchema).optional(),
  targetBinding: TargetBindingSchema.optional(),
  artifacts: z.array(z.string()).default([]),
  findings: z.array(z.string()).default([]),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RuntimeQualityPolicySchema = z.object({
  /** ignore keeps raw adapter events but does not classify runtime findings. */
  mode: z.enum(["ignore", "record", "fail"]).default("record"),
  pageErrors: z.boolean().default(true),
  requestFailures: z.boolean().default(false),
  consoleLevels: z.array(z.enum(["debug", "error", "info", "log", "warning", "warn", "assert", "trace"])).default(["error"]),
  failedResponses: z.object({
    enabled: z.boolean().default(true),
    include4xx: z.boolean().default(false),
  }).default({}),
  /** Regular expressions matched against event URLs. An allow list takes precedence over collection. */
  allowUrlPatterns: z.array(z.string().min(1)).default([]),
  ignoreUrlPatterns: z.array(z.string().min(1)).default([]),
  /** Explicit console signatures that invalidate the test environment, such as missing authentication. */
  blockConsolePatterns: z.array(z.string().min(1)).default([]),
});
export type RuntimeQualityPolicy = z.infer<typeof RuntimeQualityPolicySchema>;

export const RunEventSchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  type: z.enum(["run.started", "run.completed", "step.started", "step.completed", "assertion.completed", "oracle.completed", "adapter.event", "artifact.created", "finding.created", "target.binding"]),
  stepId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/** A bounded, read-only fingerprint of the tested repository at Mission execution time. */
export const SourceStateSchema = z.object({
  method: z.enum(["git", "unavailable"]),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  worktreeSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  complete: z.boolean(),
  trackedDiffBytes: z.number().int().nonnegative().default(0),
  untrackedFiles: z.number().int().nonnegative().default(0),
  reason: z.string().optional(),
  capturedAt: z.string(),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const ProjectEntryPointSchema = z.object({
  kind: z.enum(["web", "electron", "backend", "test", "script"]),
  path: z.string().min(1),
  reason: z.string().min(1),
});
export const ProjectRouteHintSchema = z.object({
  kind: z.enum(["web", "api"]),
  path: z.string().min(1),
  source: z.string().min(1),
  line: z.number().int().positive(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  /** Static extraction provenance, never runtime coverage. Older maps omit it. */
  discovery: z.enum(["literal", "gin"]).optional(),
});
export const RouteDiscoveryDiagnosticSchema = z.object({
  extractor: z.literal("gin"),
  source: z.string().min(1),
  line: z.number().int().positive(),
  reason: z.enum(["dynamic-path", "unknown-router-prefix", "unsupported-router-operation"]),
});

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
    entryPoints: z.array(ProjectEntryPointSchema).default([]),
    routeHints: z.array(ProjectRouteHintSchema).default([]),
    /** Unresolved static declarations are separate from scan truncation. */
    routeDiagnostics: z.object({
      total: z.number().int().nonnegative(),
      items: z.array(RouteDiscoveryDiagnosticSchema).max(20),
      omitted: z.number().int().nonnegative(),
    }).optional(),
    /** Literal focus prioritizes retention before inventory caps; it is not semantic coverage. */
    retentionFocus: z.string().min(1).max(128).optional(),
  }).default({}),
  generatedAt: z.string(),
});
export type ProjectMap = z.infer<typeof ProjectMapSchema>;

/** A curated test case in the external workspace, selected by explicit aliases. */
export const RouteHttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type RouteHttpMethod = z.infer<typeof RouteHttpMethodSchema>;
const RoutePathSchema = z.string().min(1).max(256).refine((value) => value.startsWith("/") && !/[?#\s{}$]/.test(value), "Use a static route path without a query or fragment");
/** Repository-relative source path, useful when the same route appears in multiple files. */
const RouteSourceSchema = z.string().min(1).max(512).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "Use a repository-relative source path");
export const RouteCoverageTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), path: RoutePathSchema, source: RouteSourceSchema.optional() }),
  z.object({
    kind: z.literal("api"), path: RoutePathSchema, source: RouteSourceSchema.optional(),
    method: RouteHttpMethodSchema,
    /** Exact origin of the test gateway; path-only matches are not sufficient. */
    origin: z.string().url().refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value.replace(/\/$/, "") === url.origin;
      } catch { return false; }
    }, "Use an HTTP(S) origin without a path, credentials, query or fragment"),
  }),
]);
export type RouteCoverageTarget = z.infer<typeof RouteCoverageTargetSchema>;

export const CharterCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  path: z.string().min(1),
  aliases: z.array(z.string().trim().min(2)).min(1),
  level: TestLevelSchema,
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
  routeTargets: z.array(RouteCoverageTargetSchema).optional(),
});
export type CharterCatalogEntry = z.infer<typeof CharterCatalogEntrySchema>;

const CatalogIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/);

/** A release suite names its workflows explicitly; discovery never expands it implicitly. */
export const SuiteCatalogEntrySchema = z.object({
  id: CatalogIdSchema,
  aliases: z.array(z.string().trim().min(2)).min(1),
  level: z.literal("release"),
  charterIds: z.array(CatalogIdSchema).min(2),
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.charterIds).size !== suite.charterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charterIds"], message: "Suite Charter IDs must be unique" });
  if (new Set(suite.surfaces).size !== suite.surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "Suite surfaces must be unique" });
  if ((suite.surfaces.includes("web") || suite.surfaces.includes("electron")) && !(suite.surfaces.includes("web") && suite.surfaces.includes("electron"))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "A release suite with Web or Electron must include both surfaces" });
});
export type SuiteCatalogEntry = z.infer<typeof SuiteCatalogEntrySchema>;

export const TestSuiteSchema = z.object({
  suiteId: CatalogIdSchema,
  level: z.literal("release"),
  surfaces: z.array(z.enum(["web", "electron", "mobile"])).min(1),
  charters: z.array(z.object({ charterId: CatalogIdSchema, charter: TestCharterSchema, routeTargets: z.array(RouteCoverageTargetSchema).optional() })).min(2),
  uncoveredCharterIds: z.array(CatalogIdSchema).default([]),
}).superRefine((suite, ctx) => {
  if (new Set(suite.charters.map((item) => item.charterId)).size !== suite.charters.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters"], message: "Suite Charter IDs must be unique" });
  if (new Set(suite.surfaces).size !== suite.surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "Suite surfaces must be unique" });
  if ((suite.surfaces.includes("web") || suite.surfaces.includes("electron")) && !(suite.surfaces.includes("web") && suite.surfaces.includes("electron"))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["surfaces"], message: "A release suite with Web or Electron must include both surfaces" });
  if (new Set(suite.uncoveredCharterIds).size !== suite.uncoveredCharterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uncoveredCharterIds"], message: "Uncovered Charter IDs must be unique" });
  if (suite.uncoveredCharterIds.some((id) => suite.charters.some((item) => item.charterId === id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uncoveredCharterIds"], message: "Included Charters cannot be uncovered" });
  for (const [index, item] of suite.charters.entries()) {
    if (item.charter.level !== suite.level) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["charters", index, "charter", "level"], message: "Suite Charter level must match the suite" });
  }
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

export const TestScopeInputSchema = z.object({
  level: TestLevelSchema.default("core"),
  surface: z.enum(["web", "electron", "mobile"]).default("web"),
  /** Literal, case-insensitive substring; this is not semantic workflow selection. */
  focus: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type TestScopeInput = z.input<typeof TestScopeInputSchema>;
const ScopePlanCheckSchema = z.object({
  eligible: z.boolean(),
  planReady: z.boolean(),
  issues: z.array(z.string()),
});
const ScopeCountSchema = z.number().int().nonnegative();
/** Static planning observations have no execution or product verdict. */
export const TestScopeSchema = z.object({
  schemaVersion: z.literal(1),
  testVerdict: z.literal("not-asserted"),
  executionChecks: z.literal("not-run"),
  projectRoot: z.string(),
  workspaceRoot: z.string(),
  selection: TestScopeInputSchema.extend({ requiredSurfaces: z.array(z.enum(["web", "electron", "mobile"])) }),
  inventory: ProjectMapSchema.shape.inventory.removeDefault().omit({ entryPoints: true, routeHints: true }),
  entryPoints: z.object({ total: ScopeCountSchema, matched: ScopeCountSchema, items: z.array(ProjectEntryPointSchema), omitted: ScopeCountSchema }),
  routes: z.object({
    total: ScopeCountSchema,
    matched: ScopeCountSchema,
    declaredTargets: ScopeCountSchema,
    mapped: ScopeCountSchema,
    unmapped: ScopeCountSchema,
    items: z.array(ProjectRouteHintSchema.extend({ charterIds: z.array(z.string()), omittedCharterIds: ScopeCountSchema, status: z.enum(["declared", "unmapped"]), runtimeSourceAmbiguous: z.boolean() })),
    omitted: ScopeCountSchema,
    unresolvedTargets: z.array(RouteCoverageTargetSchema.and(z.object({ charterId: z.string(), reason: z.enum(["absent", "ambiguous"]) }))),
    omittedUnresolvedTargets: ScopeCountSchema,
  }),
  catalog: z.object({
    total: ScopeCountSchema, eligible: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({
      id: z.string(), path: z.string(), aliases: z.array(z.string()), omittedAliases: ScopeCountSchema,
      level: TestLevelSchema, surfaces: z.array(z.enum(["web", "electron", "mobile"])),
      check: ScopePlanCheckSchema,
    })),
  }),
  suites: z.object({
    total: ScopeCountSchema, eligible: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({ id: z.string(), charterIds: z.array(z.string()), omittedCharterIds: ScopeCountSchema, check: ScopePlanCheckSchema })),
  }),
  integration: z.object({ name: z.string(), version: z.string().optional(), preflightRegistered: z.boolean(), setupRegistered: z.boolean() }).optional(),
  capabilities: z.object({
    total: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({
      name: z.string(), description: z.string(), sideEffect: z.enum(["none", "read", "write"]),
      environments: z.array(z.enum(["test", "staging", "local"])), environmentAllowed: z.boolean(), operatorWriteOptIn: z.boolean(),
      inputShape: z.object({ hint: z.record(z.unknown()).optional(), partial: z.boolean(), limitations: z.array(z.string()) }),
    })),
  }),
  oracles: z.object({
    total: ScopeCountSchema, matched: ScopeCountSchema, omitted: ScopeCountSchema,
    items: z.array(z.object({ name: z.string(), kind: z.enum(["registered", "configured-http"]) })),
  }),
  limitations: z.array(z.string()),
  next: z.array(z.string()),
  generatedAt: z.string(),
});
export type TestScope = z.infer<typeof TestScopeSchema>;

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
      targetUrlPrefix: z.string().min(1).optional(),
      targetTitleContains: z.string().min(1).optional(),
      executablePath: z.string().min(1).optional(),
    }).optional(),
    electron: z.object({
      cdpUrl: z.string().optional(),
      devtoolsActivePort: z.string().optional(),
      targetUrlPrefix: z.string().min(1).optional(),
      targetTitleContains: z.string().min(1).optional(),
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
  charters: z.array(CharterCatalogEntrySchema).default([]),
  suites: z.array(SuiteCatalogEntrySchema).default([]),
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
    runtime: RuntimeQualityPolicySchema.default({}),
    /** Block only an evidenced different Git checkout; keep unknown targets explicit. */
    targetBinding: z.enum(["record", "block-different"]).default("block-different"),
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
  suiteId: CatalogIdSchema.optional(),
  charterIds: z.array(CatalogIdSchema).default([]),
  collectAllResults: z.boolean().default(false),
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
  kind: z.enum(["screenshot", "snapshot", "network", "console", "process", "api", "business", "runtime", "log", "report", "other"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  description: z.string().min(1).optional(),
  capturedAt: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  charterId: CatalogIdSchema.optional(),
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
  charterId: CatalogIdSchema.optional(),
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
  charterId: CatalogIdSchema.optional(),
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
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
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
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
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
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
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
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]).optional(),
  message: z.string().min(1),
  stepId: z.string().optional(),
  oracleName: z.string().optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
  observedAt: z.string(),
});
export type FailureBoundary = z.infer<typeof FailureBoundarySchema>;

export const TaskNodeSchema = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  charterId: CatalogIdSchema.optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  dependencyMode: z.enum(["passed", "settled"]).default("passed"),
  status: MissionTaskStatusSchema.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().max(10).default(1),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskNodeSchema).min(1).max(10_000),
  terminalTaskIds: z.array(z.string()).min(1),
}).superRefine((graph, ctx) => {
  const tasks = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const dependents = new Map(graph.tasks.map((task) => [task.taskId, 0]));
  const downstreamTasks = new Map(graph.tasks.map((task) => [task.taskId, [] as string[]]));
  const outstandingDependencies = new Map(graph.tasks.map((task) => [task.taskId, 0]));
  if (tasks.size !== graph.tasks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "Task IDs must be unique" });
  }
  const terminals = new Set(graph.terminalTaskIds);
  if (terminals.size !== graph.terminalTaskIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: "Terminal task IDs must be unique" });
  }
  for (const [index, task] of graph.tasks.entries()) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} has duplicate dependencies` });
    }
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} depends on unknown task ${dependency}` });
      } else if (dependency === task.taskId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "dependsOn"], message: `Task ${task.taskId} cannot depend on itself` });
      } else {
        dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
        downstreamTasks.get(dependency)?.push(task.taskId);
        outstandingDependencies.set(task.taskId, (outstandingDependencies.get(task.taskId) ?? 0) + 1);
      }
    }
  }
  for (const [index, terminalId] of graph.terminalTaskIds.entries()) {
    if (!tasks.has(terminalId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds", index], message: `Unknown terminal task ${terminalId}` });
    }
  }
  const ready = [...outstandingDependencies].filter(([, count]) => count === 0).map(([taskId]) => taskId);
  let processed = 0;
  for (let index = 0; index < ready.length; index++) {
    const taskId = ready[index]!;
    processed++;
    for (const downstream of downstreamTasks.get(taskId) ?? []) {
      const remaining = (outstandingDependencies.get(downstream) ?? 0) - 1;
      outstandingDependencies.set(downstream, remaining);
      if (remaining === 0) ready.push(downstream);
    }
  }
  if (processed !== tasks.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "Task graph contains a dependency cycle" });
  }
  for (const taskId of tasks.keys()) {
    const downstream = dependents.get(taskId) ?? 0;
    if (downstream === 0 && !terminals.has(taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: `Final task ${taskId} is not declared terminal` });
    }
    if (downstream > 0 && terminals.has(taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminalTaskIds"], message: `Terminal task ${taskId} still has dependents` });
    }
  }
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const MissionPlanSchema = z.object({
  planId: z.string().min(1),
  version: z.string().min(1),
  generatedBy: z.string().min(1),
  graph: TaskGraphSchema,
  successCriteria: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  planning: PlanningQualitySchema.optional(),
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
/** Existing persisted plans may omit planning metadata. New plans populate it explicitly. */
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

export const TestMissionSchema = z.object({
  missionId: z.string().min(1),
  /** The direct source Mission when this Mission was created by replay. */
  replayOfMissionId: z.string().min(1).optional(),
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
  suite: TestSuiteSchema.optional(),
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

export const MissionComparisonRunSchema = z.object({
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]),
  runKind: z.enum(["primary", "replay", "negative"]),
  negativeCaseId: z.string().optional(),
  baselineRunId: z.string().optional(),
  candidateRunId: z.string().optional(),
  baselineVerdict: VerdictSchema.optional(),
  candidateVerdict: VerdictSchema.optional(),
  baselineBusinessFacts: z.number().int().nonnegative(),
  candidateBusinessFacts: z.number().int().nonnegative(),
  baselineEvidence: z.array(EvidenceRefSchema).default([]),
  candidateEvidence: z.array(EvidenceRefSchema).default([]),
});
export type MissionComparisonRun = z.infer<typeof MissionComparisonRunSchema>;

export const MissionComparisonDefectSchema = z.object({
  charterId: CatalogIdSchema.optional(),
  surface: z.enum(["web", "electron", "mobile"]),
  oracleName: z.string().min(1),
  baselineRunId: z.string().min(1),
  candidateRunId: z.string().optional(),
  outcome: z.enum(["not-reproduced", "reproduced", "unverified"]),
  baselineEvidence: z.array(EvidenceRefSchema).min(1),
  candidateEvidence: z.array(EvidenceRefSchema).default([]),
});
export type MissionComparisonDefect = z.infer<typeof MissionComparisonDefectSchema>;

/** A comparison is a scoped observation, never proof of which source edit caused the change. */
export const MissionComparisonSchema = z.object({
  baselineMissionId: z.string().min(1),
  candidateMissionId: z.string().min(1),
  baselineVerdict: VerdictSchema.optional(),
  candidateVerdict: VerdictSchema.optional(),
  baselineScopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidateScopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopeMatched: z.boolean(),
  baselineSourceState: SourceStateSchema.optional(),
  candidateSourceState: SourceStateSchema.optional(),
  sourceChange: z.enum(["changed", "unchanged", "unknown"]),
  candidateSourceStability: z.enum(["stable", "changed-during-run", "unknown"]),
  status: z.enum(["verified-in-scope", "defect-reproduced", "inconclusive"]),
  reason: z.string().min(1),
  gaps: z.array(z.string()),
  runs: z.array(MissionComparisonRunSchema),
  omittedRuns: z.number().int().nonnegative(),
  defects: z.array(MissionComparisonDefectSchema),
  omittedDefects: z.number().int().nonnegative(),
  comparedAt: z.string(),
});
export type MissionComparison = z.infer<typeof MissionComparisonSchema>;

/** A bounded presentation of saved Mission facts, never a second verdict reducer. */
export const MissionRunResultSchema = z.object({
  taskId: z.string().optional(),
  charterId: CatalogIdSchema.optional(),
  title: z.string().min(1),
  surface: MissionSurfaceSchema.optional(),
  runKind: z.enum(["primary", "replay", "negative", "unknown"]),
  negativeCaseId: z.string().optional(),
  taskStatus: MissionTaskStatusSchema.optional(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  /** Raw surface verdict; an expected failure is not a product defect. */
  verdict: VerdictSchema.optional(),
  expectedVerdict: VerdictSchema.optional(),
  outcomeMatched: z.boolean().optional(),
  assertions: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  oracles: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  businessFacts: z.number().int().nonnegative().optional(),
  targetBinding: TargetBindingSchema.optional(),
  evidence: z.array(EvidenceRefSchema).max(6),
  omittedEvidence: z.number().int().nonnegative(),
  issue: z.string().optional(),
});
export type MissionRunResult = z.infer<typeof MissionRunResultSchema>;

export const MissionResultSchema = z.object({
  schemaVersion: z.literal("1"),
  missionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  replayOfMissionId: z.string().optional(),
  projectRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  intent: z.string().min(1),
  status: MissionStatusSchema,
  running: z.boolean(),
  verdict: VerdictSchema.optional(),
  level: TestLevelSchema,
  levelSelection: TestLevelSelectionSchema.optional(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  generatedAt: z.string(),
  planning: PlanningQualitySchema.optional(),
  scope: z.object({
    surfaces: z.array(MissionSurfaceSchema),
    charterCount: z.number().int().nonnegative(),
    suiteId: CatalogIdSchema.optional(),
    uncoveredCharterIds: z.array(CatalogIdSchema),
    routeCoverage: z.object({
      inventoryTruncated: z.boolean(),
      candidateRoutes: z.number().int().nonnegative(),
      mappedCandidates: z.number().int().nonnegative(),
      observedCandidates: z.number().int().nonnegative(),
      gapCount: z.number().int().nonnegative(),
      unresolvedTargetCount: z.number().int().nonnegative(),
    }).optional(),
  }),
  tasks: z.object({
    total: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  expectedRuns: z.number().int().nonnegative(),
  observedRuns: z.number().int().nonnegative(),
  runs: z.array(MissionRunResultSchema).max(200),
  omittedRunResults: z.number().int().nonnegative(),
  findings: z.array(FindingSchema).max(20),
  omittedFindings: z.number().int().nonnegative(),
  confirmedProductFindings: z.number().int().nonnegative(),
  firstFailure: FailureBoundarySchema.optional(),
  diagnosis: DiagnosisSchema.optional(),
  repairSuggestions: z.array(RepairSuggestionSchema).max(10),
  omittedRepairSuggestions: z.number().int().nonnegative(),
  comparison: MissionComparisonSchema.optional(),
  comparisonUnavailable: z.string().optional(),
});
export type MissionResult = z.infer<typeof MissionResultSchema>;
