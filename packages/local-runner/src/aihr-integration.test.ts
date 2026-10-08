import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
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
    expect(success).toMatchObject({ passed: true, terminal: true, workflowPhase: "completed", resumeFileId: "303", extractStatus: "done", parseStatus: "matched", candidateId: "404", assessmentTaskStatus: "success" });
    const successOracle = await oracle.check({ runId: context.runId, charter: aihrCharter(), steps: [], assertions: [], signal: context.signal });
    expect(successOracle.passed).toBe(true);

    mode = "failed";
    const failed = await wait.execute({ conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture", sourceChannel: "boss", maxWaitMs: 1_000, pollIntervalMs: 250, requireAssessmentSuccess: true }, { runId: "aihr-failed-run", signal: context.signal });
    expect(failed).toMatchObject({ passed: false, terminal: true, workflowPhase: "terminated", extractStatus: "failed", parseStatus: "failed", lastErrorCode: "EXTRACT_FAILED" });
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
    expect(timedOut).toMatchObject({ passed: null, terminal: false, workflowPhase: "processing" });
    expect(timedOut.observationCount).toBeGreaterThan(1);

    const controller = new AbortController();
    const cancelled = wait.execute({ conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture", sourceChannel: "boss", maxWaitMs: 60_000, pollIntervalMs: 10_000, requireAssessmentSuccess: true }, { runId: "aihr-cancel-run", signal: controller.signal });
    controller.abort(new Error("fixture cancelled"));
    await expect(cancelled).rejects.toThrow("fixture cancelled");
  });

  it("uploads an in-project PDF as multipart and proves the ordinary collection pipeline", async () => {
    const fixtureBytes = Buffer.from("%PDF-1.4 proofkit fixture\n", "utf8");
    const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
    const gateway = await startCollectionGatewayMock({ fixtureSha256 });
    servers.push(gateway.server);
    const root = await createIntegrationProject(fixtureBytes);
    const service = await LocalRunnerService.create({ root });
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
      clientItemKey: "proofkit-item-1",
      resumeRole: "attachment",
      originalFilename: "candidate.pdf",
    }, context);
    expect(uploaded).toMatchObject({ fileId: "901", runId: "900", fileSha256: fixtureSha256, status: "accepted", duplicate: false });
    expect(gateway.uploadContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(gateway.uploadBody).toContain("client_item_key");
    expect(gateway.uploadBody).toMatch(/name="run_id"\r\n\r\n900\r\n/);
    expect(gateway.uploadBody).not.toContain("source_text");

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
      AIHR_PROOFKIT_FIXTURE_PATH: ".proofkit/fixtures/resume.pdf",
      AIHR_PROOFKIT_JOB_ID: "505",
      AIHR_PROOFKIT_CLIENT_ITEM_KEY: "proofkit-default-charter",
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

async function startGatewayMock(mode: () => "success" | "failed" | "processing"): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && path === "/resume-collection/online-resume-intakes") {
      await consume(request);
      return send(response, { task_id: 606, status: "pending" });
    }
    if (request.method === "GET" && path === "/boss-conversations/101/workflows/202") {
      const current = mode();
      return send(response, { workflow: current === "success"
        ? { phase: "completed", online_resume_file_id: 303 }
        : current === "failed"
          ? { phase: "terminated", online_resume_file_id: 303, last_error_code: "EXTRACT_FAILED" }
          : { phase: "processing" } });
    }
    if (request.method === "GET" && path === "/resume-collection/files/303") {
      return send(response, mode() === "failed"
        ? { file_id: 303, extract_status: "failed", parse_status: "failed" }
        : { file_id: 303, extract_status: "done", parse_status: "matched", candidate_id: 404, assessment_status: "success" });
    }
    if (request.method === "GET" && path === "/jobs/505/candidates/404") return send(response, { candidate_summary: { stage: "screening" } });
    if (request.method === "GET" && path === "/assessments/jobs/505/candidates/404") return send(response, { status: "completed", task_status: "success" });
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

type CollectionMode = "success" | "relation-old-file" | "assessment-old-file" | "extract-failed" | "not-found";

async function startCollectionGatewayMock(options: { fixtureSha256: string; mode?: CollectionMode }): Promise<{
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
      return send(response, { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, source_platform: "boss", status: "accepted", duplicate: false });
    }
    if (request.method === "GET" && path === "/resume-collection/files/901") {
      if (mode === "not-found") return sendError(response, 404, "NOT_FOUND", "file is still pending");
      return send(response, mode === "extract-failed"
        ? { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, extract_status: "failed", parse_status: "failed", error_code: "EXTRACT_FAILED" }
        : { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, extract_status: "done", parse_status: "matched", candidate_id: 902 });
    }
    if (request.method === "GET" && path === "/jobs/505/candidates/902") {
      return send(response, { candidate_summary: { current_resume_file_id: mode === "relation-old-file" ? 777 : 901, job_id: 505, stage: "screening" } });
    }
    if (request.method === "GET" && path === "/assessments/jobs/505/candidates/902") {
      return send(response, { assessment_id: 903, current_resume_file_id: mode === "assessment-old-file" ? 778 : 901, job_id: 505, candidate_id: 902, status: "completed", task_status: "success" });
    }
    if (request.method === "GET" && path === "/workflow-executions") {
      return send(response, { items: [{ run_id: 900, id: 904, screening_stage: "screening", screening_result: "passed" }] });
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
