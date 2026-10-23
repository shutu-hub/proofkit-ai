import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { EvidenceStore } from "../packages/evidence/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { registerTools } from "../packages/mcp/dist/tools.js";

const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-host-plan-project-"));
const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-host-plan-workspace-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const nextId = `next-${randomUUID()}`;
const commitId = `commit-${randomUUID()}`;
const records = new Map();
let mode = "persisted", writes = 0, modelCalls = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/requests" && request.method === "POST") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = `request-${++writes}`;
    if (mode !== "missing") records.set(id, { id, quantity: mode === "wrong-quantity" ? 1 : input.quantity, status: "created" });
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ id, quantity: input.quantity, status: "created" })); return;
  }
  if (url.pathname === "/read") {
    if (mode === "unavailable") { response.writeHead(503); response.end("Reader unavailable"); return; }
    const id = url.searchParams.get("id");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(records.get(id) ?? { id, quantity: Number(url.searchParams.get("quantity")), status: "missing" })); return;
  }
  if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(url.pathname === "/review" ? `<h1>Review request</h1><p>Quantity: 2</p><button id="${commitId}">Submit request</button><output>Awaiting submission</output><script>
    document.querySelector('button').onclick = async () => {
      await fetch('/requests', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quantity:2})});
      document.querySelector('output').textContent = 'Request accepted';
    };
  </script>` : `<h1>Request cart</h1><p>Quantity: 2</p><button id="${nextId}">Open review</button><script>document.querySelector('button').onclick = () => location.assign('/review');</script>`);
});

