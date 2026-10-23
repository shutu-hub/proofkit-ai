import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { registerTools } from "../packages/mcp/dist/tools.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-popup-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-popup-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const records = new Map(); let writes = 0, baseUrl, videoBytes, selectedVideoBytes, secondVideoBytes;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/video.webm" && videoBytes) { response.writeHead(200, { "content-type": "video/webm" }); response.end(videoBytes); return; }
  if (url.pathname === "/selected.webm" && selectedVideoBytes) { response.writeHead(200, { "content-type": "video/webm" }); response.end(selectedVideoBytes); return; }
  if (url.pathname === "/selected-2.webm" && secondVideoBytes) { response.writeHead(200, { "content-type": "video/webm" }); response.end(secondVideoBytes); return; }
  if (url.pathname === "/playback") { response.writeHead(200, { "content-type": "text/html" }); response.end(`<video preload="auto" src="/${url.searchParams.get("selected") === "2" ? "selected-2" : url.searchParams.has("selected") ? "selected" : "video"}.webm"></video>`); return; }
  if (url.pathname === "/records" && request.method === "POST") {
    const id = `record-${++writes}`; records.set(id, { id, status: "created" });
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ id })); return;
  }
  if (url.pathname === "/read") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(records.get(url.searchParams.get("id")) ?? { status: "missing" })); return; }
  if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url.pathname === "/review") {
    response.end(`<title>Request review</title><style>body{background:rgb(40,180,80)}</style><h1>Review ready</h1><button id="submit">Submit request</button><output>Awaiting submission</output><script>
      document.querySelector('#submit').onclick=async()=>{await fetch('/records',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});document.querySelector('output').textContent='Request created';};
    </script>`); return;
  }
  if (url.pathname === "/details") { response.end('<title>Request details</title><style>body{background:rgb(190,90,30)}</style><h1>Details ready</h1>'); return; }
  if (url.pathname === "/foreign") { response.end('<title>Foreign page</title><h1>Outside target origin</h1>'); return; }
  response.end(`<title>Request portal</title><style>body{background:rgb(30,70,190)}</style><h1>Portal ready</h1>
    <button id="open" onclick="window.open('/review','proofkit-review')">Open review</button>
    <button id="duplicate" onclick="window.open('/review','proofkit-duplicate')">Duplicate review</button>
    <button id="details" onclick="window.open('/details','proofkit-details')">Open details</button>
    <button id="foreign" onclick="window.open('${baseUrl.replace('127.0.0.1', 'localhost')}/foreign','proofkit-foreign')">Open foreign page</button>`);
});
let runner, client, mcpServer, playbackBrowser;
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text);
};
try {
  await new Promise((resolveServer) => server.listen(0, resolveServer));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Popup fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
  runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, restrictWebOrigins: true, config: ProofkitConfigSchema.parse({
    surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" }, sessions: { recordVideo: true } }) });
  mcpServer = new McpServer({ name: "popup-smoke", version: "0.1.0" }); registerTools(mcpServer, runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); client = new Client({ name: "popup-host", version: "0.1.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await call("interact_surface", { surface: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Portal ready" } });
  const sessionId = opened.sessionId; assert.ok(sessionId);
  const portal = await call("inspect_surface", { surface: "web", sessionId });
  const pin = (inspection) => ({ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 });
  await call("interact_surface", { surface: "web", sessionId, inspection: pin(portal), action: { kind: "click", selector: "#open" } });
  const selected = await call("interact_surface", { surface: "web", sessionId, action: { kind: "switchPage", title: "Request review" } });
  assert.equal(selected.status, "observed"); assert.equal(selected.snapshot.title, "Request review");
  assert.ok(selected.snapshot.pages.some((page) => page.active && page.title === "Request review"));
  const review = await call("inspect_surface", { surface: "web", sessionId });
  assert.equal(review.snapshot.title, "Request review"); assert.ok(review.snapshot.controls.find((control) => control.selector === "#submit"));
  assert.equal(writes, 0);
  const draft = { intent: "Submit the request in its review popup", level: "core", mode: "deterministic", sideEffectPolicy: "allow", actions: [
    { kind: "switchPage", title: "Request portal" }, { kind: "click", selector: "#open", observationId: portal.inspectionId },
    { kind: "switchPage", title: "Request review" }, { kind: "captureResponse", name: "record", trigger: { kind: "click", selector: "#submit", observationId: review.inspectionId },
      response: { url: `${baseUrl}/records`, method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "identifier" } } }, requestWindowMs: 100 },
    { kind: "waitForText", text: "Request created" }], assertions: [{ kind: "text-visible", text: "Request created" }], oracles: ["current-record"],
    httpOracles: [{ name: "current-record", url: `${baseUrl}/read`, query: { id: { source: "response", stepId: "step-004", field: "id", matchPointer: "/id" } },
      statusPointer: "/status", successValues: ["created"], failureValues: ["missing"], intervalMs: 100, deadlineMs: 1000 }] };
  const planned = (await call("plan_test", { intent: draft.intent, charter: draft, sessionId, inspections: [pin(portal), pin(review)], expect: ["Request created"], oracleNames: ["current-record"] })).charter;
  const started = await call("run_test", { charter: planned, sessionId, surface: "web" }); assert.equal(started.running, true);
  await runner.waitMission(started.missionId);
  const evidence = await runner.missionEvidence(started.missionId);
  assert.equal(evidence.testVerdict, "passed", evidence.testVerdictReason); assert.equal(writes, 1);
  const primary = evidence.summary.runs.find((run) => run.runKind === "primary"); const summary = await runner.wait(primary.runId);
  assert.equal(summary.steps[0].receipt.titleAfter, "Request portal"); assert.equal(summary.steps[2].receipt.titleAfter, "Request review");
  assert.equal(summary.steps[3].response.fields.id, "record-1");
  assert.equal(summary.steps[3].afterSnapshot.pages.find((page) => page.active).title, "Request review");
  const runReport = join(runner.evidenceDir, primary.runId, "report.html");
  const markup = await readFile(runReport, "utf8"); assert.ok(markup.includes("Page inventory (2)"));
  assert.ok(markup.includes("other windows are outside that clip"));
  const readAgain = await call("inspect_surface", { surface: "web", sessionId }); assert.equal(readAgain.snapshot.title, "Request review");
  await call("interact_surface", { surface: "web", sessionId, action: { kind: "switchPage", title: "Request portal" } });
  await call("interact_surface", { surface: "web", sessionId, inspection: pin(portal), action: { kind: "click", selector: "#duplicate" } });
  const ambiguous = await call("interact_surface", { surface: "web", sessionId, action: { kind: "switchPage", title: "Request review" } });
  assert.equal(ambiguous.action.failureCode, "surface-page-ambiguous"); assert.equal(writes, 1);
  await call("interact_surface", { surface: "web", sessionId, inspection: pin(portal), action: { kind: "click", selector: "#foreign" } });
  const foreign = await call("interact_surface", { surface: "web", sessionId, action: { kind: "switchPage", title: "Foreign page" } });
  assert.equal(foreign.action.failureCode, "surface-page-origin"); assert.equal(writes, 1);
  const remaining = await call("inspect_surface", { surface: "web", sessionId }); assert.equal(remaining.snapshot.title, "Request portal");
  await call("interact_surface", { surface: "web", sessionId, inspection: pin(portal), action: { kind: "click", selector: "#details" } });
  const details = await call("interact_surface", { surface: "web", sessionId, action: { kind: "switchPage", title: "Request details" } });
  assert.equal(details.status, "observed"); assert.equal((await call("inspect_surface", { surface: "web", sessionId })).snapshot.title, "Request details");
  assert.equal(writes, 1);
  const closed = await call("close_surface_session", { sessionId }); assert.equal(closed.networkCapture.recording.status, "recorded");
  const finalEvidence = await runner.missionEvidence(started.missionId); assert.equal(finalEvidence.testVerdict, "passed");
  assert.equal(closed.networkCapture.recording.selectedPages?.observed, 2);
  assert.equal(closed.networkCapture.recording.selectedPages?.omitted, 0);
  assert.equal(closed.networkCapture.recording.selectedPages?.artifacts.length, 2);
  assert.equal(finalEvidence.summary.sessionCaptures.segments[0].integrity, "intact");
  assert.equal(finalEvidence.summary.sessionCaptures.segments[0].evidence.filter((item) => item.kind === "video").length, 3);
  const selectedPath = join(runner.evidenceDir, closed.networkCapture.recording.selectedPages.artifacts[0]);
  const secondPath = join(runner.evidenceDir, closed.networkCapture.recording.selectedPages.artifacts[1]);
  videoBytes = await readFile(join(runner.evidenceDir, closed.networkCapture.recording.artifact));
  selectedVideoBytes = await readFile(selectedPath);
  secondVideoBytes = await readFile(secondPath);
  playbackBrowser = await chromium.launch({ executablePath, headless: true });
  const playback = await playbackBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
  await playback.goto(`${baseUrl}/playback`);
  await playback.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && Number.isFinite(video.duration); });
  const clip = await playback.locator("video").evaluate(async (video) => {
    await new Promise((resolveSeek) => { video.addEventListener("seeked", resolveSeek, { once: true }); video.currentTime = video.duration / 2; });
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 120));
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d"); context.drawImage(video, 0, 0);
    const pixel = [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
    return { pixel, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  });
  assert.ok(clip.pixel[2] > 140 && clip.pixel[0] < 100 && clip.pixel[1] < 120, `The video must retain the blue initial page, not silently switch to the green popup: ${JSON.stringify(clip)}`);
  await playback.goto(`${baseUrl}/playback?selected=1`);
  await playback.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && Number.isFinite(video.duration); });
  const selectedClip = await playback.locator("video").evaluate(async (video) => {
    await new Promise((resolveSeek) => { video.addEventListener("seeked", resolveSeek, { once: true }); video.currentTime = video.duration / 2; });
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 120));
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d"); context.drawImage(video, 0, 0);
    const pixel = [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
    return { pixel, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  });
  assert.ok(selectedClip.pixel[1] > 120 && selectedClip.pixel[0] < 100 && selectedClip.pixel[2] < 130, `The popup clip must decode the green review window: ${JSON.stringify(selectedClip)}`);
  await playback.goto(`${baseUrl}/playback?selected=2`);
  await playback.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && Number.isFinite(video.duration); });
  const secondClip = await playback.locator("video").evaluate(async (video) => {
    await new Promise((resolveSeek) => { video.addEventListener("seeked", resolveSeek, { once: true }); video.currentTime = video.duration / 2; });
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 120));
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d"); context.drawImage(video, 0, 0);
    const pixel = [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
    return { pixel, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  });
  assert.ok(secondClip.pixel[0] > 130 && secondClip.pixel[1] < 130 && secondClip.pixel[2] < 90, `The second popup clip must decode the orange details window: ${JSON.stringify(secondClip)}`);
  await playback.goto(pathToFileURL(runReport).href);
  const inventory = playback.locator("details").filter({ has: playback.locator("summary", { hasText: "Page inventory" }) }).nth(2);
  await inventory.locator("summary").click(); assert.match(await inventory.innerText(), /Selected: Request review/);
  await inventory.scrollIntoViewIfNeeded();
  if (keepArtifacts) { await mkdir(join(workspaceRoot, "review")); await playback.screenshot({ path: join(workspaceRoot, "review", "page-inventory-desktop.png") }); }
  await playback.setViewportSize({ width: 390, height: 844 }); assert.equal(await playback.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await inventory.scrollIntoViewIfNeeded();
  const box = await inventory.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "Selected-page evidence must be visible without horizontal scrolling");
  if (keepArtifacts) await playback.screenshot({ path: join(workspaceRoot, "review", "page-inventory-mobile.png") });
  await playback.goto(pathToFileURL(finalEvidence.report).href);
  assert.equal(await playback.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Mission videos must fit the narrow report viewport");
  const embedded = playback.locator("#session-evidence video"); assert.equal(await embedded.count(), 3);
  await embedded.nth(2).evaluate(async (video) => { video.muted = true; await video.play(); });
  await playback.waitForFunction(() => document.querySelectorAll('video')[2]?.currentTime > 0.1);
  const originalSelected = await readFile(secondPath);
  try {
    await writeFile(secondPath, "changed popup evidence");
    const changed = await runner.missionEvidence(started.missionId);
    assert.notEqual(changed.summary.sessionCaptures.segments[0].integrity, "intact");
    assert.equal(changed.summary.sessionCaptures.segments[0].evidence.length, 0);
    assert.equal(changed.testVerdict, "passed", "Session-context tampering cannot invent or erase independently evidenced business success");
    assert.ok(!(await readFile(changed.report, "utf8")).includes("<video"));
  } finally { await writeFile(secondPath, originalSelected); }
  const restored = await runner.missionEvidence(started.missionId);
  assert.equal(restored.summary.sessionCaptures.segments[0].integrity, "intact");
  const manifest = await runner.evidenceManifest(primary.runId); assert.equal((await runner.verifyEvidenceManifest(primary.runId, manifest.sha256)).status, "intact");
  console.log(JSON.stringify({ status: "passed", explicitSameOriginSelection: true, selectionPersistsAcrossCalls: true, popupFormalReplay: true,
    independentCurrentRecordVerified: true, preparationWrites: 0, formalWrites: writes, duplicateTitleStops: true, foreignOriginStops: true,
    pageInventoryAndScreenshots: true, initialAndSelectedClipsDecoded: { primary: clip, selected: selectedClip, second: secondClip }, missionThreeVideosPlay: true,
    tamperedPopupWithdrawsPlayback: true, desktopAndMobileReport: true,
    manifest: "intact", ...(keepArtifacts ? { workspaceRoot, projectRoot, report: finalEvidence.report, runReport, captureReport: closed.networkCapture.report,
      videoPath: join(runner.evidenceDir, closed.networkCapture.recording.artifact), selectedVideoPath: selectedPath, secondVideoPath: secondPath,
      submitScreenshot: join(runner.evidenceDir, primary.runId, "artifacts", "step-004.png") } : {}) }, null, 2));
} finally {
  await client?.close(); await mcpServer?.close(); await runner?.closeAllSurfaceSessions();
  await playbackBrowser?.close();
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
