// Workspace-owned AIHR contract; the execution kernel stays business-independent.
// Reuses the gateway reader and deadline/cancellation polling from integration.mjs.
export function createManualCandidateIntakeOracle({ z, resolveEnv, positiveString, getOrNull, pollPipeline }) {
  const name = "aihr.manualCandidateIntake";
  const configSchema = z.object({
    captureStepId: z.string().regex(/^step-[0-9]{3,}$/),
    fileStepId: z.string().regex(/^step-[0-9]{3,}$/),
    jobId: z.union([z.string(), z.number()]).refine((value) => positiveString(value) !== null),
    maxWaitMs: z.number().int().min(1).max(300000).default(60000),
    pollIntervalMs: z.number().int().min(1).max(10000).default(1000),
  }).strict();
  const idFields = { fileId: "resume_file_id", candidateId: "candidate_id", versionId: "resume_version_id",
    jobId: "job_id", relationId: "job_candidate_id" };
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const status = (value) => typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
  const result = (passed, reason, facts = undefined, boundary = undefined) => ({
    name, passed,
    message: `AIHR manual candidate intake: ${reason}.`,
    evidence: facts ? [JSON.stringify(facts)] : [],
    observedAt: new Date().toISOString(),
    ...(passed === false && boundary ? { sourceLocations: [boundary] } : {}),
  });

  function bind(charter, steps, config) {
    const captureIndex = charter.actions.findIndex((_, index) => `step-${String(index + 1).padStart(3, "0")}` === config.captureStepId);
    const fileIndex = charter.actions.findIndex((_, index) => `step-${String(index + 1).padStart(3, "0")}` === config.fileStepId);
    const capture = steps.filter((step) => step.stepId === config.captureStepId);
    const files = steps.filter((step) => step.stepId === config.fileStepId);
    if (captureIndex < 0 || fileIndex < 0 || fileIndex >= captureIndex || capture.length !== 1 || files.length !== 1) return null;
    const step = capture[0]; const selection = files[0];
    if (step.status !== "passed" || step.action.kind !== "captureResponse" || !step.response
      || selection.status !== "passed" || selection.action.kind !== "setInputFiles"
      || selection.action.files.length !== 1 || selection.inputFiles?.length !== 1
      || selection.inputFiles[0].fixture !== selection.action.files[0]
      || JSON.stringify(charter.actions[captureIndex]) !== JSON.stringify(step.action)
      || JSON.stringify(charter.actions[fileIndex]) !== JSON.stringify(selection.action)) return null;
    // A later selection on the same control would invalidate the input-to-submit binding.
    if (charter.actions.slice(fileIndex + 1, captureIndex).some((action) =>
      action.kind === "setInputFiles" && action.selector === selection.action.selector)) return null;
    const endpoint = `${(process.env.AIHR_PROOFKIT_API_BASE_URL?.trim() || "http://127.0.0.1:8080/api/v1").replace(/\/+$/, "")}/resume-collection/candidate-intakes`;
    if (step.action.response.url !== endpoint || step.action.response.method !== "POST"
      || step.response.url !== endpoint || step.response.method !== "POST"
      || step.response.name !== step.action.name || step.response.requestCount !== 1
      || step.response.association !== "action-window" || ![200, 201].includes(step.response.status)) return null;
    const target = {};
    for (const [key, field] of Object.entries(idFields)) {
      const projection = step.action.response.fields[key];
      if (projection?.pointer !== `/data/${field}` || projection.type !== "id") return null;
      target[key] = positiveString(step.response.fields[key]);
      if (!target[key]) return null;
    }
    target.fixtureSha256 = sha(selection.inputFiles[0].sha256);
    if (!target.fixtureSha256) return null;
    return target;
  }

  async function observe(target, signal) {
    // Every reader uses the captured target, never an identity inferred from another response.
    const file = (await getOrNull(`/resume-collection/files/${target.fileId}`, signal))?.data ?? {};
    const candidate = (await getOrNull(`/candidates/${target.candidateId}`, signal))?.data ?? {};
    const versions = (await getOrNull(`/candidates/${target.candidateId}/resume-versions`, signal))?.data?.items;
    const relation = (await getOrNull(`/jobs/${target.jobId}/candidates/${target.candidateId}`, signal))?.data?.candidate_summary ?? {};
    const assessment = (await getOrNull(`/assessments/jobs/${target.jobId}/candidates/${target.candidateId}`, signal))?.data ?? {};
    const matches = Array.isArray(versions) ? versions.filter((item) => positiveString(item?.resume_version_id) === target.versionId) : [];
    const version = matches.length === 1 ? matches[0] : {};
    // Only allowlisted scalars survive. Names, contacts, parsed text, scores and raw errors do not.
    return {
      file: { id: positiveString(file.file_id), sha256: sha(file.file_sha256), source: status(file.source_platform?.source_channel),
        candidateId: positiveString(file.candidate_id), extractStatus: status(file.extract_status), parseStatus: status(file.parse_status) },
      candidate: { id: positiveString(candidate.candidate_id), currentVersionId: positiveString(candidate.profile?.current_resume_version_id) },
      version: { matchCount: matches.length, fileId: positiveString(version.resume_file_id), sha256: sha(version.resume_file_sha256),
        isCurrent: typeof version.is_current === "boolean" ? version.is_current : null, source: status(version.source_channel) },
      relation: { id: positiveString(relation.job_candidate_id), jobId: positiveString(relation.job_id), candidateId: positiveString(relation.candidate_id),
        fileId: positiveString(relation.current_resume_file_id), versionId: positiveString(relation.current_resume_version_id), stage: status(relation.stage) },
      assessment: { id: positiveString(assessment.assessment_id), jobId: positiveString(assessment.job_id), candidateId: positiveString(assessment.candidate_id),
        fileId: positiveString(assessment.current_resume_file_id), relationId: positiveString(assessment.job_candidate_relation_id),
        status: status(assessment.status), taskStatus: status(assessment.task_status) },
    };
  }

  function evaluate(facts, target) {
    if (!facts) return { passed: null, reason: "no complete observation round" };
    const { file, candidate, version, relation, assessment } = facts;
    const failure = (reason, boundary) => ({ passed: false, reason, boundary });
    const pending = (reason) => ({ passed: null, reason });
    const fileOwner = "services/resume-collection-service/internal/service/file_service.go";
    const parserOwner = "services/resume-collection-service/internal/service/resume_post_processor.go";
    const candidateOwner = "services/candidate-service/internal/service/profile.go";
    const relationOwner = "services/job-service/internal/service/job_candidate_service.go";
    const assessmentOwner = "services/assessment-service/internal/service/assessment_orchestrator.go";
    for (const [actual, expected, label, owner] of [
      [file.id, target.fileId, "file identity", fileOwner],
      [candidate.id, target.candidateId, "candidate identity", candidateOwner],
      [relation.id, target.relationId, "relation identity", relationOwner],
    ]) if (actual && actual !== expected) return failure(`${label} mismatch`, owner);
    // A status or digest without the reader's own identity cannot prove a defect.
    if (file.id === target.fileId && file.sha256 && file.sha256 !== target.fixtureSha256) {
      return failure("stored file digest mismatch", fileOwner);
    }
    if (relation.id === target.relationId) {
      if (relation.jobId && relation.jobId !== target.jobId) return failure("relation job mismatch", relationOwner);
      if (relation.candidateId && relation.candidateId !== target.candidateId) return failure("relation candidate mismatch", relationOwner);
    }
    if (version.matchCount > 1) return pending("ambiguous resume version identity");
    if (version.matchCount === 1) {
      if (version.sha256 && version.sha256 !== target.fixtureSha256) return failure("resume version digest mismatch", candidateOwner);
      // AppendResumeVersion legally reuses an ID for the same SHA and updates its
      // file binding. Latest-state readers cannot distinguish that from a defect.
      if (version.fileId && version.fileId !== target.fileId) {
        return { passed: null, reason: "resume version file scope changed", superseded: true };
      }
    }
    // Current-state endpoints cannot prove the former terminal state after another upload.
    if (candidate.currentVersionId && candidate.currentVersionId !== target.versionId) {
      return { passed: null, reason: "current resume scope superseded", superseded: true };
    }
    if (!file.id) return pending("independent file identity incomplete");
    if (file.source && file.source !== "manual_upload") return failure("file source mismatch", fileOwner);
    if (file.extractStatus === "failed" || ["failed", "identity_conflict"].includes(file.parseStatus)) {
      return failure("resume extraction or parsing failed", parserOwner);
    }
    if (file.extractStatus !== "done" || file.parseStatus !== "matched") return pending("resume parsing or binding pending");
    if (file.candidateId && file.candidateId !== target.candidateId) return failure("parsed candidate identity mismatch", parserOwner);
    if (!candidate.id || !candidate.currentVersionId) return pending("current candidate scope incomplete");
    if (!relation.id) return pending("independent relation identity incomplete");
    for (const [actual, expected, label] of [
      [relation.fileId, target.fileId, "relation current file"], [relation.versionId, target.versionId, "relation current version"],
    ]) if (actual && actual !== expected) return failure(`${label} mismatch`, relationOwner);
    if (!assessment.id) return pending("independent assessment identity incomplete");
    for (const [actual, expected, label] of [
      [assessment.jobId, target.jobId, "assessment job"], [assessment.candidateId, target.candidateId, "assessment candidate"],
      [assessment.fileId, target.fileId, "assessment current file"], [assessment.relationId, target.relationId, "assessment relation"],
    ]) if (actual && actual !== expected) return failure(`${label} mismatch`, assessmentOwner);
    if (!file.id || !file.sha256 || !file.source || !file.candidateId || !candidate.id || !candidate.currentVersionId
      || version.matchCount !== 1 || !version.fileId || !version.sha256 || version.isCurrent !== true
      || !relation.id || !relation.jobId || !relation.candidateId || !relation.fileId || !relation.versionId
      || !assessment.id || !assessment.jobId || !assessment.candidateId || !assessment.fileId || !assessment.relationId) {
      return pending("independent identity or version evidence incomplete");
    }
    if (assessment.status === "failed" || ["failed", "dead", "cancelled"].includes(assessment.taskStatus)) return failure("assessment worker failed", assessmentOwner);
    if (assessment.status !== "success" || assessment.taskStatus !== "success") return pending("assessment worker pending");
    return { passed: true, reason: "captured submission, stored bytes, resume version, job binding and assessment worker agree" };
  }

  return { name, async check({ charter, steps, signal }) {
    signal?.throwIfAborted();
    let config;
    try { config = configSchema.parse(resolveEnv(charter.metadata?.aihrManual)); }
    catch { return result(null, "valid metadata.aihrManual is required"); }
    const target = bind(charter, steps, config);
    if (!target) return result(null, "completed submission and single-file input evidence are required");
    target.jobIdExpected = positiveString(config.jobId);
    if (target.jobId !== target.jobIdExpected) return result(false, "submission returned another target job", { target },
      "services/resume-collection-service/internal/service/manual_candidate_intake.go");
    let observed;
    try {
      observed = await pollPipeline({ signal, maxWaitMs: config.maxWaitMs, pollIntervalMs: config.pollIntervalMs, initial: null,
        observe: (sharedSignal) => observe(target, sharedSignal),
        evaluate: (facts) => evaluate(facts, target).passed,
        stop: (facts) => evaluate(facts, target).superseded === true || facts.version.matchCount > 1,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const httpStatus = Number.isInteger(error?.status) ? error.status : null;
      return result(null, "gateway observation unavailable", { target, httpStatus });
    }
    const conclusion = evaluate(observed.last, target);
    return result(observed.passed, conclusion.reason, { scope: "manual-intake-assessed", target,
      observationCount: observed.observationCount, facts: observed.last, outcome: observed.passed === null ? "inconclusive" : observed.passed ? "passed" : "failed" }, conclusion.boundary);
  } };
}
