import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, type NegativeCase, type RunSummary, type TestCharter, type TestMission } from "@proofkit/contracts";
import { ExecutionRunner, type SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("LocalRunnerService", () => {
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
      oracles: [{ name: "fixture-terminal", passed: true, message: "fixture is complete", evidence: ["fixture-run/oracle-1.json"], observedAt: new Date().toISOString() }],
      artifacts: ["fixture-run/after.json", "fixture-run/oracle-1.json"],
      findings: [],
    };
    service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
    service.wait = async () => summary;

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
    expect(evidence.taskSummary).toHaveLength(3);
    expect(evidence.taskSummary.every((task) => task.status === "passed" && task.attempts === 1)).toBe(true);
    expect(evidence.agentSteps).toHaveLength(3);
    expect(evidence.agentSteps.map((step) => step.phase)).toEqual(["execute", "execute", "verify"]);
    expect(evidence.agentSteps.every((step) => step.status === "succeeded" && step.toolCallIds.length === 1)).toBe(true);
    expect(evidence.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "report" }),
      expect.objectContaining({ kind: "business" }),
    ]));
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

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("inconclusive");
    expect(completed.firstFailure?.kind).toBe("evidence");
    expect(completed.findings.some((finding) => finding.message.includes("独立业务 Oracle"))).toBe(true);
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

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.verdict).toBe("inconclusive");
    expect(completed.findings.some((finding) => finding.message.includes("可观察断言"))).toBe(true);
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
    const createSummary = (adapter: string): RunSummary => {
      sequence += 1;
      return {
        runId: `release-run-${sequence}`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "completed",
        verdict: "passed",
        charter,
        steps: [],
        assertions: [{ assertion: charter.assertions[0]!, passed: true, message: `${adapter} ready`, evidence: [`release-run-${sequence}/after.json`] }],
        oracles: [{ name: "fixture-terminal", passed: true, message: `${adapter} terminal`, evidence: [`release-run-${sequence}/oracle.json`], observedAt: new Date().toISOString() }],
        artifacts: [`release-run-${sequence}/after.json`, `release-run-${sequence}/oracle.json`, `release-run-${sequence}/trace.json`],
        findings: [],
      };
    };
    service.start = async (input) => {
      const adapter = input.adapter ?? "web";
      const summary = createSummary(adapter);
      runs.push({ adapter, runKind: "primary" });
      return { runId: summary.runId, status: "completed", verdict: summary.verdict, summary };
    };
    service.wait = async (runId) => {
      const index = Number(runId.split("-").at(-1));
      return createSummary(index % 2 === 0 ? "electron" : "web");
    };
    service.replay = async (runId, input = {}) => {
      const adapter = input.adapter ?? "web";
      const summary = createSummary(adapter);
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
          evidence: [`${runId}/oracle.json`],
          observedAt: now,
        })),
        artifacts: [`${runId}/after.json`, `${runId}/oracle.json`],
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

  it("accepts an expected failed verdict for a negative case without creating a product finding", async () => {
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
        oracles: negative ? [] : [{ name: "resume-terminal", passed: true, message: "passed", evidence: [`${runId}/oracle.json`], observedAt: now }],
        artifacts: [`${runId}/after.json`, `${runId}/oracle.json`],
        findings: negative ? ["expected authorization rejection"] : [],
      };
      summaries.set(runId, summary);
      return { runId, status: "completed", verdict: summary.verdict, summary };
    };
    service.wait = async (runId) => {
      const summary = summaries.get(runId);
      if (!summary) throw new Error(`Unknown fixture run ${runId}`);
      return summary;
    };

    const created = await service.createMission({ intent: charter.intent, surface: "web", charter });
    const started = await service.startMission(created.missionId, { approve: true });
    const completed = await service.waitMission(started.mission.missionId);

    expect(completed.status).toBe("completed");
    expect(completed.verdict).toBe("passed");
    expect(completed.findings).toEqual([]);
    expect(completed.observations.find((item) => item.data.runKind === "negative")?.data).toMatchObject({
      verdict: "failed",
      expectedVerdict: "failed",
      outcomeMatched: true,
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
        run: { timeoutMs: 300_000 },
        oracles: [],
        policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
      },
    });
    const started = await service.start({ intent: "observe" });
    await expect(service.wait(started.runId)).rejects.toThrow("cannot execute project.start");
  });
});
