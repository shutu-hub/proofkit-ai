import { createHash } from "node:crypto";
let z;
const positiveId = () => z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]);
const positiveIdInput = () => z.union([z.number().int().positive(), z.string().min(1)]);
const environment = ["test", "staging", "local"];

/**
 * AIHR integration deliberately talks to the public gateway contract. It does
 * not open the project's database, run arbitrary SQL, or call internal
 * service endpoints. This keeps the integration useful for a user checkout
 * and makes every observation reproduce the same path as the desktop app.
 */
export function createIntegration({ z: injectedZ }) {
  // Keep the module dependency-free for project roots. The runner injects the
  // schema runtime when loading this factory.
  z = injectedZ;
  const state = new Map();

  return {
    name: "aihr-resume-workflows",
    version: "0.1.0",
    capabilities: [
      createResumeRunCapability(state),
      createOnlineResumeIntakeCapability(state),
      waitOnlineResumePipelineCapability(state),
      readResumeRunCapability(),
      readResumeFileCapability(),
      readWorkflowUsageCapability(),
      readBillingUsageCapability(),
    ],
    oracles: [createOnlineResumePipelineOracle(state)],
    setup: async ({ runId }) => {
      state.set(runId, { createdAt: new Date().toISOString() });
      return () => state.delete(runId);
    },
  };
}

function createResumeRunCapability(state) {
  return {
    name: "aihr.createResumeCollectionRun",
    description: "Create an AIHR resume collection run through gateway-service.",
    sideEffect: "write",
    environments: environment,
    timeoutMs: 30_000,
    inputSchema: z.object({
      sourceChannel: z.string().min(1).default("boss"),
      taskName: z.string().min(1).optional(),
      candidateUid: z.string().min(1).optional(),
      conversationId: positiveIdInput().optional(),
      bossAccountId: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
      runId: positiveId(),
      sourceChannel: z.string(),
      status: z.string(),
    }),
    async execute(input, { runId, signal }) {
      input = resolveEnv(input);
      const response = await aihrFetch("/resume-collection/runs", {
        method: "POST",
        signal,
        body: {
          source_channel: input.sourceChannel,
          task_name: input.taskName,
          candidate_uid: input.candidateUid,
          conversation_id: input.conversationId === undefined ? undefined : asId(input.conversationId),
          boss_account_id: input.bossAccountId,
        },
      });
      const data = response.data ?? {};
      const result = { runId: asId(data.run_id), sourceChannel: String(data.source_channel ?? input.sourceChannel), status: String(data.status ?? "pending") };
      const current = state.get(runId) ?? {};
      state.set(runId, { ...current, collectionRunId: result.runId, sourceChannel: result.sourceChannel });
      return result;
    },
    evidence: (output) => ({
      collectionRunId: asId(output.runId),
      sourceChannel: output.sourceChannel,
      status: output.status,
    }),
  };
}

