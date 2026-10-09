import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";
import { IntentPlanner, loadCharter } from "../packages/planner/dist/index.js";

// Real adapters and the complete Local Runner/Mission lifecycle. The gateway
// and PDF are isolated fixtures, not a running AIHR deployment or real data.
const surface = process.argv[2] ?? "web";
assert.ok(["web", "electron"].includes(surface), "Use web or electron");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const caseRoot = join(repoRoot, ".proofkit", "local-runner-smoke", `${surface}-${Date.now()}`);
const root = join(caseRoot, "source");
const workspaceRoot = join(caseRoot, "test-workspace");
await mkdir(root, { recursive: true });
await writeFile(join(root, "package.json"), JSON.stringify({ name: "aihr-isolated-source", devDependencies: { vite: "1" } }));
await mkdir(join(workspaceRoot, ".proofkit", "fixtures"), { recursive: true });
await mkdir(join(workspaceRoot, ".proofkit", "charters"));
await copyFile(join(repoRoot, ".proofkit", "integration.mjs"), join(workspaceRoot, ".proofkit", "integration.mjs"));
await copyFile(join(repoRoot, ".proofkit", "charters", "aihr-resume-upload.yml"), join(workspaceRoot, ".proofkit", "charters", "aihr-resume-upload.yml"));
await copyFile(join(repoRoot, ".proofkit", "charters", "aihr-resume-upload-idempotency.yml"), join(workspaceRoot, ".proofkit", "charters", "aihr-resume-upload-idempotency.yml"));
const fixture = Buffer.from("%PDF-1.4 isolated ProofKit gateway fixture\n", "utf8");
await writeFile(join(workspaceRoot, ".proofkit", "fixtures", "resume.pdf"), fixture);
const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");

let mode = "success";
let sequence = 900;
let collectionRunId;
let currentFile;
let uploaded = 0;
let unrelatedReads = 0;
const files = new Map();
const idempotentUploads = new Map();
const fixtureErrors = [];
const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    fixtureErrors.push(error.message);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "FIXTURE_ERROR", message: error.message }));
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AIHR_PROOFKIT_API_BASE_URL: `${baseUrl}/api/v1`,
  AIHR_PROOFKIT_ACCESS_TOKEN: "isolated-fixture-token",
  AIHR_PROOFKIT_ENTERPRISE_ID: "fixture-enterprise",
  AIHR_PROOFKIT_WORKSPACE_ID: "fixture-workspace",
  AIHR_PROOFKIT_USER_ID: "fixture-user",
  AIHR_PROOFKIT_SOURCE_CHANNEL: "boss",
  AIHR_PROOFKIT_CANDIDATE_UID: "fixture-candidate",
  AIHR_PROOFKIT_CONVERSATION_ID: "101",
  AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID: "fixture-account",
  AIHR_PROOFKIT_FIXTURE_PATH: ".proofkit/fixtures/resume.pdf",
  AIHR_PROOFKIT_JOB_ID: "505",
  AIHR_PROOFKIT_TEST_SCOPE: "proofkit:local-smoke",
  AIHR_PROOFKIT_CLIENT_ITEM_KEY: "proofkit:local-smoke:fixture-item",
});

