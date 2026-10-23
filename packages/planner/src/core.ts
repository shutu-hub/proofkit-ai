import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { hasPositiveSurfaceAssertion, normalizePlanningQuality, PlanningQualitySchema, RunModeSchema, ProjectMapSchema, SideEffectPolicySchema, SurfaceSnapshotSchema, TestCharterSchema, TestCoverageSchema, TestLevelSchema, type Assertion, type PlanningQuality, type ProjectMap, type RunMode, type SideEffectPolicy, type SurfaceSnapshot, type TestCharter, type TestLevel } from "@proofkit/contracts";
import { z } from "zod";
import { resolveTestLevel } from "./test-levels.js";
import { assessPlanningCoverage, planningCoverageRequirements } from "./coverage.js";
import { bindObservedSurfaceTargets, resolveObservedSurfaceTarget } from "./surface-targets.js";
import { actionSurfaceTargets } from "@proofkit/contracts";
import { PlanningObservationRequestSchema, SurfaceObservedStateSchema, type PlanningObservationRequest, type SurfaceObservedState } from "@proofkit/contracts";

export { getTestLevelProfile, intentTestLevelHints, resolveTestLevel, type TestLevelProfile } from "./test-levels.js";
export const PlannerConstraintsSchema = z.object({
  url: z.string().url().optional(),
  expect: z.array(z.string().min(1)).optional(),
  mode: RunModeSchema.optional(),
  sideEffectPolicy: SideEffectPolicySchema.optional(),
  oracleNames: z.array(z.string().min(1)).optional(),
  level: TestLevelSchema.optional(),
  coverage: TestCoverageSchema.optional(),
  allowedActionKinds: z.array(z.string().min(1)).optional(),
  allowedOracleNames: z.array(z.string().min(1)).optional(),
  requireAssertions: z.boolean().optional(),
  requireBusinessOracle: z.boolean().optional(),
}).strict();

export type PlannerConstraints = z.infer<typeof PlannerConstraintsSchema>;
export type PlanOptions = Pick<PlannerConstraints, "url" | "expect" | "mode" | "sideEffectPolicy" | "oracleNames" | "level" | "coverage"> & {
  requireAssertions?: boolean;
  requireBusinessOracle?: boolean;
  surfaceSnapshot?: SurfaceSnapshot;
  surfaceObservations?: SurfaceObservedState[];
};

export type PlannerInput = {
  intent: string;
  projectMap: ProjectMap;
  constraints: PlannerConstraints;
  surfaceSnapshot?: SurfaceSnapshot;
  surfaceObservations?: SurfaceObservedState[];
  signal?: AbortSignal;
};

export interface PlannerProvider {
  readonly name: string;
  plan(input: PlannerInput): Promise<unknown>;
}

export class PlanningObservationRequestError extends Error {
  override readonly name = "PlanningObservationRequestError";
  constructor(readonly request: PlanningObservationRequest) {
    super("The planner requires another observed state before returning a Test Charter");
  }
}

export class PlanningRequirementsError extends Error {
  override readonly name = "PlanningRequirementsError";
  readonly charter!: TestCharter;
  constructor(readonly issues: string[], charter: TestCharter) {
    super(issues.join("; "));
    Object.defineProperty(this, "charter", { value: charter, enumerable: false });
  }
}

export class PlannerConfigurationError extends Error {
  override readonly name = "PlannerConfigurationError";
  constructor(message: string) { super(message); }
  receipt() {
    return { status: "planner-not-ready" as const, testVerdict: "not-asserted" as const, executionStarted: false,
      reason: this.message, next: ["configure_planner", "plan_test", "run_test"] };
  }
}

export type PlanningAssessmentInput = {
  projectMap?: ProjectMap;
  constraints?: PlannerConstraints;
  source?: PlanningQuality["source"];
  /** The user's request can have broader scope than a submitted Charter's intent. */
  coverageIntent?: string;
  surfaceSnapshot?: SurfaceSnapshot;
  surfaceObservations?: SurfaceObservedState[];
};

