import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// The actual workspace connector, real browsers and AIHR-shaped gateway readers.
// This fixture does not execute live AIHR services or establish their business correctness.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = process.env.PROOFKIT_ELECTRON_PATH;
assert.ok(electronExecutable, "Set PROOFKIT_ELECTRON_PATH before running test:smoke:manual-intake");
const root = join(repo, ".proofkit", "manual-intake-smoke", String(Date.now()));
const source = join(root, "source");
const workspace = join(root, "workspace");
await mkdir(source, { recursive: true });
await mkdir(join(workspace, ".proofkit", "fixtures"), { recursive: true });
const manifest = JSON.stringify({ name: "manual-intake-fixture", devDependencies: { vite: "1", electron: "1" } });
await writeFile(join(source, "package.json"), manifest);
const fixtureRef = ".proofkit/fixtures/resume.pdf";
const bytes = Buffer.from("%PDF-1.4\nsynthetic manual-intake resume\n");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const expectedSha = digest(bytes);
await writeFile(join(workspace, fixtureRef), bytes);
for (const file of ["integration.mjs", "aihr-manual-intake.mjs", "aihr-desktop-acquisition.mjs"]) {
  await copyFile(join(repo, ".proofkit", file), join(workspace, ".proofkit", file));
}
const privateMarker = "UNSELECTED_MANUAL_CONTACT_TEXT_6a47";
const oracleName = "aihr.manualCandidateIntake";
const jobId = "505";
let nextId = 1000;
let corruption;
const ledger = new Map([["1", { fileId: "1", candidateId: "2", versionId: "3", relationId: "4",
  assessmentId: "5", mode: "good", sha256: expectedSha, rounds: 0 }]]);
