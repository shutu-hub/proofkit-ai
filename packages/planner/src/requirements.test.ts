import { describe, expect, it } from "vitest";
import type { ProjectMap, TestCharter } from "@proofkit/contracts";
import { StructuredPlanner, type PlannerConstraints } from "./core.js";

const projectMap: ProjectMap = { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false },
  inventory: { filesScanned: 0, truncated: false, source: "filesystem", sourceFiles: 0, testFiles: 0, configFiles: 0, testFrameworks: [], entryPoints: [], routeHints: [] }, generatedAt: "2026-10-21T00:00:00.000Z" };
const draft = (changed: Partial<TestCharter> = {}) => ({ intent: "Only check that the page loads", level: "quick", mode: "deterministic", sideEffectPolicy: "deny",
  actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Note saved" }], oracles: ["current-record", "other-account"], ...changed });
const planner = (output: unknown) => new StructuredPlanner({ name: "constraint-fixture", plan: async () => output });
const constraints: PlannerConstraints = { level: "core", mode: "deterministic", sideEffectPolicy: "deny", expect: ["Note saved"],
  oracleNames: ["current-record", "other-account"], allowedOracleNames: ["current-record", "other-account", "extra-reader"], allowedActionKinds: ["observe"] };

describe("authoritative planning requirements", () => {
  it.each([
    "Create a private note, reload it and verify the exact content and ownership. Do not share it.",
    "新增笔记后刷新，验证内容、归属和另一账号隔离；不执行分享。",
    "Original intent with formatting:\n  Verify saved content.\n  Preserve the required negative check.",
  ])("preserves the complete original request rather than the model's shorter intent: %s", async (intent) => {
    const output = draft(); const before = structuredClone(output);
    const charter = await planner(output).plan({ intent, projectMap, constraints });
    expect(charter.intent).toBe(intent); expect(output).toEqual(before);
    expect(charter.level).toBe("core");
  });

  it.each([
    ["deterministic", "explore"], ["guided", "deterministic"], ["explore", "guided"],
  ] as const)("rejects changing requested execution mode %s to %s", async (requested, proposed) => {
    await expect(planner(draft({ mode: proposed })).plan({ intent: "Verify the complete note", projectMap,
      constraints: { ...constraints, mode: requested } })).rejects.toThrow("requested execution mode");
  });

  it.each([
    ["deny", "allow"], ["allow", "confirm"], ["confirm", "deny"],
  ] as const)("rejects changing requested side-effect policy %s to %s", async (requested, proposed) => {
    await expect(planner(draft({ sideEffectPolicy: proposed })).plan({ intent: "Verify the complete note", projectMap,
      constraints: { ...constraints, sideEffectPolicy: requested } })).rejects.toThrow("side-effect policy");
  });

  it.each([
    ["current-record"], ["current-record", "other-account", "extra-reader"], ["current-record", "current-record"], [],
  ])("rejects changed requested independent readers %j", async (...proposed) => {
    await expect(planner(draft({ oracles: proposed })).plan({ intent: "Verify content and isolation", projectMap, constraints })).rejects.toThrow("requested business oracles");
  });

  it("keeps rejected draft inputs out of ordinary error serialization", async () => {
    const error = await planner(draft({ mode: "explore", metadata: { diagnosticFixture: "DO_NOT_LOG_REJECTED_DRAFT" } })).plan({ intent: "Verify the note", projectMap, constraints }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).toContain("requested execution mode");
    expect(JSON.stringify(error)).not.toContain("DO_NOT_LOG_REJECTED_DRAFT");
  });

  it("accepts the same reader multiset in a different order without changing the input", async () => {
    const requested = ["current-record", "other-account"];
    const charter = await planner(draft({ oracles: [...requested].reverse() })).plan({ intent: "Verify content and isolation", projectMap, constraints: { ...constraints, oracleNames: requested } });
    expect(charter.oracles).toEqual(["other-account", "current-record"]); expect(requested).toEqual(["current-record", "other-account"]);
  });

  it("does not replace a repeated required reader with an additional allowed reader", async () => {
    await expect(planner(draft()).plan({ intent: "Verify repeated observations", projectMap, constraints: { ...constraints, oracleNames: ["current-record", "current-record"] } })).rejects.toThrow("requested business oracles");
  });

  it("honors an explicit empty reader request while leaving an unspecified selection available", async () => {
    await expect(planner(draft()).plan({ intent: "UI-only scope", projectMap, constraints: { ...constraints, oracleNames: [] } })).rejects.toThrow("requested business oracles");
    const charter = await planner(draft()).plan({ intent: "Observed scope", projectMap, constraints: { ...constraints, oracleNames: undefined, mode: undefined, sideEffectPolicy: undefined } });
    expect(charter.oracles).toEqual(["current-record", "other-account"]);
  });
});