/** Recompute quality from the validated Charter instead of trusting model confidence. */
export function assessPlanningQuality(charter: TestCharter, input: PlanningAssessmentInput = {}): PlanningQuality {
  const constraints = input.constraints ?? {};
  const declared = normalizePlanningQuality(charter.planning);
  const source = input.source ?? declared.source;
  const assumptions = [...declared.assumptions];
  // Only checks against the validated Charter and Project Map can gate the
  // final verdict; provider-authored gap claims are not authoritative.
  const missingInputs: string[] = [];
  const evidenceGaps: string[] = [];
  const add = (items: string[], value: string) => { if (!items.includes(value)) items.push(value); };
  // Preserve only bounded, machine-generated gaps from a previously reviewed
  // plan. Arbitrary provider prose must not become an execution gate merely
  // because it was copied into a submitted Charter.
  const preservedGaps = new Set(["project-map-not-scanned", "project-map-truncated", "project-workflow-coverage", "surface-assertion", "business-oracle", "negative-case", "surface-selector", "surface-page"]);
  for (const gap of declared.evidenceGaps) if (preservedGaps.has(gap)) add(evidenceGaps, gap);

  if (constraints.requireAssertions && !hasPositiveSurfaceAssertion(charter.assertions)) {
    add(missingInputs, "至少一个正向可观察的表面断言");
    add(evidenceGaps, "surface-assertion");
  }
  if (constraints.requireBusinessOracle && (charter.oracles?.length ?? 0) === 0) {
    add(missingInputs, "独立业务 Oracle");
    add(evidenceGaps, "business-oracle");
  }
  if (charter.level === "release" && (charter.negativeCases?.length ?? 0) === 0) {
    add(missingInputs, "显式负向或恢复场景");
    add(evidenceGaps, "negative-case");
  }
  if (charter.actions.some((action) => action.kind === "goto") && !constraints.url) add(missingInputs, "经批准的目标 Web origin");
  const coverage = assessPlanningCoverage(input.coverageIntent ?? charter.intent, input.projectMap, constraints.coverage);
  const coverageRequirements = planningCoverageRequirements(coverage);
  missingInputs.push(...coverageRequirements.missingInputs);
  evidenceGaps.push(...coverageRequirements.evidenceGaps);
  if (input.projectMap && input.projectMap.inventory.entryPoints.length === 0) add(assumptions, "未从源码扫描中识别到约定的应用入口");
  if (input.projectMap?.inventory.routeDiagnostics?.total) add(assumptions, `有 ${input.projectMap.inventory.routeDiagnostics.total} 条 Gin 路由声明无法静态解析，项目地图不代表完整业务覆盖`);
  if (input.surfaceSnapshot || input.surfaceObservations?.length) {
    const snapshot = input.surfaceSnapshot ? SurfaceSnapshotSchema.parse(input.surfaceSnapshot) : undefined;
    const observations = input.surfaceObservations?.map((state) => SurfaceObservedStateSchema.parse(state)) ?? [];
    const missingSelectors = [...new Set([...charter.actions, ...(charter.negativeCases ?? []).flatMap((negative) => negative.actions)]
      .flatMap(actionSurfaceTargets).filter((target) => !resolveObservedSurfaceTarget(target, snapshot, observations))
      .map((target) => `${target.selector}${target.observationId ? ` @ ${target.observationId}` : ""}`))];
    if (missingSelectors.length) {
      add(missingInputs, `页面观察中未找到计划控件: ${missingSelectors.slice(0, 4).join(", ")}${missingSelectors.length > 4 ? " 等" : ""}`);
      add(evidenceGaps, "surface-selector");
    }
    const snapshots = snapshot ? [snapshot] : observations.map((state) => state.snapshot);
    const missingPages = [...new Set([...charter.actions, ...(charter.negativeCases ?? []).flatMap((item) => item.actions)]
      .filter((action) => action.kind === "switchPage")
      .filter((action) => !snapshots.some((state) => state.pages?.some((page) => page.title === action.title && page.eligibleForSwitch)))
      .map((action) => action.title))];
    if (missingPages.length) {
      add(missingInputs, `页面观察中未找到可唯一选择的同源窗口: ${missingPages.slice(0, 4).join(", ")}`);
      add(evidenceGaps, "surface-page");
    }
    if (snapshot?.controlsTruncated || observations.some((state) => state.snapshot.controlsTruncated)) add(assumptions, "页面控件观察被截断，计划不代表完整可操作控件集合");
  } else if (charter.surfaceObservation) {
    const unbound = [...charter.actions, ...(charter.negativeCases ?? []).flatMap((item) => item.actions)]
      .flatMap(actionSurfaceTargets).filter((target) => !target.expectedTarget);
    if (unbound.length) {
      add(missingInputs, "观察计划中仍有未绑定的交互目标");
      add(evidenceGaps, "surface-selector");
    }
  }

  // A model is not intrinsically more reliable than the same validated plan
  // produced deterministically. The source is recorded for audit, not scoring.
  const baseline = input.projectMap ? 0.75 : 0.6;
  const confidence = Math.max(0, Math.min(1, baseline - missingInputs.length * 0.12 - evidenceGaps.length * 0.08));
  return PlanningQualitySchema.parse({ source, confidence, assumptions, missingInputs, evidenceGaps, coverage });
}

