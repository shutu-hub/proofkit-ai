import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema, type RunSummary, type TestCharter, type Verdict } from "@proofkit/contracts";
import { captureSourceState } from "@proofkit/project";
import { LocalRunnerService, type LocalAdapterName } from "./index.js";
import { summarizeSuiteScope, verifySuiteMission } from "./suite-verifier.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 20_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit release suites", () => {
  it.each(["primary", "replay", "negative"] as const)("rechecks %s cleanup instead of trusting a saved passing outcome", async (runKind) => {
    const service = await createSuiteService();
    stubRuns(service);
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web" });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).toBe("passed");
    const observation = completed.observations.find((item) => item.data.runKind === runKind)!;
    if (runKind === "negative") expect(observation.data.outcomeMatched).toBe(true);
    for (const status of ["failed", "unverified", "verified"] as const) {
      observation.data.integrationCleanup = status === "verified"
        ? { status, declaredResources: 1, verifiedResources: 1, artifact: `${observation.data.runId}/artifacts/integration-cleanup.json`, sha256: "0".repeat(64) }
        : { status, declaredResources: 1, verifiedResources: 0 };
      expect(verifySuiteMission(completed, service.evidenceDir).verdict).toBe("blocked");
    }
  });

  it("runs two Charters on Web and Electron with separate replay and negative evidence", async () => {
    const service = await createSuiteService();
    const harness = stubRuns(service);
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web" });
    expect(mission.suite?.charters.map((item) => item.charterId)).toEqual(["resume", "login"]);
    expect(mission.levelSelection?.source).toBe("inferred");
    expect(mission.plan.graph.tasks).toHaveLength(14);
    expect(mission.plan.graph.tasks.filter((task) => task.charterId)).toHaveLength(12);
    expect(mission.plan.executionProfile).toMatchObject({ suiteId: "release-critical", charterIds: ["resume", "login"], surfaceMatrix: ["web", "electron"], collectAllResults: true });

    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(harness.started).toHaveLength(8);
    expect(harness.replayed).toHaveLength(4);
    expect(harness.started.filter((item) => item.negativeCaseId)).toHaveLength(4);
    expect(completed.observations.filter((item) => item.kind === "surface.run")).toHaveLength(12);
    expect(completed.observations.filter((item) => item.kind === "surface.run").every((item) => item.charterId === item.data.charterId)).toBe(true);
    expect(evidence.suiteScope).toMatchObject({
      suiteId: "release-critical",
      includedCharterIds: ["resume", "login"],
      uncoveredCharterIds: ["other-release"],
    });
    expect(evidence.suiteScope?.results).toHaveLength(4);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed" && item.missing.length === 0)).toBe(true);
    for (const result of evidence.suiteScope?.results ?? []) {
      expect(result.replay?.sourceRunId).toBe(result.primary?.runId);
      expect(result.negativeCases).toHaveLength(1);
    }

    const replayedMission = await service.replayMission(mission.missionId);
    const replayed = await service.waitMission(replayedMission.mission.missionId);
    expect(replayed.replayOfMissionId).toBe(mission.missionId);
    expect(replayed.suite?.suiteId).toBe("release-critical");
    expect(replayed.verdict).toBe("passed");
  });

  it("continues independent workflows after a product failure and reports the failing Charter", async () => {
    const service = await createSuiteService();
    const harness = stubRuns(service, { failedPrimary: "resume/web" });
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const scope = (await service.missionEvidence(mission.missionId)).suiteScope;
    expect(completed.status).toBe("failed");
    expect(completed.verdict).toBe("failed");
    expect(harness.started).toHaveLength(8);
    expect(harness.replayed).toHaveLength(4);
    expect(scope?.results.find((item) => item.charterId === "resume" && item.surface === "web")?.verdict).toBe("failed");
    expect(scope?.results.filter((item) => item.charterId === "login").every((item) => item.verdict === "passed")).toBe(true);
    expect(completed.findings.some((item) => item.category === "product" && item.charterId === "resume" && item.surface === "web" && item.evidence.length > 0)).toBe(true);
  });

  it("does not borrow an Oracle fact from another Charter or surface", async () => {
    const service = await createSuiteService();
    stubRuns(service, { missingBusinessFact: "resume/electron/replay" });
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const scope = (await service.missionEvidence(mission.missionId)).suiteScope;
    expect(completed.verdict).toBe("inconclusive");
    expect(scope?.results.find((item) => item.charterId === "resume" && item.surface === "electron"))
      .toMatchObject({ verdict: "inconclusive", missing: ["replay independent business fact"] });
    expect(scope?.results.filter((item) => item.charterId === "login").every((item) => item.verdict === "passed")).toBe(true);
    expect(completed.firstFailure?.kind).toBe("evidence");
  });

  it("does not pass a release suite with a saved planning evidence gap", async () => {
    const service = await createSuiteService();
    const charterPath = join(service.workspaceRoot, ".proofkit", "charters", "resume.yml");
    const charter = TestCharterSchema.parse(JSON.parse(await readFile(charterPath, "utf8")));
    await writeFile(charterPath, JSON.stringify({
      ...charter,
      planning: { source: "catalog", confidence: 0.45, assumptions: [], missingInputs: ["完整项目地图"], evidenceGaps: ["project-map-truncated"] },
    }));
    stubRuns(service);
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    expect(mission.plan.planning?.evidenceGaps).toEqual(["project-map-truncated"]);

    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.firstFailure).toMatchObject({ kind: "evidence", message: expect.stringContaining("project-map-truncated") });
    expect(completed.findings.some((item) => item.category === "test" && item.message.includes("project-map-truncated"))).toBe(true);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed")).toBe(true);
    expect(evidence.planning?.evidenceGaps).toEqual(["project-map-truncated"]);
  });

  it("keeps declared suite acceptance independent of partial discovery and preserves project gates on replay", async () => {
    const service = await createSuiteService();
    const routeSource = Array.from({ length: 230 }, (_, index) => `const route${index} = { path: '/extra-${index}' };`).join("\n");
    const routePath = join(service.root, "apps", "web", "src", "extra-router.ts");
    await writeFile(routePath, routeSource);
    stubRuns(service);
    const declared = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    expect(declared.plan.planning).toMatchObject({ evidenceGaps: [], coverage: { requested: "declared", inventory: "partial", workflowCoverage: "unmeasured" } });
    await service.startMission(declared.missionId, { approve: true });
    expect((await service.waitMission(declared.missionId)).verdict).toBe("passed");

    const single = await service.createMission({ intent: "测试整个项目", surface: "web", charterId: "resume" });
    expect(single.plan.planning).toMatchObject({ coverage: { requested: "project", source: "inferred" }, evidenceGaps: ["project-map-truncated", "project-workflow-coverage"] });
    const whole = await service.createMission({ intent: "测试整个项目", surface: "web", suiteId: "release-critical" });
    expect(whole.plan.planning?.coverage).toMatchObject({ requested: "project", inventory: "partial", workflowCoverage: "unmeasured" });
    expect(whole.suite?.charters.every((item) => item.charter.planning?.coverage?.requested === "project")).toBe(true);
    await service.startMission(whole.missionId, { approve: true });
    expect((await service.waitMission(whole.missionId)).verdict).toBe("inconclusive");
    const evidence = await service.missionEvidence(whole.missionId);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed")).toBe(true);
    expect(evidence.planning?.evidenceGaps).toContain("project-workflow-coverage");

    const replay = await service.replayMission(whole.missionId);
    const replayed = await service.waitMission(replay.mission.missionId);
    expect(replayed.verdict).toBe("inconclusive");
    expect(replayed.plan.planning?.coverage).toEqual(whole.plan.planning?.coverage);
    expect(replayed.plan.planning?.evidenceGaps).toEqual(whole.plan.planning?.evidenceGaps);
    expect(await readFile(routePath, "utf8")).toBe(routeSource);
  });

  it("measures frozen project workflow checks from verified suite Runs without claiming whole-project acceptance", async () => {
    const service = await createSuiteService();
    await writeFile(join(service.workspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
      schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) },
      review: { by: "fixture", at: new Date().toISOString(), method: "Reviewed fixture business flows" },
      workflows: ["resume", "login"].map((id) => ({ id, title: id, sourcePaths: ["apps/web/src/router.ts"],
        checks: [{ charterId: id, surfaces: ["web", "electron"] }], surfaces: ["web", "electron"] })),
    }));
    stubRuns(service, { missingBusinessFact: "resume/electron/replay" });
    const mission = await service.createMission({ intent: "测试整个项目", surface: "web", suiteId: "release-critical" });
    expect(mission.workflowInventory?.workflows).toHaveLength(2);
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(completed.verdict).toBe("inconclusive");
    expect(evidence.workflowExecution).toMatchObject({ status: "partial", requiredChecks: 4, evidencedChecks: 3,
      evidencedWorkflowCount: 1, sourceBinding: "unverified",
      gaps: [{ workflowId: "resume", charterId: "resume", surface: "electron", reason: "inconclusive" }] });
    expect(evidence.summary.scope.workflowExecution).toEqual(evidence.workflowExecution);
    expect(await readFile(evidence.report!, "utf8")).toContain("Declared workflow execution: 3/4");
    expect(evidence.planning?.evidenceGaps).toContain("project-workflow-coverage");
  });

  it("counts a mapped route as observed only after passing primary and replay visits on both surfaces", async () => {
    const service = await createSuiteService();
    stubRuns(service);
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service.startMission(mission.missionId, { approve: true });
    await service.waitMission(mission.missionId);
    const coverage = (await service.missionEvidence(mission.missionId)).suiteScope?.routeCoverage;
    expect(coverage).toMatchObject({ candidateRoutes: 6, declaredTargets: 2, mappedCandidates: 2, observedCandidates: 2, inventoryTruncated: false });
    expect(coverage?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/settings", status: "unmapped" }),
      expect.objectContaining({ path: "/api/v1/people", status: "unmapped" }),
    ]));

    const service2 = await createSuiteService();
    stubRuns(service2, { missingVisitedPath: "resume/electron/replay" });
    const mission2 = await service2.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service2.startMission(mission2.missionId, { approve: true });
    await service2.waitMission(mission2.missionId);
    const coverage2 = (await service2.missionEvidence(mission2.missionId)).suiteScope?.routeCoverage;
    expect(coverage2).toMatchObject({ candidateRoutes: 6, mappedCandidates: 2, observedCandidates: 1 });
    expect(coverage2?.gaps).toContainEqual(expect.objectContaining({ path: "/resume", status: "mapped-unobserved", charterIds: ["resume"] }));
  });

  it("reports stale and ambiguous route mappings without increasing covered counts", async () => {
    const service = await createSuiteService();
    service.config.charters[0]!.routeTargets = [{ kind: "web", path: "/unknown" }, { kind: "web", path: "/shared" }];
    stubRuns(service);
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service.startMission(mission.missionId, { approve: true });
    await service.waitMission(mission.missionId);
    const coverage = (await service.missionEvidence(mission.missionId)).suiteScope?.routeCoverage;
    expect(coverage?.unresolvedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ charterId: "resume", path: "/unknown", reason: "absent" }),
      expect.objectContaining({ charterId: "resume", path: "/shared", reason: "ambiguous" }),
    ]));
    expect(coverage?.mappedCandidates).toBe(1);
    expect(coverage?.observedCandidates).toBe(1);
  });

  it("keeps concrete route parameters out of Mission coverage observations", async () => {
    const service = await createSuiteService();
    await writeFile(join(service.root, "apps", "web", "src", "dynamic-router.ts"), "export const detail = { path: '/resumes/:id' };\n");
    service.config.charters[0]!.routeTargets = [{ kind: "web", path: "/resumes/:id" }];
    stubRuns(service, { dynamicResume: true });
    const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const observations = completed.observations.filter((item) => item.kind === "surface.run" && item.charterId === "resume");
    expect(observations).toHaveLength(6);
    expect(observations.filter((item) => item.data.runKind !== "negative").every((item) =>
      JSON.stringify(item.data.matchedRoutePaths) === '["/resumes/:id"]')).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private-candidate-123");
    expect((await service.missionEvidence(mission.missionId)).suiteScope?.routeCoverage?.observedCandidates).toBe(2);
  });

  it("requires matching API method, origin and successful responses in every required run", async () => {
    for (const network of ["valid", "wrong-method", "wrong-origin", "bad-status", "missing-replay-response"] as const) {
      const service = await createSuiteService();
      service.config.charters[0]!.routeTargets!.push({ kind: "api", method: "GET", path: "/api/v1/people", origin: "http://127.0.0.1:8765", source: "services/gateway/router.ts" });
      stubRuns(service, { network });
      const mission = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
      await service.startMission(mission.missionId, { approve: true });
      const completed = await service.waitMission(mission.missionId);
      const coverage = (await service.missionEvidence(mission.missionId)).suiteScope?.routeCoverage;
      expect(completed.verdict).toBe("passed");
      expect(coverage).toMatchObject({ candidateRoutes: 6, mappedCandidates: 3, observedCandidates: network === "valid" ? 3 : 2 });
      if (network !== "valid") expect(coverage?.gaps).toContainEqual(expect.objectContaining({ kind: "api", path: "/api/v1/people", status: "mapped-unobserved" }));
      if (network === "missing-replay-response") expect(coverage?.gaps.find((item) => item.path === "/api/v1/people")?.reason).toContain("No matching successful API response");
    }
  }, 20_000);

  it("rejects a suite whose Charter is missing a required surface or business Oracle", async () => {
    const service = await createSuiteService({ loginSurfaces: ["web"] });
    await expect(service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" }))
      .rejects.toThrow("complete release surface matrix");
    const service2 = await createSuiteService({ loginOracle: false });
    await expect(service2.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" }))
      .rejects.toThrow("independent business Oracle");
  });

  it("requires an explicit ID when suite and single-Charter aliases both match", async () => {
    const service = await createSuiteService();
    service.config.charters[0]!.aliases = ["上线完整回归"];
    await expect(service.createMission({ intent: "上线完整回归", surface: "web" })).rejects.toThrow("specify suiteId or charterId");
    const selected = await service.createMission({ intent: "上线完整回归", surface: "web", suiteId: "release-critical" });
    expect(selected.suite?.suiteId).toBe("release-critical");
  });
});

