import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema, type TestCharter } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

const envKeys = [
  "AIHR_PROOFKIT_API_BASE_URL",
  "AIHR_PROOFKIT_ACCESS_TOKEN",
  "AIHR_PROOFKIT_ENTERPRISE_ID",
  "AIHR_PROOFKIT_WORKSPACE_ID",
  "AIHR_PROOFKIT_USER_ID",
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  for (const key of envKeys) delete process.env[key];
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
    expect(timedOut).toMatchObject({ passed: false, terminal: false, workflowPhase: "processing" });
    expect(timedOut.observationCount).toBeGreaterThan(1);

    const controller = new AbortController();
    const cancelled = wait.execute({ conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture", sourceChannel: "boss", maxWaitMs: 60_000, pollIntervalMs: 10_000, requireAssessmentSuccess: true }, { runId: "aihr-cancel-run", signal: controller.signal });
    controller.abort(new Error("fixture cancelled"));
    await expect(cancelled).rejects.toThrow("fixture cancelled");
  });
});

async function createIntegrationProject(): Promise<string> {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "proofkit-aihr-integration-"));
  roots.push(root);
  await mkdir(join(root, ".proofkit"), { recursive: true });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit/integration.mjs");
  await copyFile(source, join(root, ".proofkit", "integration.mjs"));
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

async function consume(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) { /* consume fixture request body */ }
}

function send(response: ServerResponse, data: Record<string, unknown>): void {
  response.end(JSON.stringify({ code: "SUCCESS", message: "OK", data }));
}
