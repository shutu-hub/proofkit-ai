import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

const scratch = await mkdtemp(join(tmpdir(), "proofkit-inspection-"));
const source = join(scratch, "source");
const workspaceRoot = join(scratch, "workspace");
const fillEnvName = "PROOFKIT_INSPECTION_FILL_VALUE";
const previousFillValue = process.env[fillEnvName];
let mcp;
let client;
let electron;
const web = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (["/delayed", "/diagnostics", "/never"].includes(path)) {
    response.end(`<!doctype html><title>Delayed inspection fixture</title><div id="app"></div><script>
      ${path === "/diagnostics" ? "setTimeout(()=>{for(let i=0;i<15;i++)console.error('runtime diagnostic '+i+' qa@example.com');},450);" : ""}
      ${path === "/never" ? "" : "setTimeout(()=>{document.querySelector('#app').innerHTML='<h1>Delayed controls ready</h1><button id=ready>Continue</button>';},1200);"}
    </script>`);
    return;
  }
  response.end(`<!doctype html><title>Inspection fixture</title><h1>Resume intake</h1>
    <p>qa@example.com 13800138000</p>
    <label for="candidate">Candidate</label><input id="candidate" data-testid="candidate-field" value="private candidate value" oninput="document.querySelector('#result').textContent='Candidate updated'">
    <button id="fetch" onclick="document.querySelector('#result').textContent='Resume ready'">Fetch resume</button>
    <button onclick="document.querySelector('#result').textContent='Details ready'">Show details</button>
    <button>Duplicate</button><button>Duplicate</button>
    <div id="result"></div>`);
});
try {
  await Promise.all([mkdir(source), mkdir(workspaceRoot)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "inspection-source", devDependencies: { vite: "1" } }));
  await new Promise((done) => web.listen(0, "127.0.0.1", done));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Inspection fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}/?token=private`;
  await mkdir(join(workspaceRoot, ".proofkit"));
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
    project: { root: source }, surfaces: { web: { baseUrl,
      ...(process.env.PROOFKIT_BROWSER_PATH || process.platform === "win32"
        ? { executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" }
        : {}) } },
    policies: { environment: "test", sideEffects: "allow", runtime: { mode: "record" } },
  }));

  mcp = await createProofkitMcp({ root: source, workspaceRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "inspection-smoke", version: "1" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  const response = await client.callTool({ name: "inspect_surface", arguments: { surface: "web" } });
  assert.equal(response.isError, undefined);
  const inspection = JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(inspection.status, "observed", JSON.stringify(inspection));
  assert.equal(inspection.testVerdict, "not-asserted");
  assert.equal(inspection.readiness.status, "not-requested");
  assert.equal(inspection.snapshot.url, `http://127.0.0.1:${address.port}/`);
  assert.equal(inspection.snapshot.text.includes("qa@example.com"), false);
  assert.equal(inspection.snapshot.text.includes("13800138000"), false);
  assert.equal(JSON.stringify(inspection).includes("private candidate value"), false);
  const fetchControl = inspection.snapshot.controls.find((item) => item.name === "Fetch resume");
  const details = inspection.snapshot.controls.find((item) => item.name === "Show details");
  const candidate = inspection.snapshot.controls.find((item) => item.name === "Candidate");
  const duplicates = inspection.snapshot.controls.filter((item) => item.name === "Duplicate");
  assert.equal(fetchControl?.selector, "#fetch");
  assert.equal(candidate?.selector, '[data-testid="candidate-field"]');
  assert.equal(details?.selector, 'role=button[name="Show details"]');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((item) => item.selector === undefined));
  assert.ok(inspection.evidence.some((item) => item.kind === "screenshot"));
  const saved = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "runs", inspection.inspectionId, "run.json"), "utf8"));
  assert.equal(saved.steps[0].afterSnapshot.controls.length >= 2, true);

  const runner = await LocalRunnerService.create({ root: source, workspaceRoot, restrictWebOrigins: true });
  const origin = new URL(baseUrl).origin;
  const readyWhen = { text: "Delayed controls ready", timeoutMs: 5000 };
  const delayedResponse = await client.callTool({ name: "inspect_surface", arguments: { surface: "web", url: `${origin}/delayed`, readyWhen } });
  assert.equal(delayedResponse.isError, undefined);
  const delayed = JSON.parse(delayedResponse.content.find((item) => item.type === "text").text);
  assert.equal(delayed.status, "observed");
  assert.equal(delayed.readiness.status, "observed");
  assert.equal(delayed.snapshot.controls.find((item) => item.name === "Continue")?.selector, "#ready");
  const delayedRun = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", delayed.inspectionId, "run.json"), "utf8"));
  assert.deepEqual(delayedRun.charter.actions.map((action) => action.kind), ["waitForText", "observe"]);
  assert.equal(delayedRun.steps[0].beforeSnapshot.text.includes("Delayed controls ready"), false, "The fixture must begin before its delayed UI exists");

  const configuredRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
    surfaces: { ...runner.config.surfaces, web: { ...runner.config.surfaces.web, baseUrl: `${origin}/delayed`, readyWhen } } } });
  const configured = await configuredRunner.inspectSurface();
  assert.deepEqual(configured.readiness, { status: "observed", condition: readyWhen });
  const absent = await configuredRunner.inspectSurface({ readyWhen: { text: "Missing condition", timeoutMs: 100 } });
  assert.equal(absent.status, "failed");
  assert.equal(absent.readiness.status, "unverified");
  assert.equal(absent.snapshot, undefined);
  assert.equal(absent.testVerdict, "not-asserted");
  assert.ok(absent.findings.length > 0);
  const diagnostics = await runner.inspectSurface({ url: `${origin}/diagnostics`, readyWhen });
  assert.equal(diagnostics.status, "observed");
  assert.equal(diagnostics.runtimeHealth, "failed");
  assert.equal(diagnostics.runtimeFindings.length, 10);
  assert.equal(diagnostics.runtimeFindingsOmitted, 5);
  assert.ok(diagnostics.runtimeFindings.every((finding) => finding.evidence.length > 0));
  assert.equal(JSON.stringify(diagnostics.runtimeFindings).includes("qa@example.com"), false);
  const beforeInvalid = await readdir(join(workspaceRoot, ".proofkit/runs"));
  await assert.rejects(runner.inspectSurface({ readyWhen: { text: " ", timeoutMs: 100 } }));
  await assert.rejects(runner.inspectSurface({ readyWhen: { text: "ready", timeoutMs: 15001 } }));
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit/runs")), beforeInvalid);

  const cancel = new AbortController();
  const pending = runner.inspectSurface({ url: `${origin}/never`, readyWhen, signal: cancel.signal });
  const cancelTimer = setTimeout(() => cancel.abort(new Error("Readiness cancelled by smoke")), 1500);
  let cancelled;
  try { cancelled = await pending; } finally { clearTimeout(cancelTimer); }
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.readiness.status, "unverified");
  assert.ok(cancelled.findings.some((finding) => finding.includes("Readiness cancelled by smoke")));

  if (process.env.PROOFKIT_ELECTRON_PATH) {
    const profile = join(scratch, "electron-profile");
    await mkdir(profile);
    const app = join(profile, "app.cjs");
    await writeFile(app, `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('remote-debugging-port','0');
      let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(`${origin}/delayed`)});});
      app.on('window-all-closed',()=>app.quit());`);
    electron = spawn(process.env.PROOFKIT_ELECTRON_PATH, [app], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let startupDiagnostics = "";
    electron.stderr.on("data", (chunk) => { startupDiagnostics = (startupDiagnostics + chunk).slice(-2000); });
    let spawnError;
    electron.on("error", (error) => { spawnError = error; });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15000;
    let cdpReady = false;
    let probeDiagnostic = "not-probed";
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (electron.exitCode !== null) throw new Error("Electron exited before readiness inspection");
      try {
        const port = (await readFile(portFile, "utf8")).split(/\r?\n/)[0];
        probeDiagnostic = `port=${JSON.stringify(port)}`;
        if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) { cdpReady = true; break; }
      } catch (error) { probeDiagnostic = error.message; }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(cdpReady, `Electron CDP endpoint did not appear: ${probeDiagnostic}; ${startupDiagnostics}`);
    const desktopRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
      surfaces: { ...runner.config.surfaces, electron: { devtoolsActivePort: portFile, readyWhen } } } });
    const desktop = await desktopRunner.inspectSurface({ adapter: "electron" });
    assert.equal(desktop.status, "observed");
    assert.equal(desktop.readiness.status, "observed");
    assert.equal(desktop.snapshot.controls.find((item) => item.name === "Continue")?.selector, "#ready");
    const desktopAbsent = await desktopRunner.inspectSurface({ adapter: "electron", readyWhen: { text: "Missing condition", timeoutMs: 100 } });
    assert.equal(desktopAbsent.status, "failed");
    assert.equal(desktopAbsent.readiness.status, "unverified");
  }
  const started = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Use the observed semantic selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: details.selector }],
    assertions: [{ kind: "text-visible", text: "Details ready" }], sideEffectPolicy: "allow", metadata: {},
  } });
  assert.equal((await runner.wait(started.runId)).verdict, "passed");
  process.env[fillEnvName] = "inspection-fixture-value";
  const fillResponse = await client.callTool({ name: "run_test", arguments: {
    intent: "Fill using a runtime test variable", level: "quick", surface: "web", charter: {
      intent: "Fill using a runtime test variable", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "fill", selector: candidate.selector, value: { env: fillEnvName } }],
      assertions: [{ kind: "text-visible", text: "Candidate updated" }], sideEffectPolicy: "allow", metadata: {},
    },
  } });
  assert.equal(fillResponse.isError, undefined);
  const fillMission = JSON.parse(fillResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(fillMission.readiness.ready, true, JSON.stringify(fillMission.readiness));
  let fillStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const statusResponse = await client.callTool({ name: "get_mission_status", arguments: { missionId: fillMission.missionId } });
    fillStatus = JSON.parse(statusResponse.content.find((item) => item.type === "text")?.text ?? "null");
    if (["completed", "failed", "blocked", "cancelled"].includes(fillStatus.mission.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(fillStatus.mission.verdict, "passed", JSON.stringify(fillStatus.mission.findings));
  const savedMission = await readFile(join(workspaceRoot, ".proofkit", "missions", `${fillMission.missionId}.json`), "utf8");
  assert.equal(savedMission.includes("inspection-fixture-value"), false);
  const fillRunId = JSON.parse(savedMission).observations.find((item) => item.kind === "surface.run")?.data.runId;
  assert.ok(fillRunId);
  const fillEvidence = await readFile(join(workspaceRoot, ".proofkit", "runs", fillRunId, "run.json"), "utf8");
  assert.equal(fillEvidence.includes("inspection-fixture-value"), false);
  assert.deepEqual(JSON.parse(fillEvidence).charter.actions[0].value, { env: fillEnvName });
  const ambiguous = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Reject an ambiguous selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: 'role=button[name="Duplicate"]' }],
    assertions: [{ kind: "text-visible", text: "Details ready" }], sideEffectPolicy: "allow", metadata: {},
  } });
  const ambiguousSummary = await runner.wait(ambiguous.runId);
  assert.equal(ambiguousSummary.verdict, "failed");
  assert.ok(ambiguousSummary.findings.some((finding) => finding.includes("matched 2 elements")));
  assert.deepEqual(await readdir(source), ["package.json"]);
  console.log(JSON.stringify({ inspectionId: inspection.inspectionId, controls: inspection.snapshot.controls.length,
    selector: details.selector, electronReadiness: process.env.PROOFKIT_ELECTRON_PATH ? "verified" : "not-run",
    verified: ["mcp-inspect-surface", "delayed-ui-readiness", "configured-readiness", "unverified-missing-condition", "bounded-runtime-diagnostics", "readiness-cancellation", "invalid-input-before-run", "redacted-snapshot", "unique-role-selector", "ambiguous-controls-without-selector", "ambiguous-action-rejected", "reusable-selector", "runtime-fill-reference", "source-unchanged"] }, null, 2));
} finally {
  if (electron && electron.exitCode === null) {
    const exited = new Promise((done) => electron.once("exit", done));
    electron.kill();
    await exited;
  }
  if (previousFillValue === undefined) delete process.env[fillEnvName];
  else process.env[fillEnvName] = previousFillValue;
  await client?.close();
  await mcp?.close();
  await new Promise((done) => web.close(() => done()));
  const safe = resolve(scratch);
  if (!safe.startsWith(resolve(tmpdir()) + sep) || !safe.split(sep).at(-1)?.startsWith("proofkit-inspection-")) {
    throw new Error("Inspection scratch directory escaped the temporary directory");
  }
  await rm(safe, { recursive: true, force: true });
}