function createOnlineResumeIntakeCapability(state) {
  return {
    name: "aihr.createOnlineResumeIntake",
    description: "Submit a BOSS online resume source for AIHR asynchronous structuring and PDF generation.",
    sideEffect: "write",
    environments: environment,
    timeoutMs: 30_000,
    inputSchema: z.object({
      conversationId: positiveIdInput(),
      workflowId: positiveIdInput(),
      workflowVersion: positiveIdInput(),
      jobId: positiveIdInput(),
      candidateUid: z.string().min(1),
      bossAccountId: z.string().min(1),
      sourcePlatform: z.string().min(1).default("boss"),
      sourceText: z.string().min(1),
      structuredHint: z.record(z.string(), z.unknown()).optional(),
      originalFilename: z.string().min(1).default("online-resume.pdf"),
      maxAttempts: z.number().int().min(1).max(5).default(3),
      manualOverride: z.boolean().default(false),
      manualRunId: z.string().min(1).optional(),
    }),
    outputSchema: z.object({ taskId: positiveId(), status: z.string(), conversationId: positiveId(), workflowId: positiveId(), jobId: positiveId() }),
    async execute(input, { runId, signal }) {
      input = resolveEnv(input);
      const response = await aihrFetch("/resume-collection/online-resume-intakes", {
        method: "POST",
        signal,
        body: {
          conversation_id: asId(input.conversationId),
          workflow_id: asId(input.workflowId),
          workflow_version: asId(input.workflowVersion),
          job_id: asId(input.jobId),
          candidate_uid: input.candidateUid,
          boss_account_id: input.bossAccountId,
          source_platform: input.sourcePlatform,
          source_text: input.sourceText,
          structured_hint: input.structuredHint ?? {},
          original_filename: input.originalFilename,
          max_attempts: input.maxAttempts,
          manual_override: input.manualOverride,
          manual_run_id: input.manualRunId,
        },
      });
      const data = response.data ?? {};
      const result = {
        taskId: asId(data.task_id),
        status: String(data.status ?? "pending"),
        conversationId: asId(input.conversationId),
        workflowId: asId(input.workflowId),
        jobId: asId(input.jobId),
      };
      const current = state.get(runId) ?? {};
      state.set(runId, { ...current, onlineIntake: result, sourcePlatform: input.sourcePlatform, platformAccountId: input.bossAccountId });
      return result;
    },
    evidence: (output) => ({
      taskId: asId(output.taskId),
      status: output.status,
      conversationId: asId(output.conversationId),
      workflowId: asId(output.workflowId),
      jobId: asId(output.jobId),
    }),
  };
}

function waitOnlineResumePipelineCapability(state) {
  return {
    name: "aihr.waitOnlineResumePipeline",
    description: "Poll the public workflow projection and downstream resume, candidate, and assessment facts until the online resume pipeline reaches a terminal observation.",
    sideEffect: "read",
    environments: environment,
    timeoutMs: 610_000,
    inputSchema: z.object({
      conversationId: positiveIdInput().optional(),
      workflowId: positiveIdInput().optional(),
      jobId: positiveIdInput().optional(),
      platformAccountId: z.string().min(1).optional(),
      sourceChannel: z.string().min(1).default("boss"),
      maxWaitMs: z.number().int().min(1_000).max(600_000).default(300_000),
      pollIntervalMs: z.number().int().min(250).max(10_000).default(1_000),
      requireAssessmentSuccess: z.boolean().default(true),
    }),
    outputSchema: z.object({
      passed: z.boolean(),
      terminal: z.boolean(),
      workflowPhase: z.string(),
      resumeFileId: z.string().nullable(),
      extractStatus: z.string().nullable(),
      parseStatus: z.string().nullable(),
      candidateId: z.string().nullable(),
      relationStage: z.string().nullable(),
      assessmentStatus: z.string().nullable(),
      assessmentTaskStatus: z.string().nullable(),
      observationCount: z.number().int().nonnegative(),
      lastErrorCode: z.string().nullable(),
    }),
    async execute(input, { runId, signal }) {
      input = resolveEnv(input);
      const remembered = state.get(runId)?.onlineIntake;
      const target = {
        conversationId: asId(input.conversationId ?? remembered?.conversationId),
        workflowId: asId(input.workflowId ?? remembered?.workflowId),
        jobId: asId(input.jobId ?? remembered?.jobId),
        platformAccountId: input.platformAccountId ?? state.get(runId)?.platformAccountId ?? env("AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID"),
        sourceChannel: input.sourceChannel ?? state.get(runId)?.sourcePlatform ?? "boss",
      };
      const observed = await pollOnlineResumePipeline(target, { signal, maxWaitMs: input.maxWaitMs, pollIntervalMs: input.pollIntervalMs, requireAssessmentSuccess: input.requireAssessmentSuccess });
      return observed;
    },
    evidence: (output) => ({
      passed: output.passed,
      terminal: output.terminal,
      workflowPhase: output.workflowPhase,
      resumeFileId: output.resumeFileId,
      extractStatus: output.extractStatus,
      parseStatus: output.parseStatus,
      candidateId: output.candidateId,
      relationStage: output.relationStage,
      assessmentStatus: output.assessmentStatus,
      assessmentTaskStatus: output.assessmentTaskStatus,
      observationCount: output.observationCount,
      lastErrorCode: output.lastErrorCode,
    }),
  };
}

