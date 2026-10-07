import { describe, expect, it } from "vitest";
import { DeterministicPlannerProvider, IntentPlanner, OpenAICompatiblePlannerProvider, StructuredPlanner } from "./index.js";

describe("IntentPlanner", () => {
  it("creates executable navigation and text assertions", () => {
    const charter = new IntentPlanner().plan("打开招聘页", { url: "https://example.com", expect: ["Example"] });
    expect(charter.actions).toEqual([{ kind: "goto", url: "https://example.com" }, { kind: "observe" }]);
    expect(charter.assertions).toEqual([{ kind: "text-visible", text: "Example" }]);
    expect(charter.metadata.planner).toBe("deterministic-v1");
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
      projectMap: { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false }, generatedAt: new Date().toISOString() },
      constraints: {},
    })).rejects.toThrow();
  });

  it("keeps deterministic planning available as a provider", async () => {
    const provider = new DeterministicPlannerProvider();
    const charter = await new StructuredPlanner(provider).plan({
      intent: "打开首页",
      projectMap: { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false }, generatedAt: new Date().toISOString() },
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
      projectMap: { root: ".", scripts: {}, workspaces: [], packages: [], detected: { web: true, electron: false, backend: false }, generatedAt: new Date().toISOString() },
      constraints: {},
    });
    expect(output).toMatchObject({ intent: "local" });
    expect(requestBody).toContain('"model":"local-test"');
    expect(requestBody).toContain("ProofKit Test Charter");
  });
});
