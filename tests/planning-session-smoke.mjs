import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/web.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { registerTools } from "../packages/mcp/dist/tools.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-planning-session-"));
console.log(JSON.stringify({ acceptanceRoot: root }));
const project = join(root, "source"), workspace = join(root, "workspace");
await mkdir(project); await mkdir(workspace);
await writeFile(join(project, "package.json"), JSON.stringify({ name: "planning-session-fixture", private: true }));
const runtimeFiles = ["packages/local-runner/dist/index.js", "packages/mcp/dist/tools.js", "packages/planner/dist/plan-review.js", "packages/adapters/dist/web.js", "tests/planning-session-smoke.mjs"];
const digests = await Promise.all(runtimeFiles.map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(join(repository, path))).digest("hex") })));
const owner = "reviewer-" + randomUUID(), title = "Evidence review Δ";
const captureGaps = [];
const capture = WebAdapter.prototype.capture;
WebAdapter.prototype.capture = async function (label) {
  try { return await capture.call(this, label); }
  catch (error) { captureGaps.push({ label, name: error.name, message: error.message.slice(0, 1000) }); throw error; }
};
const sessions = new Map(), records = new Map([["sentinel", { id: "sentinel", owner: "foreign", title: "Unrelated record" }]]);
const traffic = []; let created = 0, authWrites = 0, cleaned = false;
function html(body, script = "") { return '<!doctype html><html><head><title>Planning session fixture</title></head><body>' + body + '<script>' + script + '</script></body></html>'; }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    traffic.push({ method: request.method, path: url.pathname });
    const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const sendHtml = (value) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(value); };
    const token = /(?:^|; )sid=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    const actor = sessions.get(token);
    if (request.method === "GET" && url.pathname === "/signin") {
      sendHtml(html('<h1>Sign in</h1><label for="user">Test identity</label><input id="user"><button id="signin">Sign in</button>',
        'document.querySelector("#signin").onclick=async()=>{const result=await fetch("/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({user:document.querySelector("#user").value})});if(result.ok)location.href="/workspace";};')); return;
    }
    if (request.method === "POST" && url.pathname === "/auth") {
      let bytes = ""; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes); if (body.user !== owner) { json(403, { error: "Unknown test identity" }); return; }
      const sid = randomUUID(); sessions.set(sid, body.user); authWrites++;
      response.setHeader("set-cookie", "sid=" + sid + "; HttpOnly; SameSite=Strict; Path=/"); json(200, { signedIn: true }); return;
    }
    if (request.method === "GET" && url.pathname === "/workspace") {
      if (!actor) { response.writeHead(302, { location: "/signin" }); response.end(); return; }
      sendHtml(html('<h1>Workspace</h1><button id="open">New review</button><dialog id="editor"><label for="title">Review title</label><input id="title"><button id="save" disabled>Save review</button></dialog><output id="status">Ready</output>',
        'const dialog=document.querySelector("#editor"),field=document.querySelector("#title"),save=document.querySelector("#save");document.querySelector("#open").onclick=()=>dialog.showModal();field.oninput=()=>save.disabled=!field.value;save.onclick=async()=>{save.disabled=true;const response=await fetch("/api/records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:field.value})});if(response.status===201){dialog.close();document.querySelector("#status").textContent="Review saved";}};')); return;
    }
    if (request.method === "POST" && url.pathname === "/api/records") {
      if (!actor) { json(401, { error: "Sign in required" }); return; }
      let bytes = ""; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes); const record = { id: "record-" + randomUUID(), owner: actor, title: body.title, status: "saved" };
      records.set(record.id, record); created++; json(201, record); return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/admin/records/")) {
      const record = records.get(url.pathname.split("/").at(-1));
      json(record && record.owner === url.searchParams.get("owner") ? 200 : 404, record?.owner === url.searchParams.get("owner") ? record : { missing: true }); return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/admin/records/")) {
      const id = url.pathname.split("/").at(-1), record = records.get(id);
      if (record && record.owner !== url.searchParams.get("owner")) { json(403, { error: "Foreign owner" }); return; }
      records.delete(id); json(200, { removed: true }); return;
    }
    json(404, { error: "Unknown fixture route" });
  } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const readRecord = async (id, signal) => {
  const response = await fetch(origin + "/admin/records/" + id + "?owner=" + owner, { redirect: "error", signal });
  return { status: response.status, record: await response.json() };
};
async function cleanup({ signal }) {
  const owned = [...records.values()].filter((record) => record.owner === owner);
  for (const record of owned) {
    assert.equal((await readRecord(record.id, signal)).record.owner, owner);
    const removed = await fetch(origin + "/admin/records/" + record.id + "?owner=" + owner, { method: "DELETE", redirect: "error", signal });
    assert.equal(removed.status, 200); assert.equal((await readRecord(record.id, signal)).status, 404);
  }
  cleaned = ![...records.values()].some((record) => record.owner === owner);
  return [{ resourceId: "records", status: cleaned ? "removed" : "retained", evidence: { owner, deleted: owned.length },
    readback: { reader: "fixture.independent-record", scope: owner, exists: !cleaned, observedAt: new Date().toISOString() } }];
}
const oracle = { name: "saved-review", async check(context) {
  const response = context.steps.find((step) => step.response?.name === "created-review")?.response;
  const id = response?.fields.id;
  if (typeof id !== "string") throw new Error("Current response ID missing");
  const observed = await readRecord(id, context.signal);
  const passed = observed.status === 200 && observed.record.id === id && observed.record.owner === owner && observed.record.title === title && observed.record.status === "saved";
  return { name: "saved-review", passed, verificationKind: "business", message: "Independent exact review identity, owner, title and saved status", evidence: [JSON.stringify({ expected: { id, owner, title, status: "saved" }, actual: observed })], observedAt: new Date().toISOString() };
} };
let round = 0;
const provider = { name: "scripted-observed-planner", async plan(input) {
  assert.equal(input.intent, intent); assert.equal(input.constraints.sideEffectPolicy, "allow");
  const states = input.surfaceObservations; assert.ok(states?.length);
  const latest = states.at(-1), observationId = latest.observationId;
  const proposals = [{ kind: "fill", selector: "#user", value: owner }, { kind: "click", selector: "#signin" }, { kind: "click", selector: "#open" }, { kind: "fill", selector: "#title", value: title }];
  if (round < proposals.length) {
    const action = proposals[round++]; assert.ok(latest.snapshot.controls.some((control) => control.selector === action.selector));
    return { status: "needs-observation", reason: "Observe the result of the reviewed fixture interaction", expectedObservation: "Next state in the same retained browser", action: { ...action, observationId } };
  }
  assert.equal(states.length, 5);
  const bound = (action, index) => ({ ...action, observationId: states[index].observationId });
  return { intent, surfaces: ["web"], level: "core", mode: "deterministic", sideEffectPolicy: "allow", oracles: [oracle.name],
    actions: [{ kind: "goto", url: origin + "/signin" }, bound(proposals[0], 0), bound(proposals[1], 1), { kind: "waitForText", text: "Workspace", timeoutMs: 5000 },
      bound(proposals[2], 2), bound(proposals[3], 3), { kind: "captureResponse", name: "created-review", trigger: bound({ kind: "click", selector: "#save" }, 4),
        response: { url: origin + "/api/records", method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "identifier" }, title: { pointer: "/title", type: "string" } }, requestFields: { title: { pointer: "/title", type: "string" } } }, requestStartTimeoutMs: 5000, timeoutMs: 10000 },
      { kind: "waitForText", text: "Review saved", timeoutMs: 5000 }], assertions: [{ kind: "text-visible", text: "Review saved" }] };
} };
const intent = "Sign in with the isolated test identity, create a review in the modal, and verify its exact saved title and owner independently.";
const config = ProofkitConfigSchema.parse({ project: { root: project }, surfaces: { web: { baseUrl: origin + "/signin", executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } }, sessions: { recordVideo: true }, policies: { sideEffects: "allow" } });
const integration = { name: "controlled-planning-fixture", oracles: [oracle], setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 }, recover: cleanup,
  async setup({ registerResources }) { const handle = { resources: [{ resourceId: "records", kind: "synthetic-owner", scope: owner, evidence: { owner } }], cleanup }; await registerResources(handle); return handle; } };