function readResumeRunCapability() {
  return simpleReadCapability(
    "aihr.readResumeCollectionRun",
    "Read an AIHR resume collection run through gateway-service.",
    z.object({ runId: positiveIdInput() }),
    async (input, signal) => {
      input = resolveEnv(input);
      const response = await aihrFetch(`/resume-collection/runs/${asId(input.runId)}`, { signal });
      const data = response.data ?? {};
      return { runId: asId(data.run_id ?? input.runId), status: String(data.status ?? "unknown"), errorCode: nullable(data.error_code), counts: { requested: numberOrNull(data.requested_count), uploaded: numberOrNull(data.uploaded_count), failed: numberOrNull(data.failed_count) } };
    },
    (output) => ({ runId: output.runId, status: output.status, errorCode: output.errorCode, requested: output.counts.requested, uploaded: output.counts.uploaded, failed: output.counts.failed }),
  );
}

function readResumeFileCapability() {
  return simpleReadCapability(
    "aihr.readResumeFile",
    "Read an AIHR resume file and its processing statuses through gateway-service.",
    z.object({ fileId: positiveIdInput() }),
    async (input, signal) => {
      input = resolveEnv(input);
      const response = await aihrFetch(`/resume-collection/files/${asId(input.fileId)}`, { signal });
      const data = response.data ?? {};
      return { fileId: asId(data.file_id ?? input.fileId), runId: nullable(data.run_id), fileSha256: nullable(data.file_sha256), extractStatus: nullable(data.extract_status), parseStatus: nullable(data.parse_status), candidateId: nullable(data.candidate_id), matchedJobId: nullable(data.matched_job_id), assessmentStatus: nullable(data.assessment_status) };
    },
    (output) => ({ fileId: output.fileId, runId: output.runId, fileSha256: output.fileSha256, extractStatus: output.extractStatus, parseStatus: output.parseStatus, candidateId: output.candidateId, matchedJobId: output.matchedJobId, assessmentStatus: output.assessmentStatus }),
  );
}

function readWorkflowUsageCapability() {
  return simpleReadCapability(
    "aihr.readWorkflowUsage",
    "Read immutable workflow execution facts for an AIHR collection run.",
    z.object({ runId: positiveIdInput() }),
    async (input, signal) => {
      input = resolveEnv(input);
      const response = await aihrFetch(`/workflow-executions?run_id=${encodeURIComponent(asId(input.runId))}&page=1&page_size=100`, { signal });
      const data = response.data ?? {};
      const items = Array.isArray(data.items) ? data.items : [];
      return { runId: asId(input.runId), total: numberOrNull(data.pagination?.total) ?? items.length, items: items.map((item) => ({ id: nullable(item.id), stage: nullable(item.screening_stage), result: nullable(item.screening_result), jobId: nullable(item.job?.id), candidateId: nullable(item.candidate?.id) })) };
    },
    (output) => ({ runId: output.runId, total: output.total, itemCount: output.items.length, successfulCount: output.items.filter((item) => item.result === "passed").length, stages: [...new Set(output.items.map((item) => item.stage).filter(Boolean))].join(",") }),
  );
}

function readBillingUsageCapability() {
  return simpleReadCapability(
    "aihr.readBillingUsage",
    "Read immutable AIHR billing usage facts and correlate them to a workflow run.",
    z.object({
      runId: positiveIdInput(),
      workflowType: z.string().min(1).optional(),
      sourcePlatform: z.string().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).default(100),
    }),
    async (input, signal) => {
      input = resolveEnv(input);
      const params = new URLSearchParams({ page: "1", page_size: String(input.pageSize) });
      if (input.workflowType) params.set("workflow_type", input.workflowType);
      if (input.sourcePlatform) params.set("source_platform", input.sourcePlatform);
      const response = await aihrFetch(`/billing/usage-charges?${params}`, { signal });
      const data = response.data ?? {};
      const items = Array.isArray(data.items) ? data.items : [];
      const runId = asId(input.runId);
      const matched = items.filter((item) => String(item.workflow_run_id ?? "") === runId);
      return {
        runId,
        total: numberOrNull(data.total) ?? items.length,
        totalPoints: numberOrNull(data.total_points) ?? 0,
        matchedCount: matched.length,
        matchedPoints: matched.reduce((sum, item) => sum + (numberOrNull(item.points) ?? 0), 0),
        itemKeys: matched.map((item) => nullable(item.workflow_item_key)).filter(Boolean).slice(0, 100),
      };
    },
    (output) => ({ runId: output.runId, total: output.total, totalPoints: output.totalPoints, matchedCount: output.matchedCount, matchedPoints: output.matchedPoints, itemKeyCount: output.itemKeys.length }),
  );
}

