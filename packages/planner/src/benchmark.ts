import { z } from "zod";
import { hasPositiveSurfaceAssertion, ProjectMapSchema, SurfaceSnapshotSchema, TestLevelSchema, type TestCharter, type SurfaceSnapshot } from "@proofkit/contracts";
import { PlannerConstraintsSchema, PlanningRequirementsError, StructuredPlanner, type PlannerProvider } from "./core.js";

export const PlannerBenchmarkExpectationSchema = z.object({
  level: TestLevelSchema.optional(),
  requiredActionKinds: z.array(z.string().min(1)).default([]),
  forbiddenActionKinds: z.array(z.string().min(1)).default([]),
  requiredOracleNames: z.array(z.string().min(1)).default([]),
  requireAssertions: z.boolean().default(false),
  requireNegativeCases: z.boolean().default(false),
  requiredSelectors: z.array(z.string().min(1)).default([]),
  requireObservedSelectors: z.boolean().default(false),
});
export type PlannerBenchmarkExpectation = z.infer<typeof PlannerBenchmarkExpectationSchema>;

export const PlannerBenchmarkCaseSchema = z.object({
  caseId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  intent: z.string().min(1),
  projectMap: ProjectMapSchema,
  constraints: PlannerConstraintsSchema,
  surfaceSnapshot: SurfaceSnapshotSchema.optional(),
  expect: PlannerBenchmarkExpectationSchema,
});
export type PlannerBenchmarkCase = z.infer<typeof PlannerBenchmarkCaseSchema>;

export type PlannerBenchmarkResult = {
  caseId: string;
  planner: string;
  valid: boolean;
  score: number;
  checks: {
    level: boolean;
    requiredActions: boolean;
    forbiddenActions: boolean;
    requiredOracles: boolean;
    assertions: boolean;
    negativeCases: boolean;
    requiredSelectors: boolean;
    observedSelectors: boolean;
  };
  failures: string[];
  admissionIssues?: string[];
  charter?: TestCharter;
  error?: string;
};

export type PlannerBenchmarkReport = {
  planner: string;
  total: number;
  passed: number;
  passRate: number;
  averageScore: number;
  failureCounts: {
    level: number;
    requiredActions: number;
    forbiddenActions: number;
    requiredOracles: number;
    assertions: number;
    negativeCases: number;
    requiredSelectors: number;
    observedSelectors: number;
    providerErrors: number;
    requirements: number;
  };
  results: PlannerBenchmarkResult[];
};

/**
 * Evaluate a planner without executing a browser, process, capability or
 * Oracle. This is intentionally a plan-quality gate, not a product test.
 */
