import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { analyzeRun } from "@proofkit/agent";
import { TestCharterSchema, type TestCharter } from "@proofkit/contracts";
import { loadCharter } from "@proofkit/planner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

const envKeys = [
  "AIHR_PROOFKIT_API_BASE_URL",
  "AIHR_PROOFKIT_ACCESS_TOKEN",
  "AIHR_PROOFKIT_ENTERPRISE_ID",
  "AIHR_PROOFKIT_WORKSPACE_ID",
  "AIHR_PROOFKIT_USER_ID",
  "AIHR_PROOFKIT_SOURCE_CHANNEL",
  "AIHR_PROOFKIT_CANDIDATE_UID",
  "AIHR_PROOFKIT_CONVERSATION_ID",
  "AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID",
  "AIHR_PROOFKIT_FIXTURE_PATH",
  "AIHR_PROOFKIT_JOB_ID",
  "AIHR_PROOFKIT_CLIENT_ITEM_KEY",
  "AIHR_PROOFKIT_NEGATIVE_CLIENT_ITEM_KEY",
  "AIHR_PROOFKIT_TEST_SCOPE",
  "AIHR_PROOFKIT_ALLOW_REMOTE_TEST_ENDPOINT",
];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  vi.restoreAllMocks();
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("AIHR project integration", () => {
  it("projects successful and failed terminal states through the gateway contract", async () => {
    let mode: "success" | "failed" = "success";
    const server = await startGatewayMock(() => mode);
    servers.push(server);
    const root = await createIntegrationProject();
    const service = await LocalRunnerService.create({ root });
    const integration = service.integration;
    if (!integration) throw new Error("AIHR integration was not loaded");

    const intake = integration.capabilities?.find((item) => item.name === "aihr.createOnlineResumeIntake");
    const wait = integration.capabilities?.find((item) => item.name === "aihr.waitOnlineResumePipeline");
    const oracle = integration.oracles?.find((item) => item.name === "aihr.onlineResumePipeline");
    if (!intake || !wait || !oracle) throw new Error("AIHR integration contract is incomplete");

    const context = { runId: "aihr-fixture-run", signal: new AbortController().signal };
    const intakeOutput = await intake.execute({
      conversationId: "101",
      workflowId: "202",
      workflowVersion: "1",
      jobId: "505",
      candidateUid: "candidate-fixture",
      bossAccountId: "acct-fixture",
      sourcePlatform: "boss",
      sourceText: "redacted resume text",
      originalFilename: "proofkit.pdf",
      maxAttempts: 3,
      manualOverride: false,
    }, context);
    expect(intakeOutput).toMatchObject({ taskId: "606", status: "pending", conversationId: "101", workflowId: "202", jobId: "505" });

    const success = await wait.execute({ sourceChannel: "boss", maxWaitMs: 1_000, pollIntervalMs: 250, requireAssessmentSuccess: true }, context);
    expect(success).toMatchObject({ passed: true, terminal: true, workflowPhase: "wait_online_screening", resumeFileId: "303", extractStatus: "done", parseStatus: "matched", candidateId: "404", assessmentTaskStatus: "success" });
    const successOracle = await oracle.check({ runId: context.runId, charter: aihrCharter(), steps: [], assertions: [], signal: context.signal });
    expect(successOracle.passed).toBe(true);

    mode = "failed";
    const failed = await wait.execute({ conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture", sourceChannel: "boss", maxWaitMs: 1_000, pollIntervalMs: 250, requireAssessmentSuccess: true }, { runId: "aihr-failed-run", signal: context.signal });
    expect(failed).toMatchObject({ passed: false, terminal: true, workflowPhase: "wait_online_screening", extractStatus: "failed", parseStatus: "pending", lastErrorCode: null });
    const failedOracle = await oracle.check({ runId: "aihr-failed-run", charter: aihrCharter(), steps: [], assertions: [], signal: context.signal });
    expect(failedOracle.passed).toBe(false);
  });

  it("bounds polling, propagates cancellation, and keeps evidence projections free of source text", async () => {
    const server = await startGatewayMock(() => "processing");
    servers.push(server);
    const root = await createIntegrationProject();
    const service = await LocalRunnerService.create({ root });
    const integration = service.integration;
    if (!integration) throw new Error("AIHR integration was not loaded");
    const intake = integration.capabilities?.find((item) => item.name === "aihr.createOnlineResumeIntake");
    const wait = integration.capabilities?.find((item) => item.name === "aihr.waitOnlineResumePipeline");
    if (!intake || !wait) throw new Error("AIHR integration capability is missing");

    const signal = new AbortController().signal;
    const context = { runId: "aihr-timeout-run", signal };
    const output = await intake.execute({
      conversationId: "101",
      workflowId: "202",
      workflowVersion: "1",
      jobId: "505",
      candidateUid: "candidate-fixture",
      bossAccountId: "acct-fixture",
      sourcePlatform: "boss",
      sourceText: "super-secret source text must never be evidence",
      originalFilename: "proofkit.pdf",
      maxAttempts: 3,
      manualOverride: false,
    }, context);
    const evidence = intake.evidence(output);
    expect(JSON.stringify(evidence)).not.toContain("super-secret");

    const timedOut = await wait.execute({ sourceChannel: "boss", maxWaitMs: 1_000, pollIntervalMs: 250, requireAssessmentSuccess: true }, context);
    expect(timedOut).toMatchObject({ passed: null, terminal: false, workflowPhase: "online_resume_processing" });
    expect(timedOut.observationCount).toBeGreaterThan(1);

    const controller = new AbortController();
    const cancelled = wait.execute({ conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture", sourceChannel: "boss", maxWaitMs: 60_000, pollIntervalMs: 10_000, requireAssessmentSuccess: true }, { runId: "aihr-cancel-run", signal: controller.signal });
    controller.abort(new Error("fixture cancelled"));
    await expect(cancelled).rejects.toThrow("fixture cancelled");
  });

  it.each([
    ["assessment-processing", null], ["assessment-retry", null], ["assessment-missing", null],
    ["relation-missing", null], ["workflow-retry", null], ["retry-before-file", null],
    ["workflow-id-missing", null], ["workflow-conversation-missing", null], ["workflow-job-missing", null],
    ["file-id-missing", null], ["conversation-candidate-missing", null], ["relation-candidate-missing", null],
    ["assessment-id-missing", null], ["assessment-file-missing", null], ["assessment-status-missing", null],
    ["assessment-task-missing", null], ["assessment-running", null],
    ["attachment-replaced-current", null], ["attachment-bound-before-phase", null], ["completed-without-attachment", null],
    ["terminated-reject", true], ["terminated-stage-missing", null], ["terminated-stage-conflict", false],
    ["assessment-dead", false], ["assessment-cancelled", false], ["assessment-conflict", false],
    ["assessment-failed", false], ["workflow-wrong-id", false], ["workflow-wrong-conversation", false],
    ["relation-wrong-candidate", false],
    ["relation-old-file", false], ["assessment-old-file", false], ["assessment-wrong-job", false],
    ["assessment-wrong-candidate", false], ["workflow-wrong-job", false], ["file-wrong-id", false],
    ["candidate-conflict", false],
  ] as const)("uses independent correlated facts for online state %s", async (mode, expected) => {
    const server = await startGatewayMock(() => mode);
    servers.push(server);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const wait = service.integration?.capabilities?.find((item) => item.name === "aihr.waitOnlineResumePipeline");
    const oracle = service.integration?.oracles?.find((item) => item.name === "aihr.onlineResumePipeline");
    if (!wait || !oracle) throw new Error("AIHR online pipeline contract is missing");
    const context = { runId: `online-${mode}`, signal: new AbortController().signal };
    const checked = await oracle.check({ ...context, charter: aihrCharter(), steps: [], assertions: [] });
    expect(checked.passed).toBe(expected);
    expect(JSON.parse(checked.evidence[0] ?? "{}")).toMatchObject({ passed: expected, terminal: expected !== null });
    expect(checked.sourceLocations?.length ?? 0).toBe(expected === false ? 2 : 0);
    const observed = await wait.execute({
      conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture",
      maxWaitMs: 1_000, pollIntervalMs: 250, requireAssessmentSuccess: true,
    }, context);
    expect(observed).toMatchObject({ passed: expected, terminal: expected !== null });
    expect(wait.outputSchema.safeParse(observed).success).toBe(true);
    expect(wait.evidence(observed)).toMatchObject({ passed: expected, terminal: expected !== null });
  });

  it("waits through retryable online errors and verifies the recovered file's assessment", async () => {
    let observation = 0;
    const server = await startGatewayMock(() => ++observation < 3 ? "workflow-retry" : "success");
    servers.push(server);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const wait = service.integration?.capabilities?.find((item) => item.name === "aihr.waitOnlineResumePipeline");
    const oracle = service.integration?.oracles?.find((item) => item.name === "aihr.onlineResumePipeline");
    if (!wait || !oracle) throw new Error("AIHR online pipeline contract is missing");
    const context = { runId: "online-recovered", signal: new AbortController().signal };
    const output = await wait.execute({
      conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture",
      maxWaitMs: 2_000, pollIntervalMs: 250, requireAssessmentSuccess: true,
    }, context);
    expect(output).toMatchObject({ passed: true, terminal: true, observationCount: 3, assessmentCurrentResumeFileId: "303", assessmentJobId: "505", assessmentCandidateId: "404" });
    expect((await oracle.check({ ...context, charter: aihrCharter(), steps: [], assertions: [] })).passed).toBe(true);
  });

  it.each(["assessment-retry", "assessment-old-file", "attachment-replaced-current"] as const)("preserves online %s source evidence without changing the failure classification", async (mode) => {
    servers.push(await startGatewayMock(() => mode));
    process.env.AIHR_PROOFKIT_TEST_SCOPE = "proofkit:fixture";
    vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
    vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const charter = TestCharterSchema.parse({ ...aihrCharter(), oracles: ["aihr.onlineResumePipeline"] });
    const started = await service.start({ charter });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe(mode === "assessment-old-file" ? "failed" : "inconclusive");
    const observed = summary.oracles[0];
    expect(observed?.sourceEvidenceArtifacts).toEqual([`${summary.runId}/artifacts/oracle-1-source.json`]);
    const evidencePath = observed?.sourceEvidenceArtifacts?.[0];
    if (!evidencePath) throw new Error("online business source artifact is missing");
    const source = JSON.parse(await readFile(join(service.evidenceDir, evidencePath), "utf8"));
    expect(source.facts[0]).toMatchObject({
      workflowId: "202", workflowConversationId: "101", workflowJobId: "505", resumeFileId: "303", fileId: "303",
      candidateId: "404", conversationCandidateId: "404", relationCandidateId: "404",
      assessmentCurrentResumeFileId: mode === "assessment-retry" ? "303" : "777",
      assessmentTaskStatus: mode === "assessment-retry" ? "retry_wait" : "success",
      passed: mode === "assessment-old-file" ? false : null,
    });
    if (mode === "attachment-replaced-current") {
      expect(source.facts[0]).toMatchObject({ acceptanceScope: "online-resume", scopeSuperseded: true, attachmentResumeFileId: "777" });
    }
    const analysis = analyzeRun({ summary, evidence: [{
      evidenceId: `${summary.runId}:${evidencePath}`, kind: "business", path: join(service.evidenceDir, evidencePath),
      capturedAt: summary.endedAt ?? summary.startedAt,
    }] });
    expect(analysis.finding).toMatchObject(mode === "assessment-old-file"
      ? { category: "product", status: "confirmed" } : { category: "test", status: "unverified" });
    expect(analysis.diagnosis !== undefined).toBe(mode === "assessment-old-file");
    expect(analysis.repairSuggestion !== undefined).toBe(mode === "assessment-old-file");
  });

  it.each([
    ["assessment-retry", null], ["assessment-running", null], ["assessment-task-missing", null],
    ["assessment-dead", false], ["assessment-cancelled", false], ["assessment-failed", false],
  ] as const)("requires evaluation and task completion for ordinary upload state %s", async (mode, expected) => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64), mode });
    servers.push(gateway.server);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const wait = service.integration?.capabilities?.find((item) => item.name === "aihr.waitResumeCollectionPipeline");
    const oracle = service.integration?.oracles?.find((item) => item.name === "aihr.resumeCollectionPipeline");
    if (!wait || !oracle) throw new Error("AIHR ordinary pipeline contract is missing");
    const context = { runId: `ordinary-${mode}`, signal: new AbortController().signal };
    const observed = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(observed).toMatchObject({ passed: expected, outcome: expected === null ? "inconclusive" : "failed" });
    expect(wait.outputSchema.safeParse(observed).success).toBe(true);
    const checked = await oracle.check({ ...context, charter: resumeCollectionCharter(), steps: [], assertions: [] });
    expect(checked.passed).toBe(expected);
    expect(checked.sourceLocations?.length ?? 0).toBe(expected === false ? 1 : 0);
  });

  it("uploads an external test-workspace PDF as multipart and proves the ordinary collection pipeline", async () => {
    const fixtureBytes = Buffer.from("%PDF-1.4 proofkit fixture\n", "utf8");
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
    const gateway = await startCollectionGatewayMock({ fixtureSha256 });
    servers.push(gateway.server);
    const workspaceRoot = await createIntegrationProject(fixtureBytes);
    const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "proofkit-aihr-source-"));
    roots.push(root);
    const service = await LocalRunnerService.create({ root, workspaceRoot });
    const integration = service.integration;
    if (!integration) throw new Error("AIHR integration was not loaded");

    const createRun = integration.capabilities?.find((item) => item.name === "aihr.createResumeCollectionRun");
    const upload = integration.capabilities?.find((item) => item.name === "aihr.uploadResumeFile");
    const wait = integration.capabilities?.find((item) => item.name === "aihr.waitResumeCollectionPipeline");
    const oracle = integration.oracles?.find((item) => item.name === "aihr.resumeCollectionPipeline");
    if (!createRun || !upload || !wait || !oracle) throw new Error("AIHR resume collection integration is incomplete");

    const context = { runId: "aihr-collection-run", signal: new AbortController().signal };
    const created = await createRun.execute({ sourceChannel: "boss", taskName: "fixture resume", bossAccountId: "acct-fixture" }, context);
    expect(created).toMatchObject({ runId: "900", status: "pending" });

    const uploaded = await upload.execute({
      fixturePath: ".proofkit/fixtures/resume.pdf",
      sourceChannel: "boss",
      targetJobIds: ["505"],
      clientItemKey: "proofkit:fixture:item-1",
      resumeRole: "attachment",
      originalFilename: "candidate.pdf",
    }, context);
    expect(uploaded).toMatchObject({ fileId: "901", runId: "900", fileSha256: fixtureSha256, status: "accepted", duplicate: false });
    expect(gateway.uploadContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(gateway.uploadBody).toContain("client_item_key");
    expect(gateway.uploadBody).toMatch(/name="run_id"\r\n\r\n900\r\n/);
    expect(gateway.uploadBody).toMatch(/name="target_job_ids"\r\n\r\n\[505\]\r\n/);
    expect(gateway.uploadBody).not.toContain("source_text");
    const sourceFixture = join(root, "source-resume.pdf");
    await writeFile(sourceFixture, fixtureBytes);
    await expect(upload.execute({ fixturePath: sourceFixture, sourceChannel: "boss", clientItemKey: "proofkit:fixture:outside-workspace" }, context))
      .rejects.toThrow("fixturePath must stay within the test workspace");

    const observed = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(observed).toMatchObject({
      passed: true,
      outcome: "passed",
      terminal: true,
      collectionRunId: "900",
      fileId: "901",
      fileRunId: "900",
      candidateId: "902",
      jobId: "505",
      relationCurrentResumeFileId: "901",
      relationJobId: "505",
      assessmentCurrentResumeFileId: "901",
      assessmentJobId: "505",
      assessmentCandidateId: "902",
      assessmentTaskStatus: "success",
      workflowMatchCount: 1,
    });
    const evidence = upload.evidence(uploaded);
    expect(JSON.stringify(evidence)).not.toContain("proofkit fixture");

    const oracleResult = await oracle.check({ runId: context.runId, charter: resumeCollectionCharter(), steps: [], assertions: [], signal: context.signal });
    expect(oracleResult.passed).toBe(true);
  });

  it("serializes int64 job IDs exactly and omits optional empty target jobs", async () => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64) });
    servers.push(gateway.server);
    const root = await createIntegrationProject(Buffer.from("%PDF-1.4 fixture\n"));
    const service = await LocalRunnerService.create({ root });
    const upload = service.integration?.capabilities?.find((item) => item.name === "aihr.uploadResumeFile");
    if (!upload) throw new Error("AIHR upload capability is missing");
    const input = { fixturePath: ".proofkit/fixtures/resume.pdf", sourceChannel: "boss", clientItemKey: "proofkit:fixture:exact-id", resumeRole: "attachment", manualOverride: false };
    const context = { runId: "exact-id-run", signal: new AbortController().signal };
    await upload.execute({ ...input, targetJobIds: ["9223372036854775807"] }, context);
    expect(gateway.uploadBody).toMatch(/name="target_job_ids"\r\n\r\n\[9223372036854775807\]\r\n/);
    await upload.execute({ ...input, targetJobIds: [] }, context);
    expect(gateway.uploadBody).not.toContain('name="target_job_ids"');
    const requestCount = gateway.requestPaths.length;
    await expect(upload.execute({ ...input, targetJobIds: [Number.MAX_SAFE_INTEGER + 1] }, context)).rejects.toThrow("safe integers");
    await expect(upload.execute({ ...input, targetJobIds: ["9223372036854775808"] }, context)).rejects.toThrow("signed int64");
    expect(gateway.requestPaths).toHaveLength(requestCount);
  });

  it.each([
    { run_id: "999" },
    { candidate: { id: "999" } },
    { job: { id: "999" } },
    { screening_stage: "screening" },
    { run_id: null },
    { candidate: {} },
    { job: {} },
  ])("keeps unrelated or incomplete workflow facts inconclusive: %j", async (override) => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64), workflowPage: () => ({ items: [{ ...completionFact(), ...override }], pagination: { page: 1, page_size: 100, total: 1 } }) });
    servers.push(gateway.server);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const oracle = service.integration?.oracles?.find((item) => item.name === "aihr.resumeCollectionPipeline");
    if (!oracle) throw new Error("AIHR collection oracle is missing");
    const observed = await oracle.check({ runId: "workflow-scope-run", charter: resumeCollectionCharter(), steps: [], assertions: [] });
    expect(observed.passed).toBeNull();
    expect(JSON.parse(observed.evidence[0]!)).toMatchObject({ outcome: "inconclusive", workflowMatchCount: 0 });
  });

  it.each([2, 21])("finds completion on later pages within the bounded scan: page %i", async (completionPage) => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64), workflowPage: (page) => ({ items: page === completionPage ? [completionFact()] : [{ ...completionFact(), candidate: { id: "999" } }], pagination: { page, page_size: 100, total: completionPage * 100 } }) });
    servers.push(gateway.server);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const oracle = service.integration?.oracles?.find((item) => item.name === "aihr.resumeCollectionPipeline");
    if (!oracle) throw new Error("AIHR collection oracle is missing");
    const observed = await oracle.check({ runId: "workflow-page-run", charter: resumeCollectionCharter(), steps: [], assertions: [] });
    expect(observed.passed).toBe(completionPage <= 20 ? true : null);
    expect(gateway.requestPaths.filter((path) => path === "/workflow-executions")).toHaveLength(Math.min(completionPage, 20));
  });

  it.each(["success", "relation-old-file"] as const)("executes the checked-in env-based Charter through Local Runner: %s", async (mode) => {
    const fixtureBytes = Buffer.from("%PDF-1.4 proofkit fixture\n", "utf8");
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
    const gateway = await startCollectionGatewayMock({ fixtureSha256, mode });
    servers.push(gateway.server);
    const root = await createIntegrationProject(fixtureBytes);
    Object.assign(process.env, {
      AIHR_PROOFKIT_SOURCE_CHANNEL: "boss",
      AIHR_PROOFKIT_CANDIDATE_UID: "candidate-fixture",
      AIHR_PROOFKIT_CONVERSATION_ID: "101",
      AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID: "account-fixture",
      AIHR_PROOFKIT_ENTERPRISE_ID: "1",
      AIHR_PROOFKIT_WORKSPACE_ID: "2",
      AIHR_PROOFKIT_USER_ID: "3",
      AIHR_PROOFKIT_FIXTURE_PATH: ".proofkit/fixtures/resume.pdf",
      AIHR_PROOFKIT_JOB_ID: "505",
      AIHR_PROOFKIT_CLIENT_ITEM_KEY: "proofkit:fixture:default-charter",
      AIHR_PROOFKIT_TEST_SCOPE: "proofkit:fixture",
    });
    vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
    vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
    const service = await LocalRunnerService.create({ root, allowCapabilityWrites: true });
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit/charters/aihr-resume-upload.yml");
    const started = await service.start({ charter: await loadCharter(source) });
    const summary = await service.wait(started.runId);

    expect(summary.verdict).toBe(mode === "success" ? "passed" : "failed");
    expect(summary.steps).toHaveLength(3);
    expect(summary.steps.every((step) => step.status === "passed")).toBe(true);
    expect(summary.oracles).toHaveLength(1);
    expect(summary.oracles[0]).toMatchObject({ name: "aihr.resumeCollectionPipeline", passed: mode === "success" });
    expect(summary.oracles[0]?.sourceEvidenceArtifacts).toEqual([`${summary.runId}/artifacts/oracle-1-source.json`]);
    expect(summary.oracles[0]?.evidence).toEqual([`${summary.runId}/artifacts/oracle-1-source.json`, `${summary.runId}/artifacts/oracle-1.json`]);
    if (mode === "relation-old-file") {
      expect(summary.oracles[0]?.sourceLocations).toContain("services/resume-collection-service/internal/service/resume_post_processor.go");
    }
    expect(summary.steps[1]?.capabilityOutput).toMatchObject({ collectionRunId: "900", fileSha256: fixtureSha256 });
    expect(summary.steps[2]?.capabilityOutput).toMatchObject({ outcome: mode === "success" ? "passed" : "failed", jobId: "505" });
    expect(gateway.uploadBody).toMatch(/name="run_id"\r\n\r\n900\r\n/);
    expect(gateway.requestPaths.filter((path) => path.startsWith("/boss-conversations/"))).toEqual([]);
    expect(summary.artifacts.some((path) => path.includes("oracle-1"))).toBe(true);
  });

  it("reports stale bindings as confirmed failures and keeps pending observations inconclusive", async () => {
    const fixtureSha256 = "a".repeat(64);
    const gateway = await startCollectionGatewayMock({ fixtureSha256 });
    servers.push(gateway.server);
    const root = await createIntegrationProject(Buffer.from("%PDF-1.4 fixture\n", "utf8"));
    const service = await LocalRunnerService.create({ root });
    const integration = service.integration;
    if (!integration) throw new Error("AIHR integration was not loaded");
    const wait = integration.capabilities?.find((item) => item.name === "aihr.waitResumeCollectionPipeline");
    if (!wait) throw new Error("AIHR resume collection wait capability is missing");
    const context = { runId: "aihr-binding-run", signal: new AbortController().signal };

    gateway.setMode("relation-old-file");
    const staleRelation = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(staleRelation).toMatchObject({ passed: false, outcome: "failed", terminal: true, relationCurrentResumeFileId: "777" });

    gateway.setMode("assessment-old-file");
    const staleAssessment = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(staleAssessment).toMatchObject({ passed: false, outcome: "failed", terminal: true, assessmentCurrentResumeFileId: "778" });

    gateway.setMode("extract-failed");
    const failedExtract = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(failedExtract).toMatchObject({ passed: false, outcome: "failed", terminal: true, extractStatus: "failed" });

    gateway.setMode("not-found");
    const pending = await wait.execute({ runId: "900", fileId: "901", jobId: "505", maxWaitMs: 1_000, pollIntervalMs: 250 }, context);
    expect(pending).toMatchObject({ passed: null, outcome: "inconclusive", terminal: false });
  });

  it("blocks an unscoped remote write endpoint before any gateway request", async () => {
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const preflight = service.integration?.preflight;
    if (!preflight) throw new Error("AIHR integration preflight is missing");
    process.env.AIHR_PROOFKIT_API_BASE_URL = "https://example.invalid/api/v1";
    delete process.env.AIHR_PROOFKIT_TEST_SCOPE;
    const result = await preflight({
      runId: "preflight-run",
      environment: "test",
      charter: TestCharterSchema.parse({
        intent: "verify isolated upload",
        level: "core",
        mode: "deterministic",
        actions: [{ kind: "capability", name: "aihr.uploadResumeFile", input: {} }],
        assertions: [],
        sideEffectPolicy: "allow",
        metadata: {},
      }),
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("remote AIHR endpoints");
    expect(result.message).toContain("AIHR_PROOFKIT_TEST_SCOPE");
  });

  it("blocks the actual upload key outside the test scope before connecting or writing", async () => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64) });
    servers.push(gateway.server);
    const root = await createIntegrationProject(Buffer.from("%PDF-1.4 fixture\n"));
    process.env.AIHR_PROOFKIT_CLIENT_ITEM_KEY = "proofkit:fixture:valid-decoy";
    process.env.AIHR_PROOFKIT_FIXTURE_PATH = ".proofkit/fixtures/resume.pdf";
    const connect = vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
    const service = await LocalRunnerService.create({ root, allowCapabilityWrites: true });
    const charter = TestCharterSchema.parse({
      intent: "reject an upload outside the test scope",
      level: "core",
      mode: "deterministic",
      actions: [{ kind: "capability", name: "aihr.uploadResumeFile", input: {
        fixturePath: ".proofkit/fixtures/resume.pdf",
        clientItemKey: "proofkit:other:item",
      } }],
      assertions: [],
      sideEffectPolicy: "allow",
      metadata: {},
    });
    const started = await service.start({ charter });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("blocked");
    expect(summary.findings.join(" ")).toContain("clientItemKey must be namespaced");
    expect(connect).not.toHaveBeenCalled();
    expect(gateway.requestPaths).toEqual([]);
    const preflightPath = summary.artifacts.find((path) => path.endsWith("/preflight.json"));
    expect(preflightPath).toBeDefined();
    expect(JSON.parse(await readFile(join(service.evidenceDir, preflightPath!), "utf8"))).toMatchObject({
      passed: false,
      evidence: { clientItemKeyNamespaced: false },
    });

    const upload = service.integration?.capabilities?.find((item) => item.name === "aihr.uploadResumeFile");
    if (!upload) throw new Error("AIHR upload capability is missing");
    await expect(upload.execute({ fixturePath: ".proofkit/fixtures/resume.pdf", clientItemKey: "proofkit:other:item" }, {
      runId: "direct-upload", signal: new AbortController().signal,
    })).rejects.toThrow("clientItemKey must be namespaced");
    await expect(upload.execute({ fixturePath: ".proofkit/fixtures/resume.pdf", clientItemKey: "proofkit:fixture:" }, {
      runId: "direct-upload", signal: new AbortController().signal,
    })).rejects.toThrow("nonempty suffix");
    expect(gateway.requestPaths).toEqual([]);
  });

  it("blocks a duplicate-upload scenario when its scoped key is missing", async () => {
    const gateway = await startCollectionGatewayMock({ fixtureSha256: "a".repeat(64) });
    servers.push(gateway.server);
    const root = await createIntegrationProject();
    const service = await LocalRunnerService.create({ root });
    const preflight = service.integration?.preflight;
    if (!preflight) throw new Error("AIHR integration preflight is missing");
    process.env.AIHR_PROOFKIT_CLIENT_ITEM_KEY = "proofkit:fixture:primary";
    process.env.AIHR_PROOFKIT_FIXTURE_PATH = ".proofkit/fixtures/resume.pdf";
    delete process.env.AIHR_PROOFKIT_NEGATIVE_CLIENT_ITEM_KEY;
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit/charters/aihr-resume-upload-idempotency.yml");
    const saved = await loadCharter(source);
    const negativeCase = saved.negativeCases?.[0];
    if (!negativeCase) throw new Error("AIHR duplicate-upload case is missing");
    const result = await preflight({
      runId: "negative-preflight",
      environment: "test",
      charter: TestCharterSchema.parse({ ...saved, actions: negativeCase.actions, assertions: negativeCase.assertions, oracles: negativeCase.oracles }),
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("AIHR_PROOFKIT_NEGATIVE_CLIENT_ITEM_KEY");
    expect(gateway.requestPaths).toEqual([]);
  });

  it("allows a quick UI-only charter without AIHR business scope", async () => {
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const preflight = service.integration?.preflight;
    if (!preflight) throw new Error("AIHR integration preflight is missing");
    process.env.AIHR_PROOFKIT_API_BASE_URL = "https://example.invalid/api/v1";
    delete process.env.AIHR_PROOFKIT_TEST_SCOPE;
    const result = await preflight({
      runId: "ui-only-preflight-run",
      environment: "test",
      charter: TestCharterSchema.parse({
        intent: "inspect the resume page",
        level: "quick",
        mode: "deterministic",
        actions: [{ kind: "goto", url: "http://127.0.0.1:5174/" }, { kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "BOSS直聘 简历获取" }],
        sideEffectPolicy: "deny",
        metadata: {},
      }),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      passed: true,
      evidence: { integrationRequired: false },
    });
    expect(result.message).toContain("quick Charter");
  });
});

