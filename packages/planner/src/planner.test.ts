import { describe, expect, it } from "vitest";
import { DeterministicPlannerProvider, IntentPlanner, OpenAICompatiblePlannerProvider, StructuredPlanner, assessPlanningQuality, intentTestLevelHints, resolveTestLevel } from "./index.js";

const projectMap = {
  root: ".", scripts: {}, workspaces: [], packages: [],
  detected: { web: true, electron: false, backend: false },
  inventory: { filesScanned: 0, truncated: false, source: "filesystem" as const, sourceFiles: 0, testFiles: 0, configFiles: 0, testFrameworks: [], entryPoints: [], routeHints: [] },
  generatedAt: new Date().toISOString(),
};

describe("IntentPlanner", () => {
  it("propagates cancellation to the configured provider request", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const provider = new OpenAICompatiblePlannerProvider({ baseUrl: "http://127.0.0.1/v1", model: "fixture", fetchImpl: async (_input, init) => {
      requestSignal = init!.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => { requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }); });
    } });
    const pending = provider.plan({ intent: "Observe", projectMap, constraints: {}, signal: controller.signal });
    const reason = new Error("Stop model planning"); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("creates executable navigation and text assertions", () => {
    const charter = new IntentPlanner().plan("打开招聘页", { url: "https://example.com", expect: ["Example"] });
    expect(charter.actions).toEqual([{ kind: "goto", url: "https://example.com" }, { kind: "observe" }]);
    expect(charter.assertions).toEqual([{ kind: "text-visible", text: "Example" }]);
    expect(charter.metadata.planner).toBe("deterministic-v1");
    expect(charter.level).toBe("core");
  });

  it("marks a plan selector as unverified when it is absent from the supplied surface observation", () => {
    const charter = {
      intent: "submit the form", level: "quick" as const, mode: "guided" as const,
      preconditions: [], actions: [{ kind: "click" as const, selector: "#submit" }, { kind: "observe" as const }],
      assertions: [{ kind: "text-visible" as const, text: "Saved" }], sideEffectPolicy: "allow" as const,
      metadata: {},
    };
    const quality = assessPlanningQuality(charter, {
      constraints: { requireAssertions: true },
      surfaceSnapshot: { capturedAt: new Date().toISOString(), url: "http://fixture", controls: [{ tag: "input", role: "textbox", selector: "#email", disabled: false }], metadata: {} },
    });
    expect(quality.evidenceGaps).toContain("surface-selector");
    expect(quality.missingInputs[0]).toContain("#submit");
  });

  it("records missing core proof and release negative cases as planning gaps", () => {
    const core = new IntentPlanner().plan("检查简历获取", { level: "core" });
    expect(core.planning?.evidenceGaps).toEqual(["surface-assertion", "business-oracle"]);
    const release = new IntentPlanner().plan("上线前完整回归", { level: "release" });
    expect(release.planning?.evidenceGaps).toEqual(["surface-assertion", "business-oracle", "negative-case"]);
  });

  it("does not treat an absence-only check as proof that a surface loaded", () => {
    const charter = new IntentPlanner().fromYaml("intent: check page\nlevel: quick\nactions: []\nassertions:\n  - kind: text-not-visible\n    text: Error\n");
    expect(assessPlanningQuality(charter, { constraints: { requireAssertions: true } }).evidenceGaps)
      .toContain("surface-assertion");
  });

  it("keeps legacy Charters readable without planning metadata", () => {
    const charter = new IntentPlanner().fromYaml("intent: verify an existing flow\nactions: []\nassertions: []\n");
    expect(charter.planning).toBeUndefined();
    expect(assessPlanningQuality(charter, { constraints: { requireAssertions: true, requireBusinessOracle: true } }).evidenceGaps)
      .toEqual(["surface-assertion", "business-oracle"]);
  });

  it("reports partial discovery separately from executable scenario proof without trusting provider claims", async () => {
    const planner = new StructuredPlanner({
      name: "openai-compatible",
      async plan() {
        return {
          intent: "verify resume acquisition", level: "core", actions: [{ kind: "observe" }],
          assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["resume-terminal"],
          planning: { source: "model", confidence: 1, evidenceGaps: ["invented-gap"] },
        };
      },
    });
    const charter = await planner.plan({
      intent: "verify resume acquisition",
      projectMap: { ...projectMap, inventory: { ...projectMap.inventory, truncated: true } },
      constraints: { requireAssertions: true, requireBusinessOracle: true, allowedOracleNames: ["resume-terminal"] },
    });
    expect(charter.planning).toMatchObject({ source: "model", evidenceGaps: [], coverage: {
      requested: "declared", source: "default", inventory: "partial", workflowCoverage: "unmeasured",
      gaps: ["project-map-truncated", "project-workflow-coverage"],
    } });
    expect(charter.planning?.confidence).toBeLessThan(1);
    expect(charter.planning?.confidence).toBe(assessPlanningQuality(charter, {
      projectMap: { ...projectMap, inventory: { ...projectMap.inventory, truncated: true } },
      constraints: { requireAssertions: true, requireBusinessOracle: true },
      source: "deterministic",
    }).confidence);
    expect(charter.planning?.evidenceGaps).not.toContain("invented-gap");
  });

  it("keeps a whole-project request unproven even when a model narrows its Charter and reports confidence", async () => {
    const planner = new StructuredPlanner({ name: "model", async plan() {
      return { intent: "check one page", level: "quick", actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "ready" }],
        planning: { confidence: 1, evidenceGaps: [], coverage: { requested: "declared", source: "explicit", reason: "model claim", inventory: "bounded", workflowCoverage: "unmeasured", gaps: [] } },
      };
    } });
    const charter = await planner.plan({ intent: "测试整个项目", projectMap, constraints: { level: "quick", requireAssertions: true } });
    expect(charter.planning).toMatchObject({ evidenceGaps: ["project-workflow-coverage"], coverage: { requested: "project", source: "inferred" } });
  });

  it("resolves explicit and natural-language test levels without upgrading the request", () => {
    expect(resolveTestLevel("快速检查简历获取").resolved).toBe("quick");
    expect(resolveTestLevel("执行核心链路测试").resolved).toBe("core");
    expect(resolveTestLevel("上线前完整回归").resolved).toBe("release");
    expect(resolveTestLevel("检查简历获取").resolved).toBe("core");
    expect(resolveTestLevel("上线前完整回归", "quick")).toMatchObject({ resolved: "quick", source: "explicit" });
    expect(intentTestLevelHints("上线前完整回归")).toEqual(["release"]);
    expect(intentTestLevelHints("快速检查上线功能")).toEqual(["release", "quick"]);
    expect(intentTestLevelHints("测试登录功能")).toEqual([]);
  });

  it("validates provider output before it becomes executable", async () => {
    const planner = new StructuredPlanner({
      name: "test-provider",
      async plan() {
        return { intent: "safe", actions: [{ kind: "run-shell", command: "whoami" }] };
      },
    });
    await expect(planner.plan({
      intent: "safe",
      projectMap,
      constraints: {},
    })).rejects.toThrow();
  });

  it("keeps deterministic planning available as a provider", async () => {
    const provider = new DeterministicPlannerProvider();
    const charter = await new StructuredPlanner(provider).plan({
      intent: "打开首页",
      projectMap,
      constraints: { url: "https://example.com", expect: ["Example"] },
    });
    expect(charter.metadata.planner).toBe("deterministic-v1");
  });

  it("parses JSON from an OpenAI-compatible provider without executing model output", async () => {
    let requestBody = "";
    const provider = new OpenAICompatiblePlannerProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "local-test",
      apiKey: "test-secret",
      fetchImpl: async (_input, init) => {
        requestBody = String(init?.body);
        return new Response(JSON.stringify({
          choices: [{ message: { content: `\`\`\`json
{"intent":"local","actions":[{"kind":"observe"}],"assertions":[]}
\`\`\`` } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const output = await provider.plan({
      intent: "观察首页",
      projectMap,
      constraints: {},
      surfaceSnapshot: { capturedAt: new Date().toISOString(), url: "http://fixture", controls: [{ tag: "button", role: "button", selector: "#ready", disabled: false }], metadata: {} },
    });
    expect(output).toMatchObject({ intent: "local" });
    expect(requestBody).toContain('"model":"local-test"');
    expect(requestBody).toContain("ProofKit Test Charter");
    expect(requestBody).toContain("surfaceSnapshot");
  });
});