let runner, client, mcpServer;
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text);
};

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Host-planning fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ project: { root: projectRoot }, surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } },
      policies: { sideEffects: "allow" }, sessions: { recordVideo: true }, oracles: [] }),
    plannerProvider: { name: "must-not-be-called", plan: async () => { modelCalls++; throw new Error("Host drafts must not invoke another model provider"); } } });
  mcpServer = new McpServer({ name: "host-planning-smoke", version: "0.1.0" }); registerTools(mcpServer, runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); client = new Client({ name: "host-smoke", version: "0.1.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await call("interact_surface", { surface: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Request cart" } });
  assert.ok(opened.sessionId); const sessionId = opened.sessionId;
  const cart = await call("inspect_surface", { surface: "web", sessionId });
  const next = cart.snapshot.controls.find((control) => control.name === "Open review"); assert.ok(next?.selector);
  const cartPin = { runId: cart.inspectionId, manifestSha256: cart.manifest.sha256 };
  await call("interact_surface", { surface: "web", sessionId, inspection: cartPin, action: { kind: "click", selector: next.selector } });
  const review = await call("inspect_surface", { surface: "web", sessionId });
  const commit = review.snapshot.controls.find((control) => control.name === "Submit request"); assert.ok(commit?.selector);
  assert.equal(writes, 0);
  const inspections = [cart, review].map((inspection) => ({ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }));
  const intent = "Submit the selected quantity and independently verify the current stored request";
  const charter = { intent: "Host-authored request plan", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
    actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: next.selector, observationId: cart.inspectionId }, { kind: "waitForText", text: "Review request" },
      { kind: "captureResponse", name: "request", trigger: { kind: "click", selector: commit.selector, observationId: review.inspectionId },
        response: { url: `${baseUrl}/requests`, method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "identifier" }, quantity: { pointer: "/quantity", type: "number" } },
          requestFields: { quantity: { pointer: "/quantity", type: "number" } } }, requestWindowMs: 100, timeoutMs: 5000 },
      { kind: "waitForText", text: "Request accepted" }], assertions: [{ kind: "text-visible", text: "Request accepted" }], oracles: ["request-stored"],
    httpOracles: [{ name: "request-stored", url: `${baseUrl}/read`, query: {
      id: { source: "response", stepId: "step-004", field: "id", matchPointer: "/id" }, quantity: { source: "response", stepId: "step-004", field: "quantity", matchPointer: "/quantity" } },
      statusPointer: "/status", successValues: ["created"], failureValues: ["missing"], expectedStatus: 200, intervalMs: 100, deadlineMs: 1200 }],
    metadata: { planner: "untrusted-claim" }, planning: { source: "model", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [] } };
  const options = { intent, charter, inspections, surface: "web", sessionId, expect: ["Request accepted"], oracleNames: ["request-stored"] };
  const reviewed = (await call("plan_test", options)).charter;
  assert.equal(reviewed.intent, intent); assert.equal(reviewed.planning.source, "submitted");
  assert.equal(reviewed.metadata.planner, "submitted-charter"); assert.equal(modelCalls, 0); assert.equal(writes, 0);
  assert.equal(reviewed.actions[1].expectedTarget.name, "Open review");
  assert.equal(reviewed.actions[3].trigger.expectedTarget.name, "Submit request");
  const invalidPin = await call("plan_test", { ...options, inspections: [{ ...cartPin, manifestSha256: "0".repeat(64) }] });
  assert.equal(invalidPin.status, "needs-observation"); assert.equal(writes, 0); assert.equal(modelCalls, 0);
  const unknown = structuredClone(charter); unknown.actions[1].selector = "#invented";
  const unbound = (await call("plan_test", { ...options, charter: unknown })).charter;
  assert.ok(unbound.planning.evidenceGaps.includes("surface-selector"));
  const blocked = await call("run_test", { intent, charter: unbound, surface: "web", sessionId });
  assert.equal(blocked.running, false); assert.equal(blocked.testVerdict, "not-asserted"); assert.equal(writes, 0);
  const results = [];
  for (const scenario of ["persisted", "missing", "wrong-quantity", "unavailable"]) {
    mode = scenario;
    const started = await call("run_test", { intent, charter: reviewed, surface: "web", sessionId });
    assert.equal(started.running, true, JSON.stringify(started));
    await runner.waitMission(started.missionId);
    const evidence = await call("get_mission_evidence", { missionId: started.missionId, detail: "full" });
    const expected = scenario === "persisted" ? "passed" : scenario === "unavailable" ? "inconclusive" : "failed";
    assert.equal(evidence.testVerdict, expected, JSON.stringify({ scenario, actual: evidence.testVerdict, firstFailure: evidence.summary.firstFailure?.message, proof: evidence.summary.proofClassification }));
    const primary = evidence.summary.runs.find((run) => run.runKind === "primary");
    const summary = await runner.wait(primary.runId);
    assert.equal(summary.assertions.every((assertion) => assertion.passed), true, "UI success alone must not decide business acceptance");
    assert.deepEqual(summary.steps[3].response.requestFields, { quantity: 2 });
    assert.equal(summary.oracles[0].verificationKind, "business");
    const runReport = join(runner.evidenceDir, primary.runId, "report.html");
    const runMarkup = await readFile(runReport, "utf8");
    assert.ok(runMarkup.includes("Captured API facts"));
    assert.ok(runMarkup.includes(`Independent HTTP read · ${scenario === "persisted" ? "passed" : scenario === "unavailable" ? "pending" : "failed"}`));
    if (scenario === "wrong-quantity") {
      assert.ok(runMarkup.includes("quantity: expected <code>2</code> · observed <code>1</code>"));
      const store = new EvidenceStore(runner.evidenceDir);
      for (const [artifact, gap, excerpt] of [
        [`${primary.runId}/artifacts/step-004-response.json`, "Selected API facts unavailable or changed", "Captured API facts"],
        [summary.oracles[0].sourceEvidenceArtifacts[0], "Independent reader facts unavailable or changed", "Independent HTTP read · failed"],
      ]) {
        const artifactPath = join(runner.evidenceDir, artifact);
        const original = await readFile(artifactPath);
        try {
          await writeFile(artifactPath, "changed saved facts");
          const changedMarkup = await readFile(await store.writeReport(summary), "utf8");
          assert.ok(changedMarkup.includes(gap)); assert.ok(!changedMarkup.includes(excerpt));
          const changed = await runner.missionEvidence(started.missionId);
          assert.equal(changed.testVerdict, "inconclusive");
        } finally {
          await writeFile(artifactPath, original); await writeFile(runReport, runMarkup);
        }
        assert.equal((await runner.missionEvidence(started.missionId)).testVerdict, expected);
      }
    }
    if (scenario === "unavailable") assert.equal(evidence.summary.confirmedProductFindings, 0);
    if (scenario === "missing" || scenario === "wrong-quantity") assert.ok(evidence.summary.confirmedProductFindings > 0);
    const manifest = await runner.evidenceManifest(primary.runId);
    assert.equal((await runner.verifyEvidenceManifest(primary.runId, manifest.sha256)).status, "intact");
    results.push({ scenario, missionId: started.missionId, verdict: evidence.testVerdict, currentRequestId: summary.steps[3].response.fields.id, manifest: "intact" });
  }
  assert.equal(writes, 4); assert.equal(modelCalls, 0);
  const closed = await call("close_surface_session", { sessionId }); assert.equal(closed.networkCapture.recording.status, "recorded");
  for (const result of results) {
    const evidence = await call("get_mission_evidence", { missionId: result.missionId, detail: "full" });
    assert.equal(evidence.testVerdict, result.verdict); assert.equal(evidence.summary.sessionCaptures.segments[0].integrity, "intact");
    assert.equal(evidence.summary.planningObservation.status, "verified");
    assert.equal(evidence.summary.planningObservation.evidence.length, 6);
    const markup = await readFile(evidence.report, "utf8"); assert.ok(markup.includes("<video"));
    if (keepArtifacts) result.report = evidence.report;
  }
  console.log(JSON.stringify({ status: "passed", hostDraftNoSecondaryModel: true, modelCalls, projectIntegrationNeeded: false,
    inlineCurrentIdAndQuantityReader: true, preparationWrites: 0, formalWrites: writes, unboundPlanNotStarted: true,
    uiSuccessNotBusinessProof: true, changedApiAndReaderFactsWithdrawn: true, changedFactsWithdrawBusinessVerdict: true,
    continuousVideoSealed: true, cases: results, ...(keepArtifacts ? { workspaceRoot, projectRoot } : {}) }, null, 2));
} finally {
  await client?.close(); await mcpServer?.close(); await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
