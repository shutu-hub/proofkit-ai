import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createWebArenaMcp } from "../scripts/webarena-mcp.mjs";
import { publicTask, upstreamCommit } from "../scripts/webarena-benchmark-lib.mjs";

// Scripted MCP and real Chrome, not autonomous public-task execution.
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-benchmark-mission-"));
const source = join(output, "source"), workspace = join(output, "workspace"), captures = join(output, "captures");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
let httpStatus = 200;
const fixturePrivate = "fixture-cookie-benchmark-only-33149";
let onHold;
const http = createServer((request, response) => {
  if (request.url === "/hold") { onHold?.(); return; }
  if (request.url === "/api/v1/todos/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state: httpStatus === 200 ? "available" : "unavailable" })); return;
  }
  response.writeHead(request.url === "/dashboard/todos" ? httpStatus : 200,
    { "content-type": "text/html; charset=utf-8", "set-cookie": `fixture_private=${fixturePrivate}; Path=/` });
  response.end('<title>Benchmark fixture</title><h1>Fixture ready</h1><a href="/dashboard/todos">Todos</a>');
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
await mkdir(source); await mkdir(join(workspace, ".proofkit"), { recursive: true });
const sourceBytes = JSON.stringify({ name: "benchmark-fixture", devDependencies: { vite: "1" } });
await writeFile(join(source, "package.json"), sourceBytes);
await writeFile(join(workspace, ".proofkit/config.yaml"), JSON.stringify(ProofkitConfigSchema.parse({
  project: { root: source }, surfaces: { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH
    ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) } },
  policies: { environment: "test", sideEffects: "allow", targetBinding: "record", runtime: { mode: "record" } },
  run: { timeoutMs: 15_000 },
})));
await writeFile(join(workspace, ".proofkit/integration.mjs"), `export default {name:'benchmark-fixture',version:'1',oracles:[{
  name:'fixture-todos',async check(context){
    const response=await fetch(${JSON.stringify(baseUrl + "/api/v1/todos/status")},{signal:context.signal});
    const data=await response.json();
    return {name:'fixture-todos',passed:response.status===200&&data.state==='available',
      message:'Independent fixture availability state',evidence:[JSON.stringify({status:response.status,state:data.state})]};
  }}]};`);
const inputPath = join(output, "public-tasks.json");
const upstream = process.env.PROOFKIT_WEBARENA_UPSTREAM, python = process.env.PROOFKIT_WEBARENA_PYTHON;
let dataset;
if (upstream && python) dataset = await json(join(upstream, "assets/dataset/webarena-verified.json"));
const publicInput = Buffer.from(JSON.stringify([dataset ? publicTask(dataset.find((task) => task.task_id === 44))
  : { taskId: 44, intent: "Open my todos page", startUrls: ["__GITLAB__"], sites: ["gitlab"] }]));
await writeFile(inputPath, publicInput);
const operatorPath = join(output, "operator.json");
const operator = { root: source, workspaceRoot: workspace, captureDirectory: captures, taskId: 44,
  publicInputPath: inputPath, publicInputSha256: hash(publicInput) };
