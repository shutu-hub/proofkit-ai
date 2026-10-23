import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-session-prep-web-"));
const projectRoot = join(root, "source"), workspaceRoot = join(root, "workspace");
await mkdir(projectRoot); await mkdir(workspaceRoot);
const scopes = new Map([["sentinel", "foreign"]]);
let createdScopes = 0, preparedScope;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname.startsWith("/view/")) {
    const scope = url.pathname.slice(6), active = scopes.get(scope) === scope;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Reviewed scope</title><h1>' + (active ? "Prepared scope ready" : "Scope unavailable") + "</h1>"); return;
  }
  if (request.method === "GET" && url.pathname === "/api/current") {
    const active = [...scopes].some(([scope, owner]) => scope !== "sentinel" && owner === scope);
    response.writeHead(active ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify({ active })); return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Web scope</title><h1>Preparation workspace</h1><script>const timer=setInterval(async()=>{const state=await fetch("/api/current");'
      + 'if(state.ok){clearInterval(timer);document.querySelector("h1").textContent="Prepared scope ready"}},100)</script>'); return;
  }
  if (url.pathname.startsWith("/scopes/")) {
    const scope = url.pathname.slice(8), active = scopes.get(scope) === scope;
    if (request.method === "GET") {
      response.writeHead(active ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify({ scope, owner: active ? scope : null })); return;
    }
    if (request.method === "POST" && !active && request.headers["x-test-owner"] === scope) {
      scopes.set(scope, scope); createdScopes++; response.writeHead(201); response.end(); return;
    }
    if (request.method === "DELETE" && active && request.headers["x-test-owner"] === scope) {
      scopes.delete(scope); response.writeHead(204); response.end(); return;
    }
  }
  response.writeHead(404); response.end();
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = "http://127.0.0.1:" + server.address().port;
async function readScope(scope, signal) {
  const response = await fetch(origin + "/scopes/" + scope, { signal });
  return { status: response.status, data: await response.json() };
}
const recover = async ({ resources, signal }) => {
  assert.equal(resources.length, 1);
  const scope = resources[0].scope; assert.equal(resources[0].evidence.owner, scope);
  const before = await readScope(scope, signal);
  if (before.status === 200) {
    assert.equal(before.data.owner, scope);
    assert.equal((await fetch(origin + "/scopes/" + scope, { method: "DELETE", headers: { "x-test-owner": scope }, signal })).status, 204);
  }
  const after = await readScope(scope, signal); assert.equal(after.status, 404);
  return [{ resourceId: "scope", status: "removed", evidence: { beforeStatus: before.status, afterStatus: after.status },
    readback: { reader: "fixture.scoped-get", scope, exists: false, observedAt: new Date().toISOString() } }];
};
const integration = { name: "prepared-browser-fixture", version: "1", setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 }, recover,
  oracles: [{ name: "prepared-scope-current", async check({ signal }) {
    const current = await readScope(preparedScope, signal);
    return { name: this.name, passed: current.status === 200 && current.data.owner === preparedScope,
      verificationKind: "business", message: "Independent current prepared scope matches its original owner",
      evidence: [JSON.stringify({ expectedOwner: preparedScope, currentStatus: current.status, currentOwner: current.data.owner })],
      observedAt: new Date().toISOString() };
  } }],
  async setup({ runId, preparedSession, registerResources, signal }) {
    const scope = preparedSession?.preparationRunId ?? runId;
    if (preparedSession) { assert.equal(preparedSession.sessionId, sessionId); assert.equal(scope, preparedScope); }
    const resources = [{ resourceId: "scope", kind: "isolated-scope", scope, evidence: { owner: scope } }];
    const handle = { resources, cleanup: ({ signal: cleanupSignal }) => recover({ resources, signal: cleanupSignal }) };
    await registerResources(handle);
    if (preparedSession) assert.equal((await readScope(scope, signal)).status, 200);
    else assert.equal((await fetch(origin + "/scopes/" + scope, { method: "POST", headers: { "x-test-owner": scope }, signal })).status, 201);
    return handle;
  } };
const runner = await LocalRunnerService.create({ root: projectRoot, workspaceRoot, integration, restrictWebOrigins: true, allowCapabilityWrites: true,
  config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } },
    sessions: { recordNetwork: true, recordVideo: true }, policies: { environment: "test", sideEffects: "allow" } }) });
