import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Real action-window observations and independent ID-scoped facts; no AIHR acceptance claim.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = process.env.PROOFKIT_ELECTRON_PATH;
assert.ok(electronExecutable, "Set PROOFKIT_ELECTRON_PATH before running test:smoke:response");
const root = join(repo, ".proofkit", "response-smoke", String(Date.now()));
const source = join(root, "source");
const workspace = join(root, "workspace");
await mkdir(source, { recursive: true });
await mkdir(join(workspace, ".proofkit", "fixtures"), { recursive: true });
const manifest = JSON.stringify({ name: "response-fixture", devDependencies: { vite: "1", electron: "1" } });
await writeFile(join(source, "package.json"), manifest);
const fixtureRef = ".proofkit/fixtures/resume.pdf";
const bytes = Buffer.from("%PDF-1.4\nsynthetic response-capture resume\n");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const expectedSha = digest(bytes);
await writeFile(join(workspace, fixtureRef), bytes);
const privateMarker = "UNSELECTED_RESPONSE_BODY_f9531";
const ledger = new Map([["1", { file_id: "1", candidate_id: "101", job_id: "7", state: "complete", sha256: expectedSha }]]);
const statusReads = [];
let nextId = 1;
let injectBadBytes = false;
const http = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/v1/intakes/status") {
      const id = url.searchParams.get("fileId"); statusReads.push(id);
      const current = ledger.get(id);
      const observed = current?.mode === "wrong-identity" ? ledger.get("1") : current;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: observed ?? { state: "pending" }, private: privateMarker })); return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/intakes") {
      const mode = url.searchParams.get("mode") ?? "good";
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const form = await new Request(url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData();
      const received = Buffer.from(await form.get("resume").arrayBuffer());
      const id = String(++nextId);
      const facts = { file_id: id, candidate_id: String(100 + nextId), job_id: "7", mode,
        state: mode === "pending" ? "pending" : mode === "rejected" ? "rejected" : "complete",
        sha256: injectBadBytes && mode === "good" ? digest("wrong stored bytes") : digest(received) };
      ledger.set(id, facts);
      const body = Buffer.from(JSON.stringify({ data: { file_id: id, candidate_id: facts.candidate_id, job_id: "7" }, private: privateMarker }));
      const headers = { "content-type": "application/json" };
      if (mode === "gzip") headers["content-encoding"] = "gzip";
      response.writeHead(mode === "rejected" ? 422 : 201, headers);
      if (mode === "stalled-body") { response.write('{"data":'); return; }
      if (mode === "chunked") { response.write(body.subarray(0, 15)); response.end(body.subarray(15)); }
      else response.end(mode === "gzip" ? gzipSync(body) : body);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/case/"))) {
      const mode = url.pathname === "/" ? "good" : url.pathname.slice(6);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>ProofKit response fixture</title><h1>Resume intake</h1>
        <form><input type="file" name="resume" hidden><button id="submit" type="submit">Submit</button></form><p id="result"></p>
        <script>document.querySelector('form').onsubmit=async(event)=>{
          event.preventDefault(); const form=event.target;
          if(${JSON.stringify(mode)}==='no-match'||${JSON.stringify(mode)}==='delayed-missing'){document.querySelector('#result').textContent='Accepted';return;}
          const send=()=>fetch('/api/v1/intakes?mode='+${JSON.stringify(mode)},{method:'POST',body:new FormData(form)});
          if(${JSON.stringify(mode)}==='delayed')await new Promise(resolve=>setTimeout(resolve,250));
          const responses=await Promise.all(${JSON.stringify(mode)}==='duplicate'?[send(),send()]:[send()]);
          await Promise.all(responses.map(response=>response.json()));
          document.querySelector('#result').textContent=${JSON.stringify(mode)}==='rejected'?'Rejected':'Accepted';
        };</script>`); return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
let electron, profile, server, client;
const results = [];
try {
  profile = await mkdtemp(join(tmpdir(), "proofkit-response-electron-"));
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
  const stateOracle = (name, successValues) => ({ name, url: `${baseUrl}/api/v1/intakes/status`,
    query: { fileId: { source: "response", stepId: "step-003", field: "fileId", matchPointer: "/data/file_id" } },
    statusPointer: "/data/state", successValues, failureValues: ["failed"], intervalMs: 40, deadlineMs: 350 });
  const config = ProofkitConfigSchema.parse({ project: { root: source }, surfaces: {
    web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) },
    electron: { devtoolsActivePort: portFile } },
    policies: { environment: "test", sideEffects: "allow", runtime: { mode: "record" } }, run: { timeoutMs: 12_000 },
    oracles: [stateOracle("intake-state", ["complete"]), stateOracle("intake-rejected", ["rejected"])] });
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
  await writeFile(join(workspace, ".proofkit", "integration.mjs"), `export default {name:'resume-response-fixture',oracles:[{
    name:'resume-business',async check(context){
      const capture=context.steps.find(step=>step.action.kind==='captureResponse').response;
      const {fileId,candidateId,jobId}=capture.fields;
      const response=await fetch(${JSON.stringify(baseUrl + "/api/v1/intakes/status")}+'?fileId='+encodeURIComponent(fileId),{signal:context.signal});
      const data=(await response.json()).data;
      const selected=context.steps.find(step=>step.inputFiles)?.inputFiles[0];
      const identity=data.file_id===fileId&&data.candidate_id===candidateId&&data.job_id===jobId;
      const bytes=data.sha256===selected?.sha256;
      const passed=response.status===200&&identity&&bytes;
      return {name:'resume-business',passed,message:passed?'Current intake identities and bytes match':'Current intake identities or stored bytes differ',
        evidence:[JSON.stringify({expected:{fileId,candidateId,jobId,sha256:selected?.sha256},observed:{fileId:data.file_id,candidateId:data.candidate_id,jobId:data.job_id,sha256:data.sha256},identity,bytes})],observedAt:new Date().toISOString()};
    }}]};`);
  server = await createProofkitMcp({ root: source, workspaceRoot: workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "response-smoke", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  for (const surface of ["web", "electron"]) {
    const accepted = await run(charter("good"), surface);
    assert.equal(accepted.status.mission.verdict, "passed", JSON.stringify(accepted.status.mission.findings));
    const originalId = await capturedId(accepted);
    const replayed = await replay(accepted.started.missionId);
    assert.equal(replayed.status.mission.verdict, "passed", JSON.stringify(replayed.status.mission.findings));
    assert.notEqual(await capturedId(replayed), originalId, "Replay must bind the newly created object");
    await verifyEvidence(accepted); await verifyEvidence(replayed);
    injectBadBytes = true;
    const defective = await run(charter("good"), surface);
    assert.equal(defective.status.mission.verdict, "failed");
    assert.ok(defective.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed" && item.evidence.some((ref) => ref.kind === "business")));
    injectBadBytes = false;
    const fixed = await replay(defective.started.missionId);
    assert.equal(fixed.status.mission.verdict, "passed");
    assert.equal(fixed.evidence.comparison.status, "verified-in-scope", JSON.stringify(fixed.evidence.comparison.gaps));
    assert.notEqual(await capturedId(fixed), await capturedId(defective));
    await verifyEvidence(defective); await verifyEvidence(fixed);
  }
  const release = await run(charter("good", "release"), "web");
  assert.equal(release.status.mission.verdict, "passed", JSON.stringify(release.status.mission.findings));
  assert.equal(release.evidence.summary.expectedRuns, 6);
  assert.equal(new Set(await Promise.all(release.evidence.summary.runs.map(async (item) => (await savedRun(item.runId)).steps[2].response.fields.fileId))).size, 6);
  await verifyEvidence(release);
  for (const surface of ["web", "electron"]) {
    for (const mode of ["chunked", "gzip", "delayed"]) {
      const result = await run(charter(mode), surface);
      assert.equal(result.status.mission.verdict, "passed", JSON.stringify(result.status.mission.findings));
      if (mode === "delayed") {
        const capture = (await savedRun(result.evidence.summary.runs[0].runId)).steps[2].response;
        assert.ok(Date.parse(capture.requestStartedAt) - Date.parse(capture.windowStartedAt) >= 100);
      }
      await verifyEvidence(result);
    }
    for (const mode of ["pending", "duplicate", "no-match", "delayed-missing", "stalled-body", "wrong-identity"]) {
      const result = await run(charter(mode), surface);
      assert.equal(result.status.mission.verdict, mode === "wrong-identity" ? "failed" : "inconclusive", JSON.stringify(result.status.mission.findings));
      if (mode !== "wrong-identity") assert.ok(!result.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed"));
      if (["duplicate", "no-match", "delayed-missing", "stalled-body"].includes(mode)) {
        assert.ok(result.status.mission.findings.some((item) => item.category === "test" && item.status === "unverified"));
        const saved = await savedRun(result.evidence.summary.runs[0].runId);
        assert.equal(saved.steps[2].response, undefined);
        assert.ok(saved.steps[2].artifacts.some((path) => path.endsWith("response-gap.json")));
      }
      await verifyEvidence(result);
    }
  }
  assert.ok(statusReads.length > 0 && !statusReads.includes("1"), "Never query a historical object as the current intake");
  assert.deepEqual(await readdir(source), ["package.json"]);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), manifest);
  console.log(JSON.stringify({ workspace, report: release.evidence.report, missions: results,
    verified: ["web-electron-response-id", "fresh-replay-ids", "six-release-run-identities", "config-only-id-status-check",
      "independent-byte-and-relation-check", "historical-success-rejected", "pending-inconclusive", "duplicate-no-match-stalled-gaps",
      "chunked-gzip-json", "delayed-request-and-timeout", "business-defect-repair-replay", "unselected-bodies-not-persisted", "no-source-writes"] }, null, 2));
} finally {
  await client?.close(); await server?.close();
  if (electron && electron.exitCode === null) {
    const exited = new Promise((resolve) => electron.once("exit", resolve)); electron.kill(); await exited;
  }
  http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  if (profile) {
    assert.equal(dirname(profile), resolve(tmpdir()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function charter(mode, level = "core") {
  const actions = (mode) => [{ kind: "goto", url: `${baseUrl}/case/${mode}` },
    { kind: "setInputFiles", selector: 'input[type="file"]', files: [fixtureRef] },
    { kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" }, requestWindowMs: 100,
      ...(mode === "delayed" || mode === "delayed-missing" ? { requestStartTimeoutMs: mode === "delayed" ? 800 : 80 } : {}), timeoutMs: 2_000,
      response: { url: `${baseUrl}/api/v1/intakes`, method: "POST", statuses: [mode === "rejected" ? 422 : 201], fields: {
        fileId: { pointer: "/data/file_id", type: "id" }, candidateId: { pointer: "/data/candidate_id", type: "id" }, jobId: { pointer: "/data/job_id", type: "id" } } } },
    { kind: "waitForText", text: mode === "rejected" ? "Rejected" : "Accepted" }];
  return TestCharterSchema.parse({ intent: "Verify current resume intake and terminal facts", level, sideEffectPolicy: "allow", actions: actions(mode),
    assertions: [{ kind: "text-visible", text: "Accepted" }], oracles: ["intake-state", "resume-business"],
    ...(level === "release" ? { negativeCases: [{ caseId: "rejected", title: "Reject unsupported intake", sideEffectPolicy: "allow",
      actions: actions("rejected"), assertions: [{ kind: "text-visible", text: "Rejected" }], oracles: ["intake-rejected", "resume-business"] }] } : {}) });
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function run(plan, surface) {
  const started = await call("run_test", { intent: "验证本次简历获取场景", charter: plan, surface });
  assert.equal(started.readiness.ready, true, JSON.stringify(started.readiness));
  return collect(started, started.missionId);
}
async function replay(missionId) {
  const started = await call("replay_mission", { missionId }); return collect(started, started.mission.missionId);
}
async function collect(started, missionId) {
  const deadline = Date.now() + 60_000; let status;
  while (Date.now() < deadline) {
    status = await call("get_mission_status", { missionId });
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(["completed", "failed", "blocked", "cancelled"].includes(status?.mission.status), "Mission did not settle");
  const evidence = await call("get_mission_evidence", { missionId });
  results.push({ missionId, verdict: status.mission.verdict, report: evidence.report });
  return { started, status, evidence };
}
async function savedRun(runId) { return JSON.parse(await readFile(join(workspace, ".proofkit", "runs", runId, "run.json"), "utf8")); }
async function capturedId(result) { return (await savedRun(result.evidence.summary.runs[0].runId)).steps[2].response.fields.fileId; }
async function verifyEvidence(result) {
  for (const item of result.evidence.summary.runs) {
    const run = await savedRun(item.runId);
    for (const artifact of run.artifacts.filter((path) => path.endsWith(".json"))) {
      assert.ok(!(await readFile(join(workspace, ".proofkit", "runs", artifact), "utf8")).includes(privateMarker));
    }
    assert.ok(!JSON.stringify(run).includes(privateMarker));
    assert.ok(!(await readFile(join(workspace, ".proofkit", "runs", run.runId, "events.jsonl"), "utf8")).includes(privateMarker));
    const capture = run.steps[2];
    if (capture.response) {
      assert.ok(capture.artifacts.some((path) => path.endsWith("response.json")));
      assert.deepEqual(Object.keys(capture.response.fields).sort(), ["candidateId", "fileId", "jobId"]);
      assert.equal(capture.response.association, "action-window");
      assert.equal(capture.response.requestCount, 1);
      assert.equal(run.steps[1].inputFiles[0].sha256, expectedSha);
      for (const oracle of run.oracles) {
        assert.ok(oracle.sourceEvidenceArtifacts.length > 0);
        for (const artifact of oracle.sourceEvidenceArtifacts) await readFile(join(workspace, ".proofkit", "runs", artifact));
      }
    }
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP endpoint did not appear");
}