describe("workflow inventory Missions", () => {
  it("counts a quick Web route but requires core business proof for an API route", async () => {
    for (const level of ["quick", "core"] as const) {
      const service = await createWorkflowService(level);
      service.config.charters.find((entry) => entry.id === "resume")!.routeTargets!.push({
        kind: "api", method: "GET", path: "/api/v1/people", origin: "http://127.0.0.1:8765",
        source: "services/gateway/router.ts",
      });
      stubRuns(service, { network: "valid" });
      const mission = await service.createMission({ intent: "测试整个项目", surface: "web", level });
      await service.startMission(mission.missionId, { approve: true });
      await service.waitMission(mission.missionId);
      const coverage = (await service.missionEvidence(mission.missionId)).suiteScope?.routeCoverage;
      expect(coverage?.gaps.find((item) => item.kind === "web" && item.path === "/resume")).toBeUndefined();
      const apiGap = coverage?.gaps.find((item) => item.kind === "api" && item.path === "/api/v1/people");
      if (level === "quick") expect(apiGap?.reason).toContain("Quick surface checks");
      else expect(apiGap).toBeUndefined();
    }
  });

  it("runs a quick project graph with only declared surface checks and keeps business acceptance open", async () => {
    const service = await createWorkflowService("quick");
    const harness = stubRuns(service);
    const mission = await service.createMission({ intent: "快速测试整个项目", surface: "web" });
    expect(mission.suite).toMatchObject({ origin: "workflow-inventory", level: "quick", surfaces: ["web", "electron"] });
    expect(mission.levelSelection).toMatchObject({ resolved: "quick", source: "inferred" });
    expect(mission.plan.executionProfile).toMatchObject({ requireBusinessOracle: false, requireReplay: false, minimumEvidence: 1 });
    expect(mission.plan.graph.tasks.filter((task) => task.tool === "surface.run-charter")
      .map((task) => `${task.charterId}/${task.input.adapter}`)).toEqual(["resume/web", "login/electron"]);
    expect(mission.plan.graph.tasks.some((task) => task.tool === "surface.replay-charter" || task.tool === "surface.run-negative-charter")).toBe(false);

    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(harness.started).toHaveLength(2);
    expect(harness.replayed).toHaveLength(0);
    expect(evidence.suiteScope?.results).toHaveLength(2);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed" && !item.replay)).toBe(true);
    expect(evidence.workflowExecution).toMatchObject({ status: "all-declared-evidenced", requiredProof: "surface", requiredChecks: 2, evidencedChecks: 2 });
    expect(evidence.workflowExecution?.limitations).toContain("Quick checks establish declared surface assertions, not independent business terminal state.");
    expect(evidence.proofClassification).toMatchObject({ status: "not-applicable", businessOracles: 0, unavailableRuns: 0, legacyOracles: 0 });
    expect(completed.verdict).toBe("inconclusive");
  });

  it("runs a core project graph with different Charters on Web and Electron", async () => {
    const service = await createWorkflowService("core");
    const harness = stubRuns(service);
    const mission = await service.createMission({ intent: "测试整个项目", surface: "web" });
    expect(mission.suite).toMatchObject({ origin: "workflow-inventory", level: "core", surfaces: ["web", "electron"] });
    expect(mission.plan.generatedBy).toBe("deterministic-workflow-planner-v1");
    expect(mission.plan.planning?.source).toBe("workflow-inventory");
    expect(mission.plan.executionProfile.requireReplay).toBe(false);
    expect(mission.plan.graph.tasks.filter((task) => task.tool === "surface.run-charter")
      .map((task) => `${task.charterId}/${task.input.adapter}`)).toEqual(["resume/web", "login/electron"]);
    expect(mission.plan.graph.tasks.some((task) => task.tool === "surface.replay-charter")).toBe(false);

    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(harness.started.map((item) => `${item.charterId}/${item.surface}`)).toEqual(["resume/web", "login/electron", "resume/web", "login/electron"]);
    expect(harness.replayed).toHaveLength(0);
    expect(evidence.suiteScope?.results.map((item) => `${item.charterId}/${item.surface}`)).toEqual(["resume/web", "login/electron"]);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed" && !item.replay)).toBe(true);
    expect(evidence.workflowExecution).toMatchObject({ status: "all-declared-evidenced", requiredProof: "business", requiredChecks: 2, evidencedChecks: 2, sourceBinding: "matching" });
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.plan.planning?.evidenceGaps).toContain("project-workflow-coverage");
    const unscheduled = structuredClone(completed);
    unscheduled.plan.graph.tasks.find((task) => task.taskId === "execute-resume-web")!.status = "skipped";
    expect(summarizeSuiteScope(unscheduled, service.evidenceDir)?.results[0]).toMatchObject({
      verdict: "inconclusive", missing: expect.arrayContaining(["primary task did not pass"]),
    });
    const weakened = structuredClone(completed);
    weakened.plan.executionProfile.requireBusinessOracle = false;
    weakened.observations.find((item) => item.kind === "surface.run" && item.charterId === "resume")!.data.passedOracles = 0;
    weakened.observations.find((item) => item.kind === "surface.run" && item.charterId === "resume")!.data.businessEvidence = 0;
    expect(summarizeSuiteScope(weakened, service.evidenceDir)?.results[0]).toMatchObject({
      verdict: "inconclusive", missing: expect.arrayContaining([
        "business Oracle policy differs from suite level", "primary passed business Oracle", "primary independent business fact",
      ]),
    });
  });

  it("replays only declared Charter and platform pairs at release intensity", async () => {
    const service = await createWorkflowService("release");
    const harness = stubRuns(service);
    const mission = await service.createMission({ intent: "测试整个项目上线", surface: "web", level: "release" });
    expect(mission.suite?.origin).toBe("workflow-inventory");
    expect(mission.plan.graph.tasks.filter((task) => task.tool === "surface.replay-charter")
      .map((task) => `${task.charterId}/${task.input.adapter}`)).toEqual(["resume/web", "login/electron"]);
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    const evidence = await service.missionEvidence(mission.missionId);
    expect(harness.started).toHaveLength(4);
    expect(harness.replayed.map((item) => `${item.charterId}/${item.surface}`)).toEqual(["resume/web", "login/electron"]);
    expect(evidence.suiteScope?.results).toHaveLength(2);
    expect(evidence.suiteScope?.results.every((item) => item.verdict === "passed" && item.replay?.sourceRunId === item.primary?.runId)).toBe(true);
    expect(evidence.workflowExecution).toMatchObject({ status: "all-declared-evidenced", requiredChecks: 2, evidencedChecks: 2, sourceBinding: "matching" });
    expect(completed.verdict).toBe("inconclusive");
  });
});

