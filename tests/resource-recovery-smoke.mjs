import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";
import { sha256 } from "../packages/evidence/dist/index.js";

// Forced Node termination, real Web/Electron UI, fresh HTTP cleanup and immutable original evidence.
// This fixture validates recovery mechanics; it is not live AIHR business acceptance.
assert.ok(process.env.PROOFKIT_ELECTRON_PATH, "Set PROOFKIT_ELECTRON_PATH for the required Electron recovery case");
const scratch = await mkdtemp(join(tmpdir(), "proofkit-resource-recovery-smoke-"));
const source = join(scratch, "source"), workspaceRoot = join(scratch, "workspace");
const resources = new Set(["sentinel"]), armed = new Set(), operations = [], cases = [], children = [];
let currentScope, deleteGate, unblockDelete, browserContext, electron;
const http = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const match = /^\/(scopes|armed)\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (match) {
    const [, action, scope] = match;
    operations.push({ method: request.method, action, scope });
    if (action === "armed") { armed.add(scope); response.writeHead(204).end(); return; }
    if (request.method === "POST") { resources.add(scope); currentScope = scope; response.writeHead(201).end(); return; }
    if (request.method === "DELETE") {
      if (deleteGate) await deleteGate;
      resources.delete(scope); response.writeHead(204).end(); return;
    }
    response.writeHead(resources.has(scope) ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ scope, exists: resources.has(scope) })); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Recovery fixture</title><h1>Ready</h1>
    <button id="hold" onclick="fetch('/armed/${currentScope}')">Start long operation</button>`);
});

async function until(condition, label, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
function startNode(args) {
  const child = spawn(process.execPath, args, { cwd: resolve("."), stdio: "pipe", windowsHide: true });
  children.push(child);
  child.output = ""; child.errors = "";
  child.stdout.on("data", (data) => { child.output += data; });
  child.stderr.on("data", (data) => { child.errors += data; });
  child.on("error", (error) => { child.spawnError = error; });
  return child;
}
async function exited(child) {
  await until(() => child.spawnError || child.exitCode !== null || child.signalCode !== null, "child exit");
  if (child.spawnError) throw child.spawnError;
}
async function inventory(root) {
  const result = {};
  async function visit(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(path, relative + "/");
      else result[relative] = sha256(await readFile(path));
    }
  }
  await visit(root); return result;
}
async function connectClient(allowCapabilityWrites) {
  const server = await createProofkitMcp({ root: source, workspaceRoot, allowCapabilityWrites });
  const client = new Client({ name: "recovery-smoke", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}
async function call(client, name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

try {
  await mkdir(source); await mkdir(join(workspaceRoot, ".proofkit"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"recovery-source","devDependencies":{"vite":"1"}}');
  await writeFile(join(source, "README.md"), "This tested application remains unchanged.\n");
  const sourceBefore = await inventory(source);
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const chromeProfile = join(scratch, "chrome-profile");
  browserContext = await chromium.launchPersistentContext(chromeProfile, { executablePath: process.env.PROOFKIT_BROWSER_PATH,
    headless: true, args: ["--remote-debugging-port=0"] });
  const chromePort = (await readFile(join(chromeProfile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  await browserContext.pages()[0].goto(origin);
  const electronProfile = join(scratch, "electron-profile"); await mkdir(electronProfile);
  const appPath = join(electronProfile, "app.cjs");
  await writeFile(appPath, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(electronProfile)});app.commandLine.appendSwitch('remote-debugging-port','0');let w;app.whenReady().then(()=>{w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`);
  electron = spawn(process.env.PROOFKIT_ELECTRON_PATH, [appPath], { stdio: "ignore", windowsHide: true });
  let electronError; electron.on("error", (error) => { electronError = error; });
  const electronPortFile = join(electronProfile, "DevToolsActivePort");
  await until(async () => {
    if (electronError) throw electronError;
    assert.equal(electron.exitCode, null, "Electron exited unexpectedly");
    try { const port = (await readFile(electronPortFile, "utf8")).split(/\r?\n/)[0]; return /^\d+$/.test(port); } catch { return false; }
  }, "Electron CDP");
  await writeFile(join(workspaceRoot, ".proofkit/config.yaml"), JSON.stringify({ project: { root: source },
    policies: { environment: "test", sideEffects: "allow" }, surfaces: {
      web: { baseUrl: origin, cdpUrl: `http://127.0.0.1:${chromePort}`, targetUrlPrefix: origin },
      electron: { devtoolsActivePort: electronPortFile, targetUrlPrefix: origin },
    } }));
  await writeFile(join(workspaceRoot, ".proofkit/integration.mjs"), `
    const origin = ${JSON.stringify(origin)};
    const policy = { sideEffect: 'write', environments: ['test'], cleanupTimeoutMs: 3000 };
    async function cleanup({ runId, signal, resources }) {
      const results = [];
      for (const resource of [...resources].reverse()) {
        if (resource.scope !== runId || resource.resourceId !== 'tenant' || resource.kind !== 'test-tenant') throw new Error('Foreign scope');
        const url = origin + '/scopes/' + resource.scope;
        const deletion = await fetch(url, { method: 'DELETE', signal });
        if (deletion.status !== 204) throw new Error('Deletion failed');
        const readback = await fetch(url, { signal });
        const fact = await readback.json();
        if (fact.scope !== resource.scope) throw new Error('Foreign readback');
        results.push({ resourceId: resource.resourceId, status: readback.status === 404 ? 'removed' : 'retained',
          evidence: { deletionStatus: deletion.status, readStatus: readback.status },
          readback: { reader: 'fixture.get', scope: resource.scope, exists: fact.exists, observedAt: new Date().toISOString() } });
      }
      return results;
    }
    export default { name: 'recovery-fixture', version: '1.0.0', setupPolicy: policy, recover: cleanup,
      async setup({ runId, signal }) {
        const created = await fetch(origin + '/scopes/' + runId, { method: 'POST', signal });
        if (created.status !== 201) throw new Error('Setup failed');
        const resources = [{ resourceId: 'tenant', kind: 'test-tenant', scope: runId, evidence: { owner: runId } }];
        return { resources, cleanup: context => cleanup({ ...context, resources }) };
      } };
  `);

  for (const surface of ["web", "electron"]) {
    const previousScope = currentScope;
    const script = `
      import { LocalRunnerService } from ${JSON.stringify(pathToFileURL(resolve("packages/local-runner/dist/index.js")).href)};
      const [root, workspaceRoot, surface, origin] = process.argv.slice(1);
      const runner = await LocalRunnerService.create({ root, workspaceRoot, allowCapabilityWrites: true });
      const charter = { intent: 'Verify process-kill resource recovery', level: 'quick', mode: 'deterministic', preconditions: [],
        actions: [{kind:'goto',url:origin},{kind:'click',selector:'#hold'},{kind:'waitForText',text:'Never',timeoutMs:60000}],
        assertions: [{kind:'text-visible',text:'Ready'}], sideEffectPolicy:'allow',metadata:{} };
      const mission = await runner.createMission({ intent: charter.intent, charter, surface });
      process.stdout.write(JSON.stringify({missionId:mission.missionId})+'\\n');
      await runner.startMission(mission.missionId, { approve: true });
      setInterval(()=>{},1000);
    `;
    const child = startNode(["--input-type=module", "--eval", script, source, workspaceRoot, surface, origin]);
    await until(() => child.output.includes("missionId") || child.exitCode !== null, "Mission creation");
    assert.equal(child.exitCode, null, child.errors);
    const { missionId } = JSON.parse(child.output.trim().split(/\r?\n/)[0]);
    await until(() => currentScope && currentScope !== previousScope && armed.has(currentScope), `${surface} real UI action`, 30000);
    const runId = currentScope;
    const { server, client } = await connectClient(true);
    try {
      assert.equal((await call(client, "inspect_run_resources", { runId })).status, "active");
      assert.equal((await client.callTool({ name: "recover_run_resources", arguments: { runId } })).isError, true);
      child.kill("SIGKILL"); await exited(child);
      await until(async () => (await call(client, "inspect_run_resources", { runId })).status === "recoverable", "orphaned owner release");
      assert.ok(resources.has(runId));
      const runRoot = join(workspaceRoot, ".proofkit/runs", runId);
      const before = await inventory(runRoot);
      const missionPath = join(workspaceRoot, ".proofkit/missions", missionId + ".json");
      const missionBefore = sha256(await readFile(missionPath));
      const { server: deniedServer, client: deniedClient } = await connectClient(false);
      try { assert.equal((await deniedClient.callTool({ name: "recover_run_resources", arguments: { runId } })).isError, true); }
      finally { await deniedClient.close(); await deniedServer.close(); }
      let recovered;
      if (surface === "web") recovered = await call(client, "recover_run_resources", { runId });
      else {
        deleteGate = new Promise((done) => { unblockDelete = done; });
        const cli = startNode(["bundle/main.js", "resources", "recover", runId, "--root", source, "--workspace", workspaceRoot, "--allow-capability-writes"]);
        await until(() => operations.some((operation) => operation.scope === runId && operation.method === "DELETE"), "CLI cleanup started");
        assert.equal((await client.callTool({ name: "recover_run_resources", arguments: { runId } })).isError, true, "Concurrent MCP recovery must be excluded");
        unblockDelete(); unblockDelete = undefined; deleteGate = undefined;
        await exited(cli); assert.equal(cli.exitCode, 0, cli.errors); recovered = JSON.parse(cli.output);
      }
      assert.equal(recovered.status, "verified"); assert.equal(recovered.testVerdict, "not-asserted");
      assert.equal(resources.has(runId), false); assert.ok(resources.has("sentinel"));
      const relevant = operations.filter((operation) => operation.scope === runId && operation.action === "scopes");
      assert.deepEqual(relevant.map((operation) => operation.method), ["POST", "DELETE", "GET"]);
      assert.deepEqual(await inventory(runRoot), before);
      assert.equal(sha256(await readFile(missionPath)), missionBefore);
      assert.equal(JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")).status, "running");
      assert.equal((await call(client, "inspect_run_resources", { runId })).status, "cleaned");
      const cliInspect = startNode(["bundle/main.js", "resources", "inspect", runId, "--root", source, "--workspace", workspaceRoot]);
      await exited(cliInspect); assert.equal(cliInspect.exitCode, 0, cliInspect.errors);
      assert.equal(JSON.parse(cliInspect.output).latestRecovery.attemptId, recovered.attemptId);
      cases.push({ surface, missionId, runId, recoveryAttemptId: recovered.attemptId, status: recovered.status, originalEvidenceUnchanged: true,
        originalVerdict: "not-completed", evidence: recovered.evidence });
    } finally { await client.close(); await server.close(); }
  }
  assert.deepEqual(await inventory(source), sourceBefore);
  const proof = { status: "passed", surfaces: ["web", "electron"], processKillCases: cases, sourceUnchanged: true, sentinelPreserved: resources.has("sentinel") };
  const proofPath = join(workspaceRoot, ".proofkit/resource-recovery-validation.json");
  await writeFile(proofPath, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ...proof, proofPath }, null, 2));
} finally {
  unblockDelete?.(); deleteGate = undefined;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited(child); }
  if (electron?.exitCode === null && electron.signalCode === null) { electron.kill(); await exited(electron); }
  await browserContext?.close();
  http.closeAllConnections(); await new Promise((done) => http.close(done));
}
