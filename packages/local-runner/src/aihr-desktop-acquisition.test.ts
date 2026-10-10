import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepResultSchema, TestCharterSchema } from "@proofkit/contracts";
import type { BusinessOracle } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const integrationRoot = fileURLToPath(new URL("../../../.proofkit/", import.meta.url));
const name = "aihr.desktopResumeAcquisition";
const privateMarker = "PRIVATE_RESUME_AND_CONTACT_82fc";
const envKeys = ["AIHR_PROOFKIT_API_BASE_URL", "AIHR_PROOFKIT_TEST_SCOPE", "AIHR_PROOFKIT_ENTERPRISE_ID",
  "AIHR_PROOFKIT_WORKSPACE_ID", "AIHR_PROOFKIT_USER_ID", "AIHR_PROOFKIT_ACCESS_TOKEN"];
const previous = new Map<string, string | undefined>();
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
let base: string;
let responses: Record<string, unknown>;
let paths: string[];
let service: LocalRunnerService;
let oracle: BusinessOracle;

beforeEach(async () => {
  for (const key of envKeys) { previous.set(key, process.env[key]); delete process.env[key]; }
  Object.assign(process.env, { AIHR_PROOFKIT_TEST_SCOPE: "proofkit:desktop", AIHR_PROOFKIT_ENTERPRISE_ID: "1",
    AIHR_PROOFKIT_WORKSPACE_ID: "2", AIHR_PROOFKIT_USER_ID: "3", AIHR_PROOFKIT_ACCESS_TOKEN: "fixture-token" });
  paths = [];
  responses = {
    "/resume-collection/runs/701": { run_id: "701", source_channel: "boss", status: "completed", error_code: null, display_logs: privateMarker },
    "/resume-collection/files": { total: 1, page: 1, page_size: 20, items: [{ file_id: "801", run_id: "701", original_filename: privateMarker }] },
    "/resume-collection/files/801": { file_id: "801", run_id: "701", file_sha256: "a".repeat(64), extract_status: "done",
      parse_status: "matched", candidate_id: "901", matched_job_id: "505", extracted_text: privateMarker },
    "/jobs/505/candidates/901": { candidate_summary: { current_resume_file_id: "801", job_id: "505", candidate_id: "901", stage: "screening" } },
    "/assessments/jobs/505/candidates/901": { assessment_id: "1001", current_resume_file_id: "801", job_id: "505",
      candidate_id: "901", status: "success", task_status: "success", summary: privateMarker },
    "/workflow-executions": { items: [{ run_id: "701", screening_stage: "workflow_completion",
      candidate: { id: "901" }, job: { id: "505" }, screening_result: "passed" }] },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/api\/v1/, ""); paths.push(`${path}${url.search}`);
    const found = Object.hasOwn(responses, path);
    response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: found ? "SUCCESS" : "NOT_FOUND", data: responses[path] ?? {} }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No gateway port");
  base = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.AIHR_PROOFKIT_API_BASE_URL = base;
  const root = await mkdtemp(join(tmpdir(), "proofkit-desktop-oracle-")); roots.push(root);
  await mkdir(join(root, ".proofkit"));
  for (const file of ["integration.mjs", "aihr-manual-intake.mjs", "aihr-desktop-acquisition.mjs"])
    await copyFile(join(integrationRoot, file), join(root, ".proofkit", file));
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
  const charter = TestCharterSchema.parse({ intent: "点击立即运行并验收一份测试简历", level: "core", sideEffectPolicy: "allow", oracles: [name],
    actions: [{ kind: "captureResponse", name: "created-run", trigger: { kind: "click", selector: "button.control-btn:has-text('立即运行')" },
      followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 300 },
      requestStartTimeoutMs: 3000, requestWindowMs: 200, timeoutMs: 5000, response: {
        url: `${base}/resume-collection/runs`, method: "POST", statuses: [201],
        fields: { collectionRunId: { pointer: "/data/run_id", type: "id" } },
      } }],
    assertions: [{ kind: "text-visible", text: "任务进度" }],
    metadata: { aihrDesktop: { captureStepId: "step-001", jobId: "505", sourceChannel: "boss",
      expectedFileCount: 1, maxWaitMs: 100, pollIntervalMs: 5 } },
  });
  const now = new Date().toISOString();
  const steps = [StepResultSchema.parse({ stepId: "step-001", action: charter.actions[0], status: "passed", response: {
    name: "created-run", association: "action-window", url: `${base}/resume-collection/runs`, method: "POST", status: 201,
    requestCount: 1, windowStartedAt: now, requestStartedAt: now, followUp: "clicked", windowEndedAt: now, capturedAt: now,
    bodyBytes: 20, bodySha256: "a".repeat(64), fields: { collectionRunId: "701" },
  } })];
  return { runId: "proofkit-run", charter, steps, assertions: [] };
}

