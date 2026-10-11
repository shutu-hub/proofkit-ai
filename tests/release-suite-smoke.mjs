import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";
import { captureSourceState } from "../packages/project/dist/index.js";

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
let transientResumeFailures = 0;
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
    const transientFailure = flow === "resume" && transientResumeFailures > 0;
    if (transientFailure) transientResumeFailures--;
    state[flow] = flow === "resume" && (defect || transientFailure) ? "wrong" : "done";
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
let quickMcpServer;
let quickClient;
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
    // This fixture server runs in the smoke process, outside the synthetic source checkout.
    policies: { environment: "test", sideEffects: "allow", targetBinding: "record" },
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
  assert.deepEqual({ status: good.evidence.summary.replayConsistency.status,
    expected: good.evidence.summary.replayConsistency.expectedPairs,
    compared: good.evidence.summary.replayConsistency.comparedPairs }, { status: "agree", expected: 4, compared: 4 });
  assert.equal(good.evidence.suiteScope.results.length, 4);
  assert.ok(good.evidence.suiteScope.results.every((item) => item.verdict === "passed" && item.replay.sourceRunId === item.primary.runId));
  assert.deepEqual({ candidates: good.evidence.suiteScope.routeCoverage.candidateRoutes, mapped: good.evidence.suiteScope.routeCoverage.mappedCandidates, observed: good.evidence.suiteScope.routeCoverage.observedCandidates }, { candidates: 5, mapped: 4, observed: 4 });
  assert.ok(good.evidence.suiteScope.routeCoverage.gaps.some((item) => item.path === "/settings" && item.status === "unmapped"));
  const goodRunIds = good.evidence.suiteScope.results.flatMap((item) => [item.primary.runId, item.replay.runId]);
  assert.equal(new Set(goodRunIds).size, 8);
  for (const runId of goodRunIds) {
    const runRoot = join(workspaceRoot, ".proofkit", "runs", runId);
    const run = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
    const path = `${runId}/artifacts/assertion-001-snapshot.json`;
    assert.deepEqual(run.assertions[0].evidence.filter((item) => item.endsWith(".json")), [path]);
    const snapshot = JSON.parse(await readFile(join(runRoot, "artifacts", "assertion-001-snapshot.json"), "utf8"));
    assert.ok(snapshot.text.includes(run.assertions[0].assertion.text));
    assert.ok((await readFile(join(runRoot, "report.html"), "utf8")).includes('href="artifacts/assertion-001-snapshot.json"'));
  }
  assert.ok(good.evidence.evidence.some((item) => item.kind === "network"));
  for (const item of good.evidence.evidence.filter((evidence) => ["business", "report", "network"].includes(evidence.kind))) await readFile(item.path);

  transientResumeFailures = 1;
  const divergent = await runSuite(client);
  assert.equal(divergent.status.mission.verdict, "failed");
  assert.deepEqual({ status: divergent.evidence.summary.replayConsistency.status,
    compared: divergent.evidence.summary.replayConsistency.comparedPairs,
    divergent: divergent.evidence.summary.replayConsistency.divergentPairs }, { status: "diverge", compared: 4, divergent: 1 });
  assert.ok(divergent.evidence.summary.replayConsistency.pairs.some((pair) => pair.charterId === "resume"
    && pair.surface === "web" && pair.primaryVerdict === "failed" && pair.replayVerdict === "passed"));
  assert.ok((await readFile(divergent.evidence.report, "utf8")).includes("Primary and replay verdicts differ"));

  transientResumeFailures = 1;
  const singleStarted = payload(await client.callTool({ name: "run_test", arguments: {
    intent: "测试简历上线完整回归", charterId: "resume", surface: "web",
  } }));
  const singleStatus = await waitForMission(client, singleStarted.missionId);
  const singleEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: singleStarted.missionId } }));
  assert.equal(singleStatus.mission.verdict, "failed");
  assert.equal(singleEvidence.testVerdict, "failed");
  assert.equal(singleEvidence.summary.runs.length, 4);
  assert.equal(singleEvidence.summary.runs.filter((run) => run.runKind === "primary").length, 2);
  assert.equal(singleEvidence.summary.runs.filter((run) => run.runKind === "replay").length, 2);
  assert.equal(singleEvidence.summary.runs.find((run) => run.surface === "web" && run.runKind === "primary")?.verdict, "failed");
  assert.ok(singleEvidence.summary.runs.filter((run) => run.runKind === "replay").every((run) => run.verdict === "passed"));
  assert.equal(singleStatus.mission.plan.graph.tasks.filter((task) => task.status === "pending").length, 0);
  assert.ok(singleEvidence.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"));

  defect = true;
  const bad = await runSuite(client);
  assert.equal(bad.status.mission.verdict, "failed");
  assert.deepEqual({ status: bad.evidence.summary.replayConsistency.status,
    expected: bad.evidence.summary.replayConsistency.expectedPairs,
    compared: bad.evidence.summary.replayConsistency.comparedPairs }, { status: "agree", expected: 4, compared: 4 });
  assert.equal(bad.status.mission.firstFailure.kind, "business-oracle");
  assert.ok(bad.evidence.suiteScope.results.filter((item) => item.charterId === "resume").every((item) => item.verdict === "failed"));
  assert.ok(bad.evidence.suiteScope.results.filter((item) => item.charterId === "login").every((item) => item.verdict === "passed"));
  assert.equal(bad.evidence.suiteScope.routeCoverage.observedCandidates, 2);
  assert.ok(bad.status.mission.findings.some((item) => item.category === "product" && item.status === "confirmed" && item.charterId === "resume" && item.evidence.length > 0));
  defect = false;
  const replayStarted = payload(await client.callTool({ name: "replay_mission", arguments: { missionId: bad.started.missionId } }));
  assert.equal(replayStarted.mission.replayOfMissionId, bad.started.missionId);
  let replayStatus;
  for (let attempt = 0; attempt < 500; attempt++) {
    replayStatus = payload(await client.callTool({ name: "get_mission_status", arguments: { missionId: replayStarted.mission.missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(replayStatus.mission.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(replayStatus.mission.verdict, "passed", JSON.stringify(replayStatus.mission.findings));
  const comparison = payload(await client.callTool({ name: "compare_missions", arguments: { baselineMissionId: bad.started.missionId, candidateMissionId: replayStarted.mission.missionId } }));
  assert.equal(comparison.status, "verified-in-scope", JSON.stringify(comparison.gaps));
  assert.ok(comparison.defects.length >= 2 && comparison.defects.every((item) => item.outcome === "not-reproduced" && item.charterId === "resume"));
  assert.equal(comparison.runs.length, 8);
  const replayEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: replayStarted.mission.missionId } }));
  assert.equal(replayEvidence.summary.comparison.status, "verified-in-scope");
  await verifyMissionReports([good.evidence, bad.evidence, replayEvidence]);
  const cli = await promisify(execFile)(process.execPath, [join(repoRoot, "packages", "cli", "dist", "main.js"), "mission", "report", good.started.missionId, "--root", sourceRoot, "--workspace", workspaceRoot], { timeout: 15_000 });
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.summary.verdict, "passed");
  assert.equal(cliReport.report, good.evidence.report);

  // A partial static inventory must not prevent acceptance of a declared core flow.
  const extraRouteFile = join(sourceRoot, "apps", "web", "src", "extra-router.ts");
  const extraRouteSource = Array.from({ length: 230 }, (_, index) => `const route${index} = { path: '/extra-${index}' };`).join("\n");
  await writeFile(extraRouteFile, extraRouteSource);
  const savedResume = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "charters", "resume.yml"), "utf8"));
  const coreCharter = TestCharterSchema.parse({ ...savedResume, level: "core" });
  const scopedMissions = [];
  for (const surface of ["web", "electron"]) {
    const started = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试简历核心链路", charter: coreCharter, surface } }));
    assert.equal(started.readiness.ready, true);
    assert.deepEqual(started.planning.evidenceGaps, []);
    assert.equal(started.planning.coverage.requested, "declared");
    assert.equal(started.planning.coverage.inventory, "partial");
    assert.equal(started.planning.coverage.workflowCoverage, "unmeasured");
    assert.ok(started.planning.coverage.gaps.includes("project-map-truncated"));
    const status = await waitForMission(client, started.missionId);
    assert.equal(status.mission.verdict, "passed", JSON.stringify(status.mission.findings));
    const evidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
    assert.deepEqual(evidence.planning.coverage, started.planning.coverage);
    assert.equal(evidence.summary.planning.coverage.inventory, "partial");
    assert.ok((await readFile(evidence.report, "utf8")).includes("source inventory is partial"));
    assert.ok(evidence.evidence.some((item) => item.kind === "business"));
    for (const item of evidence.evidence.filter((item) => item.kind === "business")) await readFile(item.path);
    scopedMissions.push(started.missionId);
  }
  const singleWhole = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目", surface: "web", charter: coreCharter } }));
  assert.equal(singleWhole.running, false);
  assert.equal(singleWhole.readiness.ready, false);
  assert.ok(singleWhole.planning.evidenceGaps.includes("project-workflow-coverage"));
  await writeFile(join(workspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
    schemaVersion: 1, source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) },
    workflows: ["resume", "login"].map((id) => ({ id, title: id, sourcePaths: ["apps/web/src/router.ts"],
      checks: [{ charterId: id, surfaces: ["web", "electron"] }], surfaces: ["web", "electron"] })),
  }));
  const wholeSuite = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目", surface: "web", suiteId: "release-critical" } }));
  assert.equal(wholeSuite.readiness.ready, true);
  assert.ok(wholeSuite.readiness.acceptanceGaps.includes("project-workflow-coverage"));
  assert.equal(wholeSuite.planning.coverage.requested, "project");
  const wholeStatus = await waitForMission(client, wholeSuite.missionId);
  assert.equal(wholeStatus.mission.verdict, "inconclusive");
  const wholeEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: wholeSuite.missionId } }));
  assert.deepEqual({ status: wholeEvidence.workflowExecution.status, requiredChecks: wholeEvidence.workflowExecution.requiredChecks,
    evidencedChecks: wholeEvidence.workflowExecution.evidencedChecks }, { status: "all-declared-evidenced", requiredChecks: 4, evidencedChecks: 4 });
  assert.ok((await readFile(wholeEvidence.report, "utf8")).includes("Declared workflow execution: 4/4"));
  assert.deepEqual(await readdir(sourceRoot), ["apps", "package.json", "services"]);
  assert.equal(await readFile(routeFile, "utf8"), routeSource);
  assert.equal(await readFile(apiRouteFile, "utf8"), apiRouteSource);
  assert.equal(await readFile(extraRouteFile, "utf8"), extraRouteSource);

  const git = promisify(execFile);
  await git("git", ["init", "-q"], { cwd: sourceRoot });
  await git("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: sourceRoot });
  await git("git", ["-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"], { cwd: sourceRoot });
  const source = await captureSourceState(sourceRoot);
  assert.ok(source.complete && source.headSha && source.worktreeSha256);
  await writeFile(join(workspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
    schemaVersion: 1, source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
    review: { by: "fixture", at: new Date().toISOString(), method: "Declared the two fixture workflows" },
    workflows: [
      { id: "resume-flow", title: "Resume", sourcePaths: ["apps/web/src/router.ts"], checks: [{ charterId: "resume", surfaces: ["web"] }], surfaces: ["web"] },
      { id: "login-flow", title: "Login", sourcePaths: ["apps/web/src/router.ts"], checks: [{ charterId: "login", surfaces: ["electron"] }], surfaces: ["electron"] },
    ], exclusions: [],
  }));
  const directProject = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试整个项目上线", level: "release" } }));
  assert.equal(directProject.suiteId, "project-workflows");
  assert.equal(directProject.readiness.ready, true);
  assert.ok(directProject.readiness.acceptanceGaps.includes("project-workflow-coverage"));
  assert.deepEqual(directProject.taskSummary.filter((task) => task.tool === "surface.run-charter").map((task) => task.charterId), ["resume", "login"]);
  const directStatus = await waitForMission(client, directProject.missionId);
  assert.equal(directStatus.mission.verdict, "inconclusive");
  const directEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: directProject.missionId } }));
  assert.deepEqual(directEvidence.suiteScope.results.map((item) => `${item.charterId}/${item.surface}`), ["resume/web", "login/electron"]);
  assert.ok(directEvidence.suiteScope.results.every((item) => item.verdict === "passed" && item.replay.sourceRunId === item.primary.runId));
  assert.deepEqual({ status: directEvidence.workflowExecution.status, required: directEvidence.workflowExecution.requiredChecks,
    evidenced: directEvidence.workflowExecution.evidencedChecks, source: directEvidence.workflowExecution.sourceBinding },
  { status: "all-declared-evidenced", required: 2, evidenced: 2, source: "matching" });

  const quickWorkspaceRoot = join(caseRoot, "quick-workspace");
  await mkdir(join(quickWorkspaceRoot, ".proofkit", "charters"), { recursive: true });
  for (const flow of ["resume", "login"]) {
    const charter = TestCharterSchema.parse({
      intent: `quick ${flow}`, level: "quick", mode: "deterministic",
      actions: [{ kind: "goto", url: `${baseUrl}/${flow}` }, { kind: "click", selector: "#start" },
        { kind: "waitForText", text: `${flow} ready` }],
      assertions: [{ kind: "text-visible", text: `${flow} ready` }],
      oracles: [], sideEffectPolicy: "allow",
    });
    await writeFile(join(quickWorkspaceRoot, ".proofkit", "charters", `${flow}.yml`), JSON.stringify(charter));
  }
  const quickConfig = ProofkitConfigSchema.parse({ project: { root: sourceRoot }, surfaces,
    policies: { environment: "test", sideEffects: "allow", targetBinding: "record" },
    run: { timeoutMs: 15_000 },
    charters: ["resume", "login"].map((flow) => ({ id: flow, path: `.proofkit/charters/${flow}.yml`,
      aliases: [flow], level: "quick", surfaces: [flow === "resume" ? "web" : "electron"],
      routeTargets: [{ kind: "web", path: `/${flow}`, source: "apps/web/src/router.ts" },
        { kind: "api", method: "POST", path: `/api/v1/${flow}/start`, origin: baseUrl, source: "services/gateway/router.ts" }] })),
  });
  await writeFile(join(quickWorkspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(quickConfig));
  await writeFile(join(quickWorkspaceRoot, ".proofkit", "workflows.yaml"), JSON.stringify({
    schemaVersion: 1, source: { headSha: source.headSha, worktreeSha256: source.worktreeSha256 },
    review: { by: "fixture", at: new Date().toISOString(), method: "Declared quick fixture checks" },
    workflows: [
      { id: "resume-flow", title: "Resume", sourcePaths: ["apps/web/src/router.ts"], checks: [{ charterId: "resume", surfaces: ["web"] }], surfaces: ["web"] },
      { id: "login-flow", title: "Login", sourcePaths: ["apps/web/src/router.ts"], checks: [{ charterId: "login", surfaces: ["electron"] }], surfaces: ["electron"] },
    ], exclusions: [],
  }));
  quickMcpServer = await createProofkitMcp({ root: sourceRoot, workspaceRoot: quickWorkspaceRoot });
  const [quickClientTransport, quickServerTransport] = InMemoryTransport.createLinkedPair();
  quickClient = new Client({ name: "quick-project-smoke", version: "1" });
  await Promise.all([quickMcpServer.connect(quickServerTransport), quickClient.connect(quickClientTransport)]);
  const quickProject = payload(await quickClient.callTool({ name: "run_test", arguments: { intent: "快速测试整个项目" } }));
  assert.equal(quickProject.suiteId, "project-workflows");
  assert.equal(quickProject.levelSelection.resolved, "quick");
  assert.equal(quickProject.readiness.ready, true);
  const quickStatus = await waitForMission(quickClient, quickProject.missionId);
  assert.equal(quickStatus.mission.verdict, "inconclusive");
  const quickEvidence = payload(await quickClient.callTool({ name: "get_mission_evidence", arguments: { missionId: quickProject.missionId } }));
  assert.equal(quickEvidence.summary.expectedRuns, 2);
  assert.equal(quickEvidence.summary.observedRuns, 2);
  assert.deepEqual(quickEvidence.suiteScope.results.map((item) => `${item.charterId}/${item.surface}`), ["resume/web", "login/electron"]);
  assert.ok(quickEvidence.suiteScope.results.every((item) => item.verdict === "passed" && !item.replay));
  assert.deepEqual({ required: quickEvidence.workflowExecution.requiredChecks, evidenced: quickEvidence.workflowExecution.evidencedChecks, proof: quickEvidence.workflowExecution.requiredProof }, { required: 2, evidenced: 2, proof: "surface" });
  assert.ok(quickEvidence.workflowExecution.limitations.some((item) => item.includes("not independent business terminal state")));
  assert.equal(quickEvidence.proofClassification.businessOracles, 0);
  assert.ok(quickEvidence.suiteScope.routeCoverage.gaps.every((item) => item.kind !== "api" || item.status === "mapped-unobserved"));
  assert.equal((await captureSourceState(sourceRoot)).worktreeSha256, source.worktreeSha256);
  const acceptedAgain = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } }));
  assert.equal(acceptedAgain.testVerdict, "passed");
  assert.equal(acceptedAgain.summary.executionAudit.status, "complete");
  const savedMissionPath = join(workspaceRoot, ".proofkit", "missions", `${good.started.missionId}.json`);
  const savedMissionBytes = await readFile(savedMissionPath, "utf8");
  const wrongReplaySource = JSON.parse(savedMissionBytes);
  const webReplayObservation = wrongReplaySource.observations.find((item) => item.kind === "surface.run"
    && item.charterId === "resume" && item.data.surface === "web" && item.data.runKind === "replay");
  assert.ok(webReplayObservation);
  webReplayObservation.data.sourceRunId = "unrelated-run";
  await writeFile(savedMissionPath, JSON.stringify(wrongReplaySource));
  const wrongReplayEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } }));
  assert.equal(wrongReplayEvidence.verdict, "passed");
  assert.equal(wrongReplayEvidence.testVerdict, "inconclusive");
  assert.ok(wrongReplayEvidence.summary.executionAudit.issues.some((issue) => issue.includes("replay source")));
  assert.equal(JSON.parse(await readFile(join(dirname(wrongReplayEvidence.report), "summary.json"), "utf8")).testVerdict, "inconclusive");
  const checkedWrongReplay = await promisify(execFile)(process.execPath, [join(repoRoot, "packages", "cli", "dist", "main.js"),
    "mission", "check", good.started.missionId, "--root", sourceRoot, "--workspace", workspaceRoot], { timeout: 15_000 })
    .then(({ stdout }) => ({ code: 0, stdout }), (error) => {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout ?? "" };
    });
  assert.equal(checkedWrongReplay.code, 2);
  assert.equal(JSON.parse(checkedWrongReplay.stdout).testVerdict, "inconclusive");
  const duplicateMission = JSON.parse(savedMissionBytes);
  const primaryObservation = duplicateMission.observations.find((item) => item.kind === "surface.run"
    && item.charterId === "resume" && item.data.surface === "web" && item.data.runKind === "primary");
  assert.ok(primaryObservation);
  duplicateMission.observations.push({ ...primaryObservation, observationId: `duplicate-${primaryObservation.observationId}` });
  await writeFile(savedMissionPath, JSON.stringify(duplicateMission));
  const duplicateEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } }));
  assert.equal(duplicateEvidence.testVerdict, "inconclusive");
  assert.ok(duplicateEvidence.summary.executionAudit.issues.some((issue) => issue.includes("expected one Run observation, found 2")));
  const borrowedMission = JSON.parse(savedMissionBytes);
  const borrower = borrowedMission.observations.find((item) => item.kind === "surface.run"
    && item.charterId === "resume" && item.data.surface === "web" && item.data.runKind === "primary");
  const lender = borrowedMission.observations.find((item) => item.kind === "surface.run"
    && item.charterId === "resume" && item.data.surface === "electron" && item.data.runKind === "primary");
  assert.ok(borrower && lender);
  const borrowedReport = lender.evidence.find((ref) => ref.kind === "report");
  assert.ok(borrowedReport);
  borrower.evidence.push(borrowedReport);
  await writeFile(savedMissionPath, JSON.stringify(borrowedMission));
  const borrowedEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } }));
  assert.equal(borrowedEvidence.acceptanceEvidenceIntegrity.status, "intact");
  assert.equal(borrowedEvidence.testVerdict, "inconclusive");
  assert.ok(borrowedEvidence.summary.executionAudit.issues.some((issue) => issue.includes("does not belong to its Run")));
  const swappedMission = JSON.parse(savedMissionBytes);
  for (const [runKind, tool] of [["primary", "surface.run-charter"], ["replay", "surface.replay-charter"]]) {
    const web = swappedMission.observations.find((item) => item.kind === "surface.run"
      && item.charterId === "resume" && item.data.surface === "web" && item.data.runKind === runKind);
    const desktop = swappedMission.observations.find((item) => item.kind === "surface.run"
      && item.charterId === "resume" && item.data.surface === "electron" && item.data.runKind === runKind);
    assert.ok(web && desktop);
    web.data.surface = "electron";
    desktop.data.surface = "web";
    const webTask = swappedMission.plan.graph.tasks.find((task) => task.tool === tool && task.charterId === "resume" && task.input.adapter === "web");
    const desktopTask = swappedMission.plan.graph.tasks.find((task) => task.tool === tool && task.charterId === "resume" && task.input.adapter === "electron");
    assert.ok(webTask?.output?.runId && desktopTask?.output?.runId);
    [webTask.output.runId, desktopTask.output.runId] = [desktopTask.output.runId, webTask.output.runId];
  }
  await writeFile(savedMissionPath, JSON.stringify(swappedMission));
  const wrongAdapterEvidence = payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } }));
  assert.equal(wrongAdapterEvidence.acceptanceEvidenceIntegrity.status, "intact");
  assert.equal(wrongAdapterEvidence.testVerdict, "inconclusive");
  assert.ok(wrongAdapterEvidence.summary.executionAudit.issues.some((issue) => issue.includes("saved Run adapter")));
  await writeFile(savedMissionPath, savedMissionBytes);
  assert.equal(payload(await client.callTool({ name: "get_mission_evidence", arguments: { missionId: good.started.missionId } })).testVerdict, "passed");
  console.log(JSON.stringify({ suite: "release-critical", goodMission: good.started.missionId, divergentMission: divergent.started.missionId, singleReleaseMission: singleStarted.missionId, seededDefectMission: bad.started.missionId, repairedFixtureReplayMission: replayStarted.mission.missionId, projectScopeMission: wholeSuite.missionId, directProjectMission: directProject.missionId, quickProjectMission: quickProject.missionId, report: bad.evidence.report, review: join(caseRoot, "report-review"), scopedMissions, verified: ["mcp-one-sentence-suite", "web-electron-primary-replay", "single-charter-release-continues-after-product-failure", "saved-run-slot-audit-rejects-wrong-replay-and-duplicate", "saved-run-slot-audit-rejects-borrowed-evidence", "saved-run-facts-reject-wrong-adapter", "observed-replay-verdict-divergence", "per-charter-oracle", "assertion-time-observation-evidence", "web-and-api-route-coverage-gaps", "independent-failure", "evidence-backed-suite-comparison", "partial-map-core-web-electron", "whole-project-declared-check-measurement", "direct-inventory-project-mission", "quick-inventory-web-electron-no-business-pass", "whole-project-coverage-gate", "real-evidence-files", "source-unchanged", "mission-report-desktop-mobile", "report-evidence-links", "cli-mission-report"] }, null, 2));
} finally {
  await quickClient?.close();
  await quickMcpServer?.close();
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
  const status = await waitForMission(mcpClient, started.missionId);
  const evidence = payload(await mcpClient.callTool({ name: "get_mission_evidence", arguments: { missionId: started.missionId } }));
  assert.equal(evidence.verdict, status.mission.verdict);
  return { started, status, evidence };
}

