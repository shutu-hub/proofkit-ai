import { describe, expect, it, vi } from "vitest";
import { evaluatePlannerBenchmark, type PlannerBenchmarkCase } from "./benchmark.js";

const projectMap = {
  root: ".",
  scripts: {},
  workspaces: [],
  packages: [],
  detected: { web: true, electron: true, backend: true },
  generatedAt: new Date(0).toISOString(),
};

const baseCase = (overrides: Partial<PlannerBenchmarkCase> = {}): PlannerBenchmarkCase => ({
  caseId: "core-flow",
  intent: "执行核心链路测试",
  projectMap,
  constraints: {
    url: "https://example.com",
    expect: ["完成"],
    oracleNames: ["job-status"],
  },
  expect: {
    level: "core",
    requiredActionKinds: ["goto", "observe"],
    forbiddenActionKinds: [],
    requiredOracleNames: ["job-status"],
    requireAssertions: true,
    requireNegativeCases: false,
  },
  ...overrides,
});

describe("evaluatePlannerBenchmark", () => {
  it("evaluates a valid charter without executing any runtime capability", async () => {
    const provider = {
      name: "fixture",
      plan: vi.fn(async () => ({
        intent: "执行核心链路测试",
        level: "core",
        mode: "guided",
        actions: [
          { kind: "goto", url: "https://example.com" },
          { kind: "observe" },
        ],
        assertions: [{ kind: "text-visible", text: "完成" }],
        oracles: ["job-status"],
        sideEffectPolicy: "confirm",
      })),
    };

    const report = await evaluatePlannerBenchmark(provider, [baseCase()]);

    expect(report).toMatchObject({ planner: "fixture", total: 1, passed: 1, passRate: 1, averageScore: 1 });
    expect(provider.plan).toHaveBeenCalledTimes(1);
  });

  it("reports missing assertions, Oracle and forbidden actions", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "unsafe-fixture",
      async plan() {
        return {
          intent: "执行核心链路测试",
          level: "core",
          actions: [{ kind: "observe" }, { kind: "screenshot" }],
          assertions: [],
          sideEffectPolicy: "confirm",
        };
      },
    }, [{
      ...baseCase(),
      expect: {
        ...baseCase().expect,
        requiredActionKinds: ["goto"],
        forbiddenActionKinds: ["screenshot"],
        requiredOracleNames: ["job-status"],
        requireAssertions: true,
      },
    }]);

    expect(report.passed).toBe(0);
    expect(report.results[0]?.valid).toBe(false);
    expect(report.results[0]?.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("missing required action"),
      expect.stringContaining("contains forbidden action"),
      expect.stringContaining("missing required Oracle"),
      "no assertion was generated",
    ]));
  });

  it("returns a zero score when provider output is invalid", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "broken-fixture",
      async plan() {
        throw new Error("provider unavailable");
      },
    }, [baseCase()]);

    expect(report.results[0]).toMatchObject({ valid: false, score: 0, error: "provider unavailable" });
  });

  it("does not execute a capability action while evaluating a plan", async () => {
    const capability = vi.fn();
    const report = await evaluatePlannerBenchmark({
      name: "capability-fixture",
      async plan() {
        return {
          intent: "执行核心链路测试",
          level: "core",
          actions: [{ kind: "capability", name: "should-not-run", input: {} }],
          assertions: [{ kind: "text-visible", text: "完成" }],
          oracles: ["job-status"],
          sideEffectPolicy: "deny",
        };
      },
    }, [baseCase({ expect: { ...baseCase().expect, requiredActionKinds: ["capability"] } })]);

    expect(report.results[0]?.valid).toBe(true);
    expect(capability).not.toHaveBeenCalled();
  });

  it("uses zero aggregates for an empty benchmark", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "empty-fixture",
      async plan() {
        return {};
      },
    }, []);

    expect(report).toMatchObject({ total: 0, passed: 0, passRate: 0, averageScore: 0, results: [] });
  });
});
