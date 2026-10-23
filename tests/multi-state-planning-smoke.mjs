import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { registerTools } from "../packages/mcp/dist/tools.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-multi-state-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-multi-state-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const orders = new Map();
let writes = 0, providerCalls = 0, providerMode = "qualified", checkoutVisits = 0;
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/checkout") checkoutVisits++;
  if (path === "/orders" && request.method === "POST") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = String(100 + ++writes); orders.set(id, { id, sku: body.sku, quantity: body.quantity, status: "created" });
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ id, status: "created" })); return;
  }
  if (path.startsWith("/orders/")) {
    const record = orders.get(path.slice("/orders/".length)); response.writeHead(record ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(record ?? { status: "missing" })); return;
  }
  if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(path === "/checkout" ? `<h1>Checkout ready</h1><p>SKU-A · Quantity 2</p><button id="next">Confirm order</button><output>Awaiting confirmation</output><script>
    document.querySelector('#next').onclick = async () => {
      await fetch('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'SKU-A', quantity: 2 }) });
      document.querySelector('output').textContent = 'Order submitted';
    };
  </script>` : `<h1>Cart ready</h1><p>SKU-A · Quantity 2</p><button id="next">Open checkout</button><script>
    document.querySelector('#next').onclick = () => location.assign('/checkout');
  </script>`);
});
let runner, client, mcpServer;
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text);
};

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Multi-state fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" }, sessions: { recordVideo: true } }),
    plannerProvider: { name: "multi-state-fixture", plan: async ({ surfaceObservations }) => {
      providerCalls++;
      if (surfaceObservations?.length === 1) {
        const cart = surfaceObservations[0];
        const next = cart.snapshot.controls.find((control) => control.name === "Open checkout");
        assert.ok(next?.selector);
        return { status: "needs-observation", reason: "Only the cart has been observed; confirmation controls are unknown", expectedObservation: "Observe the checkout controls before planning the final confirmation",
          action: { kind: "click", selector: next.selector, observationId: cart.observationId } };
      }
      assert.equal(surfaceObservations?.length, 2, "Planning must use both original observed states without guessing an unseen page");
      const [cart, checkout] = surfaceObservations;
      assert.equal(cart.snapshot.controls.find((control) => control.selector === "#next").name, "Open checkout");
      assert.equal(checkout.snapshot.controls.find((control) => control.selector === "#next").name, "Confirm order");
      const reference = (id) => providerMode === "ambiguous" ? {} : { observationId: id };
      return { intent: "Place the selected order through cart and checkout", level: "core", mode: "deterministic", sideEffectPolicy: "allow", actions: [
        { kind: "goto", url: baseUrl }, { kind: "click", selector: "#next", ...reference(cart.observationId) }, { kind: "waitForText", text: "Checkout ready" },
        { kind: "captureResponse", name: "order", trigger: { kind: "click", selector: "#next", ...reference(providerMode === "wrong-state" ? cart.observationId : checkout.observationId) },
          response: { url: `${baseUrl}/orders`, method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "id" } },
            requestFields: { sku: { pointer: "/sku", type: "string" }, quantity: { pointer: "/quantity", type: "number" } } }, requestWindowMs: 100, timeoutMs: 5000 },
        { kind: "waitForText", text: "Order submitted" }], assertions: [{ kind: "text-visible", text: "Order submitted" }], oracles: ["placed-order"], metadata: {} };
    } },
    oracles: [{ name: "placed-order", check: async ({ steps }) => {
      const id = steps.find((step) => step.response?.name === "order")?.response?.fields.id;
      if (!id) return { name: "placed-order", passed: null, verificationKind: "business", message: "No current-Run order identity", evidence: [], observedAt: new Date().toISOString() };
      const response = await fetch(`${baseUrl}/orders/${id}`); const facts = await response.json();
      return { name: "placed-order", passed: response.ok && facts.id === id && facts.sku === "SKU-A" && facts.quantity === 2 && facts.status === "created", verificationKind: "business",
        message: "Independent current-order read", evidence: [JSON.stringify(facts)], observedAt: new Date().toISOString() };
    } }] });
  mcpServer = new McpServer({ name: "multi-state-planning", version: "0.1.0" }); registerTools(mcpServer, runner);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); client = new Client({ name: "smoke", version: "0.1.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await call("interact_surface", { surface: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Cart ready" } });
  assert.ok(opened.sessionId); const sessionId = opened.sessionId;
  const cart = await call("inspect_surface", { surface: "web", sessionId });
  assert.ok(cart.manifest?.sha256);
  const cartPin = { runId: cart.inspectionId, manifestSha256: cart.manifest.sha256 };
  const incomplete = await call("plan_test", { intent: "Place the selected order through cart and checkout", level: "core", sideEffectPolicy: "allow", oracleNames: ["placed-order"], expect: ["Order submitted"], sessionId, inspections: [cartPin] });
  assert.equal(incomplete.status, "needs-observation"); assert.equal(incomplete.testVerdict, "not-asserted");
  assert.equal(incomplete.charter, undefined); assert.equal(checkoutVisits, 0); assert.equal(writes, 0);
  assert.equal(incomplete.observationRequest.requiresApproval, true);
  assert.equal(incomplete.observationRequest.action.expectedTarget.name, "Open checkout");
  const priorRuns = runner.listSurfaceSessions().sessions.find((session) => session.sessionId === sessionId).borrowedRunIds.length;
  for (const changed of [
    { inspection: { ...cartPin, manifestSha256: "0".repeat(64) } },
    { action: { kind: "click", selector: "#invented" } },
    { sessionId: "00000000-0000-4000-8000-000000000001" },
  ]) {
    const rejected = await client.callTool({ name: "interact_surface", arguments: { surface: "web", sessionId, inspection: cartPin,
      action: incomplete.observationRequest.action, ...changed } });
    assert.equal(rejected.isError, true); assert.equal(checkoutVisits, 0); assert.equal(writes, 0);
    const session = runner.listSurfaceSessions().sessions.find((session) => session.sessionId === sessionId);
    assert.equal(session.reusable, true); assert.equal(session.borrowedRunIds.length, priorRuns);
  }
  const explored = await call("interact_surface", { surface: "web", sessionId, inspection: cartPin, action: incomplete.observationRequest.action });
  assert.equal(explored.status, "observed"); assert.equal(explored.testVerdict, "not-asserted");
  const drift = await call("interact_surface", { surface: "web", sessionId, inspection: cartPin, action: incomplete.observationRequest.action });
  assert.equal(drift.action.failureCode, "surface-target-changed"); assert.equal(writes, 0);
  const invalidState = await client.callTool({ name: "interact_surface", arguments: { surface: "web", sessionId, inspection: cartPin,
    action: { ...incomplete.observationRequest.action, observationId: "wrong-state" } } });
  assert.equal(invalidState.isError, true); assert.equal(writes, 0);
  const checkout = await call("inspect_surface", { surface: "web", sessionId });
  assert.ok(checkout.manifest?.sha256); assert.equal(writes, 0);
  const inspections = [cart, checkout].map((inspection) => ({ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }));
  const continuation = incomplete.observationRequest.continuation;
  assert.ok(continuation?.id && continuation?.sha256);
  const callsBeforeConflict = providerCalls;
  const conflictingResume = await client.callTool({ name: "plan_test", arguments: { intent: "Place the selected order through cart and checkout",
    continuation, expect: [], inspections: [inspections[1]] } });
  assert.equal(conflictingResume.isError, true); assert.equal(providerCalls, callsBeforeConflict); assert.equal(writes, 0);
  const planningInput = { continuation, inspections: [inspections[1]] };
  providerMode = "ambiguous";
  const ambiguous = (await call("plan_test", planningInput)).charter;
  assert.ok(ambiguous.planning.evidenceGaps.includes("surface-selector"));
  const ambiguousRun = await runner.start({ adapter: "web", sessionId, start: false, charter: ambiguous });
  assert.equal((await runner.wait(ambiguousRun.runId)).steps.length, 0); assert.equal(writes, 0);
  providerMode = "wrong-state";
  const wrongState = (await call("plan_test", planningInput)).charter;
  const wrongRun = await runner.start({ adapter: "web", sessionId, start: false, charter: wrongState });
  const wrongResult = await runner.wait(wrongRun.runId);
  assert.equal(wrongResult.verdict, "inconclusive"); assert.equal(wrongResult.steps[3].failureCode, "surface-target-changed"); assert.equal(writes, 0);
  providerMode = "qualified";
  const charter = (await call("plan_test", planningInput)).charter;
  assert.equal(charter.surfaceObservation.sources.length, 2); assert.equal(charter.surfaceObservation.sessionId, sessionId);
  assert.equal(charter.level, "core"); assert.equal(charter.sideEffectPolicy, "allow");
  assert.equal(charter.intent, "Place the selected order through cart and checkout");
  assert.deepEqual(charter.oracles, ["placed-order"]);
  assert.equal(charter.actions[1].expectedTarget.name, "Open checkout"); assert.equal(charter.actions[3].trigger.expectedTarget.name, "Confirm order");
  assert.ok(!charter.planning.evidenceGaps.includes("surface-selector"));
  const callsBeforeBadPin = providerCalls;
  const badPin = await call("plan_test", { ...planningInput, inspections: [inspections[0], { ...inspections[1], manifestSha256: "0".repeat(64) }] });
  assert.equal(badPin.status, "needs-observation"); assert.equal(providerCalls, callsBeforeBadPin); assert.equal(writes, 0);
  const sourcePath = join(runner.evidenceDir, charter.surfaceObservation.sources[1].source.snapshotPath);
  const original = await readFile(sourcePath); await writeFile(sourcePath, "changed checkout observation");
  const invalid = await runner.start({ adapter: "web", sessionId, start: false, charter });
  assert.equal((await runner.wait(invalid.runId)).steps.length, 0); assert.equal(writes, 0);
  await writeFile(sourcePath, original);
  const mission = await runner.createMission({ intent: charter.intent, charter, surface: "web", sessionId });
  await runner.startMission(mission.missionId, { approve: true }); await runner.waitMission(mission.missionId);
  const evidence = await runner.missionEvidence(mission.missionId);
  assert.equal(evidence.testVerdict, "passed", JSON.stringify(evidence, null, 2)); assert.equal(writes, 1);
  assert.equal(evidence.summary.planningObservation.status, "verified"); assert.equal(evidence.summary.planningObservation.evidence.length, 6);
  assert.ok(evidence.summary.proofClassification.requiredRunsWithPassingBusiness > 0);
  const primary = evidence.summary.runs.find((run) => run.runKind === "primary");
  const summary = await runner.wait(primary.runId);
  assert.equal(summary.steps[1].targetChecks[0].expected.observationId, cart.inspectionId);
  assert.equal(summary.steps[3].targetChecks[0].expected.observationId, checkout.inspectionId);
  assert.deepEqual(summary.steps[3].response.requestFields, { sku: "SKU-A", quantity: 2 });
  assert.equal(summary.oracles.find((oracle) => oracle.name === "placed-order").passed, true);
  const markup = await readFile(evidence.report, "utf8");
  assert.ok(markup.includes(`../../runs/${cart.inspectionId}/report.html`) && markup.includes(`../../runs/${checkout.inspectionId}/report.html`));
  const closed = await runner.closeSurfaceSession(sessionId); assert.equal(closed.networkCapture.recording.status, "recorded");
  const finalEvidence = await runner.missionEvidence(mission.missionId); assert.equal(finalEvidence.testVerdict, "passed");
  assert.equal(finalEvidence.summary.sessionCaptures.segments[0].integrity, "intact");
  const manifest = await runner.evidenceManifest(primary.runId); assert.equal((await runner.verifyEvidenceManifest(primary.runId, manifest.sha256)).status, "intact");
  console.log(JSON.stringify({ status: "passed", modelRequestedMissingState: true, noAutomaticExploratoryClick: true, guardedExploration: true, exploratoryDriftStopsBeforeWrite: true,
    twoObservedPagesOneReviewedPlan: true, savedContinuationRestoresRequirementsAndPreviousState: true, conflictingResumeStopsBeforeModelOrWrite: true,
    reusedSelectorStatesExplicit: true, ambiguousStateStopsBeforeActions: true,
    wrongStateStopsBeforeWrite: true, changedOrBadPinnedStateStops: true, explorationWrites: 0, formalWrites: writes, independentCurrentOrderVerified: true,
    selectedRequestAndResponseFacts: true, continuousVideoSealed: true, manifest: "intact", ...(keepArtifacts ? { workspaceRoot, projectRoot, report: finalEvidence.report,
      runReport: join(runner.evidenceDir, primary.runId, "report.html") } : {}) }, null, 2));
} finally {
  await client?.close(); await mcpServer?.close(); await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
