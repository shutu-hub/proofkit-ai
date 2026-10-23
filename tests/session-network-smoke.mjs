import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-session-network-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-session-network-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const runners = [];
const idleCommands = new Set();
let pendingResponse;
let pendingSeen;
let idleSeen;
const pendingRequest = new Promise((resolve) => { pendingSeen = resolve; });
const idleRequest = new Promise((resolve) => { idleSeen = resolve; });

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Network fixture deadline exceeded")), 15_000); })]); }
  finally { clearTimeout(timer); }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/pending") { pendingResponse = response; pendingSeen(); return; }
  if (path === "/queue") { await pendingRequest; response.writeHead(204); response.end(); return; }
  if (path === "/release") {
    pendingResponse.writeHead(202, { "content-type": "application/json" });
    pendingResponse.end('{"done":true}');
    response.writeHead(204); response.end(); return;
  }
  if (path === "/idle-command") { idleCommands.add(response); response.on("close", () => idleCommands.delete(response)); return; }
  if (path === "/idle") { response.writeHead(207); response.end("idle complete"); idleSeen(); return; }
  if (path === "/other") { response.writeHead(206, { "content-type": "text/html" }); response.end("<h1>Other isolated session</h1>"); return; }
  if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<h1>Network context fixture</h1><button id="queue">Queue request</button><button id="release">Release response</button><p id="state">Ready</p><script>
    document.querySelector('#queue').onclick = () => {
      fetch('/pending?token=private-query', {method:'POST',headers:{'content-type':'text/plain'},body:'private-request-body'}).then(() => document.querySelector('#state').textContent = 'Delayed done');
      fetch('/queue').then(() => document.querySelector('#state').textContent = 'Queued');
    };
    document.querySelector('#release').onclick = () => fetch('/release');
    fetch('/idle-command').then(() => fetch('/idle?token=private-idle-query'));
  </script>`);
});

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Session network fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
    && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
  const config = ProofkitConfigSchema.parse({ project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" }, run: { timeoutMs: 20_000 } });
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config }); runners.push(runner);
  const first = await runner.interactSurface({ adapter: "web", keepSession: true, action: { kind: "waitForText", text: "Ready" } });
  const second = await runner.interactSurface({ adapter: "web", keepSession: true, url: `${baseUrl}/other`, action: { kind: "goto", url: `${baseUrl}/other` } });
  assert.ok(first.sessionId && second.sessionId);
  const firstCapture = runner.listSurfaceSessions().sessions.find((session) => session.sessionId === first.sessionId)?.networkCapture;
  assert.ok(firstCapture?.runId);
  const queueRun = await runner.start({ adapter: "web", sessionId: first.sessionId, start: false,
    charter: { intent: "Queue a delayed response", level: "quick", mode: "deterministic", preconditions: [], sideEffectPolicy: "allow", metadata: {},
      actions: [{ kind: "click", selector: "#queue" }, { kind: "waitForText", text: "Queued" }], assertions: [{ kind: "text-visible", text: "Queued" }] } });
  assert.equal((await runner.wait(queueRun.runId)).verdict, "passed");
  assert.ok(idleCommands.size > 0);
  for (const command of [...idleCommands]) { command.writeHead(200); command.end("send idle request"); }
  await within(idleRequest);
  const releaseRun = await runner.start({ adapter: "web", sessionId: first.sessionId, start: false,
    charter: { intent: "Observe delayed response across Run boundary", level: "quick", mode: "deterministic", preconditions: [], sideEffectPolicy: "allow", metadata: {},
      actions: [{ kind: "click", selector: "#release" }, { kind: "waitForText", text: "Delayed done" }], assertions: [{ kind: "text-visible", text: "Delayed done" }] } });
  assert.equal((await runner.wait(releaseRun.runId)).verdict, "passed");
  const closed = await runner.closeSurfaceSession(first.sessionId);
  assert.equal(closed.networkCapture?.status, "sealed", JSON.stringify(closed));
  assert.equal(closed.networkCapture.runId, firstCapture.runId);
  const raw = await readFile(join(runner.evidenceDir, closed.networkCapture.runId, "events.jsonl"), "utf8");
  const traffic = raw.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "adapter.event");
  const delayed = traffic.find((event) => event.payload.eventType === "response" && event.payload.status === 202);
  assert.ok(delayed, "The delayed response must survive the originating Run closing");
  assert.equal(delayed.payload.initiatingRunId, queueRun.runId);
  assert.equal(delayed.payload.observedDuringRunId, releaseRun.runId);
  assert.ok(traffic.some((event) => event.payload.eventType === "request" && event.payload.requestId === delayed.payload.requestId));
  const idle = traffic.find((event) => event.payload.eventType === "response" && event.payload.status === 207);
  assert.ok(idle);
  const idleStarted = traffic.find((event) => event.payload.eventType === "request" && event.payload.requestId === idle.payload.requestId);
  assert.ok(idleStarted);
  assert.equal(idleStarted.payload.initiatingRunId, undefined, "Background traffic between Runs must not be assigned to a product action");
  assert.equal(idleStarted.payload.observedDuringRunId, undefined);
  assert.ok(!traffic.some((event) => event.payload.status === 206), "Another browser context's traffic must remain isolated");
  for (const secret of ["private-query", "private-request-body", "private-idle-query"]) assert.ok(!raw.includes(secret));
  assert.equal((await runner.verifyEvidenceManifest(closed.networkCapture.runId, closed.networkCapture.manifest.sha256)).status, "intact");
  const summary = await runner.wait(closed.networkCapture.runId);
  assert.equal(summary.verdict, "inconclusive", "A network capture cannot assert product correctness");
  const report = await readFile(closed.networkCapture.report, "utf8");
  assert.ok(report.includes("Session network timeline") && report.includes("Between Runs"));
  assert.ok(report.includes(queueRun.runId) && report.includes(releaseRun.runId));
  assert.ok(!(await readFile(join(runner.evidenceDir, queueRun.runId, "events.jsonl"), "utf8")).includes('"status":202'));
  assert.equal((await runner.closeSurfaceSession(second.sessionId)).networkCapture?.status, "sealed");
  const disabled = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ ...config, sessions: { recordNetwork: false } }) }); runners.push(disabled);
  const noCapture = await disabled.interactSurface({ adapter: "web", keepSession: true, url: `${baseUrl}/other`, action: { kind: "goto", url: `${baseUrl}/other` } });
  assert.equal(disabled.listSurfaceSessions().sessions[0]?.networkCapture, undefined);
  assert.equal((await disabled.closeSurfaceSession(noCapture.sessionId)).networkCapture, undefined);
  console.log(JSON.stringify({ status: "passed", crossRunResponseLinked: true, idleRequestRecorded: true, isolated: true, payloadsScrubbed: true,
    manifest: "intact", noProductVerdict: true, captureOptOut: true,
    ...(keepArtifacts ? { report: closed.networkCapture.report, workspaceRoot, projectRoot } : {}) }, null, 2));
} finally {
  await Promise.all(runners.map((runner) => runner.closeAllSurfaceSessions()));
  server.closeAllConnections();
  await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