async function createIntegrationProject(fixtureBytes?: Buffer): Promise<string> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "proofkit-aihr-integration-"));
  roots.push(root);
  await mkdir(join(root, ".proofkit"), { recursive: true });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit/integration.mjs");
  await copyFile(source, join(root, ".proofkit", "integration.mjs"));
  if (fixtureBytes) {
    await mkdir(join(root, ".proofkit", "fixtures"), { recursive: true });
    await writeFile(join(root, ".proofkit", "fixtures", "resume.pdf"), fixtureBytes);
  }
  return root;
}

function aihrCharter(): TestCharter {
  return TestCharterSchema.parse({
    intent: "verify AIHR online resume",
    level: "core",
    mode: "deterministic",
    preconditions: [],
    actions: [],
    assertions: [],
    sideEffectPolicy: "deny",
    metadata: {
      aihr: {
        conversationId: "101",
        workflowId: "202",
        jobId: "505",
        platformAccountId: "acct-fixture",
        sourceChannel: "boss",
        requireAssessmentSuccess: true,
      },
    },
  });
}

function resumeCollectionCharter(): TestCharter {
  return TestCharterSchema.parse({
    intent: "verify AIHR resume collection",
    level: "core",
    mode: "deterministic",
    preconditions: [],
    actions: [],
    assertions: [],
    sideEffectPolicy: "deny",
    metadata: {
      aihr: {
        runId: "900",
        fileId: "901",
        jobId: "505",
        requireCandidateBinding: true,
        requireAssessmentSuccess: true,
        requireWorkflowUsage: true,
      },
    },
  });
}

