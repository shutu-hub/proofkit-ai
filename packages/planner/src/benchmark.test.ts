import { describe, expect, it, vi } from "vitest";
import { evaluatePlannerBenchmark, type PlannerBenchmarkCase } from "./benchmark.js";

const projectMap = {
  root: ".",
  scripts: {},
  workspaces: [],
  packages: [],
  detected: { web: true, electron: true, backend: true },
  inventory: { filesScanned: 0, truncated: false, source: "filesystem" as const, sourceFiles: 0, testFiles: 0, configFiles: 0, testFrameworks: [], entryPoints: [], routeHints: [] },
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
    requiredSelectors: [],
    requireObservedSelectors: false,
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
    expect(report.failureCounts).toEqual({ level: 0, requiredActions: 0, forbiddenActions: 0, requiredOracles: 0, assertions: 0, negativeCases: 0, requiredSelectors: 0, observedSelectors: 0, providerErrors: 0, requirements: 0 });
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
      constraints: { ...baseCase().constraints, expect: undefined },
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
      "no positive surface assertion was generated",
    ]));
    expect(report.failureCounts).toMatchObject({ requiredActions: 1, forbiddenActions: 1, requiredOracles: 1, assertions: 1 });
  });

  it("rejects a mode change even when all structural benchmark expectations pass", async () => {
    const report = await evaluatePlannerBenchmark({ name: "changed-mode", async plan() {
      return { intent: "Narrowed", mode: "explore", sideEffectPolicy: "confirm", actions: [{ kind: "goto", url: "https://example.com" }, { kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "完成" }], oracles: ["job-status"] };
    } }, [baseCase({ constraints: { ...baseCase().constraints, mode: "deterministic" } })]);
    expect(report.results[0]).toMatchObject({ valid: false, score: 0, admissionIssues: ["Planner changed the requested execution mode"], charter: { intent: "执行核心链路测试" } });
    expect(Object.values(report.results[0]!.checks).every(Boolean)).toBe(true);
    expect(report.failureCounts).toMatchObject({ providerErrors: 0, requirements: 1 });
  });

  it("returns a zero score when provider output is invalid", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "broken-fixture",
      async plan() {
        throw new Error("provider unavailable");
      },
    }, [baseCase()]);

    expect(report.results[0]).toMatchObject({ valid: false, score: 0, error: "provider unavailable" });
    expect(report.failureCounts.providerErrors).toBe(1);
  });

  it("does not execute a capability action while evaluating a plan", async () => {
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
  });

  it("uses zero aggregates for an empty benchmark", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "empty-fixture",
      async plan() {
        return {};
      },
    }, []);

    expect(report).toMatchObject({ total: 0, passed: 0, passRate: 0, averageScore: 0, results: [] });
    expect(report.failureCounts).toEqual({ level: 0, requiredActions: 0, forbiddenActions: 0, requiredOracles: 0, assertions: 0, negativeCases: 0, requiredSelectors: 0, observedSelectors: 0, providerErrors: 0, requirements: 0 });
  });

  it("fails a plan that invents a selector absent from the observed surface", async () => {
    const report = await evaluatePlannerBenchmark({
      name: "selector-fixture",
      async plan() {
        return {
          intent: "执行核心链路测试", level: "core", mode: "guided",
          actions: [{ kind: "goto", url: "https://example.com" }, { kind: "click", selector: "#missing" }],
          assertions: [{ kind: "text-visible", text: "完成" }], sideEffectPolicy: "allow",
        };
      },
    }, [baseCase({
      surfaceSnapshot: { capturedAt: new Date(0).toISOString(), url: "https://example.com", title: "Example", text: "", controls: [{ tag: "button", role: "button", name: "Save", selector: "#save", visible: true, disabled: false }], controlsTruncated: false, metadata: {} },
      expect: { ...baseCase().expect, requiredSelectors: ["#missing"], requireObservedSelectors: true },
    })]);
    expect(report.passed).toBe(0);
    expect(report.failureCounts.observedSelectors).toBe(1);
    expect(report.results[0]?.failures).toContain("planned selector is absent from the supplied observed surface snapshot");
  });
});
