import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { planIntent } from "../packages/planner/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>ProofKit fixture</title><h1>Resume fixture</h1>
    <button id="fetch" onclick="document.querySelector('#result').textContent='Resume ready'">Fetch resume</button>
    <div id="result"></div>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture server did not bind");

const baseUrl = `http://127.0.0.1:${address.port}`;
const adapter = new WebAdapter({
  baseUrl,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const charter = planIntent("验证简历获取页面", { url: baseUrl, expect: ["Resume ready"] });
charter.actions.splice(1, 0, { kind: "click", selector: "#fetch" }, { kind: "waitForText", text: "Resume ready" });
const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/smoke-runs" }).run(charter);
assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
assert.ok(summary.steps.some((step) => step.action.kind === "click"));
assert.ok(summary.artifacts.length >= 2);
console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
server.close();
