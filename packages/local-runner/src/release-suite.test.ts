import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema, type RunSummary, type TestCharter, type Verdict } from "@proofkit/contracts";
import { LocalRunnerService, type LocalAdapterName } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit release suites", () => {
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
    for (const network of ["valid", "wrong-method", "wrong-origin", "bad-status", "missing-replay-log"] as const) {
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
      if (network === "missing-replay-log") expect(coverage?.gaps.find((item) => item.path === "/api/v1/people")?.reason).toContain("unavailable");
    }
  });

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

function stubRuns(service: LocalRunnerService, options: { failedPrimary?: string; missingBusinessFact?: string; missingVisitedPath?: string; dynamicResume?: boolean; network?: "valid" | "wrong-method" | "wrong-origin" | "bad-status" | "missing-replay-log" } = {}) {
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
      runId, startedAt: now, endedAt: now, status: "completed", verdict, charter,
      steps: kind === "negative" ? [] : [{
        stepId: "step-001", action: { kind: "observe" }, status: "passed", artifacts: [],
        beforeSnapshot: { capturedAt: now, url: "http://127.0.0.1:8765/", metadata: {} },
        afterSnapshot: { capturedAt: now, url: `http://127.0.0.1:8765/${visited ? options.dynamicResume && charterId === "resume" ? "resumes/private-candidate-123" : charterId : ""}`, metadata: {} },
      }],
      assertions: kind === "negative" ? [] : [{ assertion: charter.assertions[0]!, passed: true, message: "visible", evidence: [`${runId}/snapshot.json`] }],
      oracles: [{ name: `${charterId}-oracle`, passed: !failed, message: failed ? "business state is wrong" : "business state is done", evidence: missing ? [oracleArtifact] : [sourceArtifact, oracleArtifact], sourceEvidenceCount: missing ? 0 : 1, sourceEvidenceArtifacts: missing ? [] : [sourceArtifact], observedAt: now }],
      artifacts: [`${runId}/snapshot.json`, ...(missing ? [] : [sourceArtifact]), oracleArtifact],
      findings: [],
    };
    summaries.set(runId, summary);
    return summary;
  };
  const writeNetworkEvent = async (summary: RunSummary, surface: LocalAdapterName, kind: "primary" | "replay" | "negative") => {
    if (!options.network || options.network === "missing-replay-log" && kind === "replay") return;
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
