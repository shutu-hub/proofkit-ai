import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
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
export function createIntegration({ z: injectedZ, workspaceRoot }) {
  // Keep the module dependency-free for external test workspaces. The runner injects the
  // schema runtime when loading this factory.
  z = injectedZ;
  const state = new Map();

  return {
    name: "aihr-resume-workflows",
    version: "0.1.0",
    capabilities: [
      createResumeRunCapability(state),
      createResumeFileUploadCapability(state, workspaceRoot),
      waitResumeCollectionPipelineCapability(state),
      createOnlineResumeIntakeCapability(state),
      waitOnlineResumePipelineCapability(state),
      readResumeRunCapability(),
      readResumeFileCapability(),
      readWorkflowUsageCapability(),
      readBillingUsageCapability(),
    ],
    oracles: [createResumeCollectionPipelineOracle(state), createOnlineResumePipelineOracle(state), createResumeUploadIdempotencyOracle(state)],
    preflight: aihrPreflight,
    setup: async ({ runId }) => {
      state.set(runId, { createdAt: new Date().toISOString() });
      return () => state.delete(runId);
    },
  };
}

async function aihrPreflight({ charter, environment }) {
  const actionNames = charter.actions
    .filter((action) => action.kind === "capability")
    .map((action) => action.name);
  const writeActions = actionNames.filter((name) => [
    "aihr.createResumeCollectionRun",
    "aihr.uploadResumeFile",
    "aihr.createOnlineResumeIntake",
  ].includes(name));
  const baseUrl = env("AIHR_PROOFKIT_API_BASE_URL") ?? "http://127.0.0.1:8080/api/v1";
  const errors = [];
  let parsed;
  try {
    parsed = new URL(baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) errors.push("AIHR API base URL must use HTTP or HTTPS");
  } catch {
    errors.push("AIHR_PROOFKIT_API_BASE_URL is not a valid URL");
  }
  const loopback = parsed ? ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) : false;
  if (!loopback && env("AIHR_PROOFKIT_ALLOW_REMOTE_TEST_ENDPOINT") !== "true") {
    errors.push("remote AIHR endpoints require AIHR_PROOFKIT_ALLOW_REMOTE_TEST_ENDPOINT=true");
  }
  if (!["test", "local"].includes(environment)) errors.push(`AIHR write tests require test or local environment, received ${environment}`);

  const scope = env("AIHR_PROOFKIT_TEST_SCOPE");
  const clientItemKey = env("AIHR_PROOFKIT_CLIENT_ITEM_KEY");
  if (!scope || !/^proofkit:[A-Za-z0-9._-]+$/.test(scope)) errors.push("AIHR_PROOFKIT_TEST_SCOPE must match proofkit:<scope>");
  if (writeActions.length > 0) {
    if (!clientItemKey) errors.push("AIHR_PROOFKIT_CLIENT_ITEM_KEY is required for write capabilities");
    if (scope && clientItemKey && !clientItemKey.startsWith(`${scope}:`)) errors.push("AIHR_PROOFKIT_CLIENT_ITEM_KEY must be namespaced by AIHR_PROOFKIT_TEST_SCOPE");
    for (const name of ["AIHR_PROOFKIT_ENTERPRISE_ID", "AIHR_PROOFKIT_WORKSPACE_ID", "AIHR_PROOFKIT_USER_ID"]) {
      if (!env(name)) errors.push(`${name} is required for write capabilities`);
    }
  }
  if (actionNames.includes("aihr.uploadResumeFile") && !env("AIHR_PROOFKIT_FIXTURE_PATH")) {
    errors.push("AIHR_PROOFKIT_FIXTURE_PATH is required for resume uploads");
  }
  return {
    passed: errors.length === 0,
    message: errors.length === 0 ? "AIHR test scope and endpoint preflight passed." : errors.join("; "),
    evidence: {
      environment,
      apiHost: parsed?.hostname ?? "invalid",
      loopbackEndpoint: loopback,
      remoteEndpointOverride: env("AIHR_PROOFKIT_ALLOW_REMOTE_TEST_ENDPOINT") === "true",
      writeActionCount: writeActions.length,
      testScopeConfigured: Boolean(scope),
      clientItemKeyNamespaced: Boolean(scope && clientItemKey?.startsWith(`${scope}:`)),
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

function createResumeFileUploadCapability(state, workspaceRoot) {
  return {
    name: "aihr.uploadResumeFile",
    description: "Upload a PDF resume through the same gateway multipart contract used by the AIHR desktop flow.",
    sideEffect: "write",
    environments: environment,
    timeoutMs: 60_000,
    inputSchema: z.object({
      runId: positiveIdInput().optional(),
      fixturePath: z.string().min(1),
      sourceChannel: z.string().min(1).default("boss"),
      originalFilename: z.string().min(1).optional(),
      targetJobIds: z.array(positiveIdInput()).max(20).default([]),
      clientItemKey: z.string().min(1).max(255),
      resumeRole: z.enum(["online", "attachment"]).default("online"),
      expectedCandidateId: positiveIdInput().optional(),
      bossAccountId: z.string().min(1).optional(),
      candidateUid: z.string().min(1).optional(),
      conversationId: positiveIdInput().optional(),
      candidateAge: z.number().int().positive().optional(),
      manualOverride: z.boolean().default(false),
      manualRunId: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
      fileId: positiveId(),
      runId: positiveId().nullable(),
      fileSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      sourceChannel: z.string(),
      clientItemKey: z.string(),
      status: z.string(),
      duplicate: z.boolean(),
      extractStatus: z.string().nullable(),
      parseStatus: z.string().nullable(),
      candidateId: z.string().nullable(),
    }),
    async execute(input, { runId, signal }) {
      input = resolveEnv(input);
      const fixture = await readFixture(workspaceRoot, input.fixturePath);
      const form = new FormData();
      form.append("file", new Blob([fixture.bytes], { type: fixture.contentType }), input.originalFilename ?? fixture.filename);
      const collectionRunId = input.runId ?? state.get(runId)?.collectionRunId;
      if (collectionRunId !== undefined) form.append("run_id", asId(collectionRunId));
      form.append("source_channel", input.sourceChannel);
      form.append("original_filename", input.originalFilename ?? fixture.filename);
      // AIHR decodes []int64, so quoted IDs are invalid. Decimal literals keep
      // string-supplied int64 IDs exact without a lossy Number conversion.
      if (input.targetJobIds.length) form.append("target_job_ids", `[${input.targetJobIds.map(asId).join(",")}]`);
      form.append("client_item_key", input.clientItemKey);
      form.append("resume_role", input.resumeRole);
      if (input.expectedCandidateId !== undefined) form.append("expected_candidate_id", asId(input.expectedCandidateId));
      if (input.bossAccountId) form.append("boss_account_id", input.bossAccountId);
      if (input.candidateUid) form.append("candidate_uid", input.candidateUid);
      if (input.conversationId !== undefined) form.append("conversation_id", asId(input.conversationId));
      if (input.candidateAge !== undefined) form.append("candidate_age", String(input.candidateAge));
      form.append("manual_override", String(input.manualOverride));
      if (input.manualRunId) form.append("manual_run_id", input.manualRunId);

      const response = await aihrFetch("/resume-collection/files", { method: "POST", signal, body: form });
      const data = response.data ?? {};
      const result = {
        fileId: asId(data.file_id),
        runId: data.run_id === null || data.run_id === undefined ? null : asId(data.run_id),
        fileSha256: String(data.file_sha256 ?? fixture.sha256),
        sourceChannel: String(data.source_platform ?? input.sourceChannel),
        clientItemKey: input.clientItemKey,
        status: String(data.status ?? "accepted"),
        duplicate: Boolean(data.duplicate),
        extractStatus: nullable(data.extract_status),
        parseStatus: nullable(data.parse_status),
        candidateId: positiveString(data.candidate_id),
      };
      const current = state.get(runId) ?? {};
      const uploadHistory = [...(current.uploadHistory ?? []), result];
      state.set(runId, { ...current, collectionRunId: result.runId ?? current.collectionRunId, uploadedFile: result, uploadHistory, fixtureSha256: fixture.sha256, sourceChannel: result.sourceChannel });
      return result;
    },
    evidence: (output) => ({
      fileId: output.fileId,
      collectionRunId: output.runId,
      fileSha256: output.fileSha256,
      sourceChannel: output.sourceChannel,
      clientItemKey: output.clientItemKey,
      status: output.status,
      duplicate: output.duplicate,
      extractStatus: output.extractStatus,
      parseStatus: output.parseStatus,
      candidateId: output.candidateId,
    }),
  };
}

function waitResumeCollectionPipelineCapability(state) {
  return {
    name: "aihr.waitResumeCollectionPipeline",
    description: "Poll the ordinary AIHR PDF upload path and verify file, candidate-job relation, assessment and workflow facts belong to the same upload.",
    sideEffect: "read",
    environments: environment,
    timeoutMs: 610_000,
    inputSchema: resumePipelineInputSchema(),
    outputSchema: resumePipelineOutputSchema(),
    async execute(input, { runId, signal }) {
      input = resolveEnv(input);
      const remembered = state.get(runId) ?? {};
      const target = resolveResumePipelineTarget(input, remembered);
      const observed = await pollResumeCollectionPipeline(target, { signal, maxWaitMs: input.maxWaitMs, pollIntervalMs: input.pollIntervalMs });
      state.set(runId, { ...remembered, resumePipeline: observed });
      return observed;
    },
    evidence: resumePipelineEvidence,
  };
}

function resumePipelineInputSchema() {
  return z.object({
    runId: positiveIdInput().optional(),
    fileId: positiveIdInput().optional(),
    jobId: positiveIdInput().optional(),
    clientItemKey: z.string().min(1).optional(),
    maxWaitMs: z.number().int().min(1_000).max(600_000).default(300_000),
    pollIntervalMs: z.number().int().min(250).max(10_000).default(1_000),
    requireCandidateBinding: z.boolean().default(true),
    requireAssessmentSuccess: z.boolean().default(true),
    requireWorkflowUsage: z.boolean().default(false),
  });
}

function resumePipelineOutputSchema() {
  return z.object({
    passed: z.boolean().nullable(),
    outcome: z.enum(["passed", "failed", "inconclusive"]),
    terminal: z.boolean(),
    collectionRunId: z.string().nullable(),
    fileId: z.string().nullable(),
    fileRunId: z.string().nullable(),
    fileSha256: z.string().nullable(),
    extractStatus: z.string().nullable(),
    parseStatus: z.string().nullable(),
    candidateId: z.string().nullable(),
    jobId: z.string().nullable(),
    relationCurrentResumeFileId: z.string().nullable(),
    relationJobId: z.string().nullable(),
    relationStage: z.string().nullable(),
    assessmentId: z.string().nullable(),
    assessmentCurrentResumeFileId: z.string().nullable(),
    assessmentJobId: z.string().nullable(),
    assessmentCandidateId: z.string().nullable(),
    assessmentStatus: z.string().nullable(),
    assessmentTaskStatus: z.string().nullable(),
    workflowMatchCount: z.number().int().nonnegative(),
    lastErrorCode: z.string().nullable(),
    observationCount: z.number().int().nonnegative(),
  });
}

function resumePipelineEvidence(output) {
  return {
    passed: output.passed,
    outcome: output.outcome,
    terminal: output.terminal,
    collectionRunId: output.collectionRunId,
    fileId: output.fileId,
    fileRunId: output.fileRunId,
    fileSha256: output.fileSha256,
    extractStatus: output.extractStatus,
    parseStatus: output.parseStatus,
    candidateId: output.candidateId,
    jobId: output.jobId,
    relationCurrentResumeFileId: output.relationCurrentResumeFileId,
    relationJobId: output.relationJobId,
    relationStage: output.relationStage,
    assessmentId: output.assessmentId,
    assessmentCurrentResumeFileId: output.assessmentCurrentResumeFileId,
    assessmentJobId: output.assessmentJobId,
    assessmentCandidateId: output.assessmentCandidateId,
    assessmentStatus: output.assessmentStatus,
    assessmentTaskStatus: output.assessmentTaskStatus,
    workflowMatchCount: output.workflowMatchCount,
    lastErrorCode: output.lastErrorCode,
    observationCount: output.observationCount,
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

function createResumeCollectionPipelineOracle(state) {
  return {
    name: "aihr.resumeCollectionPipeline",
    async check({ runId, charter, signal }) {
      const configuration = resolveEnv(charter.metadata?.aihr);
      if (!configuration || typeof configuration !== "object") {
        return { name: "aihr.resumeCollectionPipeline", passed: null, message: "Charter metadata.aihr is required for the independent AIHR resume collection oracle.", evidence: [] };
      }
      const remembered = state.get(runId) ?? {};
      const target = resolveResumePipelineTarget(configuration, remembered);
      if (!target.fileId) {
        return { name: "aihr.resumeCollectionPipeline", passed: null, message: "No upload file ID was observed for the configured collection run.", evidence: [] };
      }
      const result = await observeResumeCollectionPipeline(target, signal);
      const requireCandidateBinding = configuration.requireCandidateBinding !== false;
      const requireAssessmentSuccess = configuration.requireAssessmentSuccess !== false;
      const requireWorkflowUsage = configuration.requireWorkflowUsage === true;
      const passed = evaluateResumePipeline(result, {
        collectionRunId: target.collectionRunId,
        jobId: target.jobId,
        requireCandidateBinding,
        requireAssessmentSuccess,
        requireWorkflowUsage,
      });
      const facts = resumePipelineEvidence({ ...result, passed, outcome: passed === true ? "passed" : passed === false ? "failed" : "inconclusive" });
      return {
        name: "aihr.resumeCollectionPipeline",
        passed,
        message: passed === true
          ? "AIHR PDF upload facts belong to the requested run and reached the required terminal state."
          : passed === false
            ? `AIHR PDF upload reached a confirmed failure: extract=${result.extractStatus ?? "unknown"}, parse=${result.parseStatus ?? "unknown"}.`
            : "AIHR PDF upload evidence is incomplete or still pending; no product failure is confirmed.",
        evidence: [JSON.stringify(facts)],
        ...(passed === false ? { sourceLocations: ["services/resume-collection-service/internal/service/resume_post_processor.go"] } : {}),
        observedAt: new Date().toISOString(),
      };
    },
  };
}

function resolveResumePipelineTarget(input, remembered) {
  return {
    collectionRunId: input.runId === undefined ? nullable(remembered.collectionRunId) : asId(input.runId),
    fileId: input.fileId === undefined ? positiveString(remembered.uploadedFile?.fileId) : asId(input.fileId),
    jobId: input.jobId === undefined ? positiveString(remembered.jobId ?? remembered.targetJobId) : asId(input.jobId),
    clientItemKey: input.clientItemKey ?? remembered.uploadedFile?.clientItemKey ?? null,
    requireCandidateBinding: input.requireCandidateBinding !== false,
    requireAssessmentSuccess: input.requireAssessmentSuccess !== false,
    requireWorkflowUsage: input.requireWorkflowUsage === true,
  };
}

async function pollResumeCollectionPipeline(target, options) {
  if (!target.fileId) throw new Error("AIHR fileId is required; upload a resume or provide fileId");
  const deadline = Date.now() + options.maxWaitMs;
  let observationCount = 0;
  let last = emptyResumePipelineObservation(target);
  while (Date.now() <= deadline) {
    last = await observeResumeCollectionPipeline(target, options.signal);
    observationCount += 1;
    const passed = evaluateResumePipeline(last, target);
    if (passed === true || passed === false) {
      return { ...last, passed, outcome: passed ? "passed" : "failed", observationCount };
    }
    await delay(options.pollIntervalMs, options.signal);
  }
  return { ...last, passed: null, outcome: "inconclusive", terminal: false, observationCount };
}

async function observeResumeCollectionPipeline(target, signal) {
  const fileResult = await getOrNull(`/resume-collection/files/${asId(target.fileId)}`, signal);
  if (!fileResult) return emptyResumePipelineObservation(target);
  const file = fileResult.data ?? {};
  const collectionRunId = positiveString(file.run_id ?? target.collectionRunId);
  const fileId = positiveString(file.file_id ?? target.fileId);
  const candidateId = positiveString(file.candidate_id);
  const jobId = positiveString(target.jobId ?? file.matched_job_id);
  let relation = {};
  let assessment = {};
  if (candidateId && jobId) {
    relation = (await getOrNull(`/jobs/${jobId}/candidates/${candidateId}`, signal))?.data ?? {};
    assessment = (await getOrNull(`/assessments/jobs/${jobId}/candidates/${candidateId}`, signal))?.data ?? {};
  }
  const workflow = collectionRunId && candidateId && jobId
    ? await readWorkflowItems(collectionRunId, candidateId, jobId, signal)
    : { count: 0 };
  const relationSummary = relation.candidate_summary ?? {};
  return {
    passed: null,
    outcome: "inconclusive",
    terminal: isResumeFileTerminal(file),
    collectionRunId,
    fileId,
    fileRunId: positiveString(file.run_id),
    fileSha256: nullable(file.file_sha256),
    extractStatus: nullable(file.extract_status),
    parseStatus: nullable(file.parse_status),
    candidateId,
    jobId,
    relationCurrentResumeFileId: positiveString(relationSummary.current_resume_file_id),
    relationJobId: positiveString(relationSummary.job_id ?? relation.job_id),
    relationStage: nullable(relationSummary.stage),
    assessmentId: positiveString(assessment.assessment_id),
    assessmentCurrentResumeFileId: positiveString(assessment.current_resume_file_id),
    assessmentJobId: positiveString(assessment.job_id),
    assessmentCandidateId: positiveString(assessment.candidate_id),
    assessmentStatus: nullable(assessment.status),
    assessmentTaskStatus: nullable(assessment.task_status),
    workflowMatchCount: workflow.count,
    lastErrorCode: nullable(file.error_code ?? file.extract_error_code),
    observationCount: 0,
  };
}

function evaluateResumePipeline(observation, requirements) {
  if (observation.fileRunId && requirements.collectionRunId && observation.fileRunId !== requirements.collectionRunId) return false;
  if (!isResumeFileTerminal(observation)) return null;
  if (observation.extractStatus === "failed" || ["failed", "identity_conflict", "needs_manual_match", "needs_job_sync"].includes(observation.parseStatus ?? "")) return false;
  if (observation.extractStatus !== "done" || observation.parseStatus !== "matched" || !observation.candidateId) return null;
  if (requirements.requireCandidateBinding !== false) {
    if (!requirements.jobId) return null;
    if (observation.relationCurrentResumeFileId && observation.relationCurrentResumeFileId !== observation.fileId) return false;
    if (observation.relationJobId && observation.relationJobId !== requirements.jobId) return false;
    if (!observation.relationCurrentResumeFileId || !observation.relationJobId) return null;
  }
  if (requirements.requireAssessmentSuccess !== false) {
    if (observation.assessmentCurrentResumeFileId && observation.assessmentCurrentResumeFileId !== observation.fileId) return false;
    if (observation.assessmentJobId && observation.assessmentJobId !== requirements.jobId) return false;
    if (observation.assessmentCandidateId && observation.assessmentCandidateId !== observation.candidateId) return false;
    if (!observation.assessmentCurrentResumeFileId || !observation.assessmentJobId || !observation.assessmentCandidateId) return null;
    if (!isAssessmentSuccess(observation.assessmentStatus, observation.assessmentTaskStatus)) {
      if (isAssessmentFailure(observation.assessmentStatus, observation.assessmentTaskStatus)) return false;
      return null;
    }
  }
  if (requirements.requireWorkflowUsage === true && observation.workflowMatchCount < 1) return null;
  return true;
}

function isResumeFileTerminal(value) {
  const extractStatus = value?.extractStatus ?? value?.extract_status;
  const parseStatus = value?.parseStatus ?? value?.parse_status;
  if (!value || !["done", "failed"].includes(extractStatus ?? "")) return false;
  if (extractStatus === "failed") return true;
  return ["matched", "needs_manual_match", "needs_job_sync", "failed", "identity_conflict"].includes(parseStatus ?? "");
}

function isAssessmentSuccess(status, taskStatus) {
  return ["success", "completed", "passed"].includes(String(taskStatus ?? "").toLowerCase()) || ["success", "completed", "passed"].includes(String(status ?? "").toLowerCase());
}

function isAssessmentFailure(status, taskStatus) {
  return ["failed", "error", "failure"].includes(String(taskStatus ?? "").toLowerCase()) || ["failed", "error", "failure"].includes(String(status ?? "").toLowerCase());
}

function emptyResumePipelineObservation(target) {
  return {
    passed: null,
    outcome: "inconclusive",
    terminal: false,
    collectionRunId: target.collectionRunId ?? null,
    fileId: target.fileId ?? null,
    fileRunId: null,
    fileSha256: null,
    extractStatus: null,
    parseStatus: null,
    candidateId: null,
    jobId: target.jobId ?? null,
    relationCurrentResumeFileId: null,
    relationJobId: null,
    relationStage: null,
    assessmentId: null,
    assessmentCurrentResumeFileId: null,
    assessmentJobId: null,
    assessmentCandidateId: null,
    assessmentStatus: null,
    assessmentTaskStatus: null,
    workflowMatchCount: 0,
    lastErrorCode: null,
    observationCount: 0,
  };
}

async function readWorkflowItems(runId, candidateId, jobId, signal) {
  // This endpoint proves completion for run/candidate/job only. It does not
  // expose the exact resume file, assessment ID or billing idempotency key.
  for (let page = 1; page <= 20; page += 1) {
    const response = await getOrNull(`/workflow-executions?run_id=${encodeURIComponent(runId)}&page=${page}&page_size=100`, signal);
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    const count = items.filter((item) => positiveString(item.run_id) === runId
      && item.screening_stage === "workflow_completion"
      && positiveString(item.candidate?.id) === candidateId
      && positiveString(item.job?.id) === jobId).length;
    if (count > 0) return { count };
    const pagination = response?.data?.pagination;
    if (!pagination || pagination.page !== page
      || !Number.isSafeInteger(pagination.page_size) || pagination.page_size < 1 || pagination.page_size > 100
      || !Number.isSafeInteger(pagination.total) || pagination.total < 0
      || page * pagination.page_size >= pagination.total) break;
  }
  return { count: 0 };
}

async function getOrNull(path, signal) {
  try { return await aihrFetch(path, { signal }); } catch (error) { if (isNotFound(error)) return null; throw error; }
}

async function readFixture(workspaceRoot, fixturePath) {
  const requested = String(fixturePath);
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
  const rel = relative(resolve(workspaceRoot), path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("AIHR fixturePath must stay within the test workspace");
  const realRoot = await realpath(workspaceRoot);
  const realPath = await realpath(path);
  const realRel = relative(realRoot, realPath);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("AIHR fixturePath must stay within the test workspace");
  const info = await stat(realPath);
  if (!info.isFile()) throw new Error("AIHR fixturePath must point to a file");
  const bytes = await readFile(realPath);
  if (bytes.length === 0) throw new Error("AIHR resume fixture is empty");
  const filename = basename(path);
  const contentType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
  return { bytes, filename, contentType, sha256: createHash("sha256").update(bytes).digest("hex") };
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
      passed: z.boolean().nullable(),
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
      const configuration = resolveEnv(charter.metadata?.aihr);
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
      const passed = !result.terminal
        ? null
        : result.parseStatus === "matched" && result.extractStatus === "done" && Boolean(result.candidateId) && (!requireAssessmentSuccess || result.assessmentTaskStatus === "success");
      const facts = { ...result, passed, requireAssessmentSuccess };
      return { name: "aihr.onlineResumePipeline", passed, message: passed ? "AIHR online resume facts reached the requested terminal state." : `AIHR online resume pipeline is not valid: phase=${result.workflowPhase}, extract=${result.extractStatus ?? "unknown"}, parse=${result.parseStatus ?? "unknown"}, assessment_task=${result.assessmentTaskStatus ?? "unknown"}.`, evidence: [JSON.stringify(facts)], ...(passed === false ? { sourceLocations: ["services/resume-collection-service/internal/service/structured_online_resume.go", "services/resume-collection-service/internal/service/resume_post_processor.go"] } : {}), observedAt: new Date().toISOString() };
    },
  };
}

function createResumeUploadIdempotencyOracle(state) {
  return {
    name: "aihr.resumeUploadIdempotency",
    async check({ runId }) {
      const history = state.get(runId)?.uploadHistory ?? [];
      const first = history[0];
      const second = history[1];
      const passed = Boolean(first && second && second.duplicate && first.fileSha256 === second.fileSha256 && first.fileId === second.fileId);
      const evidence = {
        uploadCount: history.length,
        firstFileId: first?.fileId ?? null,
        secondFileId: second?.fileId ?? null,
        secondDuplicate: second?.duplicate ?? false,
        sameFile: Boolean(first && second && first.fileId === second.fileId),
        sameSha256: Boolean(first && second && first.fileSha256 === second.fileSha256),
      };
      return {
        name: "aihr.resumeUploadIdempotency",
        passed,
        message: passed ? "Repeated AIHR upload was deduplicated to the same file." : `AIHR upload idempotency was not proven: uploads=${history.length}, duplicate=${second?.duplicate ?? false}.`,
        evidence: [JSON.stringify(evidence)],
        observedAt: new Date().toISOString(),
      };
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
  return { ...result, passed: null, terminal: false, observationCount };
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
  const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = {
    accept: "application/json",
    ...(isMultipart || options.body === undefined ? {} : { "content-type": "application/json" }),
  };
  const token = env("AIHR_PROOFKIT_ACCESS_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  for (const [name, variable] of [["X-Enterprise-Id", "AIHR_PROOFKIT_ENTERPRISE_ID"], ["X-Workspace-Id", "AIHR_PROOFKIT_WORKSPACE_ID"], ["X-User-Id", "AIHR_PROOFKIT_USER_ID"]]) {
    const value = env(variable);
    if (value) headers[name] = value;
  }
  const requestBody = isMultipart
    ? options.body
    : options.body === undefined
      ? undefined
      : JSON.stringify(options.body);
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: requestBody, signal: options.signal });
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
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("AIHR numeric identifiers must be safe integers; use decimal strings for int64 IDs");
  const stringValue = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(stringValue)) throw new Error("AIHR identifiers must be positive decimal strings");
  if (BigInt(stringValue) > 9223372036854775807n) throw new Error("AIHR identifiers must fit a signed int64");
  return stringValue;
}

function positiveString(value) {
  try { return asId(value); } catch { return null; }
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