await writeFile(operatorPath, JSON.stringify(operator));
const { server, session } = await createWebArenaMcp(operatorPath);
const client = new Client({ name: "scripted-benchmark-controller", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const results = [];
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
};
const charter = (path = "/dashboard/todos", text = "Fixture ready") => TestCharterSchema.parse({
  intent: "Open fixture todos page", level: "quick", mode: "guided", sideEffectPolicy: "deny",
  actions: [{ kind: "goto", url: `${baseUrl}${path}` }], assertions: [{ kind: "text-visible", text }],
});
async function mission(value, kind) {
  const created = await call("run_test", { intent: value.intent, charter: value, surface: "web", level: value.level });
  const missionId = created.missionId ?? created.mission?.missionId;
  assert.ok(missionId, JSON.stringify(created));
  if (kind === "cancelled") onHold = () => { void call("cancel_mission", { missionId }); };
  let current;
  for (let i = 0; i < 6; i++) {
    await call("await_test_result", { missionId, timeoutMs: 10_000 });
    current = (await call("get_mission_status", { missionId })).mission;
    if (["completed", "failed", "blocked", "cancelled"].includes(current.status)) break;
  }
  onHold = undefined;
  assert.ok(["completed", "failed", "blocked", "cancelled"].includes(current.status), JSON.stringify(current));
  const observations = current.observations.filter((item) => item.kind === "surface.run");
  assert.equal(observations.length, 1 + (value.negativeCases?.length ?? 0), JSON.stringify(current));
  const runId = observations.find((item) => item.data.runKind === "primary").data.runId;
  for (const observation of observations) {
    const associated = await session.auditRun(observation.data.runId);
    assert.equal(associated.status, "associated", JSON.stringify(associated));
    assert.equal(associated.runKind, observation.data.runKind);
  }
  const audit = await session.auditRun(runId);
  assert.equal(audit.status, "associated", JSON.stringify(audit));
  assert.equal(audit.runKind, "primary"); assert.equal(audit.missionId, missionId);
  const inspection = current.observations.find((item) => item.kind === "surface.inspected");
  if (inspection) {
    const inspectionAudit = await session.auditRun(inspection.data.inspectionId);
    assert.equal(inspectionAudit.status, "associated", JSON.stringify(inspectionAudit));
    assert.equal(inspectionAudit.runKind, "inspection");
    assert.notEqual(inspection.data.inspectionId, runId);
  }
  const evidence = await call("get_mission_evidence", { missionId, detail: "full" });
  assert.ok(!JSON.stringify(evidence).includes(captures), "ordinary MCP results must not expose raw captures");
  assert.ok(!JSON.stringify(evidence).includes(fixturePrivate), "raw cookies must not enter ordinary evidence");
  results.push({ kind, missionId, runId, verdict: current.verdict, audit, inspectionId: inspection?.data.inspectionId });
  return results.at(-1);
}

try {
  // Verify the operator's actual subprocess entrypoint, including clean MCP stdout.
  // This handshake is not a cross-process capture audit or an AI execution result.
  const stdioOperatorPath = join(output, "stdio-operator.json");
  await writeFile(stdioOperatorPath, JSON.stringify({ ...operator, captureDirectory: join(output, "stdio-captures") }));
  const stdioClient = new Client({ name: "scripted-benchmark-stdio-controller", version: "1" });
  const stdioTransport = new StdioClientTransport({ command: process.execPath,
    args: [join(repo, "scripts/webarena-mcp.mjs"), "--session", stdioOperatorPath], cwd: repo, stderr: "pipe" });
  let stdioErrors = "";
  stdioTransport.stderr.on("data", (bytes) => { stdioErrors += bytes.toString(); });
  try {
    await stdioClient.connect(stdioTransport);
    const stdioTools = await stdioClient.listTools();
    assert.ok(stdioTools.tools.some((tool) => tool.name === "run_test"));
    assert.ok(!JSON.stringify(stdioTools).includes("captureDirectory"));
    const discovery = await stdioClient.callTool({ name: "discover_project", arguments: {} });
    assert.ok(!discovery.isError, JSON.stringify(discovery));
    assert.ok(JSON.stringify(discovery).includes("benchmark-fixture"));
  } finally { await stdioClient.close(); await stdioTransport.close(); }
  assert.equal(stdioErrors, "");
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  assert.ok(!JSON.stringify(tools).includes("benchmarkCapture") && !JSON.stringify(tools).includes("captureDirectory"));
  const pass = await mission(charter(), "pass"); assert.equal(pass.verdict, "passed");
  const fail = await mission(charter("/dashboard/todos", "Missing fixture text"), "failed-assertion");
  assert.equal(fail.verdict, "failed");
  httpStatus = 500;
  const error = await mission(charter(), "http-500");
  httpStatus = 200;
  const cancelled = await mission(charter("/hold"), "cancelled");
  assert.equal(cancelled.verdict, "cancelled");
  const coreCharter = TestCharterSchema.parse({ ...charter(), level: "core", oracles: ["fixture-todos"],
    negativeCases: [{ caseId: "root-remains-available", title: "Root remains available without todos navigation", actions: [{ kind: "goto", url: baseUrl }],
      assertions: [{ kind: "text-visible", text: "Fixture ready" }], oracles: ["fixture-todos"],
      sideEffectPolicy: "deny", expectedVerdict: "passed" }] });
  const core = await mission(coreCharter, "core-primary-negative");
  assert.equal(core.verdict, "passed");
  const standaloneCharter = TestCharterSchema.parse({ ...charter(), metadata: {
    missionId: pass.missionId, missionTaskId: "run-web", runKind: "primary", benchmarkTaskId: 44 } });
  const standalone = await call("start_run", { charter: standaloneCharter, adapter: "web" });
  let standaloneStatus;
  for (let index = 0; index < 100; index++) {
    standaloneStatus = await call("get_run_status", { runId: standalone.runId });
    if (standaloneStatus.status === "completed" || standaloneStatus.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(standaloneStatus.status, "completed");
  const standaloneAudit = await session.auditRun(standalone.runId);
  assert.equal(standaloneAudit.status, "incomplete");
  assert.ok(standaloneAudit.issues.includes("standalone-run-has-no-mission-binding"));

  const finishedPath = join(captures, `${pass.runId}.finished.json`);
  const finishedBytes = await readFile(finishedPath);
  const wrongBinding = JSON.parse(finishedBytes.toString()); wrongBinding.taskId = 118;
  await writeFile(finishedPath, JSON.stringify(wrongBinding));
  assert.ok((await session.auditRun(pass.runId)).issues.includes("capture-binding-changed"));
  await writeFile(finishedPath, finishedBytes);
  const harPath = join(captures, pass.runId, "network.har"), originalHar = await readFile(harPath);
  await writeFile(harPath, Buffer.concat([originalHar, Buffer.from(" ")]));
  assert.ok((await session.auditRun(pass.runId)).issues.includes("network-trace-changed"));
  await writeFile(harPath, originalHar);
  const runPath = join(workspace, `.proofkit/runs/${pass.runId}/run.json`);
  const runBytes = await readFile(runPath);
  await writeFile(runPath, Buffer.concat([runBytes, Buffer.from(" ")]));
  assert.ok((await session.auditRun(pass.runId)).issues.includes("saved-run-changed"));
  await writeFile(runPath, runBytes);
  const missionPath = join(workspace, `.proofkit/missions/${pass.missionId}.json`);
  const missionBytes = await readFile(missionPath), changed = JSON.parse(missionBytes.toString());
  changed.observations = changed.observations.filter((item) => item.data.runId !== pass.runId);
  await writeFile(missionPath, JSON.stringify(changed));
  assert.equal((await session.auditRun(pass.runId)).status, "incomplete");
  await writeFile(missionPath, missionBytes);
  assert.equal((await session.auditRun("orphan-run")).status, "incomplete");
  assert.equal((await session.auditRun(pass.runId)).status, "associated");

  // Independent official judging receives this actual Mission's browser trace.
  let official = { status: "not-run", reason: "official-environment-not-configured" };
  if (dataset) {
    const execute = promisify(execFile);
    const head = (await execute("git", ["-C", upstream, "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim();
    assert.equal(head, upstreamCommit);
    const datasetSha256 = hash(await readFile(join(upstream, "assets/dataset/webarena-verified.json")));
    const response = join(output, "agent_response.json");
    await writeFile(response, JSON.stringify({ task_type: "NAVIGATE", status: "SUCCESS", retrieved_data: null, error_details: null }));
    const cases = await Promise.all([pass, error, cancelled].map(async ({ runId }) => ({ caseId: runId, taskId: 44, response,
      responseSha256: hash(await readFile(response)), trace: join(captures, runId, "network.har"),
      traceSha256: hash(await readFile(join(captures, runId, "network.har"))) })));
    const request = join(output, "official-request.json");
    await writeFile(request, JSON.stringify({ operation: "evaluate", datasetSha256,
      environments: { __GITLAB__: { urls: [baseUrl] } }, cases }));
    const { stdout } = await execute(python, [join(repo, "scripts/webarena-evaluator.py"), "--upstream", upstream, "--request", request],
      { timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    official = JSON.parse(stdout);
    await writeFile(join(output, "official-results.json"), JSON.stringify(official, null, 2));
    assert.deepEqual(official.results.map(({ result }) => result.status), ["success", "failure", "failure"]);
  }
  assert.equal(await readFile(join(source, "package.json"), "utf8"), sourceBytes);
  assert.deepEqual(await readdir(source), ["package.json"]);
  await writeFile(inputPath, "[]");
  await assert.rejects(createWebArenaMcp(operatorPath), /public input changed/);
  const report = { mode: "scripted-mcp-mission-har-fixture", results, official,
    stdioEntrypoint: { connected: true, discovery: true, autonomousExecution: false },
    webArenaTasksExecuted: 0, proofkitEffectiveness: "not-measured", taskTrajectory: "separate-browser-contexts" };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, results: results.map(({ kind, verdict, audit }) => ({ kind, verdict, association: audit.status })),
    official: official.results?.map(({ result }) => result.status) ?? official, proofkitEffectiveness: "not-measured" }, null, 2));
} finally {
  await client.close(); await server.close();
  http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
}
