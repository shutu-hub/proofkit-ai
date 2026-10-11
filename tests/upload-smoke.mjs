import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Real hidden HTML file inputs, browser multipart requests and independently read server facts.
// The fixture verifies upload transport and evidence, not AIHR parsing or platform acquisition.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = process.env.PROOFKIT_ELECTRON_PATH;
assert.ok(electronExecutable, "Set PROOFKIT_ELECTRON_PATH to a local Electron executable before running test:smoke:upload");
const root = join(repo, ".proofkit", "upload-smoke", String(Date.now()));
const source = join(root, "source");
const workspace = join(root, "workspace");
const fixtureRoot = join(workspace, ".proofkit", "fixtures");
await mkdir(source, { recursive: true });
await mkdir(fixtureRoot, { recursive: true });
const manifest = JSON.stringify({ name: "upload-fixture", devDependencies: { vite: "1", electron: "1" } });
await writeFile(join(source, "package.json"), manifest);
const privateMarker = "PRIVATE_UPLOAD_BYTES_7e53c6";
const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n${privateMarker}\n`), Buffer.from([0, 255, 128, 10])]);
const secondPdf = Buffer.from("%PDF-1.4\nsecond synthetic fixture\n");
const invalid = Buffer.from("synthetic invalid resume input\n");
const ref = ".proofkit/fixtures/简历.pdf";
const secondRef = ".proofkit/fixtures/second.pdf";
const invalidRef = ".proofkit/fixtures/invalid.txt";
await writeFile(join(workspace, ref), pdf);
await writeFile(join(workspace, secondRef), secondPdf);
await writeFile(join(workspace, invalidRef), invalid);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = {
  single: [{ name: "简历.pdf", sizeBytes: pdf.length, sha256: digest(pdf), mimeType: "application/pdf" }],
  multi: [{ name: "简历.pdf", sizeBytes: pdf.length, sha256: digest(pdf), mimeType: "application/pdf" },
    { name: "second.pdf", sizeBytes: secondPdf.length, sha256: digest(secondPdf), mimeType: "application/pdf" }],
  invalid: [{ name: "invalid.txt", sizeBytes: invalid.length, sha256: digest(invalid), mimeType: "text/plain" }],
};
const ledger = {};
let requestCount = 0;
let corruptSavedContent = false;
const http = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const caseId = url.searchParams.get("case") ?? "single";
    if (request.method === "GET" && url.pathname === "/api/v1/uploads/facts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ledger[caseId] ?? { state: "pending", files: [] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/uploads") {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Fixture request exceeds its bound");
        chunks.push(chunk);
      }
      const form = await new Request(url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData();
      const received = [];
      for (const file of form.getAll("resume")) {
        assert.equal(typeof file.arrayBuffer, "function");
        const bytes = Buffer.from(await file.arrayBuffer());
        const stored = corruptSavedContent && caseId !== "invalid" ? Buffer.from("wrong stored resume") : bytes;
        received.push({ name: file.name, sizeBytes: stored.length, sha256: digest(stored), mimeType: file.type });
      }
      requestCount++;
      ledger[caseId] = { requestId: requestCount, state: caseId === "invalid" ? "rejected" : "accepted", files: received };
      response.writeHead(caseId === "invalid" ? 422 : 201, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: ledger[caseId].state }));
      return;
    }
    const mode = url.pathname.slice(1) || "single";
    if (request.method === "GET" && ["single", "multi", "invalid", "ambiguous", "text"].includes(mode)) {
      const uploadCase = mode === "multi" || mode === "invalid" ? mode : "single";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>ProofKit upload fixture</title><h1>Resume upload</h1>
        <form action="/api/v1/uploads?case=${uploadCase}">
          <input type="file" name="resume" aria-label="Resume" style="display:none" ${mode === "multi" ? "multiple" : ""}>
          ${mode === "ambiguous" ? '<input type="file" name="other" hidden>' : ''}
          <input id="name" aria-label="Name"><button type="submit">Upload</button>
        </form><p id="result"></p>
        <script>document.querySelector('form').onsubmit=async(event)=>{
          event.preventDefault();const form=event.target;const response=await fetch(form.action,{method:'POST',body:new FormData(form)});
          const result=await response.json();document.querySelector('#result').textContent=result.state==='accepted'?'Uploaded':'File rejected';
        };</script>`);
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((done) => http.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
let electron, profile, server, client;
const results = [];
try {
  profile = await mkdtemp(join(tmpdir(), "proofkit-upload-electron-"));
  const app = join(profile, "app.cjs");
  await writeFile(app, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('remote-debugging-port','0');
    let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(baseUrl)});});
    app.on('window-all-closed',()=>app.quit());`);
  electron = spawn(electronExecutable, [app], { stdio: "ignore", windowsHide: true });
  let spawnError;
  electron.on("error", (error) => { spawnError = error; });
  const portFile = join(profile, "DevToolsActivePort");
  await waitForDevtools(portFile, () => spawnError ?? (electron.exitCode === null ? undefined : new Error("Electron exited before CDP")));
  const config = ProofkitConfigSchema.parse({ project: { root: source },
    surfaces: { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) },
      electron: { devtoolsActivePort: portFile } },
    policies: { environment: "test", sideEffects: "allow", runtime: { mode: "record", failedResponses: { include4xx: true } } }, run: { timeoutMs: 15_000 },
  });
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
  await writeFile(join(workspace, ".proofkit", "integration.mjs"), `
    const expected=${JSON.stringify(expected)};
    export default {name:'upload-smoke-business',oracles:[{name:'upload-bytes',async check(context){
      const caseId=context.charter.metadata.negativeCaseId==='invalid'?'invalid':context.charter.metadata.inputCase??'single';
      const response=await fetch(${JSON.stringify(baseUrl)}+'/api/v1/uploads/facts?case='+caseId,{signal:context.signal});
      const facts=await response.json();
      const passed=response.status===200&&facts.state===(caseId==='invalid'?'rejected':'accepted')
        &&JSON.stringify(facts.files)===JSON.stringify(expected[caseId]);
      return {name:'upload-bytes',passed,message:passed?'Server stored the expected input bytes':'Server input bytes differ',
        evidence:[JSON.stringify({status:response.status,...facts})],observedAt:new Date().toISOString()};
    }}]};`);
  server = await createProofkitMcp({ root: source, workspaceRoot: workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "upload-smoke", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  for (const surface of ["web", "electron"]) {
    const inspection = await call("inspect_surface", { surface });
    assert.equal(inspection.status, "observed");
    const input = inspection.snapshot.controls.find((item) => item.inputType === "file");
    assert.equal(input.visible, false);
    assert.equal(input.role, "file-input");
    assert.equal(input.selector, 'input[type="file"]');
    const multi = await run(charter("multi", "core"), surface);
    assert.equal(multi.status.mission.verdict, "passed", JSON.stringify(multi.status.mission.findings));
    assert.deepEqual(ledger.multi.files, expected.multi);
  }
  const release = await run(charter("single", "release", true), "web");
  assert.equal(release.status.mission.verdict, "passed", JSON.stringify(release.status.mission.findings));
  assert.equal(release.evidence.summary.expectedRuns, 6);
  assert.equal(release.evidence.summary.observedRuns, 6);
  await verifyFacts(release);

  // A changed negative fixture must fail replay even if its new bytes would still be rejected.
  await writeFile(join(workspace, invalidRef), "different invalid input");
  const changedNegative = await replay(release.started.missionId);
  assert.equal(changedNegative.status.mission.verdict, "blocked");
  assert.ok(changedNegative.status.mission.observations.some((item) => item.data.runKind === "negative" && item.data.outcomeMatched === false));
  await writeFile(join(workspace, invalidRef), invalid);

  corruptSavedContent = true;
  for (const surface of ["web", "electron"]) {
    const bad = await run(charter("single", "core"), surface);
    assert.equal(bad.status.mission.verdict, "failed");
    assert.equal(bad.status.mission.firstFailure.kind, "business-oracle");
    assert.ok(bad.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed" && item.evidence.some((ref) => ref.kind === "business")));
    corruptSavedContent = false;
    const fixed = await replay(bad.started.missionId);
    assert.equal(fixed.status.mission.verdict, "passed", JSON.stringify(fixed.status.mission.findings));
    assert.equal(fixed.evidence.comparison.status, "verified-in-scope", JSON.stringify(fixed.evidence.comparison.gaps));
    await verifyFacts(bad); await verifyFacts(fixed);
    await writeFile(join(workspace, ref), "different resume bytes");
    const beforeReplay = requestCount;
    const changed = await replay(bad.started.missionId);
    assert.equal(changed.status.mission.verdict, "blocked");
    assert.equal(changed.evidence.comparison.status, "inconclusive");
    assert.equal(requestCount, beforeReplay, "Changed replay must stop before HTTP upload");
    await writeFile(join(workspace, ref), pdf);
    corruptSavedContent = true;
  }
  corruptSavedContent = false;
  for (const [mode, selector, error] of [["ambiguous", 'input[type="file"]', "matched 2 elements"], ["text", "#name", "input[type=file]"]]) {
    for (const surface of ["web", "electron"]) {
      const before = requestCount;
      const plan = charter(mode, "quick"); plan.actions[1].selector = selector;
      const result = await run(plan, surface);
      assert.equal(result.status.mission.verdict, "failed");
      const runResult = await savedRun(result.evidence.summary.runs[0].runId);
      assert.ok(runResult.steps[1].error.toLowerCase().includes(error));
      assert.ok(!result.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed"));
      assert.equal(requestCount, before);
    }
  }
  const missingPlan = charter("single", "quick"); missingPlan.actions[1].files = [".proofkit/fixtures/missing.pdf"];
  const beforeMissing = requestCount;
  assert.equal((await run(missingPlan, "web")).status.mission.verdict, "blocked");
  assert.equal(requestCount, beforeMissing);
  assert.deepEqual(await readdir(source), ["package.json"]);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), manifest);
  console.log(JSON.stringify({ workspace, report: release.evidence.report, missions: results,
    verified: ["hidden-input-discovery-web-electron", "multipart-real-byte-digests", "multiple-file-order", "release-primary-replay-negative", "server-corruption-detected",
      "evidence-backed-repair-comparison", "changed-primary-and-negative-inputs-blocked", "ambiguous-and-non-file-selectors", "missing-fixture", "no-source-writes", "no-persisted-input-body"] }, null, 2));
} finally {
  await client?.close(); await server?.close();
  if (electron && electron.exitCode === null) {
    const exited = new Promise((done) => electron.once("exit", done)); electron.kill(); await exited;
  }
  await new Promise((done) => http.close(done));
  if (profile) {
    assert.equal(dirname(profile), resolve(tmpdir()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function charter(mode, level, negative = false) {
  return TestCharterSchema.parse({ intent: "Verify resume file upload", level, sideEffectPolicy: "allow",
    actions: [{ kind: "goto", url: `${baseUrl}/${mode}` }, { kind: "setInputFiles", selector: 'input[type="file"]', files: mode === "multi" ? [ref, secondRef] : [ref] },
      { kind: "click", selector: "button[type=submit]" }, { kind: "waitForText", text: "Uploaded" }],
    assertions: [{ kind: "text-visible", text: "Uploaded" }], oracles: level === "quick" ? [] : ["upload-bytes"], metadata: { inputCase: mode },
    ...(negative ? { negativeCases: [{ caseId: "invalid", title: "Reject unsupported resume", sideEffectPolicy: "allow",
      actions: [{ kind: "goto", url: `${baseUrl}/invalid` }, { kind: "setInputFiles", selector: 'input[type="file"]', files: [invalidRef] },
        { kind: "click", selector: "button[type=submit]" }, { kind: "waitForText", text: "File rejected" }],
      assertions: [{ kind: "text-visible", text: "File rejected" }], oracles: ["upload-bytes"] }] } : {}),
  });
}

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.content.find((item) => item.type === "text").text);
}
async function run(plan, surface) {
  const started = await call("run_test", { intent: "验证简历上传声明场景", charter: plan, surface });
  assert.equal(started.readiness.ready, true, JSON.stringify(started.readiness));
  return collect(started, started.missionId);
}
async function replay(missionId) {
  const started = await call("replay_mission", { missionId, approve: true });
  return collect(started, started.mission.missionId);
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
  results.push({ missionId, verdict: status.mission.verdict, report: evidence.report });
  return { started, status, evidence };
}
async function savedRun(runId) { return JSON.parse(await readFile(join(workspace, ".proofkit", "runs", runId, "run.json"), "utf8")); }
async function verifyFacts(result) {
  for (const item of result.evidence.summary.runs.filter((run) => run.runId)) {
    const run = await savedRun(item.runId);
    const fileStep = run.steps.find((step) => step.action.kind === "setInputFiles");
    const caseId = run.charter.metadata.negativeCaseId === "invalid" ? "invalid" : run.charter.metadata.inputCase;
    assert.deepEqual(fileStep.inputFiles.map(({ fixture: _fixture, ...fact }) => fact), expected[caseId]);
    assert.ok(fileStep.artifacts.some((artifact) => artifact.endsWith("input-files.json")));
    let persisted = JSON.stringify(run) + await readFile(join(workspace, ".proofkit", "runs", run.runId, "events.jsonl"), "utf8");
    for (const artifact of fileStep.artifacts.filter((path) => path.endsWith("input-files.json"))) persisted += await readFile(join(workspace, ".proofkit", "runs", artifact), "utf8");
    assert.ok(!persisted.includes(privateMarker) && !persisted.includes(pdf.toString("base64")) && !persisted.includes('"buffer"'));
    for (const oracle of run.oracles) for (const artifact of oracle.sourceEvidenceArtifacts ?? []) await readFile(join(workspace, ".proofkit", "runs", artifact));
  }
}
async function waitForDevtools(path, error) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (error()) throw error();
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* Wait for this isolated Electron instance's endpoint. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Electron CDP endpoint did not appear");
}