function createOnlineResumePipelineOracle(state) {
  return {
    name: "aihr.onlineResumePipeline",
    async check({ runId, charter, signal }) {
      const configuration = charter.metadata?.aihr;
      if (!configuration || typeof configuration !== "object") {
        return { name: "aihr.onlineResumePipeline", passed: null, message: "Charter metadata.aihr is required for the independent AIHR workflow oracle.", evidence: [] };
      }
      const remembered = state.get(runId)?.onlineIntake;
      const target = {
        conversationId: asId(configuration.conversationId ?? remembered?.conversationId),
        workflowId: asId(configuration.workflowId ?? remembered?.workflowId),
        jobId: asId(configuration.jobId ?? remembered?.jobId),
        platformAccountId: String(configuration.platformAccountId ?? state.get(runId)?.platformAccountId ?? env("AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID") ?? ""),
        sourceChannel: String(configuration.sourceChannel ?? state.get(runId)?.sourcePlatform ?? "boss"),
      };
      const result = await observeOnlineResumePipeline(target, signal);
      const requireAssessmentSuccess = configuration.requireAssessmentSuccess !== false;
      const passed = result.terminal && result.parseStatus === "matched" && result.extractStatus === "done" && Boolean(result.candidateId) && (!requireAssessmentSuccess || result.assessmentTaskStatus === "success");
      const facts = { ...result, passed, requireAssessmentSuccess };
      return { name: "aihr.onlineResumePipeline", passed, message: passed ? "AIHR online resume facts reached the requested terminal state." : `AIHR online resume pipeline is not valid: phase=${result.workflowPhase}, extract=${result.extractStatus ?? "unknown"}, parse=${result.parseStatus ?? "unknown"}, assessment_task=${result.assessmentTaskStatus ?? "unknown"}.`, evidence: [JSON.stringify(facts)], observedAt: new Date().toISOString() };
    },
  };
}

function simpleReadCapability(name, description, inputSchema, execute, evidence) {
  return { name, description, sideEffect: "read", environments: environment, timeoutMs: 30_000, inputSchema, outputSchema: z.any(), execute, evidence };
}

async function pollOnlineResumePipeline(target, options) {
  assertTarget(target);
  const deadline = Date.now() + options.maxWaitMs;
  let observationCount = 0;
  let last;
  while (Date.now() <= deadline) {
    last = await observeOnlineResumePipeline(target, options.signal);
    observationCount += 1;
    const terminal = isTerminalObservation(last);
    const passed = terminal && last.extractStatus === "done" && last.parseStatus === "matched" && Boolean(last.candidateId) && (!options.requireAssessmentSuccess || last.assessmentTaskStatus === "success");
    if (passed || last.workflowPhase === "terminated" || last.lastErrorCode) return { ...last, passed, terminal, observationCount };
    await delay(options.pollIntervalMs, options.signal);
  }
  const result = last ?? emptyObservation();
  return { ...result, passed: false, terminal: false, observationCount };
}

