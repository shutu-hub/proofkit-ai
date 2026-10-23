import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function service() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-intent-level-")); roots.push(root);
  return new LocalRunnerService({ root, workspaceRoot: root });
}
const originalIntent = "Review one currently published product page against this frozen public catalog baseline and an independent current-record GET. No cart, account, order or payment mutations. This is a targeted field-reader regression, not entire store acceptance.";

describe("Mission intent intensity admission", () => {
  it.each([
    { intent: originalIntent, level: "core" as const },
    { intent: "Smoke check only; no release regression.", level: "quick" as const },
    { intent: "无需发布门禁，做快速检查", level: "quick" as const },
    { intent: "No release, regression or smoke tests. Check the core path.", level: "core" as const },
  ])("saves the full original intent without upgrading a $level Charter", async ({ intent, level }) => {
    const runner = await service();
    const charter = TestCharterSchema.parse({ intent, level, actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "reviewed" }],
      oracles: level === "core" ? ["reviewed-fields"] : [], sideEffectPolicy: "deny" });
    const mission = await runner.createMission({ intent, surface: "web", charter });
    expect(mission.intent).toBe(intent); expect(mission.level).toBe(level);
    expect(mission.charter?.intent).toBe(intent); expect(mission.agentSteps).toEqual([]); expect(mission.verdict).toBeUndefined();
    const saved = (await runner.missionStatus(mission.missionId)).mission; expect(saved.intent).toBe(intent);
    expect(saved.levelSelection).toMatchObject({ requested: level, resolved: level, source: "explicit" });
    const bytes = await readFile(join(runner.workspaceRoot, ".proofkit/missions", mission.missionId + ".json"), "utf8");
    expect(JSON.parse(bytes).intent).toBe(intent);
  });
  it.each([
    "Do not run smoke tests; run full release regression.",
    "不要做冒烟测试，执行上线前回归测试",
    "Do not skip release regression.",
    "不要省略上线回归测试",
  ])("still rejects an explicit quick selection for %s", async (intent) => {
    const runner = await service();
    const charter = TestCharterSchema.parse({ intent, level: "quick", actions: [], assertions: [{ kind: "text-visible", text: "reviewed" }] });
    await expect(runner.createMission({ intent, surface: "web", charter })).rejects.toThrow("intent indicates release but supplied selection is quick");
  });
});