async function verifyMissionReports(results) {
  const reviewRoot = join(caseRoot, "report-review");
  await mkdir(reviewRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) });
  try {
    const page = await browser.newPage();
    const errors = [];
    const externalRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith("file:")) externalRequests.push(request.url()); });
    for (const result of results) {
      assert.equal(result.reportUnavailable, undefined);
      assert.equal(result.summary.verdict, result.verdict);
      assert.equal(result.summary.expectedRuns, 8);
      assert.equal(result.summary.observedRuns, 8);
      assert.equal(result.summary.runs.length, 8);
      assert.ok(result.summary.runs.every((run) => run.taskId && run.runId));
      assert.ok(result.summary.runs.every((run) => run.verdict === "failed" ? run.issue === "Tool returned verdict failed" : !run.issue));
      const summary = JSON.parse(await readFile(join(dirname(result.report), "summary.json"), "utf8"));
      assert.deepEqual(summary, result.summary);
      const url = pathToFileURL(result.report).href;
      await page.setViewportSize({ width: 1365, height: 950 });
      await page.goto(url);
      assert.equal(await page.locator("tbody tr").count(), 8);
      assert.ok((await page.locator(".comparison").allInnerTexts()).some((text) => text.includes("Observed replay verdicts agree")));
      assert.ok((await page.locator(".scope").innerText()).includes("Whole-project workflow coverage has not been measured"));
      assert.ok((await page.locator("footer").innerText()).includes(`revision ${result.summary.revision}`));
      assert.equal(await page.locator(".unavailable").count(), 0);
      if (result.verdict === "failed") assert.ok((await page.locator("#first-failure").innerText()).length > 0);
      if (result.summary.comparison) assert.ok((await page.locator(".comparison").allInnerTexts()).some((text) => text.includes("Original defect not reproduced in tested scope")));
      await page.screenshot({ path: join(reviewRoot, `${result.verdict}-${result.summary.comparison ? "replay" : "initial"}-desktop.png`), fullPage: true });
      const reportLink = page.getByRole("link", { name: "Run report", exact: true }).first();
      const expectedUrl = new URL(await reportLink.getAttribute("href"), url).href;
      await reportLink.click();
      assert.equal(page.url(), expectedUrl);
      assert.ok((await page.locator("body").innerText()).includes("ProofKit"));
      await page.goto(url);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Report page overflows the narrow viewport");
      assert.ok(await page.locator(".table-wrap").evaluate((element) => element.scrollWidth > element.clientWidth), "Narrow matrix needs its own horizontal scroll");
      await page.screenshot({ path: join(reviewRoot, `${result.verdict}-${result.summary.comparison ? "replay" : "initial"}-mobile.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
}

async function waitForMission(mcpClient, missionId) {
  let status;
  for (let attempt = 0; attempt < 500; attempt++) {
    status = payload(await mcpClient.callTool({ name: "get_mission_status", arguments: { missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(status && ["completed", "failed", "blocked", "cancelled"].includes(status.mission.status), "Mission did not finish");
  return status;
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
