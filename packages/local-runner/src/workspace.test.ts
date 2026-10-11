import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { initProject } from "@proofkit/project";
import { ProjectRuntime } from "@proofkit/runtime";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
  vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }));
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-external-run-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "tests");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"real-source","devDependencies":{"vite":"1"}}');
  await initProject(root, { workspaceRoot });
  return { base, root, workspaceRoot };
}

const charter = () => TestCharterSchema.parse({ intent: "verify fixture", level: "quick", surfaces: ["web"], actions: [], assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny" });

describe("external test workspace", () => {
  it("creates a Mission only from a digest-pinned, direct external Charter file", async () => {
    const { root, workspaceRoot } = await fixture();
    const directory = join(workspaceRoot, ".proofkit", "charters");
    await mkdir(directory);
    const path = ".proofkit/charters/candidate.yml";
    const file = join(directory, "candidate.yml");
    await writeFile(file, JSON.stringify(charter()));
    const service = await LocalRunnerService.create({ root, workspaceRoot, restrictWebOrigins: true });
    const candidate = (await service.inspectTestScope({ level: "quick" })).workspaceCandidates?.items[0];
    expect(candidate).toMatchObject({ path, parseStatus: "valid", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const options = { intent: "快速检查候选流程", level: "quick" as const, surface: "web" as const, charterPath: path, charterSha256: candidate!.sha256! };
    await expect(service.createMission({ ...options, charterSha256: undefined })).rejects.toThrow("requires the SHA-256");
    await expect(service.createMission({ ...options, intent: "测试候选流程", level: undefined })).rejects.toThrow("does not match requested level core");
    await expect(service.createMission({ ...options, charter: charter() })).rejects.toThrow("cannot be combined");
    await expect(service.createMission({ ...options, charterPath: "../source/package.json" })).rejects.toThrow();
    await expect(service.createMission({ ...options, charterPath: ".proofkit/charters/nested/candidate.yml" })).rejects.toThrow("direct YAML file");
    const mission = await service.createMission(options);
    expect(mission.charter).toMatchObject({ intent: "verify fixture", metadata: { proofkitCandidate: { path, sha256: candidate!.sha256 } } });
    expect(await readdir(root)).toEqual(["package.json"]);
    const registered = new LocalRunnerService({ root, workspaceRoot, restrictWebOrigins: true, config: ProofkitConfigSchema.parse({
      charters: [{ id: "candidate-quick", path, aliases: ["candidate"], level: "quick", surfaces: ["web"] }],
    }) });
    await expect(registered.createMission(options)).rejects.toThrow("already registered");

    await writeFile(file, JSON.stringify({ ...charter(), assertions: [{ kind: "text-visible", text: "changed" }] }));
    await expect(service.createMission(options)).rejects.toThrow("digest changed");
    await writeFile(join(directory, "oversized.yml"), "x".repeat(129 * 1024));
    await expect(service.createMission({ ...options, charterPath: ".proofkit/charters/oversized.yml" })).rejects.toThrow("read limit");
    await writeFile(join(directory, "invalid.yml"), "intent: [private-source-value\n");
    const invalid = await service.inspectTestScope({ level: "quick" });
    expect(invalid.workspaceCandidates?.items.find((item) => item.path.endsWith("invalid.yml"))).toMatchObject({ parseStatus: "invalid" });
    expect(JSON.stringify(invalid)).not.toContain("private-source-value");
    const secret = join(root, "private.yml");
    await writeFile(secret, JSON.stringify(charter()));
    try { await symlink(secret, join(directory, "linked.yml")); }
    catch (error) { if (!["EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    await expect(service.createMission({ ...options, charterPath: ".proofkit/charters/linked.yml" })).rejects.toThrow("unavailable or redirected");
  });
  it.each([
    ["missing version", "recover: async () => []", "explicit connector version"],
    ["blank version", "version: ' ', recover: async () => []", "non-empty string version"],
    ["numeric version", "version: 1, recover: async () => []", "non-empty string version"],
    ["oversized version", `version: '${"v".repeat(129)}', recover: async () => []`, "non-empty string version"],
    ["invalid hook", "version: '1.0.0', recover: true", "recovery requires a function"],
  ])("rejects a recovery connector with %s at loading", async (_label, fields, message) => {
    const { root, workspaceRoot } = await fixture();
    await writeFile(join(workspaceRoot, ".proofkit/integration.mjs"), `export default { name: 'recovery-fixture', ${fields} };`);
    await expect(LocalRunnerService.create({ root, workspaceRoot })).rejects.toThrow(message);
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("selects a curated Charter from natural language without changing the source project", async () => {
    const { root, workspaceRoot } = await fixture();
    const catalogCharter = TestCharterSchema.parse({
      intent: "验证简历获取核心链路",
      level: "core",
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "ready" }],
      oracles: ["resume-status"],
      sideEffectPolicy: "deny",
    });
    await mkdir(join(workspaceRoot, ".proofkit", "charters"));
    const charterPath = join(workspaceRoot, ".proofkit", "charters", "resume.yml");
    await writeFile(charterPath, JSON.stringify(catalogCharter));
    await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
      project: { root },
      charters: [{ id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["简历获取"], level: "core", surfaces: ["web", "electron"] }],
      oracles: [{ name: "resume-status", url: "http://127.0.0.1:8080/status", statusPointer: "/data/status", successValues: ["complete"] }],
    }));
    const service = await LocalRunnerService.create({ root, workspaceRoot });
    expect(service.listCharters()).toHaveLength(1);
    const mission = await service.createMission({ intent: "测试简历获取核心链路", surface: "electron" });
    expect(mission.charter).toMatchObject({ intent: catalogCharter.intent, metadata: { catalogId: "resume-core", matchedAlias: "简历获取" } });
    expect(mission.policy.sideEffectPolicy).toBe("deny");
    expect(mission.plan.executionProfile.surfaceMatrix).toEqual(["electron"]);
    expect(await readdir(root)).toEqual(["package.json"]);
    await expect(service.createMission({ intent: "其它内容", surface: "web", charterId: "resume-core", url: "http://127.0.0.1" }))
      .rejects.toThrow("cannot be combined");
    await writeFile(charterPath, JSON.stringify({ ...catalogCharter, assertions: [] }));
    await expect(service.createMission({ intent: "简历获取", surface: "web" })).rejects.toThrow("needs a positive surface assertion");
    await writeFile(charterPath, JSON.stringify({ ...catalogCharter, oracles: ["missing"] }));
    await expect(service.createMission({ intent: "简历获取", surface: "web" })).rejects.toThrow("unregistered Oracle");
    await writeFile(charterPath, JSON.stringify({ ...catalogCharter, level: "quick" }));
    await expect(service.createMission({ intent: "简历获取", surface: "web" })).rejects.toThrow("declares core");
    await writeFile(charterPath, JSON.stringify({ ...catalogCharter, actions: [{ kind: "goto", url: "https://example.com" }] }));
    const restricted = await LocalRunnerService.create({ root, workspaceRoot, restrictWebOrigins: true });
    await expect(restricted.createMission({ intent: "简历获取", surface: "web" })).rejects.toThrow("outside the configured origin");
  });

  it("validates agent-submitted plans before persisting a Mission", async () => {
    const { root, workspaceRoot } = await fixture();
    const service = await LocalRunnerService.create({ root, workspaceRoot, restrictWebOrigins: true });
    const submitted = TestCharterSchema.parse({
      intent: "测试核心流程", level: "core", actions: [],
      assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["missing"], sideEffectPolicy: "deny",
    });
    await expect(service.createMission({ intent: submitted.intent, charter: submitted }))
      .rejects.toThrow("unregistered Oracle");
    await expect(service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [], actions: [{ kind: "capability", name: "missing", input: {} }] } }))
      .rejects.toThrow("unregistered capability");
    await expect(service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [], actions: [{ kind: "goto", url: "https://example.com" }] } }))
      .rejects.toThrow("outside the configured origin");
    await expect(service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [], actions: [{ kind: "click", selector: "#submit" }] } }))
      .rejects.toThrow("interactive action click requires sideEffectPolicy=allow");
    await expect(service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [], actions: [{ kind: "setInputFiles", selector: "#resume", files: [".proofkit/fixtures/resume.pdf"] }] } }))
      .rejects.toThrow("interactive action setInputFiles requires sideEffectPolicy=allow");
    await expect(service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [], sideEffectPolicy: "allow", actions: [{ kind: "setInputFiles", selector: "#resume", files: [".proofkit/fixtures/resume.pdf"] }] } }))
      .rejects.toThrow("requires policies.sideEffects=allow");
    const incomplete = await service.createMission({ intent: submitted.intent, charter: { ...submitted, oracles: [] } });
    expect(incomplete.plan.planning).toMatchObject({ source: "submitted", evidenceGaps: ["business-oracle"] });
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("runs an external Charter and connector, then reads and replays a Mission after restart", async () => {
    const { root, workspaceRoot } = await fixture();
    await mkdir(join(workspaceRoot, ".proofkit", "fixtures"));
    await writeFile(join(workspaceRoot, ".proofkit", "fixtures", "value.txt"), "complete");
    await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export function createIntegration({ root, projectRoot, workspaceRoot, z }) {
        return { name: 'external-fixture', roots: { root, projectRoot, workspaceRoot },
          capabilities: [{ name: 'fixture.read', description: 'read fixture', sideEffect: 'read', environments: ['test'], timeoutMs: 1000,
            inputSchema: z.object({}), outputSchema: z.object({ status: z.string() }),
            execute: async () => ({ status: await readFile(join(root, '.proofkit/fixtures/value.txt'), 'utf8') }), evidence: (value) => value }],
          oracles: [{ name: 'fixture.terminal', check: async ({ steps }) => ({ name: 'fixture.terminal', passed: steps[0].capabilityOutput.status === 'complete', message: 'terminal', evidence: [JSON.stringify({ status: steps[0].capabilityOutput.status })] }) }] };
      }
    `);
    const core = TestCharterSchema.parse({ ...charter(), level: "core", actions: [{ kind: "capability", name: "fixture.read", input: {} }], oracles: ["fixture.terminal"] });
    await writeFile(join(workspaceRoot, "charter.json"), JSON.stringify(core));
    const service = await LocalRunnerService.create({ root, workspaceRoot });
    expect((await service.discover()).packageName).toBe("real-source");
    expect(service.integration).toMatchObject({ roots: { root: workspaceRoot, projectRoot: root, workspaceRoot } });
    const started = await service.start({ charterPath: "charter.json" });
    const summary = await service.wait(started.runId);
    expect(summary).toMatchObject({ verdict: "passed", projectRoot: root, workspaceRoot });
    expect(summary.oracles[0]?.sourceEvidenceCount).toBe(1);
    const mission = await service.createMission({ intent: core.intent, charter: core });
    await service.startMission(mission.missionId, { approve: true });
    expect((await service.waitMission(mission.missionId)).verdict).toBe("passed");
    const restarted = await LocalRunnerService.create({ root, workspaceRoot });
    expect((await restarted.status(started.runId)).verdict).toBe("passed");
    const acceptedEvidence = await restarted.missionEvidence(mission.missionId);
    expect(acceptedEvidence).toMatchObject({
      projectRoot: root, workspaceRoot, verdict: "passed",
      testVerdict: "passed",
      summary: { verdict: "passed", testVerdict: "passed" },
      acceptanceEvidenceIntegrity: { status: "intact", scope: "mission-evidence", references: { omitted: 0 } },
      proofClassification: { status: "explicit", checkedRuns: 1, classifiedOracles: 1, legacyOracles: 0 },
      targetBindings: [{ surface: "web", binding: { status: "unverified" } }],
      evidenceIntegrity: { visibleConfirmedFindings: { saved: 0, supported: 0 } },
    });
    const omittedEvidenceReferences = acceptedEvidence.summary.runs.reduce((count, run) => count + run.omittedEvidence, 0);
    expect(acceptedEvidence.evidenceIntegrity).toMatchObject({
      status: omittedEvidenceReferences ? "partial" : "intact",
      omittedEvidenceReferences,
    });
    expect((await restarted.evidenceFor(started.runId, "report")).content).toContain("Oracle checks");
    const replay = await restarted.replayMission(mission.missionId, { approve: true });
    expect((await restarted.waitMission(replay.mission.missionId)).verdict).toBe("passed");
    const business = acceptedEvidence.evidence.find((ref) => ref.kind === "business");
    expect(business?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(business!.path, "changed after acceptance");
    const degraded = await restarted.missionEvidence(mission.missionId);
    expect(degraded.verdict).toBe("passed");
    expect(degraded.testVerdict).toBe("inconclusive");
    expect(degraded.testVerdictReason).toContain("unverifiable evidence");
    expect(degraded.acceptanceEvidenceIntegrity).toMatchObject({ status: "degraded", references: { unavailable: 1 } });
    expect(degraded.summary).toMatchObject({ verdict: "passed", testVerdict: "inconclusive" });
    expect(degraded.evidenceIntegrity).toMatchObject({ status: "degraded", references: { unavailable: 1 } });
    expect(degraded.summary.evidenceIntegrity).toEqual(degraded.evidenceIntegrity);
    expect(await readFile(degraded.report!, "utf8")).toContain("Saved pass · current evidence unverified");
    const missionRunId = acceptedEvidence.summary.runs.find((run) => run.runKind === "primary")?.runId;
    if (!missionRunId) throw new Error("Mission has no primary Run");
    const savedRunPath = join(restarted.evidenceDir, missionRunId, "run.json");
    const legacyRun = JSON.parse(await readFile(savedRunPath, "utf8"));
    delete legacyRun.oracles[0].verificationKind;
    await writeFile(savedRunPath, JSON.stringify(legacyRun));
    const legacyEvidence = await restarted.missionEvidence(mission.missionId);
    expect(legacyEvidence.verdict).toBe("passed");
    expect(legacyEvidence.testVerdict).toBe("inconclusive");
    expect(legacyEvidence.testVerdictReason).toContain("classified passing business Oracle in every required Run");
    expect(legacyEvidence.summary).toMatchObject({ verdict: "passed", testVerdict: "inconclusive" });
    expect(legacyEvidence.proofClassification).toMatchObject({ status: "unverified", legacyOracles: 1,
      legacyRunIds: [missionRunId] });
    expect(legacyEvidence.summary.proofClassification).toEqual(legacyEvidence.proofClassification);
    expect(await readFile(legacyEvidence.report!, "utf8")).toContain("Saved pass · current business proof unverified");
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("keeps project startup on the source root", async () => {
    const { root, workspaceRoot } = await fixture();
    const start = vi.spyOn(ProjectRuntime.prototype, "start").mockResolvedValue();
    vi.spyOn(ProjectRuntime.prototype, "stop").mockResolvedValue();
    const service = await LocalRunnerService.create({ root, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { start: "node app.js", cwd: "apps/web" } }) });
    const run = await service.start({ charter: charter() });
    await service.wait(run.runId);
    expect(start).toHaveBeenCalledOnce();
    const runtime = start.mock.instances[0] as unknown as { options: { root: string; config: { project: { cwd: string } } } };
    expect(runtime.options.root).toBe(root);
    expect(runtime.options.config.project.cwd).toBe("apps/web");
  });

  it("rejects another project's workspace even when a caller overrides config", async () => {
    const { base, root, workspaceRoot } = await fixture();
    const other = join(base, "other");
    await mkdir(other);
    await expect(LocalRunnerService.create({ root: other, workspaceRoot, config: ProofkitConfigSchema.parse({}) })).rejects.toThrow("bound to another project");
    expect(() => new LocalRunnerService({ root: other, workspaceRoot })).toThrow("bound to another project");
    expect(await readdir(root)).toEqual(["package.json"]);
  });

  it("refuses a Mission copied from another workspace before approval or execution", async () => {
    const { base, root, workspaceRoot } = await fixture();
    const first = await LocalRunnerService.create({ root, workspaceRoot });
    const mission = await first.createMission({ intent: "ready", charter: charter() });
    const otherWorkspace = join(base, "other-tests");
    await initProject(root, { workspaceRoot: otherWorkspace });
    await mkdir(join(otherWorkspace, ".proofkit", "missions"));
    await copyFile(join(workspaceRoot, ".proofkit", "missions", `${mission.missionId}.json`), join(otherWorkspace, ".proofkit", "missions", `${mission.missionId}.json`));
    const second = await LocalRunnerService.create({ root, workspaceRoot: otherWorkspace });
    await expect(second.approveMission(mission.missionId)).rejects.toThrow("another workspace");
    await expect(second.startMission(mission.missionId, { approve: true })).rejects.toThrow("another workspace");
    await expect(second.missionEvidence(mission.missionId)).rejects.toThrow("another workspace");
    await expect(second.replayMission(mission.missionId)).rejects.toThrow("another workspace");
    expect(JSON.parse(await readFile(join(otherWorkspace, ".proofkit", "missions", `${mission.missionId}.json`), "utf8")).status).toBe("awaiting-approval");
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("refuses a Mission with the wrong source and permits old unbound Missions only in the legacy layout", async () => {
    const { base, root, workspaceRoot } = await fixture();
    const service = await LocalRunnerService.create({ root, workspaceRoot });
    const mission = await service.createMission({ intent: "ready", charter: charter() });
    const path = join(workspaceRoot, ".proofkit", "missions", `${mission.missionId}.json`);
    await writeFile(path, JSON.stringify({ ...mission, projectRoot: base }));
    await expect(service.missionStatus(mission.missionId)).rejects.toThrow("another project");
    await writeFile(path, JSON.stringify({ ...mission, workspaceRoot: undefined }));
    await expect(service.missionStatus(mission.missionId)).rejects.toThrow("no workspace binding");
    const legacy = new LocalRunnerService({ root, workspaceRoot: root });
    const old = await legacy.createMission({ intent: "old", charter: charter() });
    await writeFile(join(root, ".proofkit", "missions", `${old.missionId}.json`), JSON.stringify({ ...old, workspaceRoot: undefined }));
    expect((await legacy.missionStatus(old.missionId)).mission.intent).toBe("old");
  });

  it("rejects foreign run evidence in a shared artifact directory", async () => {
    const { base, root, workspaceRoot } = await fixture();
    const evidenceDir = join(base, "shared-runs");
    const first = await LocalRunnerService.create({ root, workspaceRoot, evidenceDir });
    const run = await first.start({ charter: charter() });
    await first.wait(run.runId);
    const other = join(base, "other");
    await mkdir(other);
    const second = new LocalRunnerService({ root: other, workspaceRoot: join(base, "other-tests"), evidenceDir });
    await expect(second.status(run.runId)).rejects.toThrow("another project");
    await expect(second.wait(run.runId)).rejects.toThrow("another project");
    await expect(second.evidenceFor(run.runId, "report")).rejects.toThrow("another project");
    await expect(second.replay(run.runId)).rejects.toThrow("another project");
  });
});