const runner = await LocalRunnerService.create({ root: project, workspaceRoot: workspace, config, plannerProvider: provider, integration, allowCapabilityWrites: true, restrictWebOrigins: true });
const mcp = new McpServer({ name: "planning-session-acceptance", version: "1" }); registerTools(mcp, runner);
const client = new Client({ name: "planning-session-driver", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport); await client.connect(clientTransport);
const calls = [];
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!result.isError, JSON.stringify(result));
  const data = JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.text).join(""));
  calls.push({ tool: name, status: data.status, testVerdict: data.testVerdict }); return data;
}
let mediaBrowser;
try {
  let result = await call("plan_test", { intent, keepSession: true, headful: true, sessionLabel: "Synthetic reviewer", level: "core", mode: "deterministic", sideEffectPolicy: "allow", oracleNames: [oracle.name] });
  assert.equal(result.status, "needs-observation"); assert.ok(result.observationRequest, JSON.stringify(result));
  const sessionId = result.observationRequest.sessionId; assert.ok(sessionId);
  assert.equal(authWrites, 0); assert.equal(created, 0); assert.equal(traffic.filter((entry) => entry.path === "/signin").length, 1);
  const isolation = await call("inspect_surface", { surface: "web", url: origin + "/workspace", keepSession: true, headful: true, sessionLabel: "Unsigned observer" });
  assert.ok(isolation.snapshot.text.includes("Sign in")); assert.notEqual(isolation.sessionId, sessionId); assert.equal(authWrites, 0);
  const history = [];
  while (result.status === "needs-observation") {
    const request = result.observationRequest;
    const action = request.action;
    assert.ok(action && request.continuation); assert.equal(request.sessionId, sessionId);
    const pin = request.inspections.find((item) => item.runId === action.observationId) ?? request.inspections.at(-1);
    const interaction = await call("interact_surface", { sessionId, inspection: pin, action });
    assert.equal(interaction.status, "observed"); assert.equal(interaction.testVerdict, "not-asserted"); assert.equal(interaction.sessionId, sessionId);
    const observed = await call("inspect_surface", { sessionId, ...(action.selector === "#signin" ? { readyWhen: { text: "Workspace", timeoutMs: 5000 } } : {}) });
    assert.equal(observed.sessionId, sessionId); assert.equal(observed.status, "observed");
    history.push({ interactionId: interaction.interactionId, inspectionId: observed.inspectionId, source: pin, action: action.kind });
    assert.equal(created, 0, "Planning must not submit the review");
    result = await call("plan_test", { continuation: request.continuation, inspections: [{ runId: observed.inspectionId, manifestSha256: observed.manifest.sha256 }] });
  }
  assert.equal(result.status, "ready-for-review"); assert.equal(result.testVerdict, "not-asserted"); assert.equal(result.executionStarted, false); assert.equal(result.sessionId, sessionId);
  assert.equal(result.charter.intent, intent); assert.equal(result.charter.surfaceObservation.sources.length, 5); assert.equal(authWrites, 1); assert.equal(created, 0);
  const unchanged = await call("inspect_surface", { sessionId: isolation.sessionId, readyWhen: { text: "Sign in", timeoutMs: 5000 } });
  assert.ok(unchanged.snapshot.text.includes("Sign in")); assert.ok(!unchanged.snapshot.text.includes("Workspace"));
  const started = await call("run_test", { intent, charter: result.charter, surface: "web", sessionId, headful: true });
  assert.equal(started.readiness.ready, true, JSON.stringify(started));
  await runner.waitMission(started.missionId);
  const evidence = await runner.missionEvidence(started.missionId);
  assert.equal(evidence.testVerdict, "passed", JSON.stringify({ reason: evidence.testVerdictReason, findings: evidence.findings }));
  assert.equal(created, 1); assert.equal(authWrites, 2); assert.equal(cleaned, true); assert.equal(records.size, 1); assert.equal(records.get("sentinel").owner, "foreign");
  const formal = await runner.wait(evidence.summary.runs[0].runId);
  assert.equal(formal.execution.sessionId, sessionId); assert.equal(formal.steps.length, 8); assert.equal(formal.integrationCleanup.status, "verified");
  assert.equal(formal.steps[6].response.requestFields.title, title);
  const formalManifest = await runner.evidenceManifest(formal.runId);
  const closed = await call("close_surface_session", { sessionId }); const isolationClosed = await call("close_surface_session", { sessionId: isolation.sessionId });
  assert.equal(runner.listSurfaceSessions().sessions.length, 0);
  const sealedEvidence = await runner.missionEvidence(started.missionId);
  assert.equal(sealedEvidence.testVerdict, "passed");
  assert.equal(sealedEvidence.summary.sessionCaptures?.segments[0]?.integrity, "intact", JSON.stringify(sealedEvidence.summary.sessionCaptures));
  assert.equal(sealedEvidence.summary.sessionCaptures?.segments[0]?.capture?.recording?.status, "recorded");
  assert.ok((await readFile(sealedEvidence.report, "utf8")).includes("Initial primary-page recording"));
  assert.equal((await runner.verifyEvidenceManifest(formal.runId, formalManifest.sha256)).status, "intact");
  mediaBrowser = await chromium.launch({ executablePath: config.surfaces.web.executablePath, headless: true }); const mediaPage = await mediaBrowser.newPage();
  const recordings = [];
  for (const sealed of [closed.networkCapture, isolationClosed.networkCapture]) {
    assert.ok(sealed?.recording?.artifact, JSON.stringify(sealed));
    assert.equal((await runner.verifyEvidenceManifest(sealed.runId, sealed.manifest.sha256)).status, "intact");
    const videoPath = join(runner.evidenceDir, sealed.recording.artifact);
    await mediaPage.goto(pathToFileURL(videoPath).href);
    await mediaPage.locator("video").evaluate(async (video) => { video.muted = true; video.playbackRate = 8; await video.play(); });
    await mediaPage.waitForFunction(() => { const video = document.querySelector("video"); return video && video.ended && video.duration > 0 && !video.error; }, null, { timeout: 30000 });
    recordings.push({ runId: sealed.runId, path: videoPath, duration: await mediaPage.locator("video").evaluate((video) => video.duration) });
  }
  let screenshots = 0;
  await mediaPage.goto(pathToFileURL(join(runner.evidenceDir, formal.runId, "report.html")).href);
  await mediaPage.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } });
  screenshots = await mediaPage.locator("img").count(); assert.ok(screenshots >= 8, JSON.stringify({ screenshots, captureGaps }));
  assert.ok(formal.steps[2].artifacts.some((artifact) => artifact.endsWith("step-003.png")));
  if (formal.steps[2].artifacts.some((artifact) => artifact.endsWith("step-003-after-navigation.json"))) {
    assert.ok(formal.steps[2].afterSnapshot.text.includes("Workspace"));
  }
  await mediaPage.goto(pathToFileURL(sealedEvidence.report).href);
  const reportLayouts = [];
  for (const width of [1280, 390]) {
    await mediaPage.setViewportSize({ width, height: 900 });
    const layout = await mediaPage.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: document.body.innerText }));
    assert.ok(layout.scrollWidth <= layout.width, JSON.stringify({ width, scrollWidth: layout.scrollWidth }));
    assert.ok(layout.text.includes("Passed") && layout.text.includes("saved-review"));
    const screenshot = join(repository, "outputs", width === 1280 ? "planning-session-desktop.png" : "planning-session-mobile.png");
    await mediaPage.screenshot({ path: screenshot, fullPage: true });
    reportLayouts.push({ width: layout.width, scrollWidth: layout.scrollWidth, screenshot });
  }
  for (const item of digests) assert.equal(createHash("sha256").update(await readFile(join(repository, item.path))).digest("hex"), item.sha256);
  const receipt = { checkedAt: new Date().toISOString(), root, missionId: started.missionId, report: sealedEvidence.report, testVerdict: sealedEvidence.testVerdict, sessionId, history,
    modelCalls: round + 1, formalActions: formal.steps.length, createdRecords: created, authWrites, isolatedObserverStayedUnsigned: true, cleanupVerified: cleaned, foreignSentinelRetained: records.size === 1,
    recordings, decodedScreenshots: screenshots, reportLayouts, formalManifest, digests, calls, limitation: "Controlled local fixture and scripted observation-aware provider through in-process MCP, not autonomous model performance, production authentication or unseen-site coverage. Planning navigation loads the initial URL; retained observations do not add exploratory navigation or submit the record." };
  await writeFile(join(repository, "outputs/planning-session-validation.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const failure = { root, driverStatus: "failed", reason: error.message, captureGaps, createdRecords: created, authWrites, cleanupVerified: cleaned, remainingOwnedRecords: [...records.values()].filter((record) => record.owner === owner).length, calls, digests };
  await writeFile(join(repository, "outputs/planning-session-failure-" + Date.now() + ".json"), JSON.stringify(failure, null, 2));
  throw error;
} finally {
  await mediaBrowser?.close(); await client.close(); await mcp.close(); await runner.closeAllSurfaceSessions();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