export class IntentPlanner {
  plan(intent: string, options: PlanOptions = {}): TestCharter {
    const levelSelection = resolveTestLevel(intent, options.level);
    const url = options.url ?? intent.match(/https?:\/\/[^\s]+/)?.[0];
    const assertions: Assertion[] = (options.expect ?? []).map((text) => ({ kind: "text-visible", text }));
    const actions: TestCharter["actions"] = [];
    if (url) actions.push({ kind: "goto", url });
    actions.push({ kind: "observe" });

    const charter = TestCharterSchema.parse({
      intent,
      level: levelSelection.resolved,
      levelSelection,
      mode: options.mode ?? "guided",
      preconditions: ["运行在隔离的测试环境", "使用可回滚的测试数据"],
      actions,
      assertions,
      oracles: options.oracleNames,
      sideEffectPolicy: options.sideEffectPolicy ?? "confirm",
      metadata: { planner: "deterministic-v1", url: url ?? null, testLevel: levelSelection.resolved },
    });
    return bindObservedSurfaceTargets(TestCharterSchema.parse({
      ...charter,
      planning: assessPlanningQuality(charter, {
        constraints: {
          ...options,
          requireAssertions: options.requireAssertions ?? true,
          requireBusinessOracle: options.requireBusinessOracle ?? levelSelection.resolved !== "quick",
        },
        source: "deterministic", surfaceSnapshot: options.surfaceSnapshot, surfaceObservations: options.surfaceObservations,
      }),
    }), options.surfaceSnapshot, options.surfaceObservations);
  }

  fromYaml(source: string): TestCharter {
    return TestCharterSchema.parse(parse(source));
  }

  toYaml(charter: TestCharter): string {
    return stringify(charter);
  }
}

export class DeterministicPlannerProvider implements PlannerProvider {
  readonly name = "deterministic-v1";

  async plan(input: PlannerInput): Promise<unknown> {
    ProjectMapSchema.parse(input.projectMap);
    return new IntentPlanner().plan(input.intent, input.constraints);
  }
}

export type OpenAICompatiblePlannerOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class OpenAICompatiblePlannerProvider implements PlannerProvider {
  readonly name = "openai-compatible";
  private readonly options: OpenAICompatiblePlannerOptions;

  constructor(options: OpenAICompatiblePlannerOptions) {
    this.options = options;
  }

  async plan(input: PlannerInput): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          response_format: { type: "json_object" },
      messages: [
            {
              role: "system",
              content: "Generate a ProofKit Test Charter JSON object, or request a missing observation before planning an unknown state. For an observation request return a JSON object with status set to needs-observation, reason and expectedObservation strings, and an optional action object. action contains one supported exploratory operation and must use an actually observed selector and its observationId when supplied; the host reviews it separately and planning never executes it. Never invent a future control or declare workflow completeness from one page. Keep the exact original user intent text, requested execution mode, exact sideEffectPolicy, requested visible expect texts and oracleNames in the final Charter; do not summarize the intent or substitute independent checks. Use only allowedActionKinds and allowedOracleNames. Never generate shell commands, SQL, arbitrary JavaScript, credentials or environment-secret references in observation proposals. Include a positive assertion when required. When surfaceSnapshot is supplied, use its observed selectors. surfaceObservations contains separately observed states: every control action, response trigger and follow-up should declare the observationId whose controls it uses. Plan explicit navigation/checkpoints between states and independent final business verification. Distinguish required intent fields, request projections, response echoes and independent final record fields. A source-code example is not proof of the deployed response schema. Do not invent nested JSON pointers or remove a required business field because its independent observation is unavailable. Ask the host for the missing schema or connector readiness observation before a write workflow depends on it. Planning assumptions, missingInputs and evidenceGaps are advisory and ProofKit recomputes them.",
            },
            {
              role: "user",
              content: JSON.stringify({ intent: input.intent, projectMap: input.projectMap, surfaceSnapshot: input.surfaceSnapshot, surfaceObservations: input.surfaceObservations, constraints: input.constraints }),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Planner provider returned HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("Planner provider returned no JSON content");
      return parseJsonContent(content);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class StructuredPlanner {
  private readonly provider: PlannerProvider;

  constructor(provider: PlannerProvider, private readonly sourceOverride?: "submitted") {
    this.provider = provider;
  }

  async plan(input: PlannerInput): Promise<TestCharter> {
    input.signal?.throwIfAborted();
    if (input.surfaceSnapshot && input.surfaceObservations?.length) throw new Error("Use one snapshot or a bounded set of observed states");
    if (input.surfaceObservations) {
      SurfaceObservedStateSchema.array().min(1).max(10).refine((states) => new Set(states.map((state) => state.observationId)).size === states.length).parse(input.surfaceObservations);
    }
    const candidate = await this.provider.plan(input);
    input.signal?.throwIfAborted();
    if (candidate && typeof candidate === "object" && "status" in candidate && candidate.status === "needs-observation") {
      const request = PlanningObservationRequestSchema.parse(candidate);
      if (request.action) {
        if (input.constraints.allowedActionKinds && !input.constraints.allowedActionKinds.includes(request.action.kind)) throw new Error("Observation request contains an action outside the allowed action kinds");
        if (request.action.kind === "goto") {
          const target = new URL(request.action.url);
          if (!input.constraints.url || target.origin !== new URL(input.constraints.url).origin || target.username || target.password) throw new Error("Observation request navigation is outside the approved origin");
        }
        if (request.action.kind === "switchPage") {
          const snapshots = input.surfaceSnapshot ? [input.surfaceSnapshot] : (input.surfaceObservations ?? []).map((state) => state.snapshot);
          const title = request.action.title;
          if (!snapshots.some((snapshot) => snapshot.pages?.some((page) => page.title === title && page.eligibleForSwitch))) throw new Error("Observation request must select an observed unique same-origin page");
        }
        const bound = bindObservedSurfaceTargets(TestCharterSchema.parse({ intent: input.intent, actions: [request.action], sideEffectPolicy: input.constraints.sideEffectPolicy ?? "confirm" }), input.surfaceSnapshot, input.surfaceObservations).actions[0]!;
        if (actionSurfaceTargets(bound).some((target) => !target.expectedTarget)) throw new Error("Observation request must reference a uniquely observed control and state");
        request.action = bound;
      }
      throw new PlanningObservationRequestError(request);
    }
    const charter = TestCharterSchema.parse(candidate);
    if (input.constraints.requireAssertions && !hasPositiveSurfaceAssertion(charter.assertions)) {
      throw new Error("Planner output must include at least one positive surface assertion");
    }
    if (input.constraints.expect?.some((text) => !charter.assertions.some((assertion) => assertion.kind === "text-visible" && assertion.text === text))) {
      throw new Error("Planner omitted a requested visible outcome");
    }
    if (input.constraints.allowedActionKinds && [...charter.actions, ...(charter.negativeCases ?? []).flatMap((item) => item.actions)].some((action) => !input.constraints.allowedActionKinds?.includes(action.kind))) {
      throw new Error("Planner output contains an action outside the allowed action kinds");
    }
    if (input.constraints.allowedOracleNames && [...(charter.oracles ?? []), ...(charter.negativeCases ?? []).flatMap((item) => item.oracles)].some((name) => !input.constraints.allowedOracleNames?.includes(name))) {
      throw new Error("Planner output references an unregistered oracle");
    }
    const requirementIssues: string[] = [];
    if (input.constraints.mode !== undefined && charter.mode !== input.constraints.mode) {
      requirementIssues.push("Planner changed the requested execution mode");
    }
    if (input.constraints.sideEffectPolicy !== undefined && charter.sideEffectPolicy !== input.constraints.sideEffectPolicy) {
      requirementIssues.push("Planner changed the side-effect policy");
    }
    if (input.constraints.oracleNames !== undefined && JSON.stringify([...(charter.oracles ?? [])].sort()) !== JSON.stringify([...input.constraints.oracleNames].sort())) {
      requirementIssues.push("Planner changed the requested business oracles");
    }
    const levelSelection = resolveTestLevel(input.intent, input.constraints.level);
    const source: PlanningQuality["source"] = this.sourceOverride ?? (this.provider.name === "deterministic-v1" ? "deterministic" : "model");
    const planned = bindObservedSurfaceTargets(TestCharterSchema.parse({
      ...charter,
      intent: input.intent,
      level: levelSelection.resolved,
      levelSelection,
      planning: assessPlanningQuality({ ...charter, intent: input.intent, level: levelSelection.resolved }, { projectMap: input.projectMap, constraints: input.constraints, source, coverageIntent: input.intent, surfaceSnapshot: input.surfaceSnapshot, surfaceObservations: input.surfaceObservations }),
      metadata: { ...charter.metadata, planner: this.provider.name, testLevel: levelSelection.resolved },
    }), input.surfaceSnapshot, input.surfaceObservations);
    if (requirementIssues.length) throw new PlanningRequirementsError(requirementIssues, planned);
    return planned;
  }
}

export async function loadCharter(path: string): Promise<TestCharter> {
  const planner = new IntentPlanner();
  return planner.fromYaml(await readFile(path, "utf8"));
}

export function planIntent(intent: string, options?: PlanOptions): TestCharter {
  return new IntentPlanner().plan(intent, options);
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? content);
}
