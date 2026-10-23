import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EvidenceStore } from "../packages/evidence/dist/index.js";
import { chromium } from "playwright-core";
import { analyzeRun } from "../packages/agent/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { pollHttpOracle } from "../packages/oracles/dist/index.js";
import { planIntent } from "../packages/planner/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

let workflowStatus = "pending";
const server = createServer((_request, response) => {
  if (_request.url === "/startup-script.js") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (_request.url?.startsWith("/api/v1/resume-status")) {
    if (_request.method === "POST") {
      setTimeout(() => { workflowStatus = "complete"; }, 50);
      response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "accepted" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: workflowStatus }, source: "fixture" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>ProofKit fixture</title><script src="/startup-script.js"></script><h1>Resume fixture</h1>
    <button id="fetch" onclick="fetch('/api/v1/resume-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({candidate_id:41})}).then(()=>document.querySelector('#result').textContent='Resume ready')">Fetch resume</button>
    <div id="result"></div><p style="display:none">Hidden configuration failure</p>
    ${_request.url === "/error" ? "<p>Page configuration failed</p>" : ""}`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture server did not bind");

const baseUrl = `http://127.0.0.1:${address.port}`;
const browserPath = process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const oracle = pollHttpOracle({
  name: "resume-workflow",
  url: `${baseUrl}/api/v1/resume-status`,
  intervalMs: 25,
  deadlineMs: 2_000,
  evaluate: (body) => body?.data?.status === "complete" ? "passed" : "pending",
  facts: (body) => ({ state: typeof body?.data?.status === "string" ? body.data.status : "unknown" }),
});
const adapter = new WebAdapter({
  baseUrl,
  ...(browserPath ? { executablePath: browserPath } : {}),
});
const charter = planIntent("验证简历获取页面", { url: baseUrl, expect: ["Resume ready"] });
charter.oracles = ["resume-workflow"];
charter.actions.splice(1, 0, { kind: "captureResponse", name: "resume-submit", trigger: { kind: "click", selector: "#fetch" },
  response: { url: `${baseUrl}/api/v1/resume-status`, method: "POST", statuses: [202],
    requestFields: { candidateId: { pointer: "/candidate_id", type: "id" } }, fields: { status: { pointer: "/data/status", type: "string" } } },
  requestWindowMs: 25, timeoutMs: 2_000 }, { kind: "waitForText", text: "Resume ready" });
charter.sideEffectPolicy = "allow";
charter.assertions.push({ kind: "text-visible", text: "Resume ready" }, { kind: "text-not-visible", text: "Hidden configuration failure" });
const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/smoke-runs", oracles: [oracle] }).run(charter);
assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
assert.equal(summary.execution?.visibility, "headless");
assert.ok(summary.steps.some((step) => step.action.kind === "captureResponse"));
assert.equal(summary.oracles[0]?.passed, true, JSON.stringify(summary, null, 2));
assert.deepEqual(summary.steps.find((step) => step.action.kind === "captureResponse")?.response?.requestFields, { candidateId: "41" });
assert.deepEqual(summary.steps.find((step) => step.action.kind === "captureResponse")?.response?.fields, { status: "accepted" });
assert.ok((await readFile(resolve(".proofkit/smoke-runs", summary.steps.find((step) => step.action.kind === "captureResponse").artifacts.find((path) => path.endsWith("-response.json"))), "utf8")).includes('"candidateId": "41"'));
const responseReport = await readFile(resolve(".proofkit/smoke-runs", summary.runId, "report.html"), "utf8");
assert.ok(responseReport.includes("Captured API facts"));
assert.ok(responseReport.includes("{&quot;candidateId&quot;:&quot;41&quot;}"));
assert.ok(!responseReport.includes("private@example.invalid"));
assert.ok(summary.artifacts.length >= 2);
const events = (await readFile(`.proofkit/smoke-runs/${summary.runId}/events.jsonl`, "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
assert.ok(events.some((event) => event.type === "adapter.event" && event.payload.eventType === "response"
  && event.payload.status === 204 && event.payload.method === "GET"
  && event.payload.url === `${baseUrl}/__redacted__` && event.payload.urlPathEvidence === "redacted"), "startup network response was not captured");
const postRequest = events.find((event) => event.type === "adapter.event" && event.payload.eventType === "request" && event.payload.method === "POST");
const postResponse = events.find((event) => event.type === "adapter.event" && event.payload.eventType === "response" && event.payload.method === "POST");
assert.equal(postRequest?.stepId, "step-002");
assert.equal(postResponse?.stepId, "step-002");
assert.equal(postResponse?.payload.requestId, postRequest?.payload.requestId);
assert.equal(summary.eventLog?.status, "sealed");
assert.ok(responseReport.includes("Event log: verified"));
const eventStore = new EvidenceStore(".proofkit/smoke-runs");
const logPath = resolve(".proofkit/smoke-runs", summary.runId, "events.jsonl");
const originalLog = await readFile(logPath);
try {
  await writeFile(logPath, Buffer.concat([originalLog, Buffer.from('{"changed":true}\n')]));
  const withdrawn = await readFile(await eventStore.writeReport(summary), "utf8");
  assert.ok(withdrawn.includes("Event log: changed"));
  assert.ok(!withdrawn.includes("Network requests ("));
  assert.ok(!withdrawn.includes('<img src="artifacts/step-'));
} finally { await writeFile(logPath, originalLog); }
await eventStore.writeReport(summary);
const failing = await new ExecutionRunner(new WebAdapter(browserPath ? { executablePath: browserPath } : {}), { evidenceDir: ".proofkit/smoke-runs" }).run({
  intent: "Detect a visible configuration error",
  level: "quick",
  mode: "deterministic",
  preconditions: [],
  actions: [{ kind: "goto", url: `${baseUrl}/error` }],
  assertions: [{ kind: "text-visible", text: "Resume fixture" }, { kind: "text-not-visible", text: "Page configuration failed" }],
  sideEffectPolicy: "deny",
  metadata: {},
});
assert.equal(failing.verdict, "failed", JSON.stringify(failing, null, 2));
assert.equal(failing.assertions[1]?.passed, false);
const assertionPath = `${failing.runId}/artifacts/assertion-002-snapshot.json`;
assert.ok(failing.assertions[1].evidence.includes(assertionPath));
assert.ok(JSON.parse(await readFile(resolve(".proofkit/smoke-runs", assertionPath), "utf8")).text.includes("Page configuration failed"));
const analysis = analyzeRun({ summary: failing, evidence: [{ evidenceId: `${failing.runId}:${assertionPath}`, kind: "snapshot",
  path: resolve(".proofkit/smoke-runs", assertionPath), capturedAt: failing.endedAt }] });
assert.equal(analysis.finding?.status, "confirmed");
assert.equal(analysis.finding?.category, "unknown");
assert.deepEqual(analysis.finding?.evidence.map((item) => item.path), [resolve(".proofkit/smoke-runs", assertionPath)]);
const failedAction = await new ExecutionRunner(new WebAdapter(browserPath ? { executablePath: browserPath } : {}), { evidenceDir: ".proofkit/smoke-runs" }).run({
  intent: "Capture an ambiguous click", level: "quick", mode: "deterministic", preconditions: [],
  actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: "button, h1" }],
  assertions: [], sideEffectPolicy: "allow", metadata: {},
});
assert.equal(failedAction.steps[1]?.failureCode, "surface-target-ambiguous");
const failureImage = `${failedAction.runId}/artifacts/step-002-failure.png`;
assert.ok(failedAction.steps[1]?.artifacts.includes(failureImage));
assert.ok((await readFile(resolve(".proofkit/smoke-runs", failureImage))).byteLength > 100);
assert.ok((await readFile(resolve(".proofkit/smoke-runs", failedAction.runId, "report.html"), "utf8"))
  .includes('src="artifacts/step-002-failure.png"'));
const recordingRunId = `video-${Date.now()}`;
const recordingRoot = resolve(".proofkit/smoke-runs", recordingRunId);
const recorded = await new ExecutionRunner(new WebAdapter({
  ...(browserPath ? { executablePath: browserPath } : {}),
  recordVideo: { directory: resolve(recordingRoot, "recording-tmp"), path: resolve(recordingRoot, "artifacts", "recording.webm") },
}), { evidenceDir: ".proofkit/smoke-runs" }).run({
  intent: "Record a visible Web action", level: "quick", mode: "deterministic", preconditions: [],
  actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: "#fetch" }],
  assertions: [{ kind: "text-visible", text: "Resume ready" }], sideEffectPolicy: "allow", metadata: {},
}, recordingRunId);
assert.equal(recorded.verdict, "passed", JSON.stringify(recorded, null, 2));
assert.deepEqual(recorded.recording, { status: "recorded", artifact: `${recordingRunId}/artifacts/recording.webm`, budget: { maxDurationMs: 600_000, maxBytes: 64 * 1024 * 1024 } });
assert.ok((await readFile(resolve(recordingRoot, "artifacts", "recording.webm"))).byteLength > 1000);
assert.ok((await readFile(resolve(recordingRoot, "report.html"), "utf8")).includes('src="artifacts/recording.webm"'));
const playbackBrowser = await chromium.launch(browserPath ? { executablePath: browserPath } : {});
try {
  const playbackPage = await playbackBrowser.newPage();
  await playbackPage.goto(pathToFileURL(resolve(recordingRoot, "report.html")).href);
  const playback = await playbackPage.locator("video").evaluate(async (video) => {
    if (video.readyState < 1) await new Promise((done, fail) => {
      video.onloadedmetadata = done;
      video.onerror = () => fail(new Error("Recorded media failed to load"));
      setTimeout(() => fail(new Error("Recorded media did not load in time")), 5000);
    });
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  });
  assert.ok(playback.duration > 0 && playback.width > 0 && playback.height > 0);
} finally { await playbackBrowser.close(); }
const configuredRunner = new LocalRunnerService({ root: resolve("."), workspaceRoot: resolve(".proofkit/smoke-video-workspace"),
  config: ProofkitConfigSchema.parse({ project: { root: resolve(".") },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    policies: { sideEffects: "allow" }, run: { recordVideo: true } }) });
const configuredRun = await configuredRunner.start({ adapter: "web", start: false, charter: {
  intent: "Record through the ordinary local runner", level: "quick", mode: "deterministic", preconditions: [],
  actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: "#fetch" }],
  assertions: [{ kind: "text-visible", text: "Resume ready" }], sideEffectPolicy: "allow", metadata: {},
} });
const configuredResult = await configuredRunner.wait(configuredRun.runId);
assert.equal(configuredResult.verdict, "passed", JSON.stringify(configuredResult, null, 2));
assert.equal(configuredResult.execution?.visibility, "headless");
assert.equal(configuredResult.recording?.status, "recorded");
assert.ok((await readFile(resolve(configuredRunner.evidenceDir, configuredResult.recording.artifact))).byteLength > 1000);
console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
server.close();
