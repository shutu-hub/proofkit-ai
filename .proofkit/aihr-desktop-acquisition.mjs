// Workspace-owned AIHR contract. The generic ProofKit runner remains domain-independent.
export function createDesktopResumeAcquisitionOracle({ z, resolveEnv, positiveString, getOrNull, aihrFetch,
  pollPipeline, observeResumeCollectionPipeline, evaluateResumePipeline, resumePipelineEvidence }) {
  const name = "aihr.desktopResumeAcquisition";
  const configSchema = z.object({
    captureStepId: z.string().regex(/^step-[0-9]{3,}$/),
    jobId: z.union([z.string(), z.number()]).refine((value) => positiveString(value) !== null),
    sourceChannel: z.literal("boss"),
    // Latest-state relation/assessment readers cannot prove earlier files after
    // another upload rebinds the same candidate. Keep this reference scope singular.
    expectedFileCount: z.literal(1),
    maxWaitMs: z.number().int().min(1).max(300000).default(60000),
    pollIntervalMs: z.number().int().min(1).max(10000).default(1000),
  }).strict();
  const endpoint = () => `${(process.env.AIHR_PROOFKIT_API_BASE_URL?.trim() || "http://127.0.0.1:8080/api/v1").replace(/\/+$/, "")}/resume-collection/runs`;
  const result = (passed, reason, facts = undefined, boundary = undefined) => ({
    name, passed, message: `AIHR desktop resume acquisition: ${reason}.`,
    evidence: facts ? [JSON.stringify(facts)] : [], observedAt: new Date().toISOString(),
    ...(passed === false && boundary ? { sourceLocations: [boundary] } : {}),
  });

  function configuration(charter) {
    return configSchema.parse(resolveEnv(charter.metadata?.aihrDesktop));
  }

  function declaredCapture(charter, config) {
    const index = charter.actions.findIndex((_, actionIndex) =>
      `step-${String(actionIndex + 1).padStart(3, "0")}` === config.captureStepId);
    const action = charter.actions[index];
    if (!action || action.kind !== "captureResponse" || action.trigger.kind !== "click"
      || action.requestStartTimeoutMs === undefined || action.response.url !== endpoint()
      || action.response.method !== "POST" || !action.response.statuses.includes(201)
      || action.response.fields.collectionRunId?.pointer !== "/data/run_id"
      || action.response.fields.collectionRunId?.type !== "id") return null;
    return { index, action };
  }

  function bind(charter, steps, config) {
    const declared = declaredCapture(charter, config);
    if (!declared) return null;
    const matches = steps.filter((step) => step.stepId === config.captureStepId);
    if (matches.length !== 1) return null;
    const step = matches[0];
    if (step.status !== "passed" || step.action.kind !== "captureResponse" || !step.response
      || JSON.stringify(step.action) !== JSON.stringify(declared.action)
      || step.response.url !== endpoint() || step.response.method !== "POST"
      || step.response.status !== 201 || step.response.association !== "action-window"
      || step.response.requestCount !== 1 || step.response.name !== declared.action.name
      || (declared.action.followUp ? !step.response.followUp : step.response.followUp !== undefined)) return null;
    return positiveString(step.response.fields.collectionRunId);
  }

  async function observe(target, signal) {
    const run = (await getOrNull(`/resume-collection/runs/${target.runId}`, signal))?.data ?? {};
    const runFacts = { id: positiveString(run.run_id), sourceChannel: typeof run.source_channel === "string" ? run.source_channel : null,
      status: typeof run.status === "string" ? run.status : null, errorCode: typeof run.error_code === "string" ? run.error_code : null };
    const facts = { run: runFacts, list: { total: null, itemCount: 0, fileIds: [] }, files: [] };
    if (runFacts.id !== target.runId || runFacts.sourceChannel !== target.sourceChannel) return facts;
    const response = await aihrFetch(`/resume-collection/files?run_id=${encodeURIComponent(target.runId)}&page=1&page_size=20`, { signal });
    const listing = response.data ?? {};
    const items = Array.isArray(listing.items) ? listing.items : [];
    const total = Number.isSafeInteger(listing.total) && listing.total >= 0 ? listing.total : null;
    const fileIds = items.map((item) => positiveString(item?.file_id));
    facts.list = { total, itemCount: items.length, fileIds };
    if (total === null || total > 20 || total !== items.length || fileIds.some((id) => !id)
      || new Set(fileIds).size !== fileIds.length) return facts;
    for (const fileId of fileIds) {
      const observed = await observeResumeCollectionPipeline({ collectionRunId: target.runId, fileId, jobId: target.jobId }, signal);
      facts.files.push({ ...resumePipelineEvidence(observed), fileReaderId: observed.fileReaderId ?? null });
    }
    return facts;
  }

  function evaluate(facts, target) {
    if (!facts) return { passed: null, reason: "no complete observation round" };
    const run = facts.run;
    if (run.id && run.id !== target.runId) return { passed: false, reason: "independent run identity mismatch", boundary: "services/resume-collection-service/internal/service/run_service.go" };
    if (run.sourceChannel && run.sourceChannel !== target.sourceChannel) return { passed: false, reason: "independent run source mismatch", boundary: "services/resume-collection-service/internal/service/run_service.go" };
    if (!run.id || !run.sourceChannel || !run.status) return { passed: null, reason: "independent run facts incomplete" };
    if (run.status === "failed") return { passed: false, reason: "captured collection run failed", boundary: "services/resume-collection-service/internal/service/run_service.go" };
    if (run.status !== "completed") return { passed: null, reason: "captured collection run has not completed" };
    if (facts.list.total !== target.expectedFileCount || facts.list.itemCount !== target.expectedFileCount
      || facts.files.length !== target.expectedFileCount) return { passed: null, reason: "run file count or bounded listing is incomplete" };
    for (const [index, file] of facts.files.entries()) {
      const listedId = facts.list.fileIds[index];
      if (file.fileReaderId && file.fileReaderId !== listedId) return { passed: false, reason: "independent file identity mismatch",
        boundary: "services/resume-collection-service/internal/service/file_service.go" };
      if (file.fileRunId && file.fileRunId !== target.runId) return { passed: false, reason: "independent file belongs to another collection run",
        boundary: "services/resume-collection-service/internal/service/file_service.go" };
      if (!file.fileReaderId || !file.fileRunId) return { passed: null, reason: "independent file and run identity are incomplete" };
      const verdict = evaluateResumePipeline(file, { collectionRunId: target.runId, jobId: target.jobId,
        requireCandidateBinding: true, requireAssessmentSuccess: true, requireWorkflowUsage: true });
      if (verdict === false) return { passed: false, reason: `file ${file.fileId ?? "unknown"} has a confirmed pipeline mismatch`,
        boundary: "services/resume-collection-service/internal/service/resume_post_processor.go" };
      if (verdict !== true) return { passed: null, reason: "file processing, job binding, assessment or workflow facts are pending" };
    }
    return { passed: true, reason: "captured run, all expected files, job bindings, assessments and workflow facts agree" };
  }

  return {
    name,
    validateCharter(charter) {
      try { const config = configuration(charter); return declaredCapture(charter, config) ? null : "metadata.aihrDesktop must reference a delayed capture of POST /resume-collection/runs"; }
      catch { return "valid metadata.aihrDesktop is required for the desktop acquisition oracle"; }
    },
    async check({ charter, steps, signal }) {
      signal?.throwIfAborted();
      let config;
      try { config = configuration(charter); } catch { return result(null, "valid metadata.aihrDesktop is required"); }
      const runId = bind(charter, steps, config);
      if (!runId) return result(null, "a completed, unique UI run-creation response is required");
      const target = { runId, sourceChannel: config.sourceChannel, jobId: positiveString(config.jobId), expectedFileCount: config.expectedFileCount };
      let observed;
      try {
        observed = await pollPipeline({ signal, maxWaitMs: config.maxWaitMs, pollIntervalMs: config.pollIntervalMs,
          initial: null, observe: (sharedSignal) => observe(target, sharedSignal), evaluate: (facts) => evaluate(facts, target).passed });
      } catch (error) {
        signal?.throwIfAborted();
        return result(null, "gateway observation unavailable", { target, httpStatus: Number.isInteger(error?.status) ? error.status : null });
      }
      const conclusion = evaluate(observed.last, target);
      return result(observed.passed, conclusion.reason, { scope: "desktop-run-and-expected-files", target,
        observationCount: observed.observationCount, facts: observed.last,
        outcome: observed.passed === null ? "inconclusive" : observed.passed ? "passed" : "failed" }, conclusion.boundary);
    },
  };
}
