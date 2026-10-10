import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeRun } from "../packages/agent/dist/index.js";
import { ElectronAdapter } from "../packages/adapters/dist/index.js";
import { pollHttpOracle } from "../packages/oracles/dist/index.js";
import { planIntent } from "../packages/planner/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

const electron = "D:\\code\\Python\\AIHR-Microservices\\node_modules\\.pnpm\\electron@28.3.3\\node_modules\\electron\\dist\\electron.exe";
const userData = await mkdtemp(join(tmpdir(), "proofkit-electron-"));
let workflowStatus = "pending";
const server = createServer((request, response) => {
  if (request.url?.startsWith("/api/v1/resume-status")) {
    if (request.method === "POST") {
      setTimeout(() => { workflowStatus = "complete"; }, 50);
      response.writeHead(202, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify({ data: { status: "accepted" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    response.end(JSON.stringify({ data: { status: workflowStatus }, source: "fixture" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Business fixture server did not bind");
const oracleUrl = `http://127.0.0.1:${address.port}/api/v1/resume-status`;
const oracle = pollHttpOracle({
  name: "resume-workflow",
  url: oracleUrl,
  intervalMs: 25,
  deadlineMs: 2_000,
  evaluate: (body) => body?.data?.status === "complete" ? "passed" : "pending",
  facts: (body) => ({ state: typeof body?.data?.status === "string" ? body.data.status : "unknown" }),
});
const child = spawn(electron, ["tests/fixtures/electron-app.cjs", `--proofkit-oracle-url=${oracleUrl}`, "--remote-debugging-port=9229", `--user-data-dir=${userData}`, "--no-sandbox", "--disable-gpu"], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });

try {
  await waitForCdp("http://127.0.0.1:9229/json/version");
  const portFile = join(userData, "DevToolsActivePort");
  await writeFile(portFile, "9229\n/devtools/browser/proofkit-smoke\n", "utf8");
  const inspectionAdapter = new ElectronAdapter({ devtoolsActivePortPath: portFile });
  try {
    await inspectionAdapter.connect();
    const snapshot = await inspectionAdapter.discover();
    assert.equal(snapshot.metadata.surface, "electron");
    assert.equal(snapshot.url, "data:text/html;base64,[CONTENT REDACTED]");
    assert.equal(snapshot.controls?.find((control) => control.name === "Fetch resume")?.selector, "#fetch");
  } finally {
    await inspectionAdapter.close();
  }
  const adapter = new ElectronAdapter({ devtoolsActivePortPath: portFile });
  const charter = planIntent("验证 Electron 简历获取", { expect: ["Resume desktop", "Resume ready"] });
  charter.oracles = ["resume-workflow"];
  charter.actions.push({ kind: "click", selector: "#fetch" }, { kind: "waitForText", text: "Resume ready" });
  const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/electron-runs", oracles: [oracle] }).run(charter);
  assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
  assert.equal(summary.oracles[0]?.passed, true, JSON.stringify(summary, null, 2));
  const failing = await new ExecutionRunner(new ElectronAdapter({ devtoolsActivePortPath: portFile }), { evidenceDir: ".proofkit/electron-runs" }).run({
    intent: "Detect a visible desktop state", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "observe" }],
    assertions: [{ kind: "text-visible", text: "Resume desktop" }, { kind: "text-not-visible", text: "Resume ready" }],
    sideEffectPolicy: "deny", metadata: {},
  });
  assert.equal(failing.verdict, "failed");
  const assertionPath = `${failing.runId}/artifacts/assertion-002-snapshot.json`;
  assert.ok(failing.assertions[1].evidence.includes(assertionPath));
  assert.ok(JSON.parse(await readFile(resolve(".proofkit/electron-runs", assertionPath), "utf8")).text.includes("Resume ready"));
  const analysis = analyzeRun({ summary: failing, evidence: [{ evidenceId: `${failing.runId}:${assertionPath}`, kind: "snapshot",
    path: resolve(".proofkit/electron-runs", assertionPath), capturedAt: failing.endedAt }] });
  assert.equal(analysis.finding?.status, "confirmed");
  assert.equal(analysis.finding?.category, "unknown");
  console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
} finally {
  child.kill();
  server.close();
}

async function waitForCdp(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
