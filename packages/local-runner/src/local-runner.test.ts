import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, type NegativeCase, type RunSummary, type TestCharter, type TestMission } from "@proofkit/contracts";
import { ExecutionRunner, type SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";
import { auditMissionExecution, auditMissionRunFacts } from "./mission-execution-audit.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("LocalRunnerService", () => {
  it("reports the first UI boundary and the later evidenced business defect separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-first-boundary-"));
    roots.push(root);
    const runId = "first-boundary-run";
    const snapshot = `${runId}/artifacts/assertion-001-snapshot.json`;
    const source = `${runId}/artifacts/oracle-2-source.json`;
    const report = `${runId}/artifacts/oracle-2.json`;
    await writeFile(join(root, "unverified.ts"), "export const unrelated = true;\n");
    await writeFile(join(root, "confirmed.ts"), "export const binding = true;\n");
    const charter: TestCharter = { intent: "verify current resume", level: "core", mode: "deterministic",
      preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "Submitted" }],
      oracles: ["unproven-reader", "binding-reader"], sideEffectPolicy: "deny", metadata: {} };
    const service = new LocalRunnerService({ workspaceRoot: root, root,
      oracles: ["unproven-reader", "binding-reader"].map((name) => ({ name,
        check: async () => ({ name, passed: null, message: "not used by stubbed Run", evidence: [] }) })) });
    const summary: RunSummary = {
      runId, startedAt: "2026-10-08T00:00:00.000Z", endedAt: "2026-10-08T00:00:04.000Z",
      status: "completed", verdict: "failed", charter, steps: [],
      assertions: [{ assertion: charter.assertions[0]!, passed: false, message: "Submitted was not visible",
        evidence: [snapshot], recordedAt: "2026-10-08T00:00:01.000Z" }],
      oracles: [
        { name: "unproven-reader", verificationKind: "business", passed: false,
          message: "reader failed without facts", evidence: [], sourceLocations: ["unverified.ts"],
          recordedAt: "2026-10-08T00:00:02.000Z" },
        { name: "binding-reader", verificationKind: "business", passed: false,
          message: "wrong candidate binding", evidence: [source, report], sourceEvidenceCount: 1,
          sourceEvidenceArtifacts: [source], sourceLocations: ["confirmed.ts"],
          recordedAt: "2026-10-08T00:00:03.000Z" },
      ], artifacts: [snapshot, source, report], findings: [],
    };
    service.start = async () => ({ runId, status: "completed", verdict: "failed", summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(created.missionId);
    expect(completed.firstFailure).toMatchObject({ kind: "assertion",
      observedAt: "2026-10-08T00:00:01.000Z" });
    expect(completed.firstFailure?.evidence[0]?.path).toContain("assertion-001-snapshot.json");
    expect(completed.findings).toContainEqual(expect.objectContaining({ category: "product", status: "confirmed",
      title: "Business oracle failed: binding-reader" }));
    expect(completed.findings.find((item) => item.category === "product")?.evidence[0]?.path).toContain("oracle-2-source.json");
    expect(completed.diagnosis?.evidence[0]?.path).toContain("oracle-2-source.json");
    expect(completed.diagnosis?.sourceLocations).toEqual(["confirmed.ts"]);
    expect(completed.repairSuggestions[0]?.evidence[0]?.path).toContain("oracle-2-source.json");
    expect(completed.repairSuggestions[0]?.changes[0]).toContain("confirmed.ts");
    expect(completed.repairSuggestions[0]?.changes[0]).not.toContain("unverified.ts");
    const intact = await service.missionEvidence(completed.missionId);
    expect(intact.sourceStability).toBe("unverified");
    expect(intact.diagnosticSupport).toMatchObject({
      diagnosis: { status: "supported" }, repairSuggestions: [{ status: "supported" }],
    });
    await writeFile(join(service.evidenceDir, source), "altered business evidence");
    const changed = await service.missionEvidence(completed.missionId);
    expect(changed).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      diagnosticSupport: { diagnosis: { status: "unsupported", reason: "unavailable-evidence" },
        repairSuggestions: [{ status: "unsupported", reason: "unavailable-evidence" }] },
      summary: { evidenceIntegrity: { diagnosticSupport: { diagnosis: { status: "unsupported" } } } },
    });
    expect(await readFile(changed.report!, "utf8")).toContain("Current proposal support: unsupported: cited evidence is missing, changed or unverifiable");
  });

  it("runs a mission through the existing deterministic run and keeps evidence references", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mission-run-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = { intent: "verify fixture", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["fixture-terminal"], sideEffectPolicy: "deny", metadata: {} };
    const summary: RunSummary = {
      runId: "fixture-run",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "completed",
      verdict: "passed",
      charter,
      steps: [],
      assertions: [{ assertion: { kind: "text-visible", text: "ready" }, passed: true, message: "ready is visible", evidence: ["fixture-run/after.json"] }],
      oracles: [{ name: "fixture-terminal", passed: true, message: "fixture is complete", evidence: ["fixture-run/oracle-1-source.json", "fixture-run/oracle-1.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["fixture-run/oracle-1-source.json"], observedAt: new Date().toISOString() }],
      artifacts: ["fixture-run/after.json", "fixture-run/oracle-1-source.json", "fixture-run/oracle-1.json"],
      findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    expect(created.status).toBe("awaiting-approval");
    expect(created.level).toBe("core");
    expect(created.policy.level).toBe("core");
    expect(created.plan.level).toBe("core");
    expect(created.levelSelection?.source).toBe("explicit");
    await service.approveMission(created.missionId);
    await service.startMission(created.missionId);
    const completed = await service.waitMission(created.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(completed.plan.graph.tasks.map((task) => task.status)).toEqual(["passed", "passed", "passed"]);
    expect(completed.evidence.some((item) => item.path.endsWith(join("fixture-run", "report.html")))).toBe(true);
    expect(completed.observations.some((item) => item.kind === "surface.run")).toBe(true);
    expect(completed.observations.some((item) => item.kind === "project.source-state")).toBe(true);
    expect(completed.observations.some((item) => item.kind === "project.source-state-final")).toBe(true);

    const missionPath = join(root, ".proofkit", "missions", `${created.missionId}.json`);
    const savedBeforeReport = await readFile(missionPath, "utf8");
    const evidence = await service.missionEvidence(created.missionId);
    expect(evidence).toMatchObject({
      missionId: created.missionId,
      status: "completed",
      running: false,
      verdict: "passed",
      level: "core",
      findings: [],
      repairSuggestions: [],
    });
    expect(evidence.sourceState?.method).toBe("unavailable");
    expect(evidence.finalSourceState?.method).toBe("unavailable");
    expect(evidence.taskSummary).toHaveLength(3);
    expect(evidence.taskSummary.every((task) => task.status === "passed" && task.attempts === 1)).toBe(true);
    expect(evidence.agentSteps).toHaveLength(3);
    expect(evidence.agentSteps.map((step) => step.phase)).toEqual(["execute", "execute", "verify"]);
    expect(evidence.agentSteps.every((step) => step.status === "succeeded" && step.toolCallIds.length === 1)).toBe(true);
    expect(evidence.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "report" }),
      expect.objectContaining({ kind: "business" }),
    ]));
    expect(evidence.summary).toMatchObject({ missionId: created.missionId, verdict: "passed", expectedRuns: 1, observedRuns: 1 });
    expect(evidence.summary.runs).toEqual([expect.objectContaining({ taskId: "execute-charter", runId: "fixture-run", surface: "web", verdict: "passed" })]);
    expect(evidence.reportUnavailable).toBeUndefined();
    expect(await readFile(evidence.report!, "utf8")).toContain("Scenario executions");
    expect(await readFile(missionPath, "utf8")).toBe(savedBeforeReport);

    // A blocked report path must not erase the saved test result or evidence.
    const reportDir = join(root, ".proofkit", "missions", created.missionId);
    await rm(reportDir, { recursive: true });
    await writeFile(reportDir, "not a directory");
    const unavailable = await service.missionEvidence(created.missionId);
    expect(unavailable.report).toBeUndefined();
    expect(unavailable.reportUnavailable).toContain("could not be written");
    expect(unavailable.evidenceIntegrity).toBeDefined();
    expect(unavailable.summary.evidenceIntegrity).toEqual(unavailable.evidenceIntegrity);
    expect(unavailable.verdict).toBe("passed");
    expect(unavailable.summary.verdict).toBe("passed");
    expect(unavailable.evidence).toEqual(evidence.evidence);
    expect(await readFile(missionPath, "utf8")).toBe(savedBeforeReport);
  });

  it("does not report a core mission as passed without an independent business oracle", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-core-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = { intent: "verify fixture", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny", metadata: {} };
    const summary: RunSummary = {
      runId: "core-gate-run",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "completed",
      verdict: "passed",
      charter,
      steps: [],
      assertions: [{ assertion: { kind: "text-visible", text: "ready" }, passed: true, message: "ready is visible", evidence: [] }],
      oracles: [],
      artifacts: ["core-gate-run/after.json"],
      findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.firstFailure?.kind).toBe("evidence");
    expect(completed.findings.some((finding) => finding.message.includes("独立业务 Oracle"))).toBe(true);
  });

  it("keeps a surface and business pass inconclusive when planning evidence is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-planning-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const assertion = { kind: "text-visible" as const, text: "ready" };
    const charter: TestCharter = {
      intent: "verify fixture", level: "core", mode: "deterministic", preconditions: [], actions: [],
      assertions: [assertion], oracles: ["fixture-terminal"], sideEffectPolicy: "deny", metadata: {},
      planning: { source: "deterministic", confidence: 0.25, assumptions: [], missingInputs: ["完整项目地图"], evidenceGaps: ["project-map-truncated"] },
    };
    const now = new Date().toISOString();
    const summary: RunSummary = {
      runId: "planning-gate-run", startedAt: now, endedAt: now, status: "completed", verdict: "passed", charter,
      steps: [], assertions: [{ assertion, passed: true, message: "ready", evidence: ["planning-gate-run/after.json"] }],
      oracles: [{ name: "fixture-terminal", passed: true, message: "complete", evidence: ["planning-gate-run/source.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["planning-gate-run/source.json"], observedAt: now }],
      artifacts: ["planning-gate-run/after.json", "planning-gate-run/source.json"], findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(created.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.firstFailure?.kind).toBe("evidence");
    expect(completed.findings.some((finding) => finding.message.includes("project-map-truncated"))).toBe(true);
    expect((await service.missionEvidence(created.missionId)).planning?.evidenceGaps).toEqual(["project-map-truncated"]);
  });

  it("does not let a negative case supply the primary run's missing business oracle", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-primary-oracle-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const visible = { kind: "text-visible" as const, text: "Ready" };
    const charter: TestCharter = {
      intent: "verify resume intake",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "observe" }],
      assertions: [visible],
      oracles: [],
      sideEffectPolicy: "deny",
      metadata: {},
      negativeCases: [{
        caseId: "duplicate",
        title: "重复上传",
        actions: [{ kind: "observe" }],
        assertions: [],
        oracles: ["duplicate-rejected"],
        sideEffectPolicy: "deny",
        metadata: {},
      }],
    };
    const summaries = new Map<string, RunSummary>();
    service.start = async (input) => {
      const negative = input.charter?.metadata.negativeCaseId === "duplicate";
      const runId = negative ? "negative-proofs" : "primary-no-oracle";
      const now = new Date().toISOString();
      const summary: RunSummary = {
        runId, startedAt: now, endedAt: now, status: "completed", verdict: "passed", charter: input.charter ?? charter,
        steps: [],
        assertions: negative ? [] : [{ assertion: visible, passed: true, message: "Ready", evidence: [`${runId}/after.json`] }],
        oracles: negative ? [{ name: "duplicate-rejected", passed: true, message: "duplicate rejected", evidence: [`${runId}/oracle.json`] }] : [],
        artifacts: negative ? [`${runId}/oracle.json`] : [`${runId}/after.json`],
        findings: [],
      };
      summaries.set(runId, summary);
      return { runId, status: "completed", verdict: summary.verdict, summary };
    };
    service.wait = async (runId) => summaries.get(runId)!;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(created.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.firstFailure?.kind).toBe("evidence");
    expect(completed.findings.some((finding) => finding.message.includes("web 主运行") && finding.message.includes("独立业务 Oracle"))).toBe(true);
  });

  it("does not treat an oracle's report or unmaterialized source count as independent business evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-facts-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const assertion = { kind: "text-visible" as const, text: "Ready" };
    const charter: TestCharter = {
      intent: "verify resume terminal state", level: "core", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [assertion], oracles: ["resume-terminal"], sideEffectPolicy: "deny", metadata: {},
    };
    const now = new Date().toISOString();
    const summary: RunSummary = {
      runId: "oracle-no-facts", startedAt: now, endedAt: now, status: "completed", verdict: "passed", charter, steps: [],
      assertions: [{ assertion, passed: true, message: "Ready", evidence: ["oracle-no-facts/after.json"] }],
      oracles: [{ name: "resume-terminal", passed: true, message: "complete", evidence: ["oracle-no-facts/artifacts/oracle-1.json"], sourceEvidenceCount: 1 }],
      artifacts: ["oracle-no-facts/after.json", "oracle-no-facts/artifacts/oracle-1.json"], findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(created.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("业务事实证据"))).toBe(true);
    expect(completed.evidence.some((item) => item.kind === "business")).toBe(false);
  });

  it("does not report a mission as passed without an observable assertion", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-assertion-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = { intent: "verify fixture", level: "quick", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} };
    const summary: RunSummary = {
      runId: "assertion-gate-run",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "completed",
      verdict: "passed",
      charter,
      steps: [],
      assertions: [],
      oracles: [],
      artifacts: ["assertion-gate-run/after.json"],
      findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("可观察断言"))).toBe(true);
  });

  it("does not report an absence-only surface check as a passing mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-absence-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const assertion = { kind: "text-not-visible" as const, text: "Page error" };
    const charter: TestCharter = { intent: "check page", level: "quick", mode: "deterministic", preconditions: [], actions: [], assertions: [assertion], sideEffectPolicy: "deny", metadata: {} };
    const summary: RunSummary = {
      runId: "absence-gate-run", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "completed", verdict: "passed",
      charter, steps: [], assertions: [{ assertion, passed: true, message: "error not visible", evidence: [] }], oracles: [],
      artifacts: ["absence-gate-run/after.json"], findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("正向表面断言"))).toBe(true);
  });

  it("keeps an explicitly requested quick level through the mission envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-quick-level-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = { intent: "check login", level: "quick", mode: "deterministic", preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny", metadata: {} };

    const mission = await service.createMission({ intent: "check login", level: "quick", surface: "web", charter });

    expect(mission.level).toBe("quick");
    expect(mission.policy.level).toBe("quick");
    expect(mission.plan.level).toBe("quick");
    expect(mission.levelSelection).toMatchObject({ requested: "quick", resolved: "quick", source: "explicit" });
  });

  it("rejects a supplied level that contradicts an unambiguous user intensity", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-intensity-conflict-"));
    roots.push(root);
    const config = ProofkitConfigSchema.parse({
      charters: [
        { id: "quick-login", path: "charters/quick-login.yml", aliases: ["登录"], level: "quick", surfaces: ["web"] },
        ...["release-login", "release-profile"].map((id) => ({ id, path: `charters/${id}.yml`, aliases: [id], level: "release" as const, surfaces: ["web", "electron"] as Array<"web" | "electron"> })),
      ],
      suites: [{ id: "release-suite", aliases: ["完整回归"], level: "release", surfaces: ["web", "electron"], charterIds: ["release-login", "release-profile"] }],
    });
    const service = new LocalRunnerService({ root, workspaceRoot: root, config });
    const charter: TestCharter = { intent: "check login", level: "quick", mode: "deterministic",
      preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "ready" }],
      sideEffectPolicy: "deny", metadata: {} };

    await expect(service.createMission({ intent: "上线完整回归登录", surface: "web", charter }))
      .rejects.toThrow("intent indicates release but supplied selection is quick");
    await expect(service.createMission({ intent: "上线完整回归登录", surface: "web", level: "quick", charter }))
      .rejects.toThrow("intent indicates release but supplied selection is quick");
    await expect(service.createMission({ intent: "上线完整回归登录", surface: "web", charterId: "quick-login" }))
      .rejects.toThrow("intent indicates release but supplied selection is quick");
    await expect(service.createMission({ intent: "快速测试登录", surface: "web", suiteId: "release-suite" }))
      .rejects.toThrow("intent indicates quick but supplied selection is release");

    const ordinary = await service.createMission({ intent: "测试登录功能", surface: "web", charter });
    expect(ordinary.level).toBe("quick");
    const mixed = await service.createMission({ intent: "快速检查上线功能", surface: "web", charter });
    expect(mixed.level).toBe("quick");
  });

  it("runs and verifies the release matrix across Web and Electron with replay evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-release-matrix-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = {
      intent: "release fixture",
      level: "release",
      mode: "deterministic",
      preconditions: [],
      actions: [],
      assertions: [{ kind: "text-visible", text: "ready" }],
      oracles: ["fixture-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
    };
    let sequence = 0;
    const runs: Array<{ adapter: string; runKind: string }> = [];
    const summaries = new Map<string, RunSummary>();
    const createSummary = (adapter: string, replayOfRunId?: string): RunSummary => {
      sequence += 1;
      const summary: RunSummary = {
        runId: `release-run-${sequence}`,
        execution: { adapter, ...(replayOfRunId ? { replayOfRunId } : {}) },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "completed",
        verdict: "passed",
        charter,
        steps: [],
        assertions: [{ assertion: charter.assertions[0]!, passed: true, message: `${adapter} ready`, evidence: [`release-run-${sequence}/after.json`] }],
        oracles: [{ name: "fixture-terminal", verificationKind: "business", passed: true, message: `${adapter} terminal`, evidence: [`release-run-${sequence}/oracle-source.json`, `release-run-${sequence}/oracle.json`], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [`release-run-${sequence}/oracle-source.json`], observedAt: new Date().toISOString() }],
        artifacts: [`release-run-${sequence}/after.json`, `release-run-${sequence}/oracle-source.json`, `release-run-${sequence}/oracle.json`, `release-run-${sequence}/trace.json`],
        findings: [],
      };
      summaries.set(summary.runId, summary);
      return summary;
    };
    service.start = async (input) => {
      const adapter = input.adapter ?? "web";
      const summary = createSummary(adapter);
      runs.push({ adapter, runKind: "primary" });
      return { runId: summary.runId, status: "completed", verdict: summary.verdict, summary };
    };
    service.wait = async (runId) => {
      const summary = summaries.get(runId);
      if (!summary) throw new Error(`Unknown fixture run ${runId}`);
      return summary;
    };
    installMockRunEvidence(service);
    service.replay = async (runId, input = {}) => {
      const adapter = input.adapter ?? "web";
      const summary = createSummary(adapter, runId);
      runs.push({ adapter, runKind: "replay" });
      return { runId: summary.runId, status: "completed", verdict: summary.verdict, summary };
    };

    const created = await service.createMission({ intent: charter.intent, surface: "web", level: "release", charter });
    expect(created.plan.executionProfile.surfaceMatrix).toEqual(["web", "electron"]);
    expect(created.plan.executionProfile.requireReplay).toBe(true);
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(completed.plan.graph.tasks.every((task) => task.status === "passed")).toBe(true);
    expect(completed.observations.filter((item) => item.kind === "surface.run")).toHaveLength(4);
    expect(completed.observations.filter((item) => item.kind === "surface.run" && item.data.runKind === "primary").map((item) => item.data.surface).sort()).toEqual(["electron", "web"]);
    expect(completed.observations.filter((item) => item.kind === "surface.run" && item.data.runKind === "replay").map((item) => item.data.surface).sort()).toEqual(["electron", "web"]);
    expect(completed.evidence.length).toBeGreaterThanOrEqual(3);
    const accepted = await service.missionEvidence(created.missionId);
    expect(accepted.summary.executionAudit).toMatchObject({ status: "complete", expectedSlots: 4, matchedSlots: 4 });
    const structural = auditMissionExecution(completed, service.evidenceDir);
    const electronRunId = completed.observations.find((item) => item.kind === "surface.run"
      && item.data.surface === "electron" && item.data.runKind === "primary")!.data.runId as string;
    const electronSummary = summaries.get(electronRunId)!;
    electronSummary.execution!.adapter = "web";
    const wrongAdapter = await auditMissionRunFacts(completed, structural, async (runId) => summaries.get(runId)!);
    expect(wrongAdapter.issues).toEqual(expect.arrayContaining([expect.stringContaining("saved Run adapter")]));
    electronSummary.execution!.adapter = "electron";
    const originalCharter = electronSummary.charter;
    electronSummary.charter = { ...originalCharter, intent: "another scenario" };
    const wrongCharter = await auditMissionRunFacts(completed, structural, async (runId) => summaries.get(runId)!);
    expect(wrongCharter.issues).toEqual(expect.arrayContaining([expect.stringContaining("saved Run Charter")]));
    electronSummary.charter = originalCharter;
    const originalExecution = electronSummary.execution;
    delete electronSummary.execution;
    const legacyRun = await auditMissionRunFacts(completed, structural, async (runId) => summaries.get(runId)!);
    expect(legacyRun.issues).toEqual(expect.arrayContaining([expect.stringContaining("saved Run adapter is missing")]));
    electronSummary.execution = originalExecution;

    const missionPath = join(root, ".proofkit", "missions", `${created.missionId}.json`);
    const saved = await readFile(missionPath, "utf8");
    const wrongSource = JSON.parse(saved) as TestMission;
    const webReplay = wrongSource.observations.find((item) => item.kind === "surface.run" && item.data.surface === "web" && item.data.runKind === "replay")!;
    webReplay.data.sourceRunId = "another-run";
    await writeFile(missionPath, JSON.stringify(wrongSource));
    const mismatched = await service.missionEvidence(created.missionId);
    expect(mismatched).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      summary: { executionAudit: { status: "incomplete" } } });
    expect(mismatched.testVerdictReason).toContain("mismatched execution Runs");
    expect(mismatched.summary.executionAudit?.issues).toEqual(expect.arrayContaining([expect.stringContaining("replay source")]));
    expect(await readFile(mismatched.report!, "utf8")).toContain("Execution slot gap");

    const duplicated = JSON.parse(saved) as TestMission;
    const primary = duplicated.observations.find((item) => item.kind === "surface.run" && item.data.surface === "web" && item.data.runKind === "primary")!;
    duplicated.observations.push({ ...primary, observationId: `duplicate-${primary.observationId}` });
    await writeFile(missionPath, JSON.stringify(duplicated));
    const ambiguous = await service.missionEvidence(created.missionId);
    expect(ambiguous).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      summary: { executionAudit: { status: "incomplete", unexpectedObservations: 2 } } });
    expect(ambiguous.summary.executionAudit?.issues).toEqual(expect.arrayContaining([expect.stringContaining("expected one Run observation, found 2")]));

    const borrowed = JSON.parse(saved) as TestMission;
    const webPrimary = borrowed.observations.find((item) => item.kind === "surface.run" && item.data.surface === "web" && item.data.runKind === "primary")!;
    const electronPrimary = borrowed.observations.find((item) => item.kind === "surface.run" && item.data.surface === "electron" && item.data.runKind === "primary")!;
    webPrimary.evidence.push(electronPrimary.evidence.find((ref) => ref.kind === "report")!);
    await writeFile(missionPath, JSON.stringify(borrowed));
    const wrongOwner = await service.missionEvidence(created.missionId);
    expect(wrongOwner).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      summary: { executionAudit: { status: "incomplete" } } });
    expect(wrongOwner.acceptanceEvidenceIntegrity.status).toBe(accepted.acceptanceEvidenceIntegrity.status);
    expect(wrongOwner.summary.executionAudit?.issues).toEqual(expect.arrayContaining([expect.stringContaining("does not belong to its Run")]));
  });

  it("requires business proof in every release replay, not just in the aggregate", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-release-per-run-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = {
      intent: "release resume workflow",
      level: "release",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
    };
    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const missionPath = join(root, ".proofkit", "missions", `${created.missionId}.json`);
    const persisted = JSON.parse(await readFile(missionPath, "utf8")) as TestMission;
    persisted.status = "approved";
    persisted.plan.graph.tasks = persisted.plan.graph.tasks.map((task) => ({
      ...task,
      status: task.taskId === "verify-result" ? "pending" : "passed",
      attempts: task.taskId === "verify-result" ? 0 : 1,
    }));
    const now = new Date().toISOString();
    persisted.observations = (["web", "electron"] as const).flatMap((surface) => (["primary", "replay"] as const).map((runKind) => ({
      observationId: `${surface}-${runKind}`,
      source: "surface" as const,
      kind: "surface.run",
      data: {
        runId: `${surface}-${runKind}`,
        surface,
        runKind,
        verdict: "passed",
        assertions: 1,
        passedAssertions: 1,
        oracles: surface === "electron" && runKind === "replay" ? 0 : 1,
        passedOracles: surface === "electron" && runKind === "replay" ? 0 : 1,
        businessEvidence: surface === "electron" && runKind === "replay" ? 0 : 1,
      },
      evidence: [],
      observedAt: now,
    })));
    persisted.evidence = persisted.observations.map((observation) => ({
      evidenceId: `${observation.observationId}:run`,
      kind: "report" as const,
      path: `${observation.observationId}/report.html`,
      capturedAt: now,
    }));
    persisted.verdict = undefined;
    await writeFile(missionPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await service.startMission(created.missionId);
    const completed = await service.waitMission(created.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("electron 回放运行") && finding.message.includes("独立业务 Oracle"))).toBe(true);
  });

  it("executes an explicitly declared negative charter with independent inputs and evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-run-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const negativeCase: NegativeCase = {
      caseId: "duplicate-upload",
      title: "重复上传应被拒绝",
      actions: [{ kind: "click", selector: "#upload" }],
      assertions: [{ kind: "text-visible", text: "Already exists" }],
      oracles: ["duplicate-upload-rejected"],
      sideEffectPolicy: "deny" as const,
      metadata: { category: "idempotency" },
    };
    const charter: TestCharter = {
      intent: "verify resume upload",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
      negativeCases: [negativeCase],
    };
    const captured: TestCharter[] = [];
    const summaries = new Map<string, RunSummary>();
    let sequence = 0;
    service.start = async (input) => {
      if (!input.charter) throw new Error("Test fixture requires a charter");
      captured.push(input.charter);
      const runId = `negative-run-${++sequence}`;
      const now = new Date().toISOString();
      const summary: RunSummary = {
        runId,
        execution: { adapter: input.adapter ?? "web", ...(input.replayOfRunId ? { replayOfRunId: input.replayOfRunId } : {}) },
        startedAt: now,
        endedAt: now,
        status: "completed",
        verdict: "passed",
        charter: input.charter,
        steps: [],
        assertions: input.charter.assertions.map((assertion) => ({
          assertion,
          passed: true,
          message: "assertion passed",
          evidence: [`${runId}/after.json`],
        })),
        oracles: (input.charter.oracles ?? []).map((name) => ({
          name,
          passed: true,
          message: "oracle passed",
          evidence: [`${runId}/oracle-source.json`, `${runId}/oracle.json`],
          sourceEvidenceCount: 1,
          sourceEvidenceArtifacts: [`${runId}/oracle-source.json`],
          observedAt: now,
        })),
        artifacts: [`${runId}/after.json`, `${runId}/oracle-source.json`, `${runId}/oracle.json`],
        findings: [],
      };
      summaries.set(runId, summary);
      return { runId, status: "completed", verdict: "passed", summary };
    };
    service.wait = async (runId) => {
      const summary = summaries.get(runId);
      if (!summary) throw new Error(`Unknown fixture run ${runId}`);
      return summary;
    };
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    expect(created.plan.executionProfile).toMatchObject({
      declaredNegativeCases: ["duplicate-upload"],
      requireNegativeCases: true,
    });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(completed.plan.graph.tasks.every((task) => task.status === "passed")).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.actions).toEqual(charter.actions);
    expect(captured[1]?.actions).toEqual(negativeCase.actions);
    expect(captured[1]?.assertions).toEqual(negativeCase.assertions);
    expect(captured[1]?.oracles).toEqual(negativeCase.oracles);
    expect(captured[1]?.metadata).toMatchObject({ negativeCaseId: "duplicate-upload" });

    const surfaceRuns = completed.observations.filter((item) => item.kind === "surface.run");
    expect(surfaceRuns).toHaveLength(2);
    expect(surfaceRuns.find((item) => item.data.runKind === "negative")?.data).toMatchObject({
      negativeCaseId: "duplicate-upload",
      surface: "web",
    });
    expect(completed.evidence.length).toBeGreaterThanOrEqual(2);
    expect((await service.missionEvidence(created.missionId)).summary.executionAudit?.status).toBe("complete");
    const missionPath = join(root, ".proofkit", "missions", `${created.missionId}.json`);
    const mismatched = JSON.parse(await readFile(missionPath, "utf8")) as TestMission;
    const negative = mismatched.observations.find((item) => item.kind === "surface.run" && item.data.runKind === "negative")!;
    negative.data.outcomeMatched = false;
    await writeFile(missionPath, JSON.stringify(mismatched));
    const audited = await service.missionEvidence(created.missionId);
    expect(audited).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      summary: { executionAudit: { status: "incomplete" } } });
    expect(audited.summary.executionAudit?.issues).toEqual(expect.arrayContaining([expect.stringContaining("negative outcome")]));
  });

  it("returns an inconclusive mission when a declared negative run is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-gate-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = {
      intent: "verify duplicate upload handling",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
      negativeCases: [{
        caseId: "duplicate-upload",
        title: "重复上传应被拒绝",
        actions: [{ kind: "click", selector: "#upload" }],
        assertions: [{ kind: "text-visible", text: "Already exists" }],
        oracles: [],
        sideEffectPolicy: "deny",
        metadata: {},
      }],
    };
    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const missionPath = join(root, ".proofkit", "missions", `${created.missionId}.json`);
    const persisted = JSON.parse(await readFile(missionPath, "utf8")) as TestMission;
    persisted.status = "approved";
    persisted.plan.graph.tasks = persisted.plan.graph.tasks.map((task) => ({
      ...task,
      status: task.taskId === "verify-result" ? "pending" : "passed",
      attempts: task.taskId === "verify-result" ? 0 : 1,
    }));
    persisted.observations = [{
      observationId: "primary-run",
      source: "surface",
      kind: "surface.run",
      data: { runId: "primary-run", surface: "web", runKind: "primary", verdict: "passed", assertions: 1, oracles: 1 },
      evidence: [],
      observedAt: new Date().toISOString(),
    }];
    persisted.evidence = [
      { evidenceId: "primary-run:run.json", kind: "snapshot", path: "primary-run/run.json", description: "run", capturedAt: new Date().toISOString() },
      { evidenceId: "primary-run/oracle.json", kind: "business", path: "primary-run/oracle.json", description: "oracle", capturedAt: new Date().toISOString() },
    ];
    persisted.verdict = undefined;
    await writeFile(missionPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const started = await service.startMission(created.missionId);
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("负向场景 duplicate-upload"))).toBe(true);
    expect(completed.firstFailure?.kind).toBe("evidence");
  });

  it.each(["legacy", "failed", "unverified", "missing-proof"] as const)("keeps expected negative outcomes separate from %s cleanup", async (cleanupMode) => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-negative-expected-failure-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = {
      intent: "verify unauthorized upload rejection",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Ready" }],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
      negativeCases: [{
        caseId: "unauthorized-upload",
        title: "未授权上传应失败",
        actions: [{ kind: "click", selector: "#upload" }],
        assertions: [],
        oracles: [],
        expectedVerdict: "failed",
        sideEffectPolicy: "deny",
        metadata: {},
      }],
    };
    const summaries = new Map<string, RunSummary>();
    let sequence = 0;
    service.start = async (input) => {
      if (!input.charter) throw new Error("Test fixture requires a charter");
      const negative = input.charter.metadata.negativeCaseId === "unauthorized-upload";
      const runId = `expected-failure-run-${++sequence}`;
      const now = new Date().toISOString();
      const summary: RunSummary = {
        runId,
        startedAt: now,
        endedAt: now,
        status: "completed",
        verdict: negative ? "failed" : "passed",
        charter: input.charter,
        steps: [],
        assertions: negative ? [] : input.charter.assertions.map((assertion) => ({ assertion, passed: true, message: "passed", evidence: [`${runId}/after.json`] })),
        oracles: negative ? [] : [{ name: "resume-terminal", passed: true, message: "passed", evidence: [`${runId}/oracle-source.json`, `${runId}/oracle.json`], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [`${runId}/oracle-source.json`], observedAt: now }],
        artifacts: [`${runId}/after.json`, ...(negative ? [] : [`${runId}/oracle-source.json`]), `${runId}/oracle.json`],
        findings: negative ? ["expected authorization rejection"] : [],
        ...(negative && cleanupMode !== "legacy" ? { integrationCleanup: cleanupMode === "missing-proof"
          ? { status: "verified" as const, declaredResources: 1, verifiedResources: 1, artifact: `${runId}/artifacts/integration-cleanup.json`, sha256: "0".repeat(64) }
          : { status: cleanupMode, declaredResources: 1, verifiedResources: 0 } } : {}),
      };
      summaries.set(runId, summary);
      return { runId, status: "completed", verdict: summary.verdict, summary };
    };
    service.wait = async (runId) => {
      const summary = summaries.get(runId);
      if (!summary) throw new Error(`Unknown fixture run ${runId}`);
      return summary;
    };
    installMockRunEvidence(service);

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    if (cleanupMode === "legacy") {
      expect(completed.status).toBe("completed");
      expect(completed.verdict).toBe("passed");
      expect(completed.findings).toEqual([]);
    } else {
      expect(completed.verdict).not.toBe("passed");
      expect(completed.findings.some((finding) => finding.category === "environment" && finding.findingId.startsWith("cleanup-"))).toBe(true);
      expect(completed.findings.some((finding) => finding.category === "product")).toBe(false);
    }
    expect(completed.observations.find((item) => item.data.runKind === "negative")?.data).toMatchObject({
      verdict: "failed",
      expectedVerdict: "failed",
      outcomeMatched: cleanupMode === "legacy",
      negativeCaseId: "unauthorized-upload",
    });
  });

  it("rejects a charter and requested level that disagree", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-level-conflict-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const charter: TestCharter = { intent: "check login", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny", metadata: {} };

    await expect(service.createMission({ intent: "check login", level: "quick", surface: "web", charter })).rejects.toThrow("Charter level core does not match requested level quick");
  });

  it("loads a project-local integration module without a hosted service", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-"));
    roots.push(root);
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "integration.mjs"), "export default { name: 'fixture-integration', version: '1' };", "utf8");

    const service = await LocalRunnerService.create({ root });

    expect(service.integration?.name).toBe("fixture-integration");
    expect(service.integration?.version).toBe("1");
  });

  it("injects the ProofKit schema runtime into project factories", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-schema-"));
    roots.push(root);
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "integration.mjs"), `
      export function createIntegration({ z }) {
        const schema = z.object({ value: z.string().min(1) });
        return { name: "schema-fixture", capabilities: [{
          name: "readSchemaValue", description: "schema fixture", sideEffect: "read", environments: ["test"], timeoutMs: 1000,
          inputSchema: schema, outputSchema: schema, execute: async (input) => input, evidence: (output) => ({ value: output.value }),
        }] };
      }
    `, "utf8");

    const service = await LocalRunnerService.create({ root });

    expect(service.integration?.name).toBe("schema-fixture");
    expect(service.integration?.capabilities?.[0]?.inputSchema.parse({ value: "ok" })).toEqual({ value: "ok" });
  });

  it("executes capabilities, oracles and cleanup from the loaded integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-run-"));
    roots.push(root);
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "integration.mjs"), `
      const passthrough = { parse(value) { return value; } };
      const integration = {
        name: "fixture-integration",
        state: { cleaned: false },
        capabilities: [{
          name: "readResumeState",
          description: "Read the fixture resume terminal state",
          sideEffect: "read",
          environments: ["test"],
          timeoutMs: 1000,
          inputSchema: passthrough,
          outputSchema: passthrough,
          execute: async () => ({ status: "complete" }),
          evidence: (output) => ({ status: output.status }),
        }],
        oracles: [{
          name: "resume-terminal",
          check: async ({ steps }) => ({
            name: "resume-terminal",
            passed: steps[0]?.capabilityOutput?.status === "complete",
            message: "resume reached the terminal state",
            evidence: [],
          }),
        }],
        setup: async () => async () => { integration.state.cleaned = true; },
      };
      export default integration;
    `, "utf8");
    const service = await LocalRunnerService.create({ root });
    const adapter: SurfaceAdapter = {
      name: "fixture",
      async connect() {},
      async discover() { return { capturedAt: new Date().toISOString(), metadata: {} }; },
      async snapshot() { return { capturedAt: new Date().toISOString(), metadata: {} }; },
      async act() { throw new Error("not used"); },
      async assert(assertion) { return { assertion, passed: true, message: "not used", evidence: [] }; },
      async capture() { return undefined; },
      async subscribeEvents() { return () => {}; },
      async close() {},
    };
    const summary = await new ExecutionRunner(adapter, {
      evidenceDir: service.evidenceDir,
      capabilities: service.integration?.capabilities,
      oracles: service.integration?.oracles,
      setup: service.integration?.setup,
    }).run({
      intent: "verify resume",
      level: "core",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "capability", name: "readResumeState", input: {} }],
      assertions: [],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "integration-run");
    expect(summary.verdict).toBe("passed");
    expect((service.integration as unknown as { state: { cleaned: boolean } }).state.cleaned).toBe(true);
  });

  it("uses the configured OpenAI-compatible planner through the local service", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    let modelCalled = false;
    const server = createServer(async (request, response) => {
      modelCalled = request.method === "POST" && request.url === "/v1/chat/completions";
      for await (const _chunk of request) { /* consume request body */ }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "check resume", actions: [{ kind: "goto", url: "http://127.0.0.1:5173" }, { kind: "observe" }], assertions: [{ kind: "text-visible", text: "Resume ready" }], sideEffectPolicy: "confirm" }) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No model server port");
    const config = ProofkitConfigSchema.parse({ planning: { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }, surfaces: { web: { baseUrl: "http://127.0.0.1:5173" } } });
    const charter = await new LocalRunnerService({ workspaceRoot: root, root, config }).plan("check resume");
    expect(modelCalled).toBe(true);
    expect(charter.assertions).toEqual([{ kind: "text-visible", text: "Resume ready" }]);
    expect(charter.metadata.planner).toBe("openai-compatible");
  });

  it("validates model actions, oracle references and navigation scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const config = ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "http://127.0.0.1:5173" } }, oracles: [{ name: "resume", url: "http://127.0.0.1:8080/status", statusPointer: "/data/status", successValues: ["done"] }] });
    let actions: unknown[] = [{ kind: "goto", url: "http://127.0.0.1:5173/resumes" }, { kind: "observe" }];
    const service = new LocalRunnerService({ workspaceRoot: root, root, config, plannerProvider: { name: "fake-model", async plan() { return { intent: "test resume", actions, assertions: [{ kind: "text-visible", text: "Resume ready" }], oracles: ["resume"], sideEffectPolicy: "confirm" }; } } });
    const valid = await service.plan("test resume");
    expect(valid.oracles).toEqual(["resume"]);
    expect(valid.metadata.planner).toBe("fake-model");
    actions = [{ kind: "click", selector: "#delete" }];
    await expect(service.plan("test resume")).rejects.toThrow("outside the allowed action kinds");
    actions = [{ kind: "goto", url: "https://example.com" }];
    await expect(service.plan("test resume")).rejects.toThrow("outside the approved origin");
  });

  it("rejects an unregistered charter oracle before browser execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root });
    const started = await service.start({ charter: { intent: "check", level: "core", mode: "guided", preconditions: [], actions: [], assertions: [], oracles: ["unknown"], sideEffectPolicy: "deny", metadata: {} } });
    await expect(service.wait(started.runId)).rejects.toThrow("Oracle is not registered");
  });

  it("rejects untrusted model-authored actions before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root, restrictWebOrigins: true });
    const started = await service.start({
      charter: { intent: "unsafe", level: "core", mode: "guided", preconditions: [], actions: [{ kind: "shell", command: "whoami" } as never], assertions: [], sideEffectPolicy: "deny", metadata: {} },
    });
    await expect(service.wait(started.runId)).rejects.toThrow();
    const status = await service.status(started.runId);
    expect(status.status).toBe("failed");
  });

  it("applies the interactive-action policy to direct MCP runs as well as Missions", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-action-policy-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root, restrictWebOrigins: true });
    const started = await service.start({ charter: {
      intent: "submit a form", level: "quick", mode: "guided", preconditions: [],
      actions: [{ kind: "click", selector: "#submit" }],
      assertions: [{ kind: "text-visible", text: "saved" }], sideEffectPolicy: "deny", metadata: {},
    } });
    await expect(service.wait(started.runId)).rejects.toThrow("interactive action click requires sideEffectPolicy=allow");
  });

  it("blocks off-origin navigation in MCP mode before creating evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ workspaceRoot: root, root, restrictWebOrigins: true });
    const started = await service.start({ intent: "open external", url: "https://example.com" });
    await expect(service.wait(started.runId)).rejects.toThrow("outside the configured origin");
    await expect(readFile(join(root, ".proofkit", "runs", started.runId, "run.json"), "utf8")).rejects.toThrow();
  });

  it("does not start a configured shell command from MCP mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({
      workspaceRoot: root,
      root,
      restrictWebOrigins: true,
      config: {
        project: { root: ".", start: "echo forbidden", health: [], startupTimeoutMs: 1_000 },
        surfaces: {},
        planning: { provider: "deterministic", timeoutMs: 30_000 },
        integration: {},
        charters: [],
        suites: [],
        run: { timeoutMs: 300_000 },
        oracles: [],
        policies: {
          environment: "test",
          sideEffects: "confirm",
          saveSensitivePayloads: false,
          targetBinding: "block-different",
          runtime: {
            mode: "record",
            pageErrors: true,
            requestFailures: false,
            consoleLevels: ["error"],
            failedResponses: { enabled: true, include4xx: false },
            allowUrlPatterns: [],
            ignoreUrlPatterns: [],
            blockConsolePatterns: [],
          },
        },
      },
    });
    const started = await service.start({ intent: "observe" });
    await expect(service.wait(started.runId)).rejects.toThrow("cannot execute project.start");
  });
});
