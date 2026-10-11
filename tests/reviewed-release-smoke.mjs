import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";
import { captureSourceState, collectWorkflowReviewMaterials, inspectWorkflowInventory, scanProject, signWorkflowReview } from "../packages/project/dist/index.js";

const runFile = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "proofkit-reviewed-release-"));
const source = join(scratch, "source");
const workspace = join(scratch, "workspace");
const profile = join(scratch, "electron-profile");
const trustRoot = join(scratch, "trust");
const browserPath = process.env.PROOFKIT_BROWSER_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const electronPath = process.env.PROOFKIT_ELECTRON_PATH
  ?? "D:\\code\\Python\\AIHR-Microservices\\node_modules\\.pnpm\\electron@28.3.3\\node_modules\\electron\\dist\\electron.exe";
const previousTrust = process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
let server;
let electron;
let mcpServer;
let client;
try {
  assert.ok(existsSync(browserPath) && existsSync(electronPath), "Real Chrome and Electron are required");
  await Promise.all([mkdir(join(source, "src"), { recursive: true }), mkdir(join(workspace, ".proofkit"), { recursive: true }),
    mkdir(join(workspace, "charters"), { recursive: true }), mkdir(profile), mkdir(trustRoot)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "reviewed-release-fixture", type: "module",
    devDependencies: { vite: "1", electron: "1" } }));
  await writeFile(join(source, "src", "main.ts"), "export const routes = [{ path: '/resumes' }];\n");
  await writeFile(join(source, "test-server.mjs"), `import { createServer } from "node:http";
createServer((request, response) => {
  if (request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "done" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Reviewed release</title><h1>Resume ready</h1>");
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`);
  const appCode = `const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.PROOFKIT_SMOKE_PROFILE);
app.commandLine.appendSwitch("remote-debugging-port", "0");
let window;
app.whenReady().then(() => {
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false } });
  window.loadURL(process.env.PROOFKIT_SMOKE_PAGE_URL);
});
app.on("window-all-closed", () => app.quit());
`;
  const appPath = join(source, "electron-app.cjs");
  await writeFile(appPath, appCode);
  await runFile("git", ["-C", source, "init", "-q"]);
  await runFile("git", ["-C", source, "-c", "core.autocrlf=false", "add", "."]);
  await runFile("git", ["-C", source, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"]);
  const sourceState = await captureSourceState(source);
  assert.ok(sourceState.complete && sourceState.headSha && sourceState.worktreeSha256);
  const map = await scanProject(source);
  assert.equal(map.inventory.truncated, false);
  const routes = map.inventory.routeHints.filter((route) => route.kind === "web" && route.path === "/resumes");
  assert.equal(routes.length, 1);
  server = spawn(process.execPath, [join(source, "test-server.mjs")], { cwd: source, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const port = await serverPort(server);
  const origin = `http://127.0.0.1:${port}`;
  electron = spawn(electronPath, [appPath], { stdio: "ignore", windowsHide: true,
    env: { ...process.env, PROOFKIT_SMOKE_PROFILE: profile, PROOFKIT_SMOKE_PAGE_URL: `${origin}/resumes` } });
  await waitForDevtools(join(profile, "DevToolsActivePort"), electron);
  const config = { project: { root: source }, surfaces: {
    web: { baseUrl: `${origin}/resumes`, executablePath: browserPath },
    electron: { devtoolsActivePort: join(profile, "DevToolsActivePort"), targetUrlPrefix: origin },
  }, charters: [{ id: "resume-release", path: "charters/resume.yaml", aliases: ["resume"], level: "release",
    surfaces: ["web", "electron"], routeTargets: routes.map((route) => ({ kind: "web", path: route.path, source: route.source })) }],
  oracles: [{ name: "resume-terminal", url: `${origin}/state`, statusPointer: "/data/status", successValues: ["done"] }],
  run: { timeoutMs: 90_000 }, policies: { targetBinding: "record" } };
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
  await writeFile(join(workspace, "charters", "resume.yaml"), JSON.stringify({ intent: "Verify resume release", level: "release",
    actions: [{ kind: "goto", url: `${origin}/resumes` }], assertions: [{ kind: "text-visible", text: "Resume ready" }],
    oracles: ["resume-terminal"], sideEffectPolicy: "deny" }));
  const inventory = { schemaVersion: 1, source: { headSha: sourceState.headSha, worktreeSha256: sourceState.worktreeSha256 },
    review: { by: "operator", at: new Date().toISOString(), method: "Reviewed every fixture entry and route" },
    workflows: [{ id: "resume", title: "Resume", sourcePaths: [...new Set(map.inventory.entryPoints.map((entry) => entry.path))],
      charterIds: ["resume-release"], surfaces: ["web", "electron"] }], exclusions: [] };
  await writeFile(join(workspace, ".proofkit", "workflows.yaml"), JSON.stringify(inventory));
  const inspected = await inspectWorkflowInventory(source, workspace, config, sourceState, map, {});
  assert.deepEqual(inspected.inspection.candidateAudit?.gaps, []);
  const materials = await collectWorkflowReviewMaterials(inventory, config, map, workspace);
  const keys = generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  await writeFile(join(workspace, ".proofkit", "workflow-review.json"), JSON.stringify(signWorkflowReview(inventory,
    inspected.inspection.candidateAudit, materials, "release-reviewer", privatePem)));
  const trustPath = join(trustRoot, "keys.json");
  await writeFile(trustPath, JSON.stringify({ "release-reviewer": publicPem }));
  process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = trustPath;
  mcpServer = await createProofkitMcp({ root: source, workspaceRoot: workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "reviewed-release-smoke", version: "1" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const started = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目上线", level: "release" } }));
  assert.equal(started.readiness.ready, true, JSON.stringify(started));
  assert.deepEqual(started.readiness.acceptanceGaps, []);
  const status = await waitForMission(client, started.missionId);
  const evidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
  assert.equal(status.mission.verdict, "passed", JSON.stringify({ findings: status.mission.findings, runs: evidence.summary.runs }));
  assert.equal(evidence.testVerdict, "passed", JSON.stringify({ reason: evidence.testVerdictReason,
    execution: evidence.summary.executionAudit, review: evidence.workflowReviewAudit, runs: evidence.summary.runs }));
  assert.equal(evidence.workflowReviewAudit?.status, "verified");
  assert.equal(evidence.summary.executionAudit?.status, "complete");
  assert.deepEqual(evidence.summary.runs.map((run) => `${run.surface}/${run.runKind}`).sort(),
    ["electron/primary", "electron/replay", "web/primary", "web/replay"]);
  assert.ok(evidence.summary.runs.filter((run) => run.surface === "electron").every((run) =>
    run.targetBinding?.status === "matching-process-path" && run.targetContinuity === "stable"
    && run.applicationBinding?.status === "matching-process-path" && run.applicationContinuity === "stable"));
  const cliArgs = ["bundle/main.js", "mission", "check", started.missionId, "--root", source, "--workspace", workspace];
  assert.equal(JSON.parse((await runFile(process.execPath, cliArgs, { timeout: 20_000 })).stdout).testVerdict, "passed");

  const otherSource = join(scratch, "other-source");
  await mkdir(otherSource);
  await writeFile(join(otherSource, "electron-app.cjs"), appCode);
  await runFile("git", ["-C", otherSource, "init", "-q"]);
  await stopElectron(electron);
  await rm(join(profile, "DevToolsActivePort"), { force: true });
  electron = spawn(electronPath, [join(otherSource, "electron-app.cjs")], { stdio: "ignore", windowsHide: true,
    env: { ...process.env, PROOFKIT_SMOKE_PROFILE: profile, PROOFKIT_SMOKE_PAGE_URL: `${origin}/resumes` } });
  await waitForDevtools(join(profile, "DevToolsActivePort"), electron);
  const foreign = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目上线", level: "release" } }));
  const foreignStatus = await waitForMission(client, foreign.missionId);
  const foreignEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: foreign.missionId } }));
  assert.equal(foreignStatus.mission.verdict, "passed", JSON.stringify({ findings: foreignStatus.mission.findings,
    runs: foreignEvidence.summary.runs }));
  assert.equal(foreignEvidence.workflowReviewAudit?.status, "verified");
  assert.ok(foreignEvidence.summary.runs.filter((run) => run.surface === "electron").every((run) =>
    run.targetBinding?.status === "matching-process-path" && run.applicationBinding?.status === "different-project"));
  assert.equal(foreignEvidence.summary.executionAudit?.status, "incomplete");
  assert.equal(foreignEvidence.testVerdict, "inconclusive");
  await assert.rejects(runFile(process.execPath, ["bundle/main.js", "mission", "check", foreign.missionId,
    "--root", source, "--workspace", workspace], { timeout: 20_000 }), (error) =>
    error.code === 2 && JSON.parse(error.stdout).testVerdict === "inconclusive");
  console.log(JSON.stringify({ reviewedMission: started.missionId, foreignElectronMission: foreign.missionId,
    matrix: evidence.summary.runs.map((run) => `${run.surface}/${run.runKind}`),
    reviewedVerdict: evidence.testVerdict, foreignVerdict: foreignEvidence.testVerdict }, null, 2));
} finally {
  if (previousTrust === undefined) delete process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
  else process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = previousTrust;
  await client?.close();
  await mcpServer?.close();
  if (electron) await stopElectron(electron);
  if (server?.exitCode === null) {
    const stopped = new Promise((done) => server.once("exit", done));
    server.kill();
    await stopped;
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function payload(result) {
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text, "MCP tool returned no text");
  return JSON.parse(text.text);
}

async function serverPort(child) {
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    const timer = setTimeout(() => rejectPort(new Error("Server did not report a port")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/)[0];
      if (/^\d+$/.test(line)) { clearTimeout(timer); resolvePort(Number(line)); }
    });
    child.once("exit", (code) => { clearTimeout(timer); rejectPort(new Error(`Server exited ${code}`)); });
  });
}

async function waitForDevtools(path, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* Electron is starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Electron CDP did not become ready");
}

async function stopElectron(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise((done) => child.once("exit", done));
  child.kill();
  await stopped;
}

async function waitForMission(mcpClient, missionId) {
  let status;
  for (let attempt = 0; attempt < 1800; attempt++) {
    status = payload(await mcpClient.callTool({ name: "get_mission_status", arguments: { missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) return status;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Mission did not finish: ${JSON.stringify(status?.taskSummary)}`);
}
