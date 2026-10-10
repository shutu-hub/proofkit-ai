import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepResultSchema, TestCharterSchema } from "@proofkit/contracts";
import type { BusinessOracle } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const integrationRoot = fileURLToPath(new URL("../../../.proofkit/", import.meta.url));
const name = "aihr.manualCandidateIntake";
const hash = "a".repeat(64);
const privateMarker = "PRIVATE_CONTACT_AND_RESUME_TEXT_9a11";
const envKeys = ["AIHR_PROOFKIT_API_BASE_URL", "AIHR_PROOFKIT_TEST_SCOPE", "AIHR_PROOFKIT_ENTERPRISE_ID",
  "AIHR_PROOFKIT_WORKSPACE_ID", "AIHR_PROOFKIT_USER_ID", "AIHR_PROOFKIT_CLIENT_ITEM_KEY", "AIHR_PROOFKIT_ACCESS_TOKEN"];
const previous = new Map<string, string | undefined>();
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
let base: string;
let paths: string[];
let responses: Record<string, unknown>;
let handler: ((path: string, response: ServerResponse) => boolean) | undefined;
let service: LocalRunnerService;
let oracle: BusinessOracle;

beforeEach(async () => {
  for (const key of envKeys) { previous.set(key, process.env[key]); delete process.env[key]; }
  Object.assign(process.env, { AIHR_PROOFKIT_TEST_SCOPE: "proofkit:manual", AIHR_PROOFKIT_ENTERPRISE_ID: "1",
    AIHR_PROOFKIT_WORKSPACE_ID: "2", AIHR_PROOFKIT_USER_ID: "3" });
  paths = []; handler = undefined;
  responses = {
    "/resume-collection/files/901": { file_id: "901", file_sha256: hash, source_platform: { source_channel: "manual_upload" },
      candidate_id: "902", extract_status: "done", parse_status: "matched", extracted_text: privateMarker },
    "/candidates/902": { candidate_id: "902", name: privateMarker, phone: privateMarker, profile: { current_resume_version_id: "903" } },
    "/candidates/902/resume-versions": { items: [{ resume_version_id: "903", resume_file_id: "901", resume_file_sha256: hash,
      is_current: true, source_channel: "manual_upload", original_filename: privateMarker }] },
    "/jobs/505/candidates/902": { candidate_summary: { job_candidate_id: "904", job_id: "505", candidate_id: "902",
      current_resume_file_id: "901", current_resume_version_id: "903", stage: "screening", candidate_name: privateMarker } },
    "/assessments/jobs/505/candidates/902": { assessment_id: "905", job_id: "505", candidate_id: "902", current_resume_file_id: "901",
      job_candidate_relation_id: "904", status: "success", task_status: "success", summary: privateMarker },
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname.replace(/^\/api\/v1/, "");
    paths.push(path);
    if (handler?.(path, response)) return;
    response.writeHead(Object.hasOwn(responses, path) ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "SUCCESS", data: responses[path] }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No gateway port");
  base = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.AIHR_PROOFKIT_API_BASE_URL = base;
  const root = await mkdtemp(join(tmpdir(), "proofkit-manual-oracle-")); roots.push(root);
  await mkdir(join(root, ".proofkit"));
  for (const file of ["integration.mjs", "aihr-manual-intake.mjs"]) await copyFile(join(integrationRoot, file), join(root, ".proofkit", file));
  service = await LocalRunnerService.create({ root });
  oracle = service.integration!.oracles!.find((item) => item.name === name)!;
});

afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const key of envKeys) {
    const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function context() {
  const charter = TestCharterSchema.parse({ intent: "test manual intake", sideEffectPolicy: "allow", oracles: [name],
    actions: [
      { kind: "setInputFiles", selector: "input[type=file]", files: [".proofkit/fixtures/resume.pdf"] },
      { kind: "captureResponse", name: "manual", trigger: { kind: "click", selector: "#submit" }, response: {
        url: `${base}/resume-collection/candidate-intakes`, method: "POST", fields: Object.fromEntries(Object.entries({
          fileId: "resume_file_id", candidateId: "candidate_id", versionId: "resume_version_id", jobId: "job_id", relationId: "job_candidate_id",
        }).map(([key, field]) => [key, { pointer: `/data/${field}`, type: "id" }])),
      } },
    ],
    metadata: { aihrManual: { captureStepId: "step-002", fileStepId: "step-001", jobId: "505", maxWaitMs: 160, pollIntervalMs: 5 } },
  });
  const now = new Date().toISOString();
  const steps = [
    StepResultSchema.parse({ stepId: "step-001", action: charter.actions[0], status: "passed",
      inputFiles: [{ fixture: ".proofkit/fixtures/resume.pdf", name: "resume.pdf", sizeBytes: 10, sha256: hash, mimeType: "application/pdf" }] }),
    StepResultSchema.parse({ stepId: "step-002", action: charter.actions[1], status: "passed", response: {
      name: "manual", association: "action-window", url: `${base}/resume-collection/candidate-intakes`, method: "POST", status: 201,
      requestCount: 1, windowStartedAt: now, windowEndedAt: now, capturedAt: now, bodyBytes: 20, bodySha256: hash,
      fields: { fileId: "901", candidateId: "902", versionId: "903", jobId: "505", relationId: "904" },
    } }),
  ];
  return { runId: "manual-run", charter, steps, assertions: [] };
}

describe("AIHR manual candidate intake independent oracle", () => {
  it("uses only captured identities and preserves allowlisted terminal facts", async () => {
    const observed = await oracle.check(context());
    expect(observed.passed).toBe(true);
    expect(paths).toEqual(Object.keys(responses));
    expect(JSON.parse(observed.evidence[0]!)).toMatchObject({ scope: "manual-intake-assessed", observationCount: 1,
      target: { fileId: "901", versionId: "903", fixtureSha256: hash }, facts: { assessment: { taskStatus: "success" } } });
    expect(JSON.stringify(observed)).not.toContain(privateMarker);
  });

  it.each([
    ["file identity", "/resume-collection/files/901", "file_id", "999"],
    ["stored bytes", "/resume-collection/files/901", "file_sha256", "b".repeat(64)],
    ["parsed candidate", "/resume-collection/files/901", "candidate_id", "999"],
    ["candidate", "/candidates/902", "candidate_id", "999"],
    ["extract failure", "/resume-collection/files/901", "extract_status", "failed"],
    ["parse conflict", "/resume-collection/files/901", "parse_status", "identity_conflict"],
    ["file source", "/resume-collection/files/901", "source_platform", { source_channel: "boss" }],
    ["assessment file", "/assessments/jobs/505/candidates/902", "current_resume_file_id", "999"],
    ["assessment relation", "/assessments/jobs/505/candidates/902", "job_candidate_relation_id", "999"],
    ["assessment job", "/assessments/jobs/505/candidates/902", "job_id", "999"],
    ["assessment candidate", "/assessments/jobs/505/candidates/902", "candidate_id", "999"],
    ["worker dead", "/assessments/jobs/505/candidates/902", "task_status", "dead"],
  ])("rejects evidenced %s despite other successful objects", async (_, path, key, value) => {
    (responses[path as string] as Record<string, unknown>)[key as string] = value;
    const observed = await oracle.check(context());
    expect(observed.passed).toBe(false); expect(observed.sourceLocations?.length).toBe(1);
    expect(observed.evidence).toHaveLength(1);
  });

  it.each(["job_candidate_id", "job_id", "candidate_id", "current_resume_file_id", "current_resume_version_id"])("rejects wrong relation %s", async (key) => {
    (responses["/jobs/505/candidates/902"] as { candidate_summary: Record<string, unknown> }).candidate_summary[key] = "999";
    expect((await oracle.check(context())).passed).toBe(false);
  });

  it("rejects an evidenced wrong version digest", async () => {
    (responses["/candidates/902/resume-versions"] as { items: Record<string, unknown>[] }).items[0]!.resume_file_sha256 = "b".repeat(64);
    expect((await oracle.check(context())).passed).toBe(false);
  });

  it.each([hash, undefined])("does not confirm a changed version file when its digest is %s", async (digest) => {
    const version = (responses["/candidates/902/resume-versions"] as { items: Record<string, unknown>[] }).items[0]!;
    version.resume_file_id = "999";
    version.resume_file_sha256 = digest;
    const observed = await oracle.check(context());
    expect(observed.passed).toBeNull(); expect(observed.sourceLocations).toBeUndefined();
    expect(observed.message).toContain("version file scope changed"); expect(paths).toHaveLength(5);
  });

  it.each(["candidate_id", "file_sha256"])("keeps missing or malformed file %s inconclusive", async (key) => {
    (responses["/resume-collection/files/901"] as Record<string, unknown>)[key] = key === "candidate_id" ? 9007199254740992 : "not-a-digest";
    const observed = await oracle.check(context()); expect(observed.passed).toBeNull(); expect(observed.sourceLocations).toBeUndefined();
  });

  it.each(Object.keys({ "/resume-collection/files/901": 1, "/candidates/902": 1, "/candidates/902/resume-versions": 1,
    "/jobs/505/candidates/902": 1, "/assessments/jobs/505/candidates/902": 1 }))("keeps a missing reader %s inconclusive", async (path) => {
    delete responses[path]; expect((await oracle.check(context())).passed).toBeNull();
  });

  it("allows a reused version ID and source history", async () => {
    (responses["/candidates/902/resume-versions"] as { items: Record<string, unknown>[] }).items[0]!.source_channel = "boss";
    expect((await oracle.check(context())).passed).toBe(true);
  });

  it.each(["file-digest", "file-failure", "relation-file", "assessment-file", "candidate-scope"])("does not confirm %s without its identity or current scope", async (mode) => {
    const file = responses["/resume-collection/files/901"] as Record<string, unknown>;
    const candidate = responses["/candidates/902"] as { profile: Record<string, unknown> };
    const relation = (responses["/jobs/505/candidates/902"] as { candidate_summary: Record<string, unknown> }).candidate_summary;
    const assessment = responses["/assessments/jobs/505/candidates/902"] as Record<string, unknown>;
    if (mode === "file-digest") { delete file.file_id; file.file_sha256 = "b".repeat(64); }
    if (mode === "file-failure") { delete file.file_id; file.extract_status = "failed"; }
    if (mode === "relation-file") { delete relation.job_candidate_id; relation.current_resume_file_id = "999"; }
    if (mode === "assessment-file") { delete assessment.assessment_id; assessment.current_resume_file_id = "999"; }
    if (mode === "candidate-scope") { delete candidate.profile.current_resume_version_id; assessment.current_resume_file_id = "999"; }
    const observed = await oracle.check(context());
    expect(observed.passed).toBeNull(); expect(observed.sourceLocations).toBeUndefined();
  });

  it("stops when a later upload supersedes current state without calling it a defect", async () => {
    (responses["/candidates/902"] as { profile: Record<string, unknown> }).profile.current_resume_version_id = "999";
    const observed = await oracle.check(context()); expect(observed.passed).toBeNull();
    expect(observed.message).toContain("scope superseded"); expect(paths).toHaveLength(5);
  });

  it("keeps duplicate version identities inconclusive", async () => {
    const items = (responses["/candidates/902/resume-versions"] as { items: unknown[] }).items; items.push(items[0]);
    expect((await oracle.check(context())).passed).toBeNull(); expect(paths).toHaveLength(5);
  });

  it("waits for task success and does not accept an old successful assessment during parsing", async () => {
    const file = responses["/resume-collection/files/901"] as Record<string, unknown>;
    const assessment = responses["/assessments/jobs/505/candidates/902"] as Record<string, unknown>;
    file.parse_status = "processing"; assessment.current_resume_file_id = "777";
    let rounds = 0;
    handler = (path) => {
      if (path === "/resume-collection/files/901" && ++rounds === 2) { file.parse_status = "matched"; assessment.current_resume_file_id = "901"; assessment.task_status = "retry_wait"; }
      if (path === "/resume-collection/files/901" && rounds === 3) assessment.task_status = "success";
      return false;
    };
    const observed = await oracle.check(context()); expect(observed.passed).toBe(true);
    expect(JSON.parse(observed.evidence[0]!).observationCount).toBe(3);
  });

  it.each(["capture", "input", "pointer", "endpoint", "status", "duplicate-step", "selection-order"])("rejects invalid %s binding before any GET", async (mode) => {
    const input = context();
    if (mode === "capture") input.steps[1]!.response = undefined;
    if (mode === "input") input.steps[0]!.status = "failed";
    if (mode === "pointer" && input.charter.actions[1]!.kind === "captureResponse") input.charter.actions[1]!.response.fields.fileId!.pointer = "/data/old_file_id";
    if (mode === "endpoint") input.steps[1]!.response!.url = `${base}/other`;
    if (mode === "status") input.steps[1]!.response!.status = 503;
    if (mode === "duplicate-step") input.steps.push(input.steps[1]!);
    if (mode === "selection-order") (input.charter.metadata.aihrManual as Record<string, unknown>).fileStepId = "step-002";
    const observed = await oracle.check(input); expect(observed.passed).toBeNull(); expect(paths).toEqual([]);
  });

  it("rejects another target job using captured evidence before GET", async () => {
    const input = context(); input.steps[1]!.response!.fields.jobId = "999";
    const observed = await oracle.check(input); expect(observed.passed).toBe(false); expect(paths).toEqual([]);
  });

  it("bounds stalled bodies and discards a partially successful round", async () => {
    handler = (path, response) => {
      if (path !== "/assessments/jobs/505/candidates/902") return false;
      response.writeHead(200, { "content-type": "application/json" }); response.write('{"data":'); return true;
    };
    const observed = await oracle.check(context()); expect(observed.passed).toBeNull();
    expect(JSON.parse(observed.evidence[0]!)).toMatchObject({ observationCount: 0, facts: null });
  });

  it("preserves cancellation while observing a stalled request", async () => {
    const controller = new AbortController(); const reason = new Error("cancel manual test");
    handler = (path) => { if (path !== "/candidates/902") return false; controller.abort(reason); return true; };
    await expect(oracle.check({ ...context(), signal: controller.signal })).rejects.toBe(reason);
  });

  it("redacts gateway error bodies and does not certify an infrastructure failure as a product bug", async () => {
    handler = (_, response) => { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ message: privateMarker })); return true; };
    const observed = await oracle.check(context()); expect(observed.passed).toBeNull(); expect(JSON.stringify(observed)).not.toContain(privateMarker);
  });

  it("requires scoped actors for surface submissions without inventing a client item key", async () => {
    const input = context(); const preflight = service.integration!.preflight!;
    const check = () => preflight({ runId: input.runId, charter: input.charter, environment: "test", signal: new AbortController().signal });
    expect((await check()).passed).toBe(true);
    delete process.env.AIHR_PROOFKIT_WORKSPACE_ID; expect((await check()).passed).toBe(false);
    process.env.AIHR_PROOFKIT_WORKSPACE_ID = "2";
    delete process.env.AIHR_PROOFKIT_TEST_SCOPE; expect((await check()).passed).toBe(false);
  });

  it("requires manual isolation for a quick capture without a business oracle", async () => {
    const input = context();
    input.charter.level = "quick";
    input.charter.oracles = [];
    delete process.env.AIHR_PROOFKIT_TEST_SCOPE;
    const observed = await service.integration!.preflight!({ runId: input.runId, charter: input.charter,
      environment: "test", signal: new AbortController().signal });
    expect(observed.passed).toBe(false);
    expect(observed.evidence).toMatchObject({ integrationRequired: true, manualIntake: true });
    expect(paths).toEqual([]);
  });

  it.each(["missing-job", "staging"])("rejects manual preflight for %s before any business request", async (mode) => {
    const input = context();
    if (mode === "missing-job") delete (input.charter.metadata.aihrManual as Record<string, unknown>).jobId;
    const observed = await service.integration!.preflight!({ runId: input.runId, charter: input.charter,
      environment: mode === "staging" ? "staging" : "test", signal: new AbortController().signal });
    expect(observed.passed).toBe(false);
    expect(paths).toEqual([]);
  });
});