async function observeOnlineResumePipeline(target, signal) {
  const query = new URLSearchParams({ platform_account_id: target.platformAccountId, source_channel: target.sourceChannel });
  const workflowResponse = await aihrFetch(`/boss-conversations/${target.conversationId}/workflows/${target.workflowId}?${query}`, { signal });
  const root = workflowResponse.data ?? {};
  const workflow = root.workflow ?? {};
  const fileId = positiveString(workflow.online_resume_file_id);
  let file = {};
  if (fileId) {
    try {
      file = (await aihrFetch(`/resume-collection/files/${fileId}`, { signal })).data ?? {};
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const candidateId = positiveString(file.candidate_id ?? root.candidate_id);
  let candidate = {};
  let assessment = {};
  if (candidateId) {
    try {
      candidate = (await aihrFetch(`/jobs/${target.jobId}/candidates/${candidateId}`, { signal })).data ?? {};
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      assessment = (await aihrFetch(`/assessments/jobs/${target.jobId}/candidates/${candidateId}`, { signal })).data ?? {};
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return {
    terminal: isTerminalObservation({ resumeFileId: fileId, workflowPhase: String(workflow.phase ?? "unknown"), extractStatus: nullable(file.extract_status), parseStatus: nullable(file.parse_status), candidateId, assessmentTaskStatus: nullable(assessment.task_status), lastErrorCode: nullable(workflow.last_error_code) }),
    workflowPhase: String(workflow.phase ?? "unknown"),
    resumeFileId: fileId,
    extractStatus: nullable(file.extract_status),
    parseStatus: nullable(file.parse_status),
    candidateId,
    relationStage: nullable(root.relation_stage ?? candidate.candidate_summary?.stage),
    assessmentStatus: nullable(root.assessment_status ?? file.assessment_status ?? candidate.candidate_summary?.assessment_status ?? assessment.status),
    assessmentTaskStatus: nullable(root.assessment_task_status ?? assessment.task_status),
    lastErrorCode: nullable(workflow.last_error_code ?? root.assessment_error_code),
  };
}

function isTerminalObservation(value) {
  return Boolean(value.resumeFileId && ["done", "failed"].includes(value.extractStatus ?? "") && value.parseStatus && ["matched", "needs_manual_match", "needs_job_sync", "failed", "identity_conflict"].includes(value.parseStatus));
}

function emptyObservation() {
  return { terminal: false, workflowPhase: "unknown", resumeFileId: null, extractStatus: null, parseStatus: null, candidateId: null, relationStage: null, assessmentStatus: null, assessmentTaskStatus: null, lastErrorCode: null };
}

function assertTarget(target) {
  for (const [key, value] of Object.entries(target)) {
    if (["conversationId", "workflowId", "jobId"].includes(key) && !/^[1-9][0-9]*$/.test(String(value ?? ""))) throw new Error(`AIHR ${key} is required`);
  }
  if (!String(target.platformAccountId ?? "").trim()) throw new Error("AIHR platformAccountId is required");
}

async function aihrFetch(path, options = {}) {
  const base = env("AIHR_PROOFKIT_API_BASE_URL") ?? "http://127.0.0.1:8080/api/v1";
  const url = `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) };
  const token = env("AIHR_PROOFKIT_ACCESS_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  for (const [name, variable] of [["X-Enterprise-Id", "AIHR_PROOFKIT_ENTERPRISE_ID"], ["X-Workspace-Id", "AIHR_PROOFKIT_WORKSPACE_ID"], ["X-User-Id", "AIHR_PROOFKIT_USER_ID"]]) {
    const value = env(variable);
    if (value) headers[name] = value;
  }
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 256) }; }
  if (!response.ok || (body.code && body.code !== "SUCCESS")) {
    const error = new Error(`AIHR gateway ${response.status}: ${String(body.message ?? body.code ?? "request failed").slice(0, 256)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function resolveEnv(value) {
  if (typeof value === "string" && value.startsWith("$env:")) {
    const name = value.slice(5);
    const resolved = env(name);
    if (!resolved) throw new Error(`Required AIHR ProofKit environment variable is missing: ${name}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnv(item)]));
  return value;
}

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function asId(value) {
  const stringValue = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(stringValue)) throw new Error("AIHR identifiers must be positive decimal strings");
  return stringValue;
}

function positiveString(value) {
  const stringValue = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(stringValue) ? stringValue : null;
}

function nullable(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" ? String(value) : String(value);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("AIHR polling cancelled")); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isNotFound(error) {
  return Number(error?.status) === 404;
}

// Kept available for future evidence adapters that need a stable digest while
// never storing source_text or other resume PII in a ProofKit artifact.
export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