let electronChild;
let profile;
let mcpServer;
let mcpClient;
try {
  const surfaces = { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) } };
  if (surface === "electron") {
    profile = await mkdtemp(join(tmpdir(), "proofkit-local-electron-"));
    const appPath = join(profile, "app.cjs");
    await writeFile(appPath, `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(profile)});
      app.commandLine.appendSwitch('remote-debugging-port','0');
      let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(baseUrl)});});
      app.on('window-all-closed',()=>app.quit());`, "utf8");
    const executable = process.env.PROOFKIT_ELECTRON_PATH ?? resolve(repoRoot, "../Python/AIHR-Microservices/node_modules/.pnpm/electron@28.3.3/node_modules/electron/dist/electron.exe");
    electronChild = spawn(executable, [appPath], { stdio: "ignore", windowsHide: true });
    let spawnError;
    electronChild.on("error", (error) => { spawnError = error; });
    const portFile = join(profile, "DevToolsActivePort");
    await waitForDevtools(portFile, () => spawnError ?? (electronChild.exitCode === null ? undefined : new Error("Electron exited before CDP was ready")));
    surfaces.electron = { devtoolsActivePort: portFile };
  }
  const ordinary = await loadCharter(join(repoRoot, ".proofkit", "charters", "aihr-resume-upload.yml"));
  const charter = TestCharterSchema.parse({
    ...ordinary,
    actions: [...ordinary.actions, { kind: "goto", url: baseUrl }, { kind: "click", selector: "#check" }, { kind: "waitForText", text: "Resume ready" }],
    assertions: [{ kind: "text-visible", text: "Resume ready" }],
  });
  await writeFile(join(workspaceRoot, ".proofkit", "charters", "aihr-resume-core-fixture.yml"), new IntentPlanner().toYaml(charter));
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(ProofkitConfigSchema.parse({
    project: { root },
    surfaces,
    policies: { environment: "test", sideEffects: "allow" },
    charters: [{
      id: "aihr-resume-core-fixture",
      path: ".proofkit/charters/aihr-resume-core-fixture.yml",
      aliases: ["简历获取"],
      level: "core",
      surfaces: ["web", "electron"],
    }],
  })));
  const service = await LocalRunnerService.create({ root, workspaceRoot, allowCapabilityWrites: true });
  assert.equal((await service.discover()).packageName, "aihr-isolated-source");
  assert.equal(service.listCharters()[0].id, "aihr-resume-core-fixture");
  mcpServer = await createProofkitMcp({ root, workspaceRoot, allowCapabilityWrites: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: "proofkit-aihr-smoke", version: "1" });
  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
  const catalog = mcpPayload(await mcpClient.callTool({ name: "list_test_charters", arguments: {} }));
  assert.equal(catalog.charters[0].id, "aihr-resume-core-fixture");

  // Run the checked-in Charter unchanged, including env references and defaults.
  const defaultRun = await service.start({ charterPath: ".proofkit/charters/aihr-resume-upload.yml", adapter: surface });
  const defaultSummary = await service.wait(defaultRun.runId);
  assert.equal(defaultSummary.verdict, "passed", JSON.stringify(defaultSummary.findings));
  assert.equal(defaultSummary.oracles.length, 1);
  assert.equal(defaultSummary.steps[1].capabilityOutput.fileSha256, fixtureSha256);
  assert.ok(defaultSummary.artifacts.some((artifact) => artifact.endsWith("/preflight.json")), "AIHR preflight evidence is missing");

  // The real MCP entrypoint selects the saved Charter from one sentence.
  const success = await runMcpMission(mcpClient, "测试简历获取");
  assert.equal(success.verdict, "passed", JSON.stringify(success.findings));
  assert.ok(success.evidence.some((evidence) => evidence.kind === "screenshot"));
  const successRunId = success.observations.find((item) => item.kind === "surface.run").data.runId;
  const successSummary = await service.wait(successRunId);
  assert.ok(successSummary.steps.some((step) => step.action.kind === "click"));
  assert.equal(successSummary.assertions[0].passed, true);
  assert.equal(successSummary.oracles[0].passed, true);

  // Seed a stale backend binding while the real UI still reports success.
  mode = "stale-binding";
  const failed = await runMcpMission(mcpClient, "测试简历获取");
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.firstFailure.kind, "business-oracle");
  assert.ok(failed.findings.some((finding) => finding.category === "product" && finding.status === "confirmed" && finding.evidence.length > 0));
  const failedRunId = failed.observations.find((item) => item.kind === "surface.run").data.runId;
  assert.equal((await service.wait(failedRunId)).assertions[0].passed, true);
  assert.equal(uploaded, 3);
  assert.equal(unrelatedReads, 0);
  assert.deepEqual(fixtureErrors, []);
  for (const evidence of [...success.evidence, ...failed.evidence]) await readFile(evidence.path);
  const restarted = await LocalRunnerService.create({ root, workspaceRoot });
  assert.equal((await restarted.missionEvidence(success.missionId)).verdict, "passed");
  assert.equal((await restarted.status(failedRunId)).verdict, "failed");
  assert.equal(defaultSummary.projectRoot, root);
  assert.equal(defaultSummary.workspaceRoot, workspaceRoot);
  assert.deepEqual(await readdir(root), ["package.json"]);
  mode = "success";
  process.env.AIHR_PROOFKIT_CLIENT_ITEM_KEY = "proofkit:local-smoke:idempotency:primary";
  const idempotencyCharter = await loadCharter(join(repoRoot, ".proofkit", "charters", "aihr-resume-upload-idempotency.yml"));
  const idempotencyMission = await runMission(service, idempotencyCharter);
  assert.equal(idempotencyMission.verdict, "passed", JSON.stringify(idempotencyMission.findings));
  const idempotencyNegative = idempotencyMission.observations.find((item) => item.data.runKind === "negative" && item.data.negativeCaseId === "duplicate-upload");
  assert.ok(idempotencyNegative, "idempotency negative run is missing");
  const idempotencySummary = await service.wait(idempotencyNegative.data.runId);
  assert.equal(idempotencySummary.oracles[0]?.name, "aihr.resumeUploadIdempotency");
  assert.equal(idempotencySummary.oracles[0]?.passed, true);

  let observerStarted;
  const observing = new Promise((resolveObserver) => { observerStarted = resolveObserver; });
  let observerSignal;
  let cleaned = false;
  const cancellationService = await LocalRunnerService.create({
    root, workspaceRoot, config: service.config,
    integration: {
      name: "cancellation-smoke",
      setup: async () => async () => { cleaned = true; },
      oracles: [{ name: "pending-terminal", async check({ runId, signal }) {
        observerSignal = signal;
        observerStarted(runId);
        await new Promise((_, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("Observer should have been cancelled");
      } }],
    },
  });
  const cancellationCharter = TestCharterSchema.parse({
    intent: "Cancel a pending business observation after real surface execution", level: "core",
    actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: "#check" }, { kind: "waitForText", text: "Resume ready" }],
    assertions: [{ kind: "text-visible", text: "Resume ready" }], oracles: ["pending-terminal"], sideEffectPolicy: "allow",
  });
  const cancellationMission = await cancellationService.createMission({ intent: cancellationCharter.intent, surface, charter: cancellationCharter });
  await cancellationService.startMission(cancellationMission.missionId, { approve: true });
  const pendingRunId = await observing;
  const cancelled = await cancellationService.cancelMission(cancellationMission.missionId);
  assert.equal(observerSignal.aborted, true);
  assert.equal(cleaned, true, "Cancellation returned before integration cleanup");
  assert.equal(cancelled.running, false);
  assert.equal(cancelled.mission.verdict, "cancelled");
  assert.equal((await cancellationService.wait(pendingRunId)).verdict, "cancelled");
  assert.equal((await cancellationService.status(pendingRunId)).status, "completed");
  assert.ok(cancelled.mission.agentSteps.some((step) => step.status === "cancelled" && step.evidence.some((item) => item.kind === "report")));
  const cancelledReport = cancelled.mission.evidence.find((item) => item.kind === "report");
  assert.match(await readFile(cancelledReport.path, "utf8"), /cancelled/);
  assert.deepEqual(await readdir(root), ["package.json"]);
  console.log(JSON.stringify({ surface, defaultRun: defaultRun.runId, successMission: success.missionId, seededDefectMission: failed.missionId, idempotencyMission: idempotencyMission.missionId, cancellationMission: cancellationMission.missionId, projectRoot: root, evidenceRoot: workspaceRoot, verified: ["external-workspace", "source-unchanged", "restart-status", "default-charter", "preflight-evidence", "multipart-run-binding", "surface-click", "mcp-one-sentence-core", "mcp-evidence", "core-mission", "stale-binding-detection", "idempotency-negative-case", "selected-oracle-only", "mission-cancellation", "cancelled-run-evidence", "cleanup-before-terminal"] }, null, 2));
} finally {
  await mcpClient?.close();
  await mcpServer?.close();
  if (electronChild && electronChild.exitCode === null) {
    const exited = new Promise((resolveExit) => electronChild.once("exit", resolveExit));
    electronChild.kill();
    await exited;
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function runMission(service, charter) {
  const mission = await service.createMission({ intent: charter.intent, surface, charter });
  await service.startMission(mission.missionId, { approve: true });
  return service.waitMission(mission.missionId);
}

async function runMcpMission(client, intent) {
  const started = mcpPayload(await client.callTool({ name: "run_test", arguments: { intent, surface } }));
  assert.equal(started.catalogId, "aihr-resume-core-fixture");
  assert.equal(started.level, "core");
  assert.equal(started.levelSelection.source, "default");
  assert.equal(started.readiness.ready, true);
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = mcpPayload(await client.callTool({ name: "get_mission_status", arguments: { missionId: started.missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.ok(status && ["completed", "failed", "blocked", "cancelled"].includes(status.mission.status), "MCP Mission did not finish");
  const evidence = mcpPayload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
  assert.equal(evidence.verdict, status.mission.verdict);
  assert.ok(evidence.evidence.some((item) => item.kind === "business"), "MCP business evidence is missing");
  return status.mission;
}

function mcpPayload(result) {
  const item = result.content.find((content) => content.type === "text");
  assert.ok(item, "MCP tool returned no text content");
  return JSON.parse(item.text);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, baseUrl);
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const send = (data) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "SUCCESS", data })); };
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>ProofKit isolated resume fixture</title><h1>Resume fixture</h1>
      <button id="check" onclick="fetch('/surface-status').then(r=>r.json()).then(r=>document.querySelector('#result').textContent=r.data.ready?'Resume ready':'Pending')">Check uploaded resume</button><div id="result"></div>`);
  } else if (path === "/surface-status") {
    send({ ready: Boolean(currentFile) });
  } else if (request.method === "POST" && path === "/resume-collection/runs") {
    for await (const _chunk of request) { /* consume the fixture request */ }
    collectionRunId = String(++sequence);
    send({ run_id: collectionRunId, source_channel: "boss", status: "pending" });
  } else if (request.method === "POST" && path === "/resume-collection/files") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Request(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": request.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
    assert.equal(form.get("run_id"), collectionRunId);
    assert.equal(form.get("target_job_ids"), "[505]");
    assert.equal(createHash("sha256").update(Buffer.from(await form.get("file").arrayBuffer())).digest("hex"), fixtureSha256);
    const clientItemKey = String(form.get("client_item_key") ?? "");
    const useIdempotencyFixture = clientItemKey.includes(":idempotency:");
    if (useIdempotencyFixture && idempotentUploads.has(clientItemKey)) {
      currentFile = idempotentUploads.get(clientItemKey);
      send({ ...currentFile, duplicate: true });
    } else {
      currentFile = { file_id: String(++sequence), run_id: collectionRunId, file_sha256: fixtureSha256, candidate_id: "902", source_platform: "boss", status: "accepted", extract_status: "done", parse_status: "matched" };
      files.set(currentFile.file_id, currentFile);
      if (useIdempotencyFixture) idempotentUploads.set(clientItemKey, currentFile);
      uploaded++;
      send({ ...currentFile, duplicate: false });
    }
  } else if (path.startsWith("/resume-collection/files/") && files.has(path.split("/").at(-1))) {
    send(files.get(path.split("/").at(-1)));
  } else if (path === "/jobs/505/candidates/902") {
    send({ candidate_summary: { current_resume_file_id: mode === "stale-binding" ? "777" : currentFile.file_id, job_id: "505", stage: "screening" } });
  } else if (path === "/assessments/jobs/505/candidates/902") {
    send({ assessment_id: "903", current_resume_file_id: currentFile.file_id, job_id: "505", candidate_id: "902", status: "completed", task_status: "success" });
  } else if (path === "/workflow-executions") {
    send({ items: [{ run_id: url.searchParams.get("run_id"), id: "904", screening_stage: "workflow_completion", candidate: { id: "902" }, job: { id: "505" }, status: "completed", record_type: "workflow_completion", screening_result: "passed" }], pagination: { page: 1, page_size: 100, total: 1 } });
  } else {
    if (path.startsWith("/boss-conversations/")) unrelatedReads++;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "NOT_FOUND", message: "Unknown fixture route" }));
  }
}

async function waitForDevtools(path, error) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (error()) throw error();
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* the isolated Electron process is still starting */ }
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  throw new Error("Isolated Electron CDP did not become ready");
}
