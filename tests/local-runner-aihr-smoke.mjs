import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { loadCharter } from "../packages/planner/dist/index.js";

// Real adapters and the complete Local Runner/Mission lifecycle. The gateway
// and PDF are isolated fixtures, not a running AIHR deployment or real data.
const surface = process.argv[2] ?? "web";
assert.ok(["web", "electron"].includes(surface), "Use web or electron");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repoRoot, ".proofkit", "local-runner-smoke", `${surface}-${Date.now()}`);
await mkdir(join(root, ".proofkit", "fixtures"), { recursive: true });
await copyFile(join(repoRoot, ".proofkit", "integration.mjs"), join(root, ".proofkit", "integration.mjs"));
const fixture = Buffer.from("%PDF-1.4 isolated ProofKit gateway fixture\n", "utf8");
await writeFile(join(root, ".proofkit", "fixtures", "resume.pdf"), fixture);
const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");

let mode = "success";
let sequence = 900;
let collectionRunId;
let currentFile;
let uploaded = 0;
let unrelatedReads = 0;
const files = new Map();
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
  AIHR_PROOFKIT_CLIENT_ITEM_KEY: "fixture-item",
});

let electronChild;
let profile;
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
  const service = await LocalRunnerService.create({ root, config: ProofkitConfigSchema.parse({ surfaces, policies: { environment: "test", sideEffects: "allow" } }), allowCapabilityWrites: true });
  const ordinary = await loadCharter(join(repoRoot, ".proofkit", "charters", "aihr-resume-upload.yml"));

  // Run the checked-in Charter unchanged, including env references and defaults.
  const defaultRun = await service.start({ charter: ordinary, adapter: surface });
  const defaultSummary = await service.wait(defaultRun.runId);
  assert.equal(defaultSummary.verdict, "passed", JSON.stringify(defaultSummary.findings));
  assert.equal(defaultSummary.oracles.length, 1);
  assert.equal(defaultSummary.steps[1].capabilityOutput.fileSha256, fixtureSha256);

  // Add a real surface path to the business Charter to exercise the core gate.
  const charter = TestCharterSchema.parse({
    ...ordinary,
    actions: [...ordinary.actions, { kind: "goto", url: baseUrl }, { kind: "click", selector: "#check" }, { kind: "waitForText", text: "Resume ready" }],
    assertions: [{ kind: "text-visible", text: "Resume ready" }],
  });
  const success = await runMission(service, charter);
  assert.equal(success.verdict, "passed", JSON.stringify(success.findings));
  assert.ok(success.evidence.some((evidence) => evidence.kind === "screenshot"));
  const successRunId = success.observations.find((item) => item.kind === "surface.run").data.runId;
  const successSummary = await service.wait(successRunId);
  assert.ok(successSummary.steps.some((step) => step.action.kind === "click"));
  assert.equal(successSummary.assertions[0].passed, true);
  assert.equal(successSummary.oracles[0].passed, true);

  // Seed a stale backend binding while the real UI still reports success.
  mode = "stale-binding";
  const failed = await runMission(service, charter);
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.firstFailure.kind, "business-oracle");
  assert.ok(failed.findings.some((finding) => finding.category === "product" && finding.status === "confirmed" && finding.evidence.length > 0));
  const failedRunId = failed.observations.find((item) => item.kind === "surface.run").data.runId;
  assert.equal((await service.wait(failedRunId)).assertions[0].passed, true);
  assert.equal(uploaded, 3);
  assert.equal(unrelatedReads, 0);
  assert.deepEqual(fixtureErrors, []);
  for (const evidence of [...success.evidence, ...failed.evidence]) await readFile(evidence.path);
  console.log(JSON.stringify({ surface, defaultRun: defaultRun.runId, successMission: success.missionId, seededDefectMission: failed.missionId, evidenceRoot: root, verified: ["default-charter", "multipart-run-binding", "surface-click", "core-mission", "stale-binding-detection", "selected-oracle-only"] }, null, 2));
} finally {
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
    currentFile = { file_id: String(++sequence), run_id: collectionRunId, file_sha256: fixtureSha256, candidate_id: "902", source_platform: "boss", status: "accepted", extract_status: "done", parse_status: "matched" };
    files.set(currentFile.file_id, currentFile);
    uploaded++;
    send({ ...currentFile, duplicate: false });
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