const charter = TestCharterSchema.parse({ intent: "Prepare isolated resources and inspect their visible Web state", level: "core", surfaces: ["web"],
  sideEffectPolicy: "allow", actions: [], assertions: [] });
let browser, sessionId, receipt;
try {
  const first = await runner.inspectSurface({ keepSession: true, headful: true });
  assert.equal(first.status, "observed"); sessionId = first.sessionId;
  receipt = await runner.prepareSurfaceSession({ sessionId, charter });
  preparedScope = receipt.runId;
  assert.equal(receipt.testVerdict, "not-asserted"); assert.equal((await readScope(receipt.runId)).status, 200);
  assert.equal((await runner.inspectRunResources(receipt.runId)).status, "active");
  const visited = await runner.interactSurface({ sessionId, action: { kind: "goto", url: origin + "/view/" + receipt.runId } });
  assert.equal(visited.status, "observed", JSON.stringify(visited.findings));
  const observed = await runner.inspectSurface({ sessionId, readyWhen: { text: "Prepared scope ready", timeoutMs: 5000 } });
  assert.equal(observed.status, "observed"); assert.ok(observed.snapshot.text.includes("Prepared scope ready"));
  const formalCharter = TestCharterSchema.parse({ intent: "Verify the prepared Web scope is visible and independently owned", level: "core", surfaces: ["web"],
    sideEffectPolicy: "allow", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Prepared scope ready" }],
    oracles: ["prepared-scope-current"] });
  const started = await runner.start({ adapter: "web", sessionId, charter: formalCharter, headful: true, start: false });
  const formal = await runner.wait(started.runId);
  assert.equal(formal.verdict, "passed", JSON.stringify(formal.findings));
  assert.equal(formal.integrationCleanup.status, "verified"); assert.equal(formal.oracles[0].passed, true);
  assert.equal(createdScopes, 1); assert.equal((await readScope(receipt.runId)).status, 404);
  assert.equal((await runner.verifyEvidenceManifest(formal.runId, (await runner.evidenceManifest(formal.runId)).sha256)).status, "intact");
  const closed = await runner.closeSurfaceSession(sessionId); sessionId = undefined;
  assert.equal(closed.resourcePreparation.runId, receipt.runId);
  assert.equal(closed.resourcePreparation.cleanup.status, "verified");
  assert.equal(closed.networkCapture.status, "sealed"); assert.equal(closed.networkCapture.recording.status, "recorded");
  assert.equal((await readScope(receipt.runId)).status, 404);
  assert.equal((await runner.inspectRunResources(receipt.runId)).status, "cleaned");
  assert.equal((await runner.verifyEvidenceManifest(receipt.runId)).status, "intact");
  assert.equal((await runner.verifyEvidenceManifest(closed.networkCapture.runId, closed.networkCapture.manifest.sha256)).status, "intact");
  assert.deepEqual([...scopes], [["sentinel", "foreign"]]);
  browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(runner.evidenceDir, closed.networkCapture.recording.artifact)).href);
  await page.locator("video").evaluate(async (video) => { video.muted = true; video.playbackRate = 16; await video.play(); });
  await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.ended && video.duration > 0 && !video.error; }, null, { timeout: 30000 });
  const duration = await page.locator("video").evaluate((video) => video.duration);
  const result = { checkedAt: new Date().toISOString(), root, origin, preparationRunId: receipt.runId, inspectionId: observed.inspectionId,
    preparationVerdict: "not-asserted", formalRunId: formal.runId, formalVerdict: formal.verdict, createdScopes,
    resourceCleanup: "verified", resourceStatus: "cleaned", networkStatus: "sealed", recordingDuration: duration,
    foreignSentinelRetained: true, scope: "Controlled Edge Web session and reviewed connector with explicit formal adoption; not an unfamiliar app or model planning proof" };
  await writeFile(join(repository, "outputs/session-preparation-browser-validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (sessionId) await runner.closeSurfaceSession(sessionId).catch(() => {});
  await runner.closeAllSurfaceSessions(); server.closeAllConnections(); await new Promise((done) => server.close(done));
}
