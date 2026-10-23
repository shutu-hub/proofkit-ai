import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService, PlanningObservationError } from "../packages/local-runner/dist/index.js";
import { registerTools } from "../packages/mcp/dist/tools.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-auto-planning-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-auto-planning-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
let unavailable = false, writes = 0, providerCalls = 0, providerMode = "normal";
const savedAccounts = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/login") {
    const account = url.searchParams.get("account") === "alpha" ? "alpha" : "beta";
    response.writeHead(302, { "set-cookie": `account=${account}; Path=/; HttpOnly`, location: "/account" }); response.end(); return;
  }
  if (url.pathname === "/save" && request.method === "POST") {
    writes++; savedAccounts.push(/account=(alpha|beta)/.exec(request.headers.cookie ?? "")?.[1] ?? "anonymous");
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return;
  }
  if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  const account = /account=(alpha|beta)/.exec(request.headers.cookie ?? "")?.[1] ?? "anonymous";
  response.writeHead(unavailable ? 503 : 200, { "content-type": "text/html; charset=utf-8" });
  response.end(unavailable ? "<h1>Target unavailable</h1>" : `<h1>Workspace ready</h1><p>Current account: ${account}</p><button id="save">Save for ${account}</button><output>Ready</output><script>
    document.querySelector('button').onclick = async () => { await fetch('/save', { method: 'POST' }); document.querySelector('output').textContent = 'Saved'; };
  </script>`);
});
let runner, client, mcpServer;
try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Automatic planning fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot, start: "node -e \"process.exit(97)\"" },
    surfaces: { web: { baseUrl, readyWhen: { text: "Workspace ready", timeoutMs: 500 }, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" } }),
    plannerProvider: { name: "automatic-observation-fixture", plan: async ({ surfaceSnapshot }) => {
      providerCalls++;
      assert.ok(surfaceSnapshot?.controls?.some((control) => control.selector === "#save"), "The provider must receive an actual page observation before planning");
      if (providerMode === "mutate-observation") surfaceSnapshot.controls.find((control) => control.selector === "#save").name = "Invented target";
      return { intent: providerMode === "narrow-intent" ? "Only observe" : "Save the current draft", level: "quick",
        mode: providerMode === "changed-mode" ? "explore" : "deterministic", sideEffectPolicy: "allow", actions: [
        { kind: "click", selector: providerMode === "unseen" ? "#unseen" : "#save" }, { kind: "waitForText", text: "Saved" }],
        assertions: [{ kind: "text-visible", text: "Saved" }], metadata: {} };
    } } });
  const options = { url: baseUrl, level: "quick", sideEffectPolicy: "allow", headful };
  const charter = await runner.plan("Save the current draft", options);
  assert.equal(writes, 0, "Planning must not execute proposed actions or project.start");
  assert.equal(providerCalls, 1);
  assert.ok(charter.surfaceObservation.source);
  assert.equal(charter.actions[0].expectedTarget.name, "Save for anonymous");
  const source = charter.surfaceObservation.source;
  const inspection = await runner.wait(source.runId);
  assert.equal(inspection.charter.metadata.purpose, "surface-inspection");
  assert.equal(inspection.charter.sideEffectPolicy, "deny");
  assert.equal(inspection.execution.visibility, headful ? "headful" : "headless");
  assert.equal((await runner.verifyEvidenceManifest(source.runId, source.manifestSha256)).status, "intact");
  const snapshotPath = join(runner.evidenceDir, source.snapshotPath);
  const originalSnapshot = await readFile(snapshotPath);
  await writeFile(snapshotPath, "changed original observation");
  const stopped = await runner.start({ adapter: "web", start: false, charter });
  const stoppedSummary = await runner.wait(stopped.runId);
  assert.equal(stoppedSummary.verdict, "inconclusive"); assert.equal(stoppedSummary.steps.length, 0); assert.equal(writes, 0);
  await writeFile(snapshotPath, originalSnapshot);
  const started = await runner.start({ adapter: "web", headful, start: false, charter });
  const completed = await runner.wait(started.runId);
  assert.equal(completed.verdict, "passed", JSON.stringify(completed, null, 2)); assert.equal(writes, 1);
  const runReport = join(runner.evidenceDir, started.runId, "report.html");
  assert.ok((await readFile(runReport, "utf8")).includes("Planning observation"));
  assert.ok((await readFile(runReport, "utf8")).includes(`../${source.runId}/report.html`));

  providerMode = "unseen";
  const unbound = await runner.plan("Save the current draft", options);
  const unboundRun = await runner.start({ adapter: "web", start: false, charter: unbound });
  assert.equal((await runner.wait(unboundRun.runId)).steps.length, 0); assert.equal(writes, 1);
  providerMode = "mutate-observation";
  await assert.rejects(runner.plan("Save the current draft", options), PlanningObservationError);
  providerMode = "normal";

  const first = await runner.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "goto", url: `${baseUrl}/login?account=alpha` } });
  const second = await runner.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "goto", url: `${baseUrl}/login?account=beta` } });
  assert.ok(first.sessionId && second.sessionId);
  const bound = await runner.plan("Save the current draft", { level: "quick", sideEffectPolicy: "allow", sessionId: first.sessionId });
  assert.equal(bound.surfaceObservation.sessionId, first.sessionId);
  assert.equal(bound.actions[0].expectedTarget.name, "Save for alpha");
  for (const sessionId of [undefined, second.sessionId]) {
    const wrong = await runner.start({ adapter: "web", start: false, charter: bound, ...(sessionId ? { sessionId } : {}) });
    const result = await runner.wait(wrong.runId);
    assert.equal(result.verdict, "inconclusive"); assert.equal(result.steps.length, 0); assert.equal(writes, 1);
  }
  const right = await runner.start({ adapter: "web", start: false, charter: bound, sessionId: first.sessionId });
  assert.equal((await runner.wait(right.runId)).verdict, "passed"); assert.equal(savedAccounts.at(-1), "alpha");
  assert.equal(runner.listSurfaceSessions().sessions.find((session) => session.sessionId === second.sessionId).reusable, true);
  const accountMission = await runner.createMission({ intent: "Save the current draft", level: "quick", sideEffectPolicy: "allow", sessionId: first.sessionId });
  assert.equal(accountMission.charter.surfaceObservation.sessionId, first.sessionId);
  await runner.startMission(accountMission.missionId, { approve: true }); await runner.waitMission(accountMission.missionId);
  const accountEvidence = await runner.missionEvidence(accountMission.missionId);
  assert.equal(accountEvidence.testVerdict, "passed"); assert.equal(accountEvidence.summary.planningObservation.status, "verified");
  assert.equal(savedAccounts.at(-1), "alpha");

  const mission = await runner.createMission({ intent: "Save the current draft", url: baseUrl, level: "quick", sideEffectPolicy: "allow", headful });
  assert.ok(mission.charter.surfaceObservation.source);
  await runner.startMission(mission.missionId, { approve: true }); await runner.waitMission(mission.missionId);
  const evidence = await runner.missionEvidence(mission.missionId);
  assert.equal(evidence.testVerdict, "passed"); assert.equal(evidence.summary.planningObservation.status, "verified");
  assert.ok((await readFile(evidence.report, "utf8")).includes("Planning observation"));
  const missionSource = mission.charter.surfaceObservation.source;
  const missionSnapshotPath = join(runner.evidenceDir, missionSource.snapshotPath);
  const missionOriginal = await readFile(missionSnapshotPath); await writeFile(missionSnapshotPath, "changed planning context after execution");
  const changedContext = await runner.missionEvidence(mission.missionId);
  assert.equal(changedContext.summary.planningObservation.status, "unverified"); assert.equal(changedContext.testVerdict, evidence.testVerdict);
  assert.ok(!(await readFile(changedContext.report, "utf8")).includes(`href="../../runs/${missionSource.runId}/report.html"`));
  await writeFile(missionSnapshotPath, missionOriginal); await runner.missionEvidence(mission.missionId);

  mcpServer = new McpServer({ name: "automatic-planning-smoke", version: "0.1.0" }); registerTools(mcpServer, runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); client = new Client({ name: "smoke-client", version: "0.1.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const mcpPlan = await client.callTool({ name: "plan_test", arguments: { intent: "Save the current draft", url: baseUrl, level: "quick", sideEffectPolicy: "allow", headful } });
  assert.equal(mcpPlan.isError, undefined); assert.ok(JSON.parse(mcpPlan.content[0].text).charter.surfaceObservation.source);
  providerMode = "changed-mode";
  const writesBeforeModeRefusal = writes;
  const missionsBeforeModeRefusal = await readdir(join(workspaceRoot, ".proofkit", "missions"));
  for (const tool of ["plan_test", "create_test_mission", "run_test"]) {
    const rejected = await client.callTool({ name: tool, arguments: { intent: "Save the current draft", url: baseUrl, level: "quick", sideEffectPolicy: "allow", mode: "deterministic", headful } });
    assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /requested execution mode/);
    assert.equal(writes, writesBeforeModeRefusal);
  }
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit", "missions")), missionsBeforeModeRefusal);
  providerMode = "narrow-intent";
  const originalRequest = "Save the current draft and wait for Saved. Preserve this original request; do not share or delete records.";
  const preserved = await client.callTool({ name: "plan_test", arguments: { intent: originalRequest, url: baseUrl, level: "quick", sideEffectPolicy: "allow", mode: "deterministic", headful } });
  assert.equal(preserved.isError, undefined); assert.equal(JSON.parse(preserved.content[0].text).charter.intent, originalRequest);
  providerMode = "normal";
  const callsBeforeFailure = providerCalls, writesBeforeFailure = writes;
  unavailable = true;
  const missionsBeforeFailure = await readdir(join(workspaceRoot, ".proofkit", "missions"));
  for (const tool of ["plan_test", "create_test_mission", "run_test"]) {
    const failedPlan = await client.callTool({ name: tool, arguments: { intent: "Save the current draft", url: baseUrl, level: "quick", sideEffectPolicy: "allow" } });
    const failure = JSON.parse(failedPlan.content[0].text);
    assert.equal(failure.status, "needs-observation"); assert.equal(failure.testVerdict, "not-asserted"); assert.ok(!failure.charter);
    assert.ok(failure.inspection.evidence.length > 0); assert.equal(providerCalls, callsBeforeFailure); assert.equal(writes, writesBeforeFailure);
  }
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit", "missions")), missionsBeforeFailure);
  unavailable = false;
  const runsBeforeAbort = await readdir(runner.evidenceDir);
  const controller = new AbortController(); controller.abort(new Error("Stop planning"));
  await assert.rejects(runner.plan("Save the current draft", { ...options, signal: controller.signal }), /Stop planning/);
  assert.deepEqual(await readdir(runner.evidenceDir), runsBeforeAbort);
  console.log(JSON.stringify({ status: "passed", automaticObservationBeforeProvider: true, noPlanningWritesOrProjectStart: true,
    tamperedSourceStopsBeforeActions: true, unboundPlanStops: true, providerCannotRewriteObservation: true, authenticatedSessionBound: true,
    wrongSessionStops: true, missionReportShowsSource: true, changedPlanningContextSeparatedFromBusinessVerdict: true,
    mcpFailureReturnsEvidenceWithoutCallingProvider: true, cancelledPlanningCreatesNoRun: true,
    changedModeRefusedByAllPlanningEntrypoints: true, noWriteOrMissionOnModeRefusal: true, originalIntentPreservedInMcpPlan: true,
    ...(keepArtifacts ? { workspaceRoot, projectRoot, runReport, missionReport: evidence.report } : {}) }, null, 2));
} finally {
  await client?.close(); await mcpServer?.close(); await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