type OnlineMode = "success" | "failed" | "processing" | "assessment-processing" | "assessment-retry"
  | "assessment-missing" | "relation-missing" | "workflow-retry" | "retry-before-file"
  | "workflow-id-missing" | "workflow-conversation-missing" | "workflow-job-missing" | "workflow-wrong-id" | "workflow-wrong-conversation"
  | "file-id-missing" | "conversation-candidate-missing" | "relation-candidate-missing" | "relation-wrong-candidate"
  | "assessment-id-missing" | "assessment-file-missing" | "assessment-status-missing" | "assessment-task-missing" | "assessment-running" | "assessment-failed"
  | "assessment-dead" | "assessment-cancelled" | "assessment-conflict" | "relation-old-file"
  | "assessment-old-file" | "assessment-wrong-job" | "assessment-wrong-candidate" | "workflow-wrong-job"
  | "file-wrong-id" | "candidate-conflict"
  | "attachment-replaced-current" | "attachment-bound-before-phase" | "completed-without-attachment"
  | "terminated-reject" | "terminated-stage-missing" | "terminated-stage-conflict";

async function startGatewayMock(mode: () => OnlineMode): Promise<ReturnType<typeof createServer>> {
  let current: OnlineMode = "processing";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/resume-collection/online-resume-intakes") {
      await consume(request);
      return send(response, { task_id: 606, status: "pending" });
    }
    if (request.method === "GET" && path === "/boss-conversations/101/workflows/202") {
      current = mode();
      return send(response, {
        workflow: {
          id: current === "workflow-id-missing" ? undefined : current === "workflow-wrong-id" ? "999" : "202",
          conversation_id: current === "workflow-conversation-missing" ? undefined : current === "workflow-wrong-conversation" ? "999" : "101",
          job_id: current === "workflow-job-missing" ? undefined : current === "workflow-wrong-job" ? "999" : "505",
          phase: current === "processing" ? "online_resume_processing"
            : current === "workflow-retry" || current === "retry-before-file" ? "retryable_error"
            : current === "attachment-replaced-current" || current === "completed-without-attachment" ? "completed"
            : current.startsWith("terminated-") ? "terminated" : "wait_online_screening",
          online_resume_file_id: current === "processing" || current === "retry-before-file" ? null : "303",
          attachment_resume_file_id: current === "attachment-replaced-current" || current === "attachment-bound-before-phase" ? "777" : null,
          last_error_code: current === "workflow-retry" || current === "retry-before-file" ? "online_resume_pipeline_failed" : null,
        },
        candidate_id: current === "conversation-candidate-missing" ? undefined : current === "candidate-conflict" ? "999" : "404",
        // The summary can look green while authoritative assessment detail is pending or failed.
        assessment_status: "success",
      });
    }
    if (request.method === "GET" && path === "/resume-collection/files/303") {
      return send(response, current === "failed"
        ? { file_id: 303, extract_status: "failed", parse_status: "pending" }
        : { file_id: current === "file-id-missing" ? undefined : current === "file-wrong-id" ? 777 : 303, extract_status: "done", parse_status: "matched", candidate_id: 404 });
    }
    if (request.method === "GET" && path === "/jobs/505/candidates/404") {
      if (current === "relation-missing") return sendError(response, 404, "NOT_FOUND", "relation pending");
      return send(response, { candidate_summary: {
        job_id: 505, candidate_id: current === "relation-candidate-missing" ? undefined : current === "relation-wrong-candidate" ? 999 : 404,
        current_resume_file_id: current === "relation-old-file" || current === "attachment-replaced-current" ? 777 : 303,
        stage: current === "terminated-reject" ? "screen_reject" : current === "terminated-stage-missing" ? undefined : "screening",
      } });
    }
    if (request.method === "GET" && path === "/assessments/jobs/505/candidates/404") {
      if (current === "assessment-missing") return sendError(response, 404, "NOT_FOUND", "assessment pending");
      return send(response, {
        assessment_id: current === "assessment-id-missing" ? undefined : 606,
        current_resume_file_id: current === "assessment-file-missing" ? undefined : current === "assessment-old-file" || current === "attachment-replaced-current" ? 777 : 303,
        job_id: current === "assessment-wrong-job" ? 999 : 505, candidate_id: current === "assessment-wrong-candidate" ? 999 : 404,
        status: current === "assessment-status-missing" ? undefined : current === "assessment-running" ? "running" : current === "assessment-failed" ? "failed" : "success",
        task_status: current === "assessment-task-missing" ? undefined : current === "assessment-processing" ? "processing" : current === "assessment-retry" ? "retry_wait"
          : current === "assessment-dead" ? "dead" : current === "assessment-cancelled" ? "cancelled"
          : current === "assessment-conflict" ? "failed" : "success",
        error_code: current === "assessment-dead" ? "TASK_LEASE_EXPIRED_EXHAUSTED" : null,
      });
    }
    response.statusCode = 404;
    return send(response, { code: "NOT_FOUND", message: "fixture route not found" });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway mock did not bind to a port");
  process.env.AIHR_PROOFKIT_API_BASE_URL = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.AIHR_PROOFKIT_ACCESS_TOKEN = "fixture-token";
  process.env.AIHR_PROOFKIT_ENTERPRISE_ID = "enterprise-fixture";
  process.env.AIHR_PROOFKIT_WORKSPACE_ID = "workspace-fixture";
  process.env.AIHR_PROOFKIT_USER_ID = "user-fixture";
  return server;
}