export async function evaluatePlannerBenchmark(provider: PlannerProvider, cases: PlannerBenchmarkCase[]): Promise<PlannerBenchmarkReport> {
  const planner = new StructuredPlanner(provider);
  const results: PlannerBenchmarkResult[] = [];
  for (const rawCase of cases) {
    const benchmarkCase = PlannerBenchmarkCaseSchema.parse(rawCase);
    const expectation = PlannerBenchmarkExpectationSchema.parse(benchmarkCase.expect);
    const checks = {
      level: expectation.level === undefined,
      requiredActions: expectation.requiredActionKinds.length === 0,
      forbiddenActions: true,
      requiredOracles: expectation.requiredOracleNames.length === 0,
      assertions: !expectation.requireAssertions,
      negativeCases: !expectation.requireNegativeCases,
      requiredSelectors: expectation.requiredSelectors.length === 0,
      observedSelectors: expectation.requireObservedSelectors === false,
    };
    const failures: string[] = [];
    const admissionIssues: string[] = [];
    try {
      const charter = await planner.plan({
        intent: benchmarkCase.intent,
        projectMap: benchmarkCase.projectMap,
        constraints: benchmarkCase.constraints,
        surfaceSnapshot: benchmarkCase.surfaceSnapshot,
      }).catch((error: unknown) => {
        if (!(error instanceof PlanningRequirementsError)) throw error;
        failures.push(...error.issues);
        admissionIssues.push(...error.issues);
        return error.charter;
      });
      const actionKinds = new Set<string>(charter.actions.map((action) => action.kind));
      const oracleNames = new Set<string>(charter.oracles ?? []);
      checks.level = expectation.level === undefined || charter.level === expectation.level;
      checks.requiredActions = expectation.requiredActionKinds.every((kind) => actionKinds.has(kind));
      checks.forbiddenActions = expectation.forbiddenActionKinds.every((kind) => !actionKinds.has(kind));
      checks.requiredOracles = expectation.requiredOracleNames.every((name) => oracleNames.has(name));
      checks.assertions = !expectation.requireAssertions || hasPositiveSurfaceAssertion(charter.assertions);
      checks.negativeCases = !expectation.requireNegativeCases || (charter.negativeCases?.length ?? 0) > 0;
      const plannedSelectors = selectorsInCharter(charter);
      checks.requiredSelectors = expectation.requiredSelectors.every((selector) => plannedSelectors.includes(selector));
      const surfaceSnapshot = benchmarkCase.surfaceSnapshot;
      const observedSelectors = surfaceSnapshot === undefined
        ? expectation.requireObservedSelectors === false
        : expectation.requireObservedSelectors && selectorsInCharter(charter).every((selector) => snapshotSelectors(surfaceSnapshot).has(selector));
      checks.observedSelectors = observedSelectors;
      if (!checks.level) failures.push(`expected level ${expectation.level}, received ${charter.level}`);
      if (!checks.requiredActions) failures.push(`missing required action kind(s): ${expectation.requiredActionKinds.filter((kind) => !actionKinds.has(kind)).join(", ")}`);
      if (!checks.forbiddenActions) failures.push(`contains forbidden action kind(s): ${expectation.forbiddenActionKinds.filter((kind) => actionKinds.has(kind)).join(", ")}`);
      if (!checks.requiredOracles) failures.push(`missing required Oracle(s): ${expectation.requiredOracleNames.filter((name) => !oracleNames.has(name)).join(", ")}`);
      if (!checks.assertions) failures.push("no positive surface assertion was generated");
      if (!checks.negativeCases) failures.push("no negative case was generated");
      if (!checks.requiredSelectors) failures.push(`missing required selector(s): ${expectation.requiredSelectors.filter((selector) => !plannedSelectors.includes(selector)).join(", ")}`);
      if (!checks.observedSelectors) failures.push("planned selector is absent from the supplied observed surface snapshot");
      const score = admissionIssues.length ? 0 : scoreChecks(checks);
      results.push({ caseId: benchmarkCase.caseId, planner: provider.name, valid: failures.length === 0, score, checks, failures,
        ...(admissionIssues.length ? { admissionIssues } : {}), charter });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        caseId: benchmarkCase.caseId,
        planner: provider.name,
        valid: false,
        score: 0,
        checks,
        failures: [message],
        error: message,
      });
    }
  }
  const passed = results.filter((result) => result.valid).length;
  const averageScore = results.length === 0 ? 0 : results.reduce((total, result) => total + result.score, 0) / results.length;
  const failureCounts = {
    level: results.filter((result) => !result.checks.level).length,
    requiredActions: results.filter((result) => !result.checks.requiredActions).length,
    forbiddenActions: results.filter((result) => !result.checks.forbiddenActions).length,
    requiredOracles: results.filter((result) => !result.checks.requiredOracles).length,
    assertions: results.filter((result) => !result.checks.assertions).length,
    negativeCases: results.filter((result) => !result.checks.negativeCases).length,
    requiredSelectors: results.filter((result) => !result.checks.requiredSelectors).length,
    observedSelectors: results.filter((result) => !result.checks.observedSelectors).length,
    providerErrors: results.filter((result) => result.error !== undefined).length,
    requirements: results.filter((result) => result.admissionIssues?.length).length,
  };
  return {
    planner: provider.name,
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    averageScore,
    failureCounts,
    results,
  };
}

function selectorsInCharter(charter: TestCharter): string[] {
  return charter.actions.flatMap((action) => {
    if (action.kind === "click" || action.kind === "fill" || action.kind === "press" || action.kind === "selectOption" || action.kind === "selectOptions" || action.kind === "setChecked" || action.kind === "setInputFiles") return [action.selector];
    if (action.kind === "captureResponse") return [action.trigger.selector, ...(action.followUp ? [action.followUp.selector] : [])];
    return [];
  });
}

function snapshotSelectors(snapshot: SurfaceSnapshot): Set<string> {
  return new Set((snapshot.controls ?? []).flatMap((control) => control.selector ? [control.selector] : []));
}

function scoreChecks(checks: PlannerBenchmarkResult["checks"]): number {
  const values = Object.values(checks);
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}
