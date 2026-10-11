import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { analyzeRun } from "@proofkit/agent";
import { TestCharterSchema, type TestCharter } from "@proofkit/contracts";
import { loadCharter } from "@proofkit/planner";
import * as project from "@proofkit/project";
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
  vi.useRealTimers();
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
  const pipelines: Array<{
    name: string;
    capability: string;
    input: Record<string, string>;
    firstPath: string;
    assessmentPath: string;
    pending: Record<string, unknown>;
    expectedPending: Record<string, unknown>;
    terminalResponses: Record<string, Record<string, unknown>>;
  }> = [
    {
      name: "ordinary upload",
      capability: "aihr.waitResumeCollectionPipeline",
      input: { runId: "900", fileId: "901", jobId: "505" },
      firstPath: "/resume-collection/files/901",
      assessmentPath: "/assessments/jobs/505/candidates/902",
      pending: { file_id: 901, run_id: 900, extract_status: "pending", parse_status: "pending" },
      expectedPending: { extractStatus: "pending", candidateId: null, assessmentId: null },
      terminalResponses: {
        "/resume-collection/files/901": { file_id: 901, run_id: 900, extract_status: "done", parse_status: "matched", candidate_id: 902 },
        "/jobs/505/candidates/902": { candidate_summary: { current_resume_file_id: 901, job_id: 505, candidate_id: 902 } },
        "/assessments/jobs/505/candidates/902": { assessment_id: 903, current_resume_file_id: 901, job_id: 505, candidate_id: 902, status: "success", task_status: "success" },
        "/workflow-executions": { items: [], pagination: { page: 1, page_size: 100, total: 0 } },
      },
    },
    {
      name: "online resume",
      capability: "aihr.waitOnlineResumePipeline",
      input: { conversationId: "101", workflowId: "202", jobId: "505", platformAccountId: "acct-fixture" },
      firstPath: "/boss-conversations/101/workflows/202",
      assessmentPath: "/assessments/jobs/505/candidates/404",
      pending: { workflow: { id: 202, conversation_id: 101, job_id: 505, phase: "online_resume_processing" } },
      expectedPending: { workflowPhase: "online_resume_processing", resumeFileId: null, candidateId: null, assessmentId: null },
      terminalResponses: {
        "/boss-conversations/101/workflows/202": { workflow: { id: 202, conversation_id: 101, job_id: 505, phase: "wait_online_screening", online_resume_file_id: 303 }, candidate_id: 404 },
        "/resume-collection/files/303": { file_id: 303, extract_status: "done", parse_status: "matched", candidate_id: 404 },
        "/jobs/505/candidates/404": { candidate_summary: { current_resume_file_id: 303, job_id: 505, candidate_id: 404 } },
        "/assessments/jobs/505/candidates/404": { assessment_id: 606, current_resume_file_id: 303, job_id: 505, candidate_id: 404, status: "success", task_status: "success" },
      },
    },
  ];

  async function loadPipelineWait(name: string) {
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const wait = service.integration?.capabilities?.find((item) => item.name === name);
    if (!wait) throw new Error(`Missing pipeline capability ${name}`);
    return wait;
  }

  async function boundedWait(wait: Awaited<ReturnType<typeof loadPipelineWait>>, input: Record<string, unknown>) {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error("pipeline exceeded its own deadline")), 2_200);
    const startedAt = performance.now();
    try {
      const result = await wait.execute({ maxWaitMs: 1_000, pollIntervalMs: 250, ...input }, { runId: "deadline-fixture", signal: controller.signal });
      expect(performance.now() - startedAt).toBeLessThan(1_800);
      expect(wait.outputSchema.safeParse(result).success).toBe(true);
      return result;
    } finally {
      clearTimeout(watchdog);
      controller.abort();
    }
  }

  it.each([
    { name: "aihr.readResumeCollectionRun", path: "/resume-collection/runs/900", input: { runId: "900" },
      data: { run_id: 900, status: "completed", requested_count: 1 }, expected: { runId: "900", status: "completed" } },
    { name: "aihr.readResumeFile", path: "/resume-collection/files/901", input: { fileId: "901" },
      data: { file_id: 901, run_id: 900, extract_status: "done", parse_status: "matched" }, expected: { fileId: "901", extractStatus: "done" } },
    { name: "aihr.readWorkflowUsage", path: "/workflow-executions", input: { runId: "900" },
      data: { items: [{ id: 902, screening_stage: "workflow_completion", screening_result: "passed" }], pagination: { total: 1 } },
      expected: { runId: "900", total: 1 } },
    { name: "aihr.readBillingUsage", path: "/billing/usage-charges", input: { runId: "900", startDate: "2026-10-09", endDate: "2026-10-11" },
      data: { items: [{ id: "1", workflow_type: "communication_resume_screening", workflow_run_id: "900", workflow_item_key: "proofkit:case", points: 300 }],
        page: 1, page_size: 100, total: 1, total_points: 300 },
      expected: { runId: "900", complete: true, matchedCount: 1, matchedPoints: 300 } },
  ])("passes the Runner capability signal to $name gateway reads", async ({ name, path, input, data, expected }) => {
    let requested = false;
    await startPollingGateway((actual, response) => {
      expect(actual).toBe(path);
      requested = true;
      send(response, data);
    });
    const read = await loadPipelineWait(name);
    const output = await read.execute(read.inputSchema.parse(input), { runId: "read-fixture", signal: new AbortController().signal });
    expect(requested).toBe(true);
    expect(output).toMatchObject(expected);
  });

  it("scans later billing pages before reporting an exact collection-run charge", async () => {
    const pages: number[] = [];
    await startPollingGateway((path, response, url) => {
      expect(path).toBe("/billing/usage-charges");
      expect(url.searchParams.get("start_date")).toBe("2026-10-09");
      expect(url.searchParams.get("end_date")).toBe("2026-10-11");
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      const items = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), workflow_type: "communication_resume_screening", workflow_run_id: "899",
          workflow_item_key: `unrelated-${index}`, points: 300 }))
        : [{ id: "101", workflow_type: "communication_resume_screening", workflow_run_id: "900", workflow_item_key: "proofkit:fixture:upload-1", points: 300 }];
      send(response, { page, page_size: 100, total: 101, total_points: 30300, items });
    });
    const read = await loadPipelineWait("aihr.readBillingUsage");
    const output = await read.execute(read.inputSchema.parse({ runId: "900", startDate: "2026-10-09", endDate: "2026-10-11" }),
      { runId: "billing-fixture", signal: new AbortController().signal });
    expect(pages).toEqual([1, 2]);
    expect(output).toMatchObject({ complete: true, pagesRead: 2, total: 101, matchedCount: 1, matchedPoints: 300,
      itemKeys: ["proofkit:fixture:upload-1"] });
    expect(read.evidence(output)).toMatchObject({ complete: true, matchedCount: 1, itemKeyCount: 1 });
    expect(read.evidence(output)).not.toHaveProperty("itemKeys");
  });

  it("keeps billing absence unverified when the date window or page coverage is incomplete", async () => {
    const read = await loadPipelineWait("aihr.readBillingUsage");
    const noWindow = await read.execute(read.inputSchema.parse({ runId: "900" }),
      { runId: "billing-no-window", signal: new AbortController().signal });
    expect(noWindow).toMatchObject({ complete: false, reason: "date-window-unverified", matchedCount: null });
    await startPollingGateway((_path, response) => send(response, {
      page: 1, page_size: 1, total: 2, total_points: 600,
      items: [{ id: "1", workflow_type: "communication_resume_screening", workflow_run_id: "899", workflow_item_key: "unrelated", points: 300 }],
    }));
    const capped = await read.execute(read.inputSchema.parse({ runId: "900", startDate: "2026-10-09", endDate: "2026-10-11", pageSize: 1, maxPages: 1 }),
      { runId: "billing-capped", signal: new AbortController().signal });
    expect(capped).toMatchObject({ complete: false, reason: "page-limit", pagesRead: 1, matchedCount: null, matchedPoints: null });
  });

  it.each(pipelines)("bounds $name polling when the interval exceeds the whole deadline", async (pipeline) => {
    await startPollingGateway((_path, response) => send(response, pipeline.pending));
    const wait = await loadPipelineWait(pipeline.capability);
    const output = await boundedWait(wait, { ...pipeline.input, pollIntervalMs: 10_000 });
    expect(output).toMatchObject({ passed: null, terminal: false, observationCount: 1, ...pipeline.expectedPending });
  });

  for (const stage of ["headers", "body"] as const) {
    it.each(pipelines)(`ends $name at its deadline when response ${stage} hang`, async (pipeline) => {
      let requested = false;
      await startPollingGateway((_path, response) => {
        requested = true;
        if (stage === "body") response.write('{"code":"SUCCESS","data":');
      });
      const wait = await loadPipelineWait(pipeline.capability);
      const output = await boundedWait(wait, pipeline.input);
      expect(requested).toBe(true);
      expect(output).toMatchObject({ passed: null, terminal: false, observationCount: 0, extractStatus: null, candidateId: null });
    });

    it.each(pipelines)(`keeps the original cancellation reason for $name during response ${stage}`, async (pipeline) => {
      let onRequest!: () => void;
      const requested = new Promise<void>((resolveRequest) => { onRequest = resolveRequest; });
      await startPollingGateway((_path, response) => {
        if (stage === "body") response.write('{"code":"SUCCESS","data":');
        onRequest();
      });
      const wait = await loadPipelineWait(pipeline.capability);
      const controller = new AbortController();
      const reason = new Error("user stopped business acceptance");
      const watchdog = setTimeout(() => controller.abort(new Error("cancellation watchdog")), 2_200);
      const pending = wait.execute({ ...pipeline.input, maxWaitMs: 60_000, pollIntervalMs: 250 }, { runId: "cancel-fixture", signal: controller.signal });
      const rejected = expect(pending).rejects.toBe(reason);
      try {
        await requested;
        controller.abort(reason);
        await rejected;
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      } finally {
        clearTimeout(watchdog);
        controller.abort(reason);
      }
    });
  }

  it.each(pipelines)("retains only the last complete $name observation after a partial round hangs", async (pipeline) => {
    let rounds = 0;
    let partialAssessmentRequested = false;
    await startPollingGateway((path, response) => {
      if (path === pipeline.firstPath && ++rounds === 1) return send(response, pipeline.pending);
      if (path === pipeline.assessmentPath) {
        partialAssessmentRequested = true;
        response.write('{"code":"SUCCESS","data":');
        return;
      }
      const data = pipeline.terminalResponses[path];
      if (!data) return sendError(response, 404, "NOT_FOUND", "fixture route not found");
      send(response, data);
    });
    const wait = await loadPipelineWait(pipeline.capability);
    const output = await boundedWait(wait, pipeline.input);
    expect(partialAssessmentRequested).toBe(true);
    expect(output).toMatchObject({ passed: null, terminal: false, observationCount: 1, ...pipeline.expectedPending });
    expect(wait.evidence(output)).toMatchObject({ passed: null, terminal: false, observationCount: 1, ...pipeline.expectedPending });
  });

  it.each(pipelines)("recovers $name after repeated pending observations without accumulating listeners", async (pipeline) => {
    const wait = await loadPipelineWait(pipeline.capability);
    const controller = new AbortController();
    let rounds = 0;
    const observedSignals = new Set<AbortSignal>();
    const listenerCounts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Polling requests must receive cancellation");
      observedSignals.add(signal);
      listenerCounts.push(getEventListeners(signal, "abort").length);
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
      const data = path === pipeline.firstPath && ++rounds <= 8
        ? pipeline.pending : pipeline.terminalResponses[path];
      return new Response(JSON.stringify({ code: "SUCCESS", data }), { status: 200 });
    });
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    vi.useFakeTimers();
    const pending = wait.execute({ ...pipeline.input, maxWaitMs: 10_000, pollIntervalMs: 250 }, { runId: "retry-fixture", signal: controller.signal });
    const checked = expect(pending).resolves.toMatchObject({ passed: true, terminal: true, observationCount: 9 });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await checked;
      expect(Math.max(...listenerCounts)).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      for (const signal of observedSignals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
    }
  });

  it.each(pipelines)("preserves a non-Error $name cancellation reason before any request", async (pipeline) => {
    const wait = await loadPipelineWait(pipeline.capability);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    const reason = { kind: "user-cancelled", requestId: "fixture-cancel" };
    controller.abort(reason);
    await expect(wait.execute({ ...pipeline.input, maxWaitMs: 1_000, pollIntervalMs: 250 }, { runId: "pre-cancelled", signal: controller.signal })).rejects.toBe(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(pipelines)("propagates an observed $name gateway error instead of treating it as timeout", async (pipeline) => {
    await startPollingGateway((_path, response) => sendError(response, 503, "UNAVAILABLE", "fixture gateway unavailable"));
    const wait = await loadPipelineWait(pipeline.capability);
    await expect(boundedWait(wait, pipeline.input)).rejects.toThrow("AIHR gateway 503");
  });

  it("keeps a private gateway error out of the persisted Run evidence", async () => {
    const marker = "PRIVATE_RESUME_CONTACT_24680";
    await startPollingGateway((_path, response) => sendError(response, 503, "UNAVAILABLE", marker));
    Object.assign(process.env, {
      AIHR_PROOFKIT_TEST_SCOPE: "proofkit:fixture",
      AIHR_PROOFKIT_ACCESS_TOKEN: "isolated-fixture-token",
      AIHR_PROOFKIT_ENTERPRISE_ID: "1",
      AIHR_PROOFKIT_WORKSPACE_ID: "2",
      AIHR_PROOFKIT_USER_ID: "3",
    });
    vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
    vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
    const root = await createIntegrationProject();
    const service = await LocalRunnerService.create({ root });
    const charter = TestCharterSchema.parse({ ...aihrCharter(), oracles: ["aihr.onlineResumePipeline"] });
    const started = await service.start({ charter });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("inconclusive");
    const runRoot = join(root, ".proofkit", "runs", summary.runId);
    const saved = [JSON.stringify(summary), await readFile(join(runRoot, "events.jsonl"), "utf8")].join("\n");
    expect(summary.findings).toEqual(["Business Oracle 1 could not establish a result; inspect its reader and connector."]);
    expect(saved).not.toContain(marker);
    expect(analyzeRun({ summary, evidence: [] }).finding).toMatchObject({ category: "test", status: "unverified" });
  });

  it.each([
    ["private HTTP failure", new Response(JSON.stringify({ code: "UNAVAILABLE", message: "PRIVATE_RESUME_CONTACT_24680" }), { status: 503 }), "request rejected"],
    ["invalid JSON", new Response("PRIVATE_RESUME_CONTACT_24680", { status: 200 }), "invalid JSON response"],
    ["large declared response", new Response("", { status: 200, headers: { "content-length": String(9 * 1024 * 1024) } }), "response too large"],
  ] as const)("bounds the AIHR gateway reader for %s", async (_name, response, expected) => {
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const read = service.integration?.capabilities?.find((item) => item.name === "aihr.readResumeCollectionRun");
    if (!read) throw new Error("AIHR reader is missing");
    const error = await read.execute({ runId: "900" }, { runId: "bounded-reader", signal: new AbortController().signal }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain("PRIVATE_RESUME_CONTACT_24680");
  });

  it("cancels a chunked gateway response after its byte limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel() { cancelled = true; },
    });
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const read = service.integration?.capabilities?.find((item) => item.name === "aihr.readResumeCollectionRun");
    if (!read) throw new Error("AIHR reader is missing");
    await expect(read.execute({ runId: "900" }, { runId: "chunked-reader", signal: new AbortController().signal })).rejects.toThrow("response too large");
    expect(cancelled).toBe(true);
  });

  it("retains the existing missing-resource behavior for a 404 gateway response", async () => {
    await startPollingGateway((_path, response) => sendError(response, 404, "NOT_FOUND", "PRIVATE_RESUME_CONTACT_24680"));
    const wait = await loadPipelineWait("aihr.waitResumeCollectionPipeline");
    const observed = await boundedWait(wait, { runId: "900", fileId: "901", jobId: "505" });
    expect(observed.passed).toBeNull();
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_RESUME_CONTACT_24680");
  });

  it.each(pipelines)("preserves cancellation during the $name polling interval and releases timers", async (pipeline) => {
    const wait = await loadPipelineWait(pipeline.capability);
    const controller = new AbortController();
    const reason = { kind: "user-cancelled", requestId: "interval-cancel" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: "SUCCESS", data: pipeline.pending })));
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    vi.useFakeTimers();
    const pending = wait.execute({ ...pipeline.input, maxWaitMs: 60_000, pollIntervalMs: 10_000 }, { runId: "interval-cancelled", signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      controller.abort(reason);
      await rejected;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(reason);
    }
  });

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
    const root = await mkdtemp(join(tmpdir(), "proofkit-aihr-source-"));
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

  it.each(["success", "relation-old-file", "upload-wrong-run", "upload-response-wrong-run",
    "billing-missing", "billing-duplicate", "billing-wrong-price", "billing-extra-item",
    "billing-extra-type", "billing-reader-error"] as const)("executes the checked-in env-based Charter through Local Runner: %s", async (mode) => {
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

    expect(summary.verdict).toBe(mode === "success" ? "passed" : mode === "billing-reader-error" ? "inconclusive" : "failed");
    expect(summary.steps).toHaveLength(3);
    expect(summary.steps.every((step) => step.status === "passed")).toBe(true);
    expect(summary.oracles).toHaveLength(2);
    expect(summary.oracles[0]).toMatchObject({ name: "aihr.resumeCollectionPipeline",
      passed: !["relation-old-file", "upload-wrong-run", "upload-response-wrong-run"].includes(mode) });
    expect(summary.oracles[1]).toMatchObject({ name: "aihr.billingUsage",
      passed: mode === "success" || mode === "upload-response-wrong-run" ? true
        : ["relation-old-file", "upload-wrong-run", "billing-reader-error"].includes(mode) ? null : false });
    const billingFacts = JSON.parse((await readFile(join(root, ".proofkit", "runs", summary.runId,
      "artifacts", "oracle-2-source.json"), "utf8")) as string);
    expect(JSON.stringify(billingFacts)).not.toContain("proofkit:fixture:default-charter");
    expect(summary.oracles[0]?.sourceEvidenceArtifacts).toEqual([`${summary.runId}/artifacts/oracle-1-source.json`]);
    expect(summary.oracles[0]?.evidence).toEqual([`${summary.runId}/artifacts/oracle-1-source.json`, `${summary.runId}/artifacts/oracle-1.json`]);
    if (mode === "relation-old-file") {
      expect(summary.oracles[0]?.sourceLocations).toContain("services/resume-collection-service/internal/service/resume_post_processor.go");
    }
    if (mode === "upload-wrong-run" || mode === "upload-response-wrong-run") {
      const pipelineFacts = JSON.parse((await readFile(join(root, ".proofkit", "runs", summary.runId,
        "artifacts", "oracle-1-source.json"), "utf8")) as string);
      expect(pipelineFacts).toMatchObject({ facts: [{ expectedCollectionRunId: "900",
        uploadResponseRunId: "999", responseRunMismatch: true,
        fileRunId: mode === "upload-wrong-run" ? "999" : "900" }] });
      expect(summary.steps[1]?.capabilityOutput).toMatchObject({ collectionRunId: "999" });
    }
    if (mode.startsWith("billing-") && mode !== "billing-reader-error") {
      expect(summary.oracles[1]?.sourceLocations).toContain("services/billing-service/internal/service/billing_service.go");
      expect(billingFacts).toMatchObject({ facts: [{ ledgerComplete: true, expectedPoints: 300 }] });
    }
    if (mode === "billing-extra-item" || mode === "billing-extra-type") {
      expect(billingFacts).toMatchObject({ facts: [{ runChargeCount: 2,
        exactChargeCount: 1, unexpectedChargeCount: 1 }] });
    }
    if (mode === "billing-reader-error") expect(billingFacts).toMatchObject({ facts: [{ ledgerReason: "reader-unavailable" }] });
    expect(summary.steps[1]?.capabilityOutput).toMatchObject({ fileSha256: fixtureSha256 });
    expect(summary.steps[2]?.capabilityOutput).toMatchObject({
      outcome: mode === "relation-old-file" || mode === "upload-wrong-run" ? "failed" : "passed", jobId: "505" });
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

  it("blocks a foreign AIHR gateway without a declared health endpoint before page connection", async () => {
    const root = await createIntegrationProject();
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1?private=ignored";
    configureBusinessScope();
    const inspected: string[] = [];
    vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (selectedRoot, targetUrl) => {
      inspected.push(targetUrl ?? "");
      if (!targetUrl) return { status: "unverified", method: "unavailable", expectedProjectRoot: selectedRoot,
        reason: "No surface target URL was configured.", observedAt: new Date().toISOString() };
      return { status: "different-project", method: "windows-listener-process", expectedProjectRoot: selectedRoot,
        observedProjectRoot: resolve(root, "../foreign-checkout"), targetOrigin: new URL(targetUrl!).origin,
        processId: 314, reason: "The gateway listener belongs to another Git checkout.", observedAt: new Date().toISOString() };
    });
    const connect = vi.spyOn(WebAdapter.prototype, "connect").mockRejectedValue(new Error("must not connect"));
    const service = await LocalRunnerService.create({ root });
    expect(service.config.project.health).toEqual([]);
    const started = await service.start({ charter: gatewayBusinessCharter() });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("blocked");
    expect(summary.findings.join(" ")).toContain("AIHR gateway listener belongs to another Git checkout before setup");
    expect(connect).not.toHaveBeenCalled();
    expect(inspected).toContain(process.env.AIHR_PROOFKIT_API_BASE_URL);
    const path = summary.artifacts.find((item) => item.endsWith("/preflight.json"));
    expect(path).toBeDefined();
    const saved = JSON.parse(await readFile(join(service.evidenceDir, path!), "utf8"));
    expect(saved).toMatchObject({ passed: false, evidence: {
      gatewayBindingStatus: "different-project", gatewayBindingObservedProjectRoot: resolve(root, "../foreign-checkout"),
      gatewayBindingProcessId: 314, gatewayBindingOrigin: "http://127.0.0.1:8080",
    } });
    expect(JSON.stringify(saved)).not.toContain("private=ignored");
  });

  it("records a foreign gateway under record policy and rechecks it after setup", async () => {
    const root = await createIntegrationProject();
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    configureBusinessScope();
    const binding = vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (selectedRoot, targetUrl) => ({
      status: "different-project", method: "windows-listener-process", expectedProjectRoot: selectedRoot,
      observedProjectRoot: resolve(root, "../foreign-checkout"), targetOrigin: new URL(targetUrl!).origin,
      reason: "The gateway listener belongs to another Git checkout.", observedAt: new Date().toISOString(),
    }));
    const defaults = (await LocalRunnerService.create({ root })).config;
    const service = await LocalRunnerService.create({ root, config: {
      ...defaults, policies: { ...defaults.policies, targetBinding: "record" },
    } });
    const preflight = service.integration?.preflight;
    const postSetupCheck = service.integration?.postSetupCheck;
    if (!preflight || !postSetupCheck) throw new Error("AIHR gateway checks are missing");
    const context = { runId: "record-gateway", environment: "test" as const, charter: gatewayBusinessCharter(),
      signal: new AbortController().signal };
    const before = await preflight(context);
    const after = await postSetupCheck(context);
    expect(before).toMatchObject({ passed: true, evidence: { gatewayBindingStatus: "different-project" } });
    expect(after).toMatchObject({ passed: true, evidence: { gatewayBindingStatus: "different-project" } });
    expect(binding).toHaveBeenCalledTimes(2);
    expect(before.message).toContain("record policy");
  });

  it("blocks a gateway that changes to a foreign checkout during setup", async () => {
    const root = await createIntegrationProject();
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    configureBusinessScope();
    let gatewayInspections = 0;
    vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (selectedRoot, targetUrl) => {
      if (!targetUrl) return { status: "unverified", method: "unavailable", expectedProjectRoot: selectedRoot,
        reason: "No surface target URL was configured.", observedAt: new Date().toISOString() };
      gatewayInspections += 1;
      return gatewayInspections === 1
        ? { status: "unverified", method: "unavailable", expectedProjectRoot: selectedRoot,
          targetOrigin: new URL(targetUrl).origin, reason: "No listener yet.", observedAt: new Date().toISOString() }
        : { status: "different-project", method: "windows-listener-process", expectedProjectRoot: selectedRoot,
          observedProjectRoot: resolve(root, "../foreign-checkout"), targetOrigin: new URL(targetUrl).origin,
          reason: "The gateway listener belongs to another Git checkout.", observedAt: new Date().toISOString() };
    });
    const connect = vi.spyOn(WebAdapter.prototype, "connect").mockRejectedValue(new Error("must not connect"));
    const service = await LocalRunnerService.create({ root });
    const started = await service.start({ charter: gatewayBusinessCharter() });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("blocked");
    expect(summary.findings.join(" ")).toContain("AIHR gateway listener belongs to another Git checkout after setup");
    expect(gatewayInspections).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    const beforePath = summary.artifacts.find((item) => item.endsWith("/preflight.json"));
    const afterPath = summary.artifacts.find((item) => item.endsWith("/post-setup-check.json"));
    expect(beforePath && afterPath).toBeTruthy();
    expect(JSON.parse(await readFile(join(service.evidenceDir, beforePath!), "utf8")))
      .toMatchObject({ passed: true, evidence: { gatewayBindingStatus: "unverified" } });
    expect(JSON.parse(await readFile(join(service.evidenceDir, afterPath!), "utf8")))
      .toMatchObject({ passed: false, evidence: { gatewayBindingStatus: "different-project" } });
  });

  it("propagates cancellation during gateway ownership inspection", async () => {
    const root = await createIntegrationProject();
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1";
    configureBusinessScope();
    vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (_selectedRoot, _targetUrl, signal) => {
      signal?.throwIfAborted();
      throw new Error("inspection unexpectedly continued");
    });
    const service = await LocalRunnerService.create({ root });
    const controller = new AbortController();
    controller.abort(new Error("stop gateway inspection"));
    await expect(service.integration?.preflight?.({ runId: "cancel-gateway", environment: "test",
      charter: gatewayBusinessCharter(), signal: controller.signal })).rejects.toThrow("stop gateway inspection");
  });

  it("records stable and replaced AIHR gateway processes at Run completion", async () => {
    const root = await createIntegrationProject();
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1?private=ignored";
    configureBusinessScope();
    let processId = 314;
    const binding = vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (selectedRoot, targetUrl) => ({
      status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: selectedRoot,
      observedProjectRoot: root, targetOrigin: new URL(targetUrl!).origin, processId,
      reason: "The gateway process is associated with the selected checkout.", observedAt: new Date().toISOString(),
    }));
    const service = await LocalRunnerService.create({ root });
    const { preflight, setup, postSetupCheck, postRunCheck } = service.integration ?? {};
    if (!preflight || !setup || !postSetupCheck || !postRunCheck) throw new Error("AIHR gateway lifecycle checks are missing");
    const context = { runId: "gateway-continuity", environment: "test" as const, charter: gatewayBusinessCharter(),
      signal: new AbortController().signal };
    expect((await preflight(context)).passed).toBe(true);
    const cleanup = await setup({ ...context, emit: async () => {} });
    expect((await postSetupCheck(context)).passed).toBe(true);
    const stable = await postRunCheck(context);
    expect(stable).toMatchObject({ passed: true, evidence: { gatewayContinuity: "stable",
      gatewayBeforeBindingProcessId: 314, gatewayAfterBindingProcessId: 314 } });
    processId = 315;
    const replaced = await postRunCheck(context);
    expect(replaced).toMatchObject({ passed: false, evidence: { gatewayContinuity: "changed",
      gatewayBeforeBindingProcessId: 314, gatewayAfterBindingProcessId: 315 } });
    processId = 314;
    process.env.AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v2?private=changed";
    const reconfigured = await postRunCheck(context);
    expect(reconfigured).toMatchObject({ passed: false, evidence: {
      gatewayContinuity: "changed", gatewayConfigurationStable: false,
      gatewayBeforeBindingProcessId: 314, gatewayAfterBindingProcessId: 314,
    } });
    expect(JSON.stringify(replaced)).not.toContain("private=ignored");
    expect(JSON.stringify(reconfigured)).not.toContain("private=changed");
    expect(binding).toHaveBeenCalledTimes(5);
    if (typeof cleanup === "function") await cleanup();
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
    const binding = vi.spyOn(project, "inspectTargetBinding");
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
    expect(binding).not.toHaveBeenCalled();
  });

  it("blocks an interactive quick Charter without isolated actor credentials", async () => {
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const preflight = service.integration?.preflight;
    if (!preflight) throw new Error("AIHR integration preflight is missing");
    process.env.AIHR_PROOFKIT_TEST_SCOPE = "proofkit:ui-click";
    delete process.env.AIHR_PROOFKIT_ACCESS_TOKEN;
    delete process.env.AIHR_PROOFKIT_ENTERPRISE_ID;
    delete process.env.AIHR_PROOFKIT_WORKSPACE_ID;
    delete process.env.AIHR_PROOFKIT_USER_ID;
    const charter = TestCharterSchema.parse({
      intent: "click AIHR resume acquisition",
      level: "quick",
      actions: [{ kind: "click", selector: "text=立即运行" }],
      assertions: [{ kind: "text-visible", text: "任务进度" }],
      sideEffectPolicy: "allow",
    });
    const result = await preflight({
      runId: "ui-click-preflight-run", environment: "test", charter,
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("AIHR_PROOFKIT_ACCESS_TOKEN");
    expect(result.message).toContain("AIHR_PROOFKIT_WORKSPACE_ID");
    expect(result.evidence).toMatchObject({ integrationRequired: true, interactiveSurfaceActionCount: 1,
      credentialConfigured: false, actorConfigured: false });
    const connect = vi.spyOn(WebAdapter.prototype, "connect").mockRejectedValue(new Error("must not connect"));
    const started = await service.start({ charter });
    const summary = await service.wait(started.runId);
    expect(summary.verdict).toBe("blocked");
    expect(summary.findings.join(" ")).toContain("AIHR_PROOFKIT_ACCESS_TOKEN");
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires a scoped actor before a core UI business Oracle", async () => {
    const service = await LocalRunnerService.create({ root: await createIntegrationProject() });
    const preflight = service.integration?.preflight;
    if (!preflight) throw new Error("AIHR integration preflight is missing");
    process.env.AIHR_PROOFKIT_TEST_SCOPE = "proofkit:ui-core";
    process.env.AIHR_PROOFKIT_ACCESS_TOKEN = "fixture-token";
    process.env.AIHR_PROOFKIT_ENTERPRISE_ID = "1";
    process.env.AIHR_PROOFKIT_WORKSPACE_ID = "2";
    delete process.env.AIHR_PROOFKIT_USER_ID;
    const result = await preflight({
      runId: "ui-core-preflight-run",
      environment: "test",
      charter: TestCharterSchema.parse({
        intent: "verify acquisition after a UI click",
        level: "core",
        actions: [{ kind: "click", selector: "text=立即运行" }],
        assertions: [{ kind: "text-visible", text: "任务进度" }],
        oracles: ["aihr.resumeCollectionPipeline"],
        sideEffectPolicy: "allow",
      }),
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("AIHR_PROOFKIT_USER_ID");
    expect(result.evidence).toMatchObject({ credentialConfigured: true, actorConfigured: false });
  });
});

function configureBusinessScope(): void {
  process.env.AIHR_PROOFKIT_TEST_SCOPE = "proofkit:gateway-check";
  process.env.AIHR_PROOFKIT_ACCESS_TOKEN = "fixture-token";
  process.env.AIHR_PROOFKIT_ENTERPRISE_ID = "1";
  process.env.AIHR_PROOFKIT_WORKSPACE_ID = "2";
  process.env.AIHR_PROOFKIT_USER_ID = "3";
}

function gatewayBusinessCharter(): TestCharter {
  return TestCharterSchema.parse({
    intent: "verify an isolated AIHR resume file",
    level: "core", mode: "deterministic", sideEffectPolicy: "deny",
    actions: [{ kind: "capability", name: "aihr.readResumeFile", input: { fileId: "901" } }],
    assertions: [], metadata: {},
  });
}

async function createIntegrationProject(fixtureBytes?: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "proofkit-aihr-integration-"));
  roots.push(root);
  await mkdir(join(root, ".proofkit"), { recursive: true });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit/integration.mjs");
  await copyFile(source, join(root, ".proofkit", "integration.mjs"));
  await copyFile(resolve(dirname(source), "aihr-manual-intake.mjs"), join(root, ".proofkit", "aihr-manual-intake.mjs"));
  await copyFile(resolve(dirname(source), "aihr-desktop-acquisition.mjs"), join(root, ".proofkit", "aihr-desktop-acquisition.mjs"));
  if (fixtureBytes) {
    await mkdir(join(root, ".proofkit", "fixtures"), { recursive: true });
    await writeFile(join(root, ".proofkit", "fixtures", "resume.pdf"), fixtureBytes);
  }
  return root;
}