type CollectionMode = "success" | "relation-old-file" | "assessment-old-file" | "extract-failed" | "not-found"
  | "assessment-retry" | "assessment-running" | "assessment-task-missing" | "assessment-dead" | "assessment-cancelled" | "assessment-failed";

function completionFact() {
  return { run_id: "900", id: "904", screening_stage: "workflow_completion", candidate: { id: "902" }, job: { id: "505" }, status: "completed", record_type: "workflow_completion", screening_result: "passed" };
}

async function startCollectionGatewayMock(options: { fixtureSha256: string; mode?: CollectionMode; workflowPage?: (page: number) => Record<string, unknown> }): Promise<{
  server: ReturnType<typeof createServer>;
  setMode: (mode: CollectionMode) => void;
  readonly uploadContentType: string | undefined;
  readonly uploadBody: string;
  readonly requestPaths: string[];
}> {
  let mode = options.mode ?? "success";
  let uploadContentType: string | undefined;
  let uploadBody = "";
  const requestPaths: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    requestPaths.push(path);
    response.setHeader("content-type", "application/json");

    if (request.method === "POST" && path === "/resume-collection/runs") {
      await consume(request);
      return send(response, { run_id: 900, source_channel: "boss", status: "pending" });
    }
    if (request.method === "POST" && path === "/resume-collection/files") {
      uploadContentType = typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined;
      uploadBody = (await collectBody(request)).toString("latin1");
      const targetJobs = uploadBody.match(/name="target_job_ids"\r\n\r\n([^\r]*)\r\n/)?.[1];
      if (targetJobs !== undefined && (!/^\[[1-9]\d*(?:,[1-9]\d*){0,19}\]$/.test(targetJobs) || targetJobs.slice(1, -1).split(",").some((id) => BigInt(id) > 9223372036854775807n))) {
        return sendError(response, 400, "VALIDATION_ERROR", "target_job_ids must be a JSON int64 array");
      }
      return send(response, { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, source_platform: "boss", status: "accepted", duplicate: false });
    }
    if (request.method === "GET" && path === "/resume-collection/files/901") {
      if (mode === "not-found") return sendError(response, 404, "NOT_FOUND", "file is still pending");
      return send(response, mode === "extract-failed"
        ? { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, extract_status: "failed", parse_status: "failed", error_code: "EXTRACT_FAILED" }
        : { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, extract_status: "done", parse_status: "matched", candidate_id: 902 });
    }
    if (request.method === "GET" && path === "/jobs/505/candidates/902") {
      return send(response, { candidate_summary: { current_resume_file_id: mode === "relation-old-file" ? 777 : 901, job_id: 505, candidate_id: 902, stage: "screening" } });
    }
    if (request.method === "GET" && path === "/assessments/jobs/505/candidates/902") {
      return send(response, {
        assessment_id: 903, current_resume_file_id: mode === "assessment-old-file" ? 778 : 901, job_id: 505, candidate_id: 902,
        status: mode === "assessment-failed" ? "failed" : mode === "assessment-running" ? "running" : "success",
        task_status: mode === "assessment-task-missing" ? undefined : mode === "assessment-retry" ? "retry_wait"
          : mode === "assessment-dead" ? "dead" : mode === "assessment-cancelled" ? "cancelled" : "success",
      });
    }
    if (request.method === "GET" && path === "/workflow-executions") {
      const page = Number(url.searchParams.get("page"));
      return send(response, options.workflowPage?.(page) ?? { items: [completionFact()], pagination: { page, page_size: 100, total: 1 } });
    }
    return sendError(response, 404, "NOT_FOUND", "collection fixture route not found");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collection gateway mock did not bind to a port");
  process.env.AIHR_PROOFKIT_API_BASE_URL = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.AIHR_PROOFKIT_ACCESS_TOKEN = "fixture-token";
  process.env.AIHR_PROOFKIT_ENTERPRISE_ID = "enterprise-fixture";
  process.env.AIHR_PROOFKIT_WORKSPACE_ID = "workspace-fixture";
  process.env.AIHR_PROOFKIT_USER_ID = "user-fixture";
  process.env.AIHR_PROOFKIT_TEST_SCOPE = "proofkit:fixture";
  return {
    server,
    setMode: (nextMode) => { mode = nextMode; },
    get uploadContentType() { return uploadContentType; },
    get uploadBody() { return uploadBody; },
    get requestPaths() { return requestPaths; },
  };
}

async function consume(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) { /* consume fixture request body */ }
}

async function collectBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, data: Record<string, unknown>): void {
  response.end(JSON.stringify({ code: "SUCCESS", message: "OK", data }));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  response.statusCode = status;
  response.end(JSON.stringify({ code, message, data: {} }));
}