async function createWorkflowService(level: "quick" | "core" | "release"): Promise<LocalRunnerService> {
  const service = await createSuiteService();
  for (const entry of service.config.charters.filter((item) => item.id === "resume" || item.id === "login")) {
    entry.level = level;
    entry.surfaces = [entry.id === "resume" ? "web" : "electron"];
    const path = join(service.workspaceRoot, entry.path);
    const charter = TestCharterSchema.parse(JSON.parse(await readFile(path, "utf8")));
    await writeFile(path, JSON.stringify({ ...charter, level,
      ...(level === "quick" ? { oracles: [], negativeCases: [] } : {}) }));
  }
  execFileSync("git", ["-C", service.root, "init", "-q"]);
  execFileSync("git", ["-C", service.root, "-c", "core.autocrlf=false", "add", "."]);
  execFileSync("git", ["-C", service.root, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"]);
  const source = await captureSourceState(service.root);
  if (!source.complete || !source.headSha || !source.worktreeSha256) throw new Error("Fixture source fingerprint is incomplete");
  await writeFile(join(service.workspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
    schemaVersion: 1, source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
    review: { by: "fixture", at: new Date().toISOString(), method: "Declared the two fixture workflows" },
    workflows: [
      { id: "resume-flow", title: "Resume", sourcePaths: ["apps/web/src/router.ts"],
        checks: [{ charterId: "resume", surfaces: ["web"] }], surfaces: ["web"] },
      { id: "login-flow", title: "Login", sourcePaths: ["apps/web/src/router.ts"],
        checks: [{ charterId: "login", surfaces: ["electron"] }], surfaces: ["electron"] },
    ], exclusions: [],
  }));
  return service;
}

async function createSuiteService(options: { loginSurfaces?: LocalAdapterName[]; loginOracle?: boolean } = {}): Promise<LocalRunnerService> {
  const root = await mkdtemp(join(tmpdir(), "proofkit-suite-source-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-suite-workspace-"));
  roots.push(root, workspaceRoot);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "suite-fixture" }));
  await mkdir(join(root, "apps", "web", "src"), { recursive: true });
  await writeFile(join(root, "apps", "web", "src", "router.ts"), "export const resume = { path: '/resume' };\nexport const login = { path: '/login' };\nexport const settings = { path: '/settings' };\nexport const shared = { path: '/shared' };\n");
  await writeFile(join(root, "apps", "web", "src", "other-router.ts"), "export const shared = { path: '/shared' };\n");
  await mkdir(join(root, "services", "gateway"), { recursive: true });
  await writeFile(join(root, "services", "gateway", "router.ts"), "router.get('/api/v1/people', handler);\n");
  await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
  const charters = ["resume", "login", "other-release"];
  const config = ProofkitConfigSchema.parse({
    project: { root },
    charters: charters.map((id) => ({
      id, path: `.proofkit/charters/${id}.yml`, aliases: [id], level: "release",
      surfaces: id === "login" ? options.loginSurfaces ?? ["web", "electron"] : ["web", "electron"],
      routeTargets: [{ kind: "web", path: `/${id === "other-release" ? "settings" : id}` }],
    })),
    suites: [{ id: "release-critical", aliases: ["上线完整回归"], level: "release", charterIds: ["resume", "login"], surfaces: ["web", "electron"] }],
    oracles: charters.map((id) => ({ name: `${id}-oracle`, url: `http://127.0.0.1:8765/${id}`, statusPointer: "/status", successValues: ["done"] })),
    run: { timeoutMs: 2_000 },
  });
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(config));
  for (const id of charters) {
    const charter = TestCharterSchema.parse({
      intent: `test ${id}`,
      level: "release",
      mode: "deterministic",
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: `${id} ready` }],
      oracles: id === "login" && options.loginOracle === false ? [] : [`${id}-oracle`],
      sideEffectPolicy: "deny",
      negativeCases: [{ caseId: "duplicate", title: "duplicate input", actions: [{ kind: "observe" }], assertions: [], oracles: [`${id}-oracle`], sideEffectPolicy: "deny" }],
    });
    await writeFile(join(workspaceRoot, ".proofkit", "charters", `${id}.yml`), JSON.stringify(charter));
  }
  return LocalRunnerService.create({ root, workspaceRoot });
}

