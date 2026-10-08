import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { pollHttpOracle } from "../packages/oracles/dist/index.js";
import { planIntent } from "../packages/planner/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

let workflowStatus = "pending";
const server = createServer((_request, response) => {
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
  response.end(`<!doctype html><title>ProofKit fixture</title><h1>Resume fixture</h1>
    <button id="fetch" onclick="fetch('/api/v1/resume-status',{method:'POST'}).then(()=>document.querySelector('#result').textContent='Resume ready')">Fetch resume</button>
    <div id="result"></div>`);
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
const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/smoke-runs", oracles: [oracle] }).run(charter);
assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
assert.ok(summary.steps.some((step) => step.action.kind === "click"));
assert.equal(summary.oracles[0]?.passed, true, JSON.stringify(summary, null, 2));
assert.ok(summary.artifacts.length >= 2);
console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
server.close();
