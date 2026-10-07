import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { ProjectMapSchema, TestCharterSchema, type Assertion, type ProjectMap, type RunMode, type SideEffectPolicy, type TestCharter } from "@proofkit/contracts";

export type PlanOptions = {
  url?: string;
  expect?: string[];
  mode?: RunMode;
  sideEffectPolicy?: SideEffectPolicy;
  oracleNames?: string[];
};

export type PlannerConstraints = PlanOptions & {
  allowedActionKinds?: string[];
  allowedOracleNames?: string[];
  requireAssertions?: boolean;
};

export type PlannerInput = {
  intent: string;
  projectMap: ProjectMap;
  constraints: PlannerConstraints;
};

export interface PlannerProvider {
  readonly name: string;
  plan(input: PlannerInput): Promise<unknown>;
}

export class IntentPlanner {
  plan(intent: string, options: PlanOptions = {}): TestCharter {
    const url = options.url ?? intent.match(/https?:\/\/[^\s]+/)?.[0];
    const assertions: Assertion[] = (options.expect ?? []).map((text) => ({ kind: "text-visible", text }));
    const actions: TestCharter["actions"] = [];
    if (url) actions.push({ kind: "goto", url });
    actions.push({ kind: "observe" });

    return TestCharterSchema.parse({
      intent,
      mode: options.mode ?? "guided",
      preconditions: ["运行在隔离的测试环境", "使用可回滚的测试数据"],
      actions,
      assertions,
      oracles: options.oracleNames,
      sideEffectPolicy: options.sideEffectPolicy ?? "confirm",
      metadata: { planner: "deterministic-v1", url: url ?? null },
    });
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
    try {
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
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
              content: "You generate only a ProofKit Test Charter JSON object. Preserve the user's intent, the exact sideEffectPolicy constraint, and explicitly requested oracleNames. Use only allowedActionKinds and allowedOracleNames. Never generate shell commands, SQL, arbitrary JavaScript, or credentials. Include an assertion when the constraints require it.",
            },
            {
              role: "user",
              content: JSON.stringify({ intent: input.intent, projectMap: input.projectMap, constraints: input.constraints }),
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

  constructor(provider: PlannerProvider) {
    this.provider = provider;
  }

  async plan(input: PlannerInput): Promise<TestCharter> {
    const candidate = await this.provider.plan(input);
    const charter = TestCharterSchema.parse(candidate);
    if (input.constraints.requireAssertions && charter.assertions.length === 0) {
      throw new Error("Planner output must include at least one assertion");
    }
    if (input.constraints.allowedActionKinds && charter.actions.some((action) => !input.constraints.allowedActionKinds?.includes(action.kind))) {
      throw new Error("Planner output contains an action outside the allowed action kinds");
    }
    if (input.constraints.allowedOracleNames && charter.oracles?.some((name) => !input.constraints.allowedOracleNames?.includes(name))) {
      throw new Error("Planner output references an unregistered oracle");
    }
    return TestCharterSchema.parse({
      ...charter,
      metadata: { ...charter.metadata, planner: this.provider.name },
    });
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