function stubRuns(service: LocalRunnerService, options: { failedPrimary?: string; missingBusinessFact?: string; missingVisitedPath?: string; dynamicResume?: boolean; network?: "valid" | "wrong-method" | "wrong-origin" | "bad-status" | "missing-replay-response" } = {}) {
  installMockRunEvidence(service);
  const summaries = new Map<string, RunSummary>();
  const started: Array<{ charterId: string; surface: LocalAdapterName; negativeCaseId?: string }> = [];
  const replayed: Array<{ sourceRunId: string; charterId: string; surface: LocalAdapterName }> = [];
  let sequence = 0;
  const summaryFor = (charter: TestCharter, surface: LocalAdapterName, kind: "primary" | "replay" | "negative"): RunSummary => {
    const charterId = String(charter.metadata.catalogId);
    const runId = `suite-${++sequence}`;
    const failed = options.failedPrimary === `${charterId}/${surface}` && kind !== "negative";
    const missing = options.missingBusinessFact === `${charterId}/${surface}/${kind}`;
    const visited = options.missingVisitedPath !== `${charterId}/${surface}/${kind}`;
    const verdict: Verdict = failed ? "failed" : "passed";
    const now = new Date().toISOString();
    const oracleArtifact = `${runId}/oracle.json`;
    const sourceArtifact = `${runId}/oracle-source.json`;
    const summary: RunSummary = {
      runId, projectRoot: service.root, workspaceRoot: service.workspaceRoot,
      startedAt: now, endedAt: now, status: "completed", verdict, charter,
      steps: kind === "negative" ? [] : [{
        stepId: "step-001", action: { kind: "observe" }, status: "passed", artifacts: [],
        beforeSnapshot: { capturedAt: now, url: "http://127.0.0.1:8765/", metadata: {} },
        afterSnapshot: { capturedAt: now, url: `http://127.0.0.1:8765/${visited ? options.dynamicResume && charterId === "resume" ? "resumes/private-candidate-123" : charterId : ""}`, metadata: {} },
      }],
      assertions: kind === "negative" ? [] : [{ assertion: charter.assertions[0]!, passed: true, message: "visible", evidence: [`${runId}/snapshot.json`] }],
      oracles: charter.oracles?.length ? [{ name: `${charterId}-oracle`, verificationKind: "business", passed: !failed, message: failed ? "business state is wrong" : "business state is done", evidence: missing ? [oracleArtifact] : [sourceArtifact, oracleArtifact], sourceEvidenceCount: missing ? 0 : 1, sourceEvidenceArtifacts: missing ? [] : [sourceArtifact], observedAt: now }] : [],
      artifacts: [`${runId}/snapshot.json`, ...(charter.oracles?.length ? [...(missing ? [] : [sourceArtifact]), oracleArtifact] : [])],
      findings: [],
    };
    summaries.set(runId, summary);
    return summary;
  };
  const writeNetworkEvent = async (summary: RunSummary, surface: LocalAdapterName, kind: "primary" | "replay" | "negative") => {
    if (!options.network || options.network === "missing-replay-response" && kind === "replay") return;
    const runDir = join(service.evidenceDir, summary.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), `${JSON.stringify({
      runId: summary.runId, timestamp: summary.endedAt, type: "adapter.event",
      payload: { adapter: surface, eventType: "response", method: options.network === "wrong-method" ? "POST" : "GET", status: options.network === "bad-status" ? 500 : 200, url: `${options.network === "wrong-origin" ? "http://127.0.0.1:9999" : "http://127.0.0.1:8765"}/api/v1/people?private=hidden` },
    })}\n`);
  };
  service.start = async (input) => {
    const charter = input.charter!;
    const surface = input?.adapter ?? "web";
    const negativeCaseId = typeof charter.metadata.negativeCaseId === "string" ? charter.metadata.negativeCaseId : undefined;
    started.push({ charterId: String(charter.metadata.catalogId), surface, negativeCaseId });
    const summary = summaryFor(charter, surface, negativeCaseId ? "negative" : "primary");
    await writeNetworkEvent(summary, surface, negativeCaseId ? "negative" : "primary");
    return { runId: summary.runId, status: "completed", verdict: summary.verdict, summary };
  };
  service.replay = async (sourceRunId, input) => {
    const source = summaries.get(sourceRunId);
    if (!source) throw new Error(`Unknown replay source ${sourceRunId}`);
    const surface = input?.adapter ?? "web";
    replayed.push({ sourceRunId, charterId: String(source.charter.metadata.catalogId), surface });
    const summary = summaryFor(source.charter, surface, "replay");
    await writeNetworkEvent(summary, surface, "replay");
    return { runId: summary.runId, status: "completed", verdict: summary.verdict, summary };
  };
  service.wait = async (runId) => {
    const summary = summaries.get(runId);
    if (!summary) throw new Error(`Unknown run ${runId}`);
    return summary;
  };
  return { started, replayed };
}
