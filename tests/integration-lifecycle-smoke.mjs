import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Real browser/CDP and HTTP lifecycle evidence; this fixture is not live AIHR acceptance.
const scratch = await mkdtemp(join(tmpdir(), "proofkit-integration-lifecycle-"));
const source = join(scratch, "source");
const workspaceRoot = join(scratch, "workspace");
const resources = new Map();
let currentScope;
let cleanupMode = "good";
let electron;
let client;
let mcp;
let missionCount = 0;
let runCount = 0;
const cases = [];
const http = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const match = /^\/scopes\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (match) {
    const scope = match[1];
    if (request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      resources.set(scope, { scope, submitted: false, negative: JSON.parse(body).negative });
      currentScope = scope; response.writeHead(201).end(); return;
    }
    if (request.method === "DELETE") {
      if (cleanupMode === "timeout") return; // Deliberately ignore cancellation in the fixture server.
      if (cleanupMode !== "retained" && !(cleanupMode === "negative-only" && resources.get(scope)?.negative)) resources.delete(scope);
      response.writeHead(204).end(); return;
    }
    response.writeHead(resources.has(scope) ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(resources.get(scope) ?? { scope, exists: false })); return;
  }
  if (url.pathname === "/submit") {
    const record = resources.get(url.searchParams.get("scope"));
    if (!record) { response.writeHead(404).end(); return; }
    if (record.negative) { response.writeHead(403).end(); return; }
    record.submitted = true; response.writeHead(200).end(); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>ProofKit resource lifecycle</title><h1>Ready</h1>
    <button id="submit" onclick="fetch('/submit?scope=${currentScope}').then(r=>{if(r.ok)document.querySelector('#result').textContent='Completed';else if(r.status===403)document.querySelector('#result').textContent='Denied'})">Submit</button><div id="result"></div>`);
});
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function run(surface, level, charter) {
  const started = await call("run_test", { intent: charter.intent, surface, level, charter });
  assert.ok(started.missionId, JSON.stringify(started));
  const deadline = Date.now() + 40000;
  let status;
  while (Date.now() < deadline) {
    status = await call("get_mission_status", { missionId: started.missionId });
    if (!status.running) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.running, false, "Mission did not settle");
  const result = await call("get_mission_evidence", { missionId: started.missionId });
  missionCount++; runCount += result.summary.observedRuns;
  cases.push({ surface, level, mode: cleanupMode, missionId: result.summary.missionId,
    verdict: result.summary.verdict, observedRuns: result.summary.observedRuns, report: result.report });
  return result;
}
async function verifyCleanupArtifacts(result, expectedStatus) {
  const executed = result.summary.runs.filter((row) => row.runId);
  assert.equal(executed.length, result.summary.observedRuns);
  for (const row of result.summary.runs) {
    if (!row.runId) {
      assert.notEqual(result.summary.verdict, "passed", "A missing execution cannot pass");
      assert.notEqual(row.taskStatus, "passed");
      assert.ok(row.issue, "A missing execution must explain its evidence gap");
      assert.equal(row.integrationCleanup, undefined);
      continue;
    }
    assert.ok(row.integrationCleanup?.artifact, `Missing cleanup artifact for executed Run ${row.runId}`);
    const path = join(workspaceRoot, ".proofkit/runs", row.integrationCleanup.artifact);
    const bytes = await readFile(path);
    const evidence = JSON.parse(bytes.toString("utf8"));
    assert.equal(evidence.runId, row.runId);
    assert.equal(evidence.status, row.integrationCleanup.status);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.integrationCleanup.sha256);
    if (expectedStatus) assert.equal(evidence.status, expectedStatus);
    if (evidence.status === "verified") for (const observation of evidence.observations) {
      assert.ok(Date.parse(observation.readback.observedAt) >= Date.parse(observation.releaseStartedAt));
    }
  }
}
try {
  await mkdir(source, { recursive: true }); await mkdir(join(workspaceRoot, ".proofkit"), { recursive: true });
  const manifest = JSON.stringify({ name: "isolated-lifecycle-fixture", devDependencies: { vite: "1" } });
  await writeFile(join(source, "package.json"), manifest);
  const sourceSha = createHash("sha256").update(manifest).digest("hex");
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  let electronConfig;
  if (process.env.PROOFKIT_ELECTRON_PATH) {
    const profile = join(scratch, "electron-profile"); await mkdir(profile);
    const app = join(profile, "app.cjs");
    await writeFile(app, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('remote-debugging-port','0');let w;app.whenReady().then(()=>{w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`);
    electron = spawn(process.env.PROOFKIT_ELECTRON_PATH, [app], { stdio: "ignore", windowsHide: true });
    let spawnError; electron.on("error", (error) => { spawnError = error; });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15000; let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (electron.exitCode !== null) throw new Error("Electron exited before CDP became ready");
      try {
        const port = (await readFile(portFile, "utf8")).split(/\r?\n/)[0];
        if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Electron CDP endpoint did not appear");
    electronConfig = { devtoolsActivePort: portFile, targetUrlPrefix: origin };
  }
  await writeFile(join(workspaceRoot, ".proofkit/config.yaml"), JSON.stringify({
    project: { root: source }, surfaces: { web: { baseUrl: origin,
      ...(process.env.PROOFKIT_BROWSER_PATH || process.platform === "win32" ? { executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) },
      ...(electronConfig ? { electron: electronConfig } : {}) },
    policies: { environment: "test", sideEffects: "allow" }, run: { timeoutMs: 10000 },
  }));
  await writeFile(join(workspaceRoot, ".proofkit/integration.mjs"), `
    export function createIntegration() {
      const runs=new Map(); const origin=${JSON.stringify(origin)};
      return {name:'lifecycle-fixture',setupPolicy:{sideEffect:'write',environments:['test'],cleanupTimeoutMs:500},
        setup:async({runId,charter,signal})=>{
          const url=origin+'/scopes/'+runId; await fetch(url,{method:'POST',body:JSON.stringify({negative:Boolean(charter.metadata.negativeCaseId)}),signal}); runs.set(runId,url);
          return {resources:[{resourceId:'namespace',kind:'fixture-namespace',scope:runId,evidence:{owner:runId}}],cleanup:async({signal})=>{
            try { await fetch(url,{method:'DELETE',signal}); const state=await fetch(url,{signal});
              const mode=await (await fetch(origin+'/mode',{signal})).text();
              return [{resourceId:'namespace',status:state.status===404?'removed':'retained',evidence:{statusCode:state.status},
                ...(mode==='missing-readback'?{}:{readback:{reader:'fixture.scoped-get',scope:mode==='wrong-scope'?'foreign':runId,observedAt:new Date().toISOString(),exists:state.status!==404}})}];
            }finally{runs.delete(runId);}
          }};
        },oracles:[{name:'fixture-terminal',check:async({runId,signal})=>{
          const data=await (await fetch(runs.get(runId),{signal})).json();
          return {name:'fixture-terminal',passed:data.scope===runId&&data.submitted,message:'Scoped independent submission read',evidence:[JSON.stringify({scope:data.scope,submitted:data.submitted})],observedAt:new Date().toISOString()};
        }}]};
    }`);
  // Add the mode reader without placing test logic in the scanned source project.
  const fixtureHandler = http.listeners("request")[0]; http.removeListener("request", fixtureHandler);
  http.on("request", (request, response) => {
    if (request.url === "/mode") { response.writeHead(200).end(cleanupMode); }
    else fixtureHandler(request, response).catch(() => response.destroy());
  });
  mcp = await createProofkitMcp({ root: source, workspaceRoot, allowCapabilityWrites: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "resource-lifecycle-smoke", version: "1" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  const charter = { intent: "测试隔离业务提交链路", level: "core", mode: "deterministic", preconditions: [],
    actions: [{ kind: "goto", url: origin }, { kind: "click", selector: "#submit" }, { kind: "waitForText", text: "Completed", timeoutMs: 2000 }],
    assertions: [{ kind: "text-visible", text: "Completed" }], oracles: ["fixture-terminal"], sideEffectPolicy: "allow", metadata: {},
    negativeCases: [{ caseId: "denied", title: "assert scoped submission denial", actions: [{ kind: "goto", url: origin },
      { kind: "click", selector: "#submit" }, { kind: "waitForText", text: "Denied", timeoutMs: 2000 }],
      assertions: [{ kind: "text-visible", text: "Denied" }], oracles: ["fixture-terminal"], sideEffectPolicy: "allow", expectedVerdict: "failed" }],
  };
  const surfaces = electronConfig ? ["web", "electron"] : ["web"];
  if (electronConfig) {
    const release = await run("web", "release", { ...charter, level: "release" });
    assert.equal(release.summary.verdict, "passed", JSON.stringify(release.summary));
    assert.equal(release.summary.observedRuns, 6);
    assert.ok(release.summary.runs.every((item) => item.integrationCleanup?.status === "verified"));
    await verifyCleanupArtifacts(release, "verified");
    assert.equal(resources.size, 0);
  }
  for (const surface of surfaces) {
    for (const mode of ["good", "retained", "wrong-scope", "missing-readback", "negative-only", "timeout"]) {
      cleanupMode = mode;
      const result = await run(surface, "core", charter);
      assert.equal(result.summary.verdict === "passed", mode === "good", JSON.stringify(result.summary));
      if (mode === "good") assert.equal(resources.size, 0);
      else {
        assert.ok(result.summary.findings.some((item) => item.category === "environment" && item.findingId.startsWith("cleanup-")));
        if (mode === "negative-only") assert.equal(result.summary.runs.find((item) => item.runKind === "negative").outcomeMatched, false);
      }
      await verifyCleanupArtifacts(result, mode === "good" ? "verified" : undefined);
      assert.ok((await readFile(result.report, "utf8")).includes("Cleanup:"));
      resources.clear(); // Only the fixture's process-local Map; retained failures remain in saved evidence.
    }
  }
  assert.equal(createHash("sha256").update(await readFile(join(source, "package.json"))).digest("hex"), sourceSha);
  assert.deepEqual(await readdir(source), ["package.json"], "Source tree must contain no injected test code or artifacts");
  const validation = { status: "passed", surfaces, missions: missionCount, runs: runCount,
    sourceUnchanged: true, sourceSha256: sourceSha, workspaceRoot, evidenceKind: "isolated-fixture", cases };
  const validationPath = join(workspaceRoot, ".proofkit/lifecycle-validation.json");
  await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify({ ...validation, cases: cases.length, validationPath }));
} finally {
  await client?.close(); await mcp?.close();
  if (electron && electron.exitCode === null) {
    const stopped = new Promise((resolve) => electron.once("exit", resolve)); electron.kill(); await stopped;
  }
  http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
}
