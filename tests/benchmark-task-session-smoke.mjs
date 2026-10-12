import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
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
import { publicTask } from "../scripts/webarena-benchmark-lib.mjs";

// Scripted local fixture: persistent state and complete evidence, no AI benchmark score.
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-benchmark-task-"));
const source = join(output, "source"), workspace = join(output, "workspace"), captures = join(output, "captures");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const loginStarted = deferred(), releaseLogin = deferred();
const holdStarted = deferred();
const privateCookie = "benchmark-http-only-cookie-73091";
let roots = 0, logins = 0, authenticatedTodos = 0;
const http = createServer(async (request, response) => {
  if (request.url === "/hold") { holdStarted.resolve(); return; }
  if (request.url === "/login" && request.method === "POST") {
    logins++; loginStarted.resolve(); await releaseLogin.promise;
    response.writeHead(303, { location: "/dashboard", "set-cookie": `session=${privateCookie}; HttpOnly; Path=/` }); response.end(); return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/dashboard/todos") {
    const authenticated = request.headers.cookie?.includes(privateCookie);
    if (authenticated) authenticatedTodos++;
    response.statusCode = authenticated ? 200 : 401;
    response.end(`<h1>${authenticated ? "Todos ready" : "Unauthorized"}</h1>`); return;
  }
  if (request.url === "/dashboard") {
    response.end(`<h1>Dashboard ready</h1><button id="todos">Todos</button><script>
      localStorage.setItem('fixture-login','ready');sessionStorage.setItem('fixture-tab','ready');window.fixtureState='ready';
      document.querySelector('#todos').onclick=()=>{
        if(localStorage.getItem('fixture-login')==='ready'&&sessionStorage.getItem('fixture-tab')==='ready'&&window.fixtureState==='ready')
          location.href='/dashboard/todos';
      };</script>`); return;
  }
  if (request.url === "/") roots++;
  response.end('<h1>Login page</h1><form action="/login" method="post"><button id="login">Login</button></form>');
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
await mkdir(source); await mkdir(join(workspace, ".proofkit"), { recursive: true });
const sourceBytes = JSON.stringify({ name: "persistent-browser-fixture", devDependencies: { vite: "1" } });
await writeFile(join(source, "package.json"), sourceBytes);
await writeFile(join(workspace, ".proofkit/config.yaml"), JSON.stringify(ProofkitConfigSchema.parse({
  project: { root: source }, surfaces: { web: { baseUrl } },
  policies: { environment: "test", sideEffects: "allow", targetBinding: "record", runtime: { mode: "record" } }, run: { timeoutMs: 15_000 },
})));
const upstream = process.env.PROOFKIT_WEBARENA_UPSTREAM, python = process.env.PROOFKIT_WEBARENA_PYTHON;
const dataset = upstream && python ? await json(join(upstream, "assets/dataset/webarena-verified.json")) : undefined;
const publicBytes = Buffer.from(JSON.stringify([dataset ? publicTask(dataset.find((task) => task.task_id === 44))
  : { taskId: 44, intent: "Open my todos page", startUrls: ["__GITLAB__"], sites: ["gitlab"] }]));
const inputPath = join(output, "public-tasks.json"), operatorPath = join(output, "operator.json");
await writeFile(inputPath, publicBytes);
await writeFile(operatorPath, JSON.stringify({ root: source, workspaceRoot: workspace, captureDirectory: captures,
  taskId: 44, publicInputPath: inputPath, publicInputSha256: hash(publicBytes), browser: {
    startUrl: baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined),
  } }));
const { server, session } = await createWebArenaMcp(operatorPath);
const client = new Client({ name: "scripted-persistent-task-controller", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
};
const answer = { task_type: "NAVIGATE", status: "SUCCESS", retrieved_data: null, error_details: null };
const charter = (actions, text) => TestCharterSchema.parse({ intent: "Exercise persistent fixture state", level: "quick",
  mode: "guided", sideEffectPolicy: "allow", actions, assertions: [{ kind: "text-visible", text }] });
async function waitMission(created) {
  const missionId = created.missionId ?? created.mission?.missionId;
  for (let count = 0; count < 6; count++) {
    await call("await_test_result", { missionId, timeoutMs: 10_000 });
    const current = (await call("get_mission_status", { missionId })).mission;
    if (["completed", "failed", "blocked", "cancelled"].includes(current.status)) return current;
  }
  throw new Error("Mission did not reach a terminal state");
}
async function run(value) { return waitMission(await call("run_test", { intent: value.intent, charter: value, surface: "web", level: "quick" })); }

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const firstInspection = await call("inspect_surface", { surface: "web" });
  assert.ok(JSON.stringify(firstInspection).includes("Login page"));
  assert.equal((await session.auditTask()).status, "incomplete");
  const login = await call("run_test", { intent: "Log into the fixture", surface: "web", level: "quick",
    charter: charter([{ kind: "click", selector: "#login" }], "Dashboard ready") });
  await Promise.race([loginStarted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Login did not start")), 15_000).unref())]);
  const premature = await client.callTool({ name: "submit_benchmark_task", arguments: answer });
  assert.equal(premature.isError, true, "submission cannot race a browser action");
  await assert.rejects(session.begin("parallel-run"), /lifecycle|serially/);
  releaseLogin.resolve();
  const loginMission = await waitMission(login); assert.equal(loginMission.verdict, "passed");
  const secondInspection = await call("inspect_surface", { surface: "web" });
  assert.ok(JSON.stringify(secondInspection).includes("Dashboard ready"));
  const failed = await run(charter([{ kind: "observe" }], "Missing target")); assert.equal(failed.verdict, "failed");
  const completed = await run(charter([{ kind: "click", selector: "#todos" }], "Todos ready"));
  assert.equal(completed.verdict, "passed");
  const result = await call("submit_benchmark_task", answer);
  assert.equal(result.status, "captured", JSON.stringify(result));
  assert.equal(result.taskTrajectory, "persistent-task-context");
  assert.equal(roots, 1, "inspection and subsequent Missions must not reset to the initial URL");
  assert.equal(logins, 1); assert.equal(authenticatedTodos, 1);
  assert.ok(!JSON.stringify(result).includes(captures));
  const failedRuns = failed.observations.filter((item) => item.kind === "surface.run").map((item) => item.data.runId);
  assert.ok(failedRuns.every((id) => result.runIds.includes(id)), "failed attempts must remain in the final trajectory");
  const taskRecord = await json(join(captures, "task.finished.json"));
  assert.deepEqual(taskRecord.runIds, taskRecord.browserRunIds);
  assert.equal(taskRecord.capture.context, "task-owned");
  const tracePath = join(captures, "task/network.har"), trace = await readFile(tracePath);
  assert.equal(hash(trace), taskRecord.capture.sha256);
  const har = JSON.parse(trace.toString());
  assert.ok(har.log.entries.some((entry) => entry.request.method === "POST" && entry.request.url.endsWith("/login")));
  assert.ok(har.log.entries.some((entry) => entry.request.url.endsWith("/dashboard/todos") && entry.response.status === 200));
  for (const mission of [loginMission, failed, completed]) {
    for (const observation of mission.observations.filter((item) => ["surface.run", "surface.inspected"].includes(item.kind))) {
      assert.equal((await session.auditRun(observation.data.runId ?? observation.data.inspectionId)).status, "associated");
    }
    const evidence = await call("get_mission_evidence", { missionId: mission.missionId, detail: "full" });
    assert.ok(!JSON.stringify(evidence).includes(privateCookie));
  }
  await assert.rejects(session.begin("after-submission"), /lifecycle|serially/);
  const repeated = await client.callTool({ name: "submit_benchmark_task", arguments: answer });
  assert.equal(repeated.isError, true);
  const responsePath = join(captures, "agent_response.json"), response = await readFile(responsePath);
  await writeFile(responsePath, "{}"); assert.ok((await session.auditTask()).issues.includes("task-submission-changed"));
  await writeFile(responsePath, response);
  await writeFile(tracePath, Buffer.concat([trace, Buffer.from(" ")])); assert.equal((await session.auditTask()).status, "incomplete");
  await writeFile(tracePath, trace);
  const recordPath = join(captures, "task.finished.json"), recordBytes = await readFile(recordPath);
  await writeFile(recordPath, JSON.stringify({ ...taskRecord, runIds: taskRecord.runIds.filter((id) => !failedRuns.includes(id)) }));
  assert.ok((await session.auditTask()).issues.includes("task-record-changed")); await writeFile(recordPath, recordBytes);
  assert.equal((await session.auditTask()).status, "captured");

  // A cancelled navigation may still have in-flight browser work. The task
  // owner must retire that context and reject any later action in this task.
  const cancelledOperatorPath = join(output, "cancelled-operator.json");
  const cancelledCaptures = join(output, "cancelled-captures");
  await writeFile(cancelledOperatorPath, JSON.stringify({ ...await json(operatorPath), captureDirectory: cancelledCaptures }));
  const cancelledOwner = await createWebArenaMcp(cancelledOperatorPath);
  const cancelledClient = new Client({ name: "scripted-cancellation-controller", version: "1" });
  const [cancelledClientTransport, cancelledServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([cancelledOwner.server.connect(cancelledServerTransport), cancelledClient.connect(cancelledClientTransport)]);
    const created = await cancelledClient.callTool({ name: "run_test", arguments: {
      intent: "Exercise cancellation", surface: "web", level: "quick",
      charter: charter([{ kind: "goto", url: `${baseUrl}/hold` }], "Never ready"),
    } });
    assert.ok(!created.isError, JSON.stringify(created));
    const missionId = JSON.parse(created.content.find((item) => item.type === "text").text).missionId;
    await Promise.race([holdStarted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Held request did not start")), 15_000).unref())]);
    const cancelled = await cancelledClient.callTool({ name: "cancel_mission", arguments: { missionId } });
    assert.ok(!cancelled.isError, JSON.stringify(cancelled));
    let terminal;
    for (let attempt = 0; attempt < 6; attempt++) {
      await cancelledClient.callTool({ name: "await_test_result", arguments: { missionId, timeoutMs: 10_000 } });
      const status = await cancelledClient.callTool({ name: "get_mission_status", arguments: { missionId } });
      terminal = JSON.parse(status.content.find((item) => item.type === "text").text).mission;
      if (["completed", "failed", "blocked", "cancelled"].includes(terminal.status)) break;
    }
    assert.equal(terminal?.verdict, "cancelled");
    assert.equal(cancelledOwner.session.webTask.unavailableReason, "run-interrupted");
    await assert.rejects(cancelledOwner.session.begin("after-cancel"), /lifecycle/);
    const cancellationSubmission = await cancelledClient.callTool({ name: "submit_benchmark_task", arguments: answer });
    assert.ok(!cancellationSubmission.isError, JSON.stringify(cancellationSubmission));
    assert.equal(JSON.parse(cancellationSubmission.content.find((item) => item.type === "text").text).status, "incomplete");
    assert.equal((await json(join(cancelledCaptures, "task/capture.json"))).context, "task-owned");
  } finally { await cancelledClient.close(); await cancelledOwner.server.close(); await cancelledOwner.session.abandonTask(); }

  // Exercise the actual stdio entrypoint with a live browser before closing
  // the client; it must leave a raw capture but no fabricated final answer.
  const stdioOperatorPath = join(output, "stdio-operator.json");
  const stdioCaptures = join(output, "stdio-captures");
  await writeFile(stdioOperatorPath, JSON.stringify({ ...await json(operatorPath), captureDirectory: stdioCaptures }));
  const stdioClient = new Client({ name: "scripted-stdio-cleanup-controller", version: "1" });
  const stdioTransport = new StdioClientTransport({ command: process.execPath,
    args: [join(repo, "scripts/webarena-mcp.mjs"), "--session", stdioOperatorPath], cwd: repo, stderr: "pipe" });
  let stderr = "";
  stdioTransport.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  try {
    await stdioClient.connect(stdioTransport);
    const inspected = await stdioClient.callTool({ name: "inspect_surface", arguments: { surface: "web" } });
    assert.ok(!inspected.isError, JSON.stringify(inspected));
  } finally { await stdioClient.close(); await stdioTransport.close(); }
  assert.equal(stderr, "");
  assert.equal((await json(join(stdioCaptures, "task/capture.json"))).context, "task-owned");
  await assert.rejects(readFile(join(stdioCaptures, "task.finished.json")));

  let official = { status: "not-run", reason: "official-environment-not-configured" };
  if (dataset) {
    const requestPath = join(output, "official-request.json");
    await writeFile(requestPath, JSON.stringify({ operation: "evaluate", datasetSha256: hash(await readFile(join(upstream, "assets/dataset/webarena-verified.json"))),
      environments: { __GITLAB__: { urls: [baseUrl] } }, cases: [{ caseId: "persistent-task", taskId: 44,
        response: responsePath, responseSha256: hash(response), trace: tracePath, traceSha256: hash(trace) }] }));
    const { stdout } = await promisify(execFile)(python, [join(repo, "scripts/webarena-evaluator.py"), "--upstream", upstream, "--request", requestPath],
      { timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    official = JSON.parse(stdout); assert.equal(official.results[0].result.status, "success");
  }
  assert.equal(await readFile(join(source, "package.json"), "utf8"), sourceBytes); assert.deepEqual(await readdir(source), ["package.json"]);
  const report = { mode: "scripted-persistent-task-fixture", audit: await session.auditTask(), roots, logins, authenticatedTodos,
    cancelledContextRetired: true, stdioAbandonmentCaptured: true,
    failedRunsRetained: failedRuns, official, webArenaTasksExecuted: 0, proofkitEffectiveness: "not-measured" };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, runs: result.runIds.length, status: result.status, official: official.results?.[0].result.status ?? official,
    webArenaTasksExecuted: 0, proofkitEffectiveness: "not-measured" }, null, 2));
} finally {
  releaseLogin.resolve(); await client.close(); await server.close(); await session.abandonTask();
  http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
}