describe("AIHR desktop acquisition independent oracle", () => {
  it("binds the clicked Run to its only file and independent terminal facts", async () => {
    const observed = await oracle.check(context());
    expect(observed.passed).toBe(true);
    expect(paths).toEqual(["/resume-collection/runs/701", "/resume-collection/files?run_id=701&page=1&page_size=20",
      "/resume-collection/files/801", "/jobs/505/candidates/901", "/assessments/jobs/505/candidates/901",
      "/workflow-executions?run_id=701&page=1&page_size=100"]);
    expect(JSON.parse(observed.evidence[0]!)).toMatchObject({ target: { runId: "701", jobId: "505", expectedFileCount: 1 },
      facts: { files: [{ fileId: "801", assessmentTaskStatus: "success", workflowMatchCount: 1 }] } });
    expect(JSON.stringify(observed)).not.toContain(privateMarker);
  });

  it.each([
    ["run identity", "/resume-collection/runs/701", "run_id", "1", false],
    ["run source", "/resume-collection/runs/701", "source_channel", "liepin", false],
    ["run failure", "/resume-collection/runs/701", "status", "failed", false],
    ["wrong file identity", "/resume-collection/files/801", "file_id", "1", false],
    ["missing file identity", "/resume-collection/files/801", "file_id", null, null],
    ["wrong file Run", "/resume-collection/files/801", "run_id", "1", false],
    ["missing file Run", "/resume-collection/files/801", "run_id", null, null],
    ["wrong job relation", "/jobs/505/candidates/901", "candidate_summary", { current_resume_file_id: "801", job_id: "999", candidate_id: "901" }, false],
    ["pending assessment", "/assessments/jobs/505/candidates/901", "task_status", "retry_wait", null],
    ["no acquired file", "/resume-collection/files", "total", 0, null],
  ])("does not pass %s", async (_, path, key, value, expected) => {
    (responses[path as string] as Record<string, unknown>)[key as string] = value;
    if (path === "/resume-collection/files") (responses[path] as { items: unknown[] }).items = [];
    const observed = await oracle.check(context());
    expect(observed.passed).toBe(expected);
    expect(JSON.stringify(observed)).not.toContain(privateMarker);
  });

  it("cannot borrow a historical Run or accept a forged capture step", async () => {
    const missing = context();
    missing.steps[0]!.response!.fields.collectionRunId = "1";
    const observed = await oracle.check(missing);
    expect(observed.passed).toBe(null);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["/resume-collection/runs/1"]));
    paths = [];
    const forged = context();
    const action = forged.steps[0]!.action;
    if (action.kind !== "captureResponse") throw new Error("Expected a response capture");
    forged.steps[0]!.action = { ...action, requestStartTimeoutMs: 1 };
    expect((await oracle.check(forged)).passed).toBe(null);
    expect(paths).toEqual([]);
    const missingBranch = context();
    delete missingBranch.steps[0]!.response!.followUp;
    expect((await oracle.check(missingBranch)).passed).toBe(null);
    expect(paths).toEqual([]);
  });

  it("rejects an invalid desktop contract during preflight", async () => {
    const input = context();
    input.charter.metadata.aihrDesktop = { ...input.charter.metadata.aihrDesktop as object, expectedFileCount: 0 };
    const checked = await service.integration!.preflight!({ charter: input.charter, environment: "test" } as never);
    expect(checked.passed).toBe(false);
    expect(checked.message).toContain("metadata.aihrDesktop");
    expect(paths).toEqual([]);
  });
});
