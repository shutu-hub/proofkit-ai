import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-web-release-")); roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "web-release-fixture", dependencies: { vite: "1" } }));
  await mkdir(join(root, "charters"));
  const charter = TestCharterSchema.parse({ intent: "Verify web note release", level: "release", surfaces: ["web"], mode: "deterministic", sideEffectPolicy: "deny",
    actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["current-record"], negativeCases: [
      { caseId: "unauthorized", title: "Access rejection", intent: "Verify an unrelated account cannot read", actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Denied" }], oracles: ["current-record"], expectedVerdict: "passed", sideEffectPolicy: "deny" } ] });
  for (const id of ["notes", "login"]) await writeFile(join(root, "charters", id + ".yaml"), JSON.stringify({ ...charter, surfaces: undefined }));
  const config = ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "http://127.0.0.1:1" } }, policies: { sideEffects: "deny" },
    charters: ["notes", "login"].map((id) => ({ id, aliases: ["发布" + id], level: "release", surfaces: ["web"], path: "charters/" + id + ".yaml" })) });
  const runner = new LocalRunnerService({ root, workspaceRoot: root, config, integration: { name: "release-check", oracles: [
    { name: "current-record", check: async () => { throw new Error("Planning must not execute the business reader"); } } ] } });
  return { root, runner, charter, config };
}

describe("explicit release platform scope", () => {
  it("allows an explicit Web-only release while retaining replay, negative cases and business proof", async () => {
    const { root, runner, charter } = await fixture();
    const mission = await runner.createMission({ intent: "Verify the web release", charter, surface: "web", level: "release" });
    expect(mission.plan.executionProfile).toMatchObject({ surfaceMatrix: ["web"], requireReplay: true, requireBusinessOracle: true, requireNegativeCases: true });
    expect(mission.plan.graph.tasks.filter((task) => task.tool.startsWith("surface.")).map((task) => task.input.adapter)).toEqual(["web", "web", "web"]);
    const saved = JSON.parse(await readFile(join(root, ".proofkit/missions", mission.missionId + ".json"), "utf8"));
    expect(saved.charter.surfaces).toEqual(["web"]); expect(saved.agentSteps).toEqual([]);
  });

  it("uses an explicit catalog Web-only matrix when the saved legacy Charter omits surfaces", async () => {
    const { runner } = await fixture();
    const scope = await runner.inspectTestScope({ level: "release", surface: "web", focus: "notes" });
    expect(scope.planningReadiness?.status).toBe("catalog-ready");
    expect(scope.targetConfiguration?.required).toEqual([{ surface: "web", status: "configured" }]);
    const mission = await runner.createMission({ intent: "Verify the web release", charterId: "notes", surface: "web", level: "release" });
    expect(mission.charter?.surfaces).toEqual(["web"]); expect(mission.plan.executionProfile.surfaceMatrix).toEqual(["web"]);
  });

  it("does not drop an explicitly requested Electron platform to fit a Web-only plan", async () => {
    const { runner, charter } = await fixture();
    await expect(runner.createMission({ intent: "Verify Web and Electron release", charter, surface: "web", level: "release" })).rejects.toThrow("electron surface is absent");
    await expect(runner.createMission({ intent: "Verify the Electron release", charter, surface: "electron", level: "release" })).rejects.toThrow("surface matrix");
  });

  it("refuses conflicting saved and catalog release matrices instead of silently narrowing them", async () => {
    const { root, runner, charter } = await fixture();
    await writeFile(join(root, "charters/notes.yaml"), JSON.stringify({ ...charter, surfaces: ["web", "electron"] }));
    await expect(runner.createMission({ intent: "Verify the web release", charterId: "notes", surface: "web", level: "release" })).rejects.toThrow("conflicting release surfaces");
    const scope = await runner.inspectTestScope({ level: "release", surface: "web", focus: "notes" });
    expect(scope.catalog.items.find((item) => item.id === "notes")?.check.planReady).toBe(false);
  });

  it("keeps the historical two-platform default when a release Charter declares no matrix", async () => {
    const { runner, charter } = await fixture();
    const mission = await runner.createMission({ intent: "Verify the release", charter: { ...charter, surfaces: undefined }, surface: "web", level: "release" });
    expect(mission.plan.executionProfile.surfaceMatrix).toEqual(["web", "electron"]);
  });

  it("creates a declared Web-only catalog suite without requiring an Electron target", async () => {
    const { root, config } = await fixture();
    const runner = new LocalRunnerService({ root, workspaceRoot: root, config: ProofkitConfigSchema.parse({ ...config,
      suites: [{ id: "web-release", aliases: ["网页发布"], level: "release", surfaces: ["web"], charterIds: ["notes", "login"] }] }),
      integration: { name: "release-check", oracles: [{ name: "current-record", check: async () => { throw new Error("Not executed"); } }] } });
    const mission = await runner.createMission({ intent: "Verify the web release", suiteId: "web-release", surface: "web", level: "release" });
    expect(mission.suite?.surfaces).toEqual(["web"]); expect(mission.plan.executionProfile.requireReplay).toBe(true);
    expect(mission.plan.graph.tasks.filter((task) => task.tool === "surface.run-charter")).toHaveLength(2);
    expect(mission.plan.graph.tasks.filter((task) => task.tool === "surface.replay-charter")).toHaveLength(2);
    expect(mission.plan.graph.tasks.filter((task) => task.tool.startsWith("surface.")).every((task) => task.input.adapter === "web")).toBe(true);
  });
});