const reads = [];
const submissions = [];
function envelope(response, data, code = "SUCCESS", httpStatus = 200) {
  response.writeHead(httpStatus, { "content-type": "application/json" });
  response.end(JSON.stringify({ code, message: code === "SUCCESS" ? "OK" : "Unavailable", data, private: privateMarker }));
}
const http = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/v1/resume-collection/candidate-intakes") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const form = await new Request(url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData();
      assert.equal(form.get("target_job_id"), jobId);
      assert.equal(form.get("name"), "Synthetic Candidate");
      const received = Buffer.from(await form.get("file").arrayBuffer());
      assert.equal(digest(received), expectedSha);
      const id = String(++nextId);
      const facts = { fileId: id, candidateId: String(nextId + 10000), versionId: String(nextId + 20000),
        relationId: String(nextId + 30000), assessmentId: String(nextId + 40000),
        sha256: corruption === "digest" ? digest("corrupted stored file") : digest(received),
        mode: url.searchParams.get("mode") ?? "good", corruption, rounds: 0 };
      ledger.set(id, facts); submissions.push(id);
      envelope(response, { resume_file_id: facts.fileId, candidate_id: facts.candidateId, resume_version_id: facts.versionId,
        job_id: jobId, job_candidate_id: facts.relationId, duplicate_file: false, relationship_created: true,
        stage: "screening", warnings: [], name: privateMarker }, "SUCCESS", 201);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/v1/")) {
      assert.equal(request.headers["x-enterprise-id"], "1");
      assert.equal(request.headers["x-workspace-id"], "2");
      assert.equal(request.headers["x-user-id"], "3");
      const fileMatch = /^\/api\/v1\/resume-collection\/files\/(\d+)$/.exec(url.pathname);
      const candidateMatch = /^\/api\/v1\/candidates\/(\d+)(\/resume-versions)?$/.exec(url.pathname);
      const relationMatch = /^\/api\/v1\/(assessments\/)?jobs\/505\/candidates\/(\d+)$/.exec(url.pathname);
      const record = fileMatch ? ledger.get(fileMatch[1]) : [...ledger.values()].find((item) => item.candidateId === (candidateMatch?.[1] ?? relationMatch?.[2]));
      if (!record) { envelope(response, {}, "NOT_FOUND", 404); return; }
      reads.push({ fileId: record.fileId, path: url.pathname });
      if (fileMatch) record.rounds++;
      if (record.mode === "gateway-unavailable") { envelope(response, {}, "SERVICE_UNAVAILABLE", 503); return; }
      const pending = record.mode === "pending" || (record.mode === "eventual" && record.rounds === 1);
      const retry = record.mode === "retry" || (record.mode === "eventual" && record.rounds === 2);
      let data;
      if (fileMatch) data = { file_id: record.fileId, file_sha256: record.sha256, source_platform: { source_channel: "manual_upload" },
        candidate_id: record.candidateId, extract_status: "done", parse_status: pending ? "processing" : "matched", extracted_text: privateMarker };
      else if (candidateMatch?.[2]) data = { items: [{ resume_version_id: record.versionId,
        resume_file_id: record.mode === "version-rebound" ? "999" : record.fileId,
        resume_file_sha256: record.corruption === "version" ? digest("corrupted version digest") : expectedSha,
        is_current: true, source_channel: "boss", original_filename: privateMarker }] };
      else if (candidateMatch) data = { candidate_id: record.candidateId, name: privateMarker, phone: privateMarker,
        profile: { current_resume_version_id: record.mode === "superseded" ? "999" : record.versionId } };
      else if (relationMatch?.[1]) data = { assessment_id: record.assessmentId, job_id: jobId, candidate_id: record.candidateId,
        current_resume_file_id: pending || record.mode === "superseded" ? "1" : record.fileId,
        job_candidate_relation_id: record.relationId, status: "success", task_status: retry ? "retry_wait" : "success", summary: privateMarker };
      else if (relationMatch) data = { candidate_summary: { job_candidate_id: record.relationId, job_id: jobId,
        candidate_id: record.candidateId, current_resume_file_id: record.corruption === "relation" || record.mode === "superseded" ? "1" : record.fileId,
        current_resume_version_id: record.versionId, stage: "screening", candidate_name: privateMarker } };
      else { envelope(response, {}, "NOT_FOUND", 404); return; }
      envelope(response, data); return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/case/"))) {
      const mode = url.pathname === "/" ? "good" : url.pathname.slice(6);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Manual candidate intake fixture</title><h1>Manual candidate intake</h1>
        <form><input type="file" name="file" hidden><input name="target_job_id" value="${jobId}" type="hidden">
        <input name="name" value="Synthetic Candidate"><button id="submit" type="submit">Submit candidate</button></form><p id="result"></p>
        <script>document.querySelector('form').onsubmit=async(event)=>{event.preventDefault();
          const response=await fetch('/api/v1/resume-collection/candidate-intakes?mode='+${JSON.stringify(mode)},{method:'POST',body:new FormData(event.target)});
          await response.json();document.querySelector('#result').textContent=response.ok?'Candidate added':'Submission failed';};</script>`);
      return;
    }
    response.writeHead(404).end();
  } catch (error) { envelope(response, {}, "FIXTURE_ERROR", 500); console.error(error); }
});
await new Promise((done) => http.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
const env = { AIHR_PROOFKIT_API_BASE_URL: `${baseUrl}/api/v1`, AIHR_PROOFKIT_TEST_SCOPE: "proofkit:manual-smoke",
  AIHR_PROOFKIT_ENTERPRISE_ID: "1", AIHR_PROOFKIT_WORKSPACE_ID: "2", AIHR_PROOFKIT_USER_ID: "3",
  AIHR_PROOFKIT_JOB_ID: jobId, AIHR_PROOFKIT_ACCESS_TOKEN: "fixture-token", AIHR_PROOFKIT_CLIENT_ITEM_KEY: undefined };
const previousEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
let electron, profile, server, client;
const results = [];
try {
  profile = await mkdtemp(join(tmpdir(), "proofkit-manual-electron-"));
  const app = join(profile, "app.cjs");
  await writeFile(app, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('remote-debugging-port','0');
    app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{
      const window=new BrowserWindow({show:false,width:1100,height:780,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
      window.loadURL(${JSON.stringify(baseUrl + "/case/good")});});app.on('window-all-closed',()=>app.quit());`);
  electron = spawn(electronExecutable, [app], { stdio: "ignore", windowsHide: true });
  let spawnError; electron.on("error", (error) => { spawnError = error; });
  const portFile = join(profile, "DevToolsActivePort");
  await waitForDevtools(portFile, () => spawnError ?? (electron.exitCode === null ? undefined : new Error("Electron exited before CDP")));
  const config = ProofkitConfigSchema.parse({ project: { root: source }, surfaces: {
    web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) },
    electron: { devtoolsActivePort: portFile } },
    policies: { environment: "test", sideEffects: "allow", runtime: { mode: "record" } }, run: { timeoutMs: 12_000 } });
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
  server = await createProofkitMcp({ root: source, workspaceRoot: workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "aihr-manual-smoke", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  for (const surface of ["web", "electron"]) {
    const accepted = await run(charter("good"), surface);
    assert.equal(accepted.status.mission.verdict, "passed", JSON.stringify(accepted.status.mission.findings));
    const replayed = await replay(accepted.started.missionId);
    assert.equal(replayed.status.mission.verdict, "passed");
    assert.notEqual(await capturedId(replayed), await capturedId(accepted));
    const eventual = await run(charter("eventual"), surface);
    assert.equal(eventual.status.mission.verdict, "passed", JSON.stringify(eventual.status.mission.findings));
    const eventualFacts = await businessFacts(await savedRun(eventual.evidence.summary.runs[0].runId));
    assert.ok(eventualFacts.observationCount >= 3, "Old success and retry_wait must not supply a pass");
    for (const defect of ["digest", "version", "relation"]) {
      corruption = defect;
      const defective = await run(charter("good"), surface);
      assert.equal(defective.status.mission.verdict, "failed", `${surface} ${defect}`);
      assert.ok(defective.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed"
        && item.evidence.some((ref) => ref.kind === "business")));
      corruption = undefined;
      const repaired = await replay(defective.started.missionId);
      assert.equal(repaired.status.mission.verdict, "passed");
      assert.equal(repaired.evidence.comparison.status, "verified-in-scope", JSON.stringify(repaired.evidence.comparison.gaps));
      assert.notEqual(await capturedId(repaired), await capturedId(defective));
    }
    for (const mode of ["pending", "retry", "superseded", "version-rebound", "gateway-unavailable"]) {
      const incomplete = await run(charter(mode), surface);
      assert.equal(incomplete.status.mission.verdict, "inconclusive", JSON.stringify(incomplete.status.mission.findings));
      assert.ok(!incomplete.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed"));
    }
  }
  assert.equal(new Set(submissions).size, submissions.length);
  assert.ok(reads.length > 0 && !reads.some((item) => item.fileId === "1"), "A historical success cannot supply this submission's facts");
  for (const result of results) await verifyEvidence(result);
  assert.deepEqual(await readdir(source), ["package.json"]);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), manifest);
  const summary = { workspace, sourceUnchanged: true, missions: results.map((result) => ({ missionId: result.started.missionId ?? result.started.mission.missionId,
    verdict: result.status.mission.verdict, report: result.evidence.report, comparison: result.evidence.comparison?.status })),
    verified: ["actual-external-workspace-connector", "web-electron-multipart", "five-captured-identities", "fresh-replay-identities",
      "independent-byte-version-relation-terminal-checks", "historical-success-not-used", "old-assessment-and-retry-not-accepted",
      "seeded-defects-and-repair-replay", "superseded-and-gateway-gaps-inconclusive", "same-sha-version-rebinding-inconclusive",
      "unselected-body-not-persisted", "no-source-writes"] };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client?.close(); await server?.close();
  if (electron && electron.exitCode === null) {
    const exited = new Promise((done) => electron.once("exit", done)); electron.kill(); await exited;
  }
  http.closeAllConnections(); await new Promise((done) => http.close(done));
  for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (profile) {
    assert.equal(dirname(profile), resolve(tmpdir()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function charter(mode) {
  return TestCharterSchema.parse({ intent: "Verify manual candidate intake through independent terminal readers", level: "core",
    sideEffectPolicy: "allow", actions: [
      { kind: "goto", url: `${baseUrl}/case/${mode}` },
      { kind: "setInputFiles", selector: 'input[type="file"]', files: [fixtureRef] },
      { kind: "captureResponse", name: "manual", trigger: { kind: "click", selector: "#submit" }, requestWindowMs: 100, timeoutMs: 2000,
        response: { url: `${baseUrl}/api/v1/resume-collection/candidate-intakes`, method: "POST", statuses: [201],
          fields: Object.fromEntries(Object.entries({ fileId: "resume_file_id", candidateId: "candidate_id", versionId: "resume_version_id",
            jobId: "job_id", relationId: "job_candidate_id" }).map(([key, field]) => [key, { pointer: `/data/${field}`, type: "id" }])) } },
      { kind: "waitForText", text: "Candidate added" } ], assertions: [{ kind: "text-visible", text: "Candidate added" }],
    oracles: [oracleName], metadata: { aihrManual: { captureStepId: "step-003", fileStepId: "step-002", jobId: "$env:AIHR_PROOFKIT_JOB_ID",
      maxWaitMs: mode === "eventual" ? 2500 : 500, pollIntervalMs: 30 } } });
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function run(plan, surface) {
  const started = await call("run_test", { intent: "验收手动录入候选人的核心链路", charter: plan, surface });
  assert.equal(started.readiness.ready, true, JSON.stringify(started.readiness));
  return collect(started, started.missionId);
}
async function replay(missionId) {
  const started = await call("replay_mission", { missionId, approve: true }); return collect(started, started.mission.missionId);
}
async function collect(started, missionId) {
  const deadline = Date.now() + 60_000; let status;
  while (Date.now() < deadline) {
    status = await call("get_mission_status", { missionId });
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(["completed", "failed", "blocked", "cancelled"].includes(status?.mission.status), "Mission did not settle");
  const evidence = await call("get_mission_evidence", { missionId });
  const result = { started, status, evidence }; results.push(result); return result;
}
async function savedRun(runId) { return JSON.parse(await readFile(join(workspace, ".proofkit", "runs", runId, "run.json"), "utf8")); }
async function capturedId(result) { return (await savedRun(result.evidence.summary.runs[0].runId)).steps[2].response.fields.fileId; }
async function businessFacts(run) {
  const oracle = run.oracles.find((item) => item.name === oracleName);
  assert.ok(oracle.sourceEvidenceArtifacts.length > 0, "Independent facts need source evidence");
  const artifact = JSON.parse(await readFile(join(workspace, ".proofkit", "runs", oracle.sourceEvidenceArtifacts[0]), "utf8"));
  return artifact.facts[0];
}
async function verifyEvidence(result) {
  assert.ok((await readFile(result.evidence.report, "utf8")).includes("ProofKit"));
  for (const item of result.evidence.summary.runs) {
    const run = await savedRun(item.runId);
    assert.ok(!JSON.stringify(run).includes(privateMarker));
    for (const path of run.artifacts.filter((path) => path.endsWith(".json"))) {
      assert.ok(!(await readFile(join(workspace, ".proofkit", "runs", path), "utf8")).includes(privateMarker));
    }
    assert.ok(!(await readFile(join(workspace, ".proofkit", "runs", run.runId, "events.jsonl"), "utf8")).includes(privateMarker));
    const capture = run.steps[2].response;
    assert.equal(capture.requestCount, 1); assert.equal(capture.association, "action-window");
    assert.deepEqual(Object.keys(capture.fields).sort(), ["candidateId", "fileId", "jobId", "relationId", "versionId"]);
    assert.equal(run.steps[1].inputFiles[0].sha256, expectedSha);
    const preflightPath = run.artifacts.find((path) => path.endsWith("preflight.json"));
    assert.ok(preflightPath);
    const facts = await businessFacts(run);
    assert.equal(facts.target.fileId, capture.fields.fileId);
    assert.equal(facts.target.fixtureSha256, expectedSha);
  }
}
async function waitForDevtools(path, error) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (error()) throw error();
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* Wait for this isolated Electron instance. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Electron CDP endpoint did not become ready");
}
