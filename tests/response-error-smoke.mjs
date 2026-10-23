import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { EvidenceStore } from "../packages/evidence/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-response-error-"));
let mode = "json", writes = 0, laterWrites = 0, oracleCalls = 0;
const server = createServer(async (request, response) => {
  if (request.url === "/submit" && request.method === "POST") {
    writes++; for await (const chunk of request) { void chunk; }
    response.writeHead(mode === "incomplete" ? 201 : 422, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "created-once", message: "Address rejected; token=PRIVATE_DIAGNOSTIC user@example.com", private: "PRIVATE_UNSELECTED_RESPONSE" })); return;
  }
  if (request.url === "/later") { laterWrites++; response.end("must not run"); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<h1>Submit address</h1><button id="submit">Submit</button><button id="later">Write again</button><output>Not submitted</output><script>'
    + 'const mode=' + JSON.stringify(mode) + ';document.querySelector("#submit").onclick=async()=>{await fetch("/submit",{method:"POST",headers:{"content-type":mode!=="form"?"application/json":"application/x-www-form-urlencoded"},'
    + 'body:mode!=="form"?JSON.stringify({quantity:2,password:"PRIVATE_UNSELECTED_REQUEST"}):"quantity=2&password=PRIVATE_UNSELECTED_REQUEST"});document.querySelector("output").textContent="Rejected"};'
    + 'document.querySelector("#later").onclick=()=>fetch("/later",{method:"POST"});</script>');
});
let runner;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  runner = new LocalRunnerService({ root: workspaceRoot, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) } }, policies: { sideEffects: "allow" } }),
    integration: { name: "error-diagnostics-fixture", oracles: [{ name: "must-not-run", async check() {
      oracleCalls++; return { name: "must-not-run", passed: true, message: "Unexpected execution", observedAt: new Date().toISOString(), evidence: [] };
    } }] } });
  const cases = [];
  for (mode of ["json", "form", "incomplete"]) {
    const inspection = await runner.inspectSurface({ adapter: "web" });
    const charter = await runner.plan("Retain declared failure diagnostics without replaying the submission", { adapter: "web",
      inspections: [{ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }], sideEffectPolicy: "allow", expect: ["Rejected"], charter: {
        intent: "Retain declared failure diagnostics without replaying the submission", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
        actions: [{ kind: "captureResponse", name: "submit", trigger: { kind: "click", selector: "#submit" }, response: {
          url: baseUrl + "/submit", method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "identifier" },
            ...(mode === "incomplete" ? { room: { pointer: "/room", type: "number" } } : {}) },
          errorFields: { message: { pointer: "/message", type: "string" } }, requestFields: { quantity: { pointer: "/quantity", type: mode === "form" ? "string" : "number" } } },
          requestWindowMs: 200, timeoutMs: 5000 }, { kind: "click", selector: "#later" }],
        assertions: [{ kind: "text-visible", text: "Rejected" }], oracles: ["must-not-run"], metadata: {} } });
    const before = writes;
    const summary = await runner.wait((await runner.start({ adapter: "web", charter, start: false })).runId);
    assert.equal(summary.verdict, "inconclusive"); assert.equal(writes - before, 1); assert.equal(laterWrites, 0); assert.equal(oracleCalls, 0);
    const step = summary.steps[0];
    assert.equal(step.status, "failed"); assert.equal(step.failureCode, mode === "incomplete" ? "response-field-missing" : "response-status"); assert.equal(step.response, undefined);
    assert.equal(step.responseError.status, mode === "incomplete" ? 201 : 422); assert.equal(step.responseError.acceptance, "not-established");
    assert.equal(step.responseError.requestFields.quantity, mode === "form" ? "2" : 2);
    if (mode === "incomplete") {
      assert.equal(step.responseError.kind, "incomplete-fields"); assert.equal(step.responseError.fields.id, "created-once");
      assert.deepEqual(step.responseError.fieldGaps, [{ name: "room", code: "missing" }]);
    } else assert.match(step.responseError.fields.message, /Address rejected/);
    const artifact = step.artifacts.find((path) => path.endsWith("step-001-response-error.json")); assert.ok(artifact);
    const manifest = await runner.evidenceManifest(summary.runId); assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    const reportPath = join(workspaceRoot, ".proofkit", "runs", summary.runId, "report.html");
    const diagnosticLabel = mode === "incomplete" ? "Incomplete response diagnostics" : "Unexpected response diagnostics";
    const html = await readFile(reportPath, "utf8"); assert.ok(html.includes(diagnosticLabel));
    const saved = (await readFile(join(workspaceRoot, ".proofkit", "runs", artifact), "utf8")) + html;
    assert.ok(!/PRIVATE_DIAGNOSTIC|PRIVATE_UNSELECTED|user@example.com/.test(saved));
    const original = await readFile(join(workspaceRoot, ".proofkit", "runs", artifact));
    await writeFile(join(workspaceRoot, ".proofkit", "runs", artifact), "changed diagnostic");
    const store = new EvidenceStore(join(workspaceRoot, ".proofkit", "runs"));
    const changed = await readFile(await store.writeReport(summary), "utf8");
    assert.ok(changed.includes(diagnosticLabel + " unavailable or changed"));
    await writeFile(join(workspaceRoot, ".proofkit", "runs", artifact), original); await store.writeReport(summary);
    assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    cases.push({ mode, runId: summary.runId, verdict: summary.verdict, writes: writes - before, laterWrites, oracleCalls, reportPath,
      manifestSha256: manifest.sha256, diagnosticsVerified: true, tamperedDiagnosticsWithdrawn: true });
  }
  const result = { status: "passed", workspaceRoot, cases, note: "Controlled browser regression; unexpected status remains inconclusive and cannot establish business acceptance" };
  await writeFile(new URL("../outputs/response-error-validation.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