async function startPollingGateway(handler: (path: string, response: ServerResponse, url: URL) => void): Promise<void> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handler(url.pathname.replace(/^\/api\/v1/, ""), response, url);
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Polling gateway did not bind to a port");
  process.env.AIHR_PROOFKIT_API_BASE_URL = `http://127.0.0.1:${address.port}/api/v1`;
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
  | "upload-wrong-run" | "upload-response-wrong-run"
  | "billing-missing" | "billing-duplicate" | "billing-wrong-price" | "billing-extra-item"
  | "billing-extra-type" | "billing-reader-error"
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
  let clientItemKey = "";
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
      clientItemKey = uploadBody.match(/name="client_item_key"\r\n\r\n([^\r]*)\r\n/)?.[1] ?? "";
      const targetJobs = uploadBody.match(/name="target_job_ids"\r\n\r\n([^\r]*)\r\n/)?.[1];
      if (targetJobs !== undefined && (!/^\[[1-9]\d*(?:,[1-9]\d*){0,19}\]$/.test(targetJobs) || targetJobs.slice(1, -1).split(",").some((id) => BigInt(id) > 9223372036854775807n))) {
        return sendError(response, 400, "VALIDATION_ERROR", "target_job_ids must be a JSON int64 array");
      }
      return send(response, { file_id: 901,
        run_id: mode === "upload-wrong-run" || mode === "upload-response-wrong-run" ? 999 : 900,
        file_sha256: options.fixtureSha256, source_platform: "boss", status: "accepted", duplicate: false });
    }
    if (request.method === "GET" && path === "/resume-collection/files/901") {
      if (mode === "not-found") return sendError(response, 404, "NOT_FOUND", "file is still pending");
      return send(response, mode === "extract-failed"
        ? { file_id: 901, run_id: 900, file_sha256: options.fixtureSha256, extract_status: "failed", parse_status: "failed", error_code: "EXTRACT_FAILED" }
        : { file_id: 901, run_id: mode === "upload-wrong-run" ? 999 : 900,
          file_sha256: options.fixtureSha256, extract_status: "done", parse_status: "matched", candidate_id: 902 });
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
    if (request.method === "GET" && path === "/billing/usage-charges") {
      if (mode === "billing-reader-error") return sendError(response, 503, "UNAVAILABLE", "billing fixture unavailable");
      if (url.searchParams.has("workflow_type")) return sendError(response, 400, "INVALID_FILTER", "all types must be checked");
      const points = mode === "billing-wrong-price" ? 50 : 300;
      const items = mode === "billing-missing" ? [] : [
        { id: "1001", workflow_type: "communication_resume_screening", workflow_run_id: 900,
          workflow_item_key: clientItemKey, points },
        ...(mode === "billing-duplicate" ? [{ id: "1002", workflow_type: "communication_resume_screening",
          workflow_run_id: 900, workflow_item_key: clientItemKey, points }] : []),
        ...(mode === "billing-extra-item" || mode === "billing-extra-type" ? [{ id: "1003",
          workflow_type: mode === "billing-extra-type" ? "proactive_talent_screening" : "communication_resume_screening",
          workflow_run_id: 900, workflow_item_key: `${clientItemKey}:unexpected`,
          points: mode === "billing-extra-type" ? 50 : 300 }] : []),
      ];
      return send(response, { page: Number(url.searchParams.get("page")),
        page_size: Number(url.searchParams.get("page_size")), total: items.length,
        total_points: items.reduce((sum, item) => sum + item.points, 0), items });
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
