import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeRun } from "../packages/agent/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
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
    <button id="fetch" onclick="fetch('/api/v1/resume-status',{method:'POST'}).then(()=>document.querySelector('#result').textContent='Resume ready')">Fetch resume</button>
    <div id="result"></div><p style="display:none">Hidden configuration failure</p>
    ${_request.url === "/error" ? "<p>Page configuration failed</p>" : ""}`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture server did not bind");

const baseUrl = `http://127.0.0.1:${address.port}`;
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
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const charter = planIntent("验证简历获取页面", { url: baseUrl, expect: ["Resume ready"] });
charter.oracles = ["resume-workflow"];
charter.actions.splice(1, 0, { kind: "click", selector: "#fetch" }, { kind: "waitForText", text: "Resume ready" });
charter.assertions.push({ kind: "text-visible", text: "Resume ready" }, { kind: "text-not-visible", text: "Hidden configuration failure" });
const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/smoke-runs", oracles: [oracle] }).run(charter);
assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
assert.ok(summary.steps.some((step) => step.action.kind === "click"));
assert.equal(summary.oracles[0]?.passed, true, JSON.stringify(summary, null, 2));
assert.ok(summary.artifacts.length >= 2);
const events = (await readFile(`.proofkit/smoke-runs/${summary.runId}/events.jsonl`, "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
assert.ok(events.some((event) => event.type === "adapter.event" && event.payload.eventType === "response"
  && event.payload.status === 204 && event.payload.url === `${baseUrl}/startup-script.js`), "startup network response was not captured");
const failing = await new ExecutionRunner(new WebAdapter({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }), { evidenceDir: ".proofkit/smoke-runs" }).run({
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
assert.equal(analysis.finding?.category, "product");
assert.deepEqual(analysis.finding?.evidence.map((item) => item.path), [resolve(".proofkit/smoke-runs", assertionPath)]);
console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
server.close();
