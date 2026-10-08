import { z } from "zod";
import { ProjectMapSchema, TestLevelSchema, type TestCharter } from "@proofkit/contracts";
import { PlannerConstraintsSchema, StructuredPlanner, type PlannerProvider } from "./core.js";

export const PlannerBenchmarkExpectationSchema = z.object({
  level: TestLevelSchema.optional(),
  requiredActionKinds: z.array(z.string().min(1)).default([]),
  forbiddenActionKinds: z.array(z.string().min(1)).default([]),
  requiredOracleNames: z.array(z.string().min(1)).default([]),
  requireAssertions: z.boolean().default(false),
  requireNegativeCases: z.boolean().default(false),
});
export type PlannerBenchmarkExpectation = z.infer<typeof PlannerBenchmarkExpectationSchema>;

export const PlannerBenchmarkCaseSchema = z.object({
  caseId: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  intent: z.string().min(1),
  projectMap: ProjectMapSchema,
  constraints: PlannerConstraintsSchema,
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
  };
  failures: string[];
  charter?: TestCharter;
  error?: string;
};

export type PlannerBenchmarkReport = {
  planner: string;
  total: number;
  passed: number;
  passRate: number;
  averageScore: number;
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
    };
    const failures: string[] = [];
    try {
      const charter = await planner.plan({
        intent: benchmarkCase.intent,
        projectMap: benchmarkCase.projectMap,
        constraints: benchmarkCase.constraints,
      });
      const actionKinds = new Set<string>(charter.actions.map((action) => action.kind));
      const oracleNames = new Set<string>(charter.oracles ?? []);
      checks.level = expectation.level === undefined || charter.level === expectation.level;
      checks.requiredActions = expectation.requiredActionKinds.every((kind) => actionKinds.has(kind));
      checks.forbiddenActions = expectation.forbiddenActionKinds.every((kind) => !actionKinds.has(kind));
      checks.requiredOracles = expectation.requiredOracleNames.every((name) => oracleNames.has(name));
      checks.assertions = !expectation.requireAssertions || charter.assertions.length > 0;
      checks.negativeCases = !expectation.requireNegativeCases || (charter.negativeCases?.length ?? 0) > 0;
      if (!checks.level) failures.push(`expected level ${expectation.level}, received ${charter.level}`);
      if (!checks.requiredActions) failures.push(`missing required action kind(s): ${expectation.requiredActionKinds.filter((kind) => !actionKinds.has(kind)).join(", ")}`);
      if (!checks.forbiddenActions) failures.push(`contains forbidden action kind(s): ${expectation.forbiddenActionKinds.filter((kind) => actionKinds.has(kind)).join(", ")}`);
      if (!checks.requiredOracles) failures.push(`missing required Oracle(s): ${expectation.requiredOracleNames.filter((name) => !oracleNames.has(name)).join(", ")}`);
      if (!checks.assertions) failures.push("no assertion was generated");
      if (!checks.negativeCases) failures.push("no negative case was generated");
      const score = scoreChecks(checks);
      results.push({ caseId: benchmarkCase.caseId, planner: provider.name, valid: failures.length === 0, score, checks, failures, charter });
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
  return {
    planner: provider.name,
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    averageScore,
    results,
  };
}

function scoreChecks(checks: PlannerBenchmarkResult["checks"]): number {
  const values = Object.values(checks);
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}

