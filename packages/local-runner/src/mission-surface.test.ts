import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestCharter } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";
import { requestedMissionSurfaces } from "./mission-surface.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const charter: TestCharter = {
  intent: "检查登录页面", level: "core", mode: "deterministic", preconditions: [], actions: [],
  assertions: [{ kind: "text-visible", text: "登录" }], oracles: ["login-state"],
  sideEffectPolicy: "deny", metadata: {},
};

async function service(): Promise<LocalRunnerService> {
  const root = await mkdtemp(join(tmpdir(), "proofkit-mission-surface-"));
  roots.push(root);
  return new LocalRunnerService({ root, workspaceRoot: root });
}

describe("Mission platform selection", () => {
  it("uses only explicit platform words, including a multi-platform request", () => {
    expect(requestedMissionSurfaces("测试桌面端简历获取")).toEqual(["electron"]);
    expect(requestedMissionSurfaces("Test the mobile app on Android")).toEqual(["mobile"]);
    expect(requestedMissionSurfaces("测试 Web 和 Electron 上线回归")).toEqual(["web", "electron"]);
    expect(requestedMissionSurfaces("测试简历获取核心链路")).toEqual([]);
  });

  it("selects Electron for an omitted surface and rejects a conflicting core Web request", async () => {
    const runner = await service();
    const electron = await runner.createMission({ intent: "测试 Electron 桌面端登录", charter });
    expect(electron.surface).toBe("electron");
    expect(electron.plan.executionProfile.surfaceMatrix).toEqual(["electron"]);
    await expect(runner.createMission({ intent: "测试桌面端登录", surface: "web", charter }))
      .rejects.toThrow("electron surface is absent");
  });

  it("keeps a release Web/Electron matrix when both platforms are requested", async () => {
    const runner = await service();
    const release = await runner.createMission({
      intent: "测试 Web 和 Electron 上线回归", level: "release", surface: "web",
      charter: { ...charter, level: "release" },
    });
    expect(release.plan.executionProfile.surfaceMatrix).toEqual(["web", "electron"]);
    await expect(runner.createMission({ intent: "测试 Web 和 Electron 核心链路", charter }))
      .rejects.toThrow("electron surface is absent");
  });
});
