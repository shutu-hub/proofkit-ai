import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { TestCharterSchema, type Assertion, type RunMode, type SideEffectPolicy, type TestCharter } from "@proofkit/contracts";

export type PlanOptions = {
  url?: string;
  expect?: string[];
  mode?: RunMode;
  sideEffectPolicy?: SideEffectPolicy;
};

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

export async function loadCharter(path: string): Promise<TestCharter> {
  const planner = new IntentPlanner();
  return planner.fromYaml(await readFile(path, "utf8"));
}

export function planIntent(intent: string, options?: PlanOptions): TestCharter {
  return new IntentPlanner().plan(intent, options);
}
