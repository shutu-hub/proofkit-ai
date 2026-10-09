import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Real Playwright Web and Electron/CDP runs against an isolated two-workflow fixture.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const caseRoot = join(repoRoot, ".proofkit", "local-runner-smoke", `release-suite-${Date.now()}`);
const sourceRoot = join(caseRoot, "source");
const workspaceRoot = join(caseRoot, "test-workspace");
await mkdir(sourceRoot, { recursive: true });
await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "release-suite-fixture", devDependencies: { vite: "1", electron: "1" } }));
const routeFile = join(sourceRoot, "apps", "web", "src", "router.ts");
const routeSource = "export const resume = { path: '/resume' };\nexport const login = { path: '/login' };\nexport const settings = { path: '/settings' };\n";
await mkdir(dirname(routeFile), { recursive: true });
await writeFile(routeFile, routeSource);
const apiRouteFile = join(sourceRoot, "services", "gateway", "router.ts");
const apiRouteSource = "router.post('/api/v1/resume/start', handler);\nrouter.post('/api/v1/login/start', handler);\n";
await mkdir(dirname(apiRouteFile), { recursive: true });
await writeFile(apiRouteFile, apiRouteSource);

let defect = false;
const state = { resume: "pending", login: "pending" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const flow = url.pathname.split("/").at(-2);
  const endpoint = url.pathname.split("/").at(-1);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Release suite fixture</title><h1>Release suite fixture</h1>");
    return;
  }
  if (request.method === "GET" && (url.pathname === "/resume" || url.pathname === "/login")) {
    const selected = url.pathname.slice(1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${selected} fixture</title><button id="start" onclick="fetch('/api/v1/${selected}/start',{method:'POST'}).then(()=>document.querySelector('#result').textContent='${selected} ready')">Start ${selected}</button><div id="result"></div>`);
    return;
  }
  if (request.method === "POST" && endpoint === "start" && flow in state) {
    state[flow] = defect && flow === "resume" ? "wrong" : "done";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "SUCCESS", data: { accepted: true } }));
    return;
  }
  if (request.method === "GET" && endpoint === "status" && flow in state) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "SUCCESS", data: { state: state[flow] } }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let electron;
let profile;
let mcpServer;
let client;
try {
  profile = await mkdtemp(join(tmpdir(), "proofkit-release-electron-"));
  const appPath = join(profile, "app.cjs");
  await writeFile(appPath, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(profile)});
    app.commandLine.appendSwitch('remote-debugging-port','0');
    let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(`${baseUrl}/resume`)});});
    app.on('window-all-closed',()=>app.quit());`, "utf8");
  const executable = process.env.PROOFKIT_ELECTRON_PATH ?? resolve(repoRoot, "../Python/AIHR-Microservices/node_modules/.pnpm/electron@28.3.3/node_modules/electron/dist/electron.exe");
  electron = spawn(executable, [appPath], { stdio: "ignore", windowsHide: true });
  let spawnError;
  electron.on("error", (error) => { spawnError = error; });
  const portFile = join(profile, "DevToolsActivePort");
  await waitForDevtools(portFile, () => spawnError ?? (electron.exitCode === null ? undefined : new Error("Electron exited before CDP was ready")));

  const surfaces = {
    web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) },
    electron: { devtoolsActivePort: portFile },
  };
  for (const flow of ["resume", "login"]) {
    const charter = TestCharterSchema.parse({
      intent: `test ${flow}`,
      level: "release",
      mode: "deterministic",
      actions: [{ kind: "goto", url: `${baseUrl}/${flow}` }, { kind: "click", selector: "#start" }, { kind: "waitForText", text: `${flow} ready` }],
      assertions: [{ kind: "text-visible", text: `${flow} ready` }],
      oracles: [`${flow}-terminal`],
      sideEffectPolicy: "allow",
    });
    await writeFile(join(workspaceRoot, ".proofkit", "charters", `${flow}.yml`), JSON.stringify(charter));
  }
  const config = ProofkitConfigSchema.parse({
    project: { root: sourceRoot },
    surfaces,
    policies: { environment: "test", sideEffects: "allow" },
    run: { timeoutMs: 15_000 },
    charters: ["resume", "login"].map((flow) => ({ id: flow, path: `.proofkit/charters/${flow}.yml`, aliases: [flow], level: "release", surfaces: ["web", "electron"], routeTargets: [
      { kind: "web", path: `/${flow}`, source: "apps/web/src/router.ts" },
      { kind: "api", method: "POST", path: `/api/v1/${flow}/start`, origin: baseUrl, source: "services/gateway/router.ts" },
    ] })),
    suites: [{ id: "release-critical", aliases: ["上线完整回归"], level: "release", charterIds: ["resume", "login"], surfaces: ["web", "electron"] }],
    oracles: ["resume", "login"].map((flow) => ({ name: `${flow}-terminal`, url: `${baseUrl}/api/v1/${flow}/status`, statusPointer: "/data/state", successValues: ["done"], failureValues: ["wrong"], intervalMs: 100, deadlineMs: 3_000 })),
  });
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(config));
  mcpServer = await createProofkitMcp({ root: sourceRoot, workspaceRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "release-suite-smoke", version: "1" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

  const good = await runSuite(client);
  assert.equal(good.status.mission.verdict, "passed", JSON.stringify(good.status.mission.findings));
  assert.equal(good.evidence.suiteScope.results.length, 4);
  assert.ok(good.evidence.suiteScope.results.every((item) => item.verdict === "passed" && item.replay.sourceRunId === item.primary.runId));
  assert.deepEqual({ candidates: good.evidence.suiteScope.routeCoverage.candidateRoutes, mapped: good.evidence.suiteScope.routeCoverage.mappedCandidates, observed: good.evidence.suiteScope.routeCoverage.observedCandidates }, { candidates: 5, mapped: 4, observed: 4 });
  assert.ok(good.evidence.suiteScope.routeCoverage.gaps.some((item) => item.path === "/settings" && item.status === "unmapped"));
  const goodRunIds = good.evidence.suiteScope.results.flatMap((item) => [item.primary.runId, item.replay.runId]);
  assert.equal(new Set(goodRunIds).size, 8);
  assert.ok(good.evidence.evidence.some((item) => item.kind === "network"));
  for (const item of good.evidence.evidence.filter((evidence) => ["business", "report", "network"].includes(evidence.kind))) await readFile(item.path);

  defect = true;
  const bad = await runSuite(client);
  assert.equal(bad.status.mission.verdict, "failed");
  assert.equal(bad.status.mission.firstFailure.kind, "business-oracle");
  assert.ok(bad.evidence.suiteScope.results.filter((item) => item.charterId === "resume").every((item) => item.verdict === "failed"));
  assert.ok(bad.evidence.suiteScope.results.filter((item) => item.charterId === "login").every((item) => item.verdict === "passed"));
  assert.equal(bad.evidence.suiteScope.routeCoverage.observedCandidates, 2);
  assert.ok(bad.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed" && item.charterId === "resume" && item.evidence.length > 0));
  assert.deepEqual(await readdir(sourceRoot), ["apps", "package.json", "services"]);
  assert.equal(await readFile(routeFile, "utf8"), routeSource);
  assert.equal(await readFile(apiRouteFile, "utf8"), apiRouteSource);
  console.log(JSON.stringify({ suite: "release-critical", goodMission: good.started.missionId, seededDefectMission: bad.started.missionId, verified: ["mcp-one-sentence-suite", "web-electron-primary-replay", "per-charter-oracle", "web-and-api-route-coverage-gaps", "independent-failure", "real-evidence-files", "source-unchanged"] }, null, 2));
} finally {
  await client?.close();
  await mcpServer?.close();
  if (electron && electron.exitCode === null) {
    const exited = new Promise((resolveExit) => electron.once("exit", resolveExit));
    electron.kill();
    await exited;
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function runSuite(mcpClient) {
  const started = payload(await mcpClient.callTool({ name: "run_test", arguments: { intent: "上线完整回归", suiteId: "release-critical", surface: "web" } }));
  assert.equal(started.readiness.ready, true);
  assert.equal(started.suiteId, "release-critical");
  let status;
  for (let attempt = 0; attempt < 500; attempt++) {
    status = payload(await mcpClient.callTool({ name: "get_mission_status", arguments: { missionId: started.missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(status && ["completed", "failed", "blocked", "cancelled"].includes(status.mission.status), "release suite did not finish");
  const evidence = payload(await mcpClient.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
  assert.equal(evidence.verdict, status.mission.verdict);
  return { started, status, evidence };
}

function payload(result) {
  const item = result.content.find((content) => content.type === "text");
  assert.ok(item, "MCP tool returned no text");
  return JSON.parse(item.text);
}

async function waitForDevtools(path, error) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (error()) throw error();
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* Electron is starting. */ }
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  throw new Error("Isolated Electron CDP did not become ready");
}
