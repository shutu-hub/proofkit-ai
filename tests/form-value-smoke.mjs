import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { EvidenceStore } from "../packages/evidence/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-form-value-"));
let mode = "overwritten", writes = 0, storedStreet;
const keepArtifacts = process.argv.includes("--keep-artifacts");
const envName = "PROOFKIT_FORM_VALUE_EXPECTATION";
const oldValue = process.env[envName]; process.env[envName] = "Synthetic private expectation";
const server = createServer(async (request, response) => {
  if (request.url === "/save") {
    let text = ""; for await (const chunk of request) text += chunk;
    storedStreet = JSON.parse(text).street; writes++;
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"saved":true}'); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<h1>Address checkpoint</h1><label for="street">Street</label><input id="street" data-proofkit-mask><button id="save">Save</button><output>Not saved</output><script>'
    + 'const mode=' + JSON.stringify(mode) + ';const field=document.querySelector("#street");field.oninput=()=>{const intended=field.value;'
    + 'if(mode==="identity-drift"){setTimeout(()=>field.setAttribute("aria-label","Another address"),120);return;}'
    + 'if(mode==="duplicate"){setTimeout(()=>field.after(field.cloneNode()),120);return;}'
    + 'setTimeout(()=>{field.value="Saved profile value"},120);if(mode==="settled")setTimeout(()=>{field.value=intended},350);};'
    + 'document.querySelector("#save").onclick=async()=>{await fetch("/save",{method:"POST",body:JSON.stringify({street:field.value})});document.querySelector("output").textContent="Saved"};</script>');
});
let runner;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  runner = new LocalRunnerService({ root: workspaceRoot, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) } }, policies: { sideEffects: "allow" } }),
    integration: { name: "independent-address-store-fixture", oracles: [{ name: "stored-expected-street", async check() {
      const matches = storedStreet === process.env[envName];
      return { name: "stored-expected-street", verificationKind: "business", passed: matches && writes === 1,
        message: "Independent server-side fixture state; runtime memory, not durable persistence", observedAt: new Date().toISOString(), evidence: [JSON.stringify({ matches, writes })] };
    } }] } });
  const observed = await runner.inspectSurface({ adapter: "web" });
  const charter = await runner.plan("Wait until the reviewed address has settled before saving", { adapter: "web",
    inspections: [{ runId: observed.inspectionId, manifestSha256: observed.manifest.sha256 }], sideEffectPolicy: "allow", expect: ["Saved"], charter: {
      intent: "Wait until the reviewed address has settled before saving", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
      actions: [{ kind: "fill", selector: "#street", value: { env: envName } },
        { kind: "waitForValue", selector: "#street", value: { env: envName }, stableForMs: 400, timeoutMs: 1500 },
        { kind: "click", selector: "#save" }, { kind: "waitForText", text: "Saved" }], assertions: [{ kind: "text-visible", text: "Saved" }], oracles: ["stored-expected-street"], metadata: {} } });
  const cases = [];
  for (const scenario of ["overwritten", "identity-drift", "duplicate", "settled"]) {
    mode = scenario;
    const before = writes;
    const summary = await runner.wait((await runner.start({ adapter: "web", charter, start: false })).runId);
    const expectedCode = scenario === "overwritten" ? "surface-value-not-stable" : scenario === "settled" ? undefined : "surface-value-target-changed";
    const expectedVerdicts = scenario === "settled" ? ["passed"] : scenario === "duplicate" ? ["failed", "inconclusive"] : ["inconclusive"];
    assert.ok(expectedVerdicts.includes(summary.verdict), JSON.stringify({ scenario, steps: summary.steps.map((step) => ({ kind: step.action.kind, status: step.status, failureCode: step.failureCode, receipt: step.receipt })) }));
    if (scenario === "identity-drift") assert.ok(["surface-target-changed", "surface-value-target-changed"].includes(summary.steps[1].failureCode));
    else if (scenario === "duplicate") assert.ok(["surface-target-ambiguous", "surface-value-target-changed"].includes(summary.steps[1].failureCode));
    else assert.equal(summary.steps[1].failureCode, expectedCode);
    assert.equal(writes - before, scenario === "settled" ? 1 : 0, "Unverified form values cannot reach the next write");
    if (scenario === "settled") {
      assert.equal(summary.steps[1].receipt.metadata.formValue.matched, true);
      assert.ok(summary.steps[1].receipt.metadata.formValue.stableForMs >= 400);
      assert.equal(summary.steps[1].receipt.metadata.formValue.actualValueRetained, false);
      assert.equal(summary.oracles[0].passed, true);
    }
    const runRoot = join(runner.evidenceDir, summary.runId);
    for (const file of ["run.json", "events.jsonl", ...(await readdir(join(runRoot, "artifacts"))).filter((file) => file.endsWith(".json")).map((file) => "artifacts/" + file)]) {
      assert.ok(!(await readFile(join(runRoot, file), "utf8")).includes(process.env[envName]), "Runtime-only expected values must not leak into structured evidence");
    }
    const manifest = await runner.evidenceManifest(summary.runId);
    assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    if (scenario === "settled") {
      const reportPath = join(runRoot, "report.html");
      const reportBytes = await readFile(reportPath);
      assert.ok(reportBytes.toString("utf8").includes("Field value checkpoint:"));
      const observationPath = join(runRoot, "artifacts/step-002-form-value.json");
      const original = await readFile(observationPath);
      try {
        await writeFile(observationPath, "changed field observation");
        const report = await new EvidenceStore(runner.evidenceDir).writeReport(summary);
        const changed = await readFile(report, "utf8");
        assert.ok(!changed.includes("Field value checkpoint:"));
        assert.ok(changed.includes("Field value observation unavailable or changed"));
      } finally { await writeFile(observationPath, original); await writeFile(reportPath, reportBytes); }
      assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    }
    cases.push({ scenario, runId: summary.runId, verdict: summary.verdict, failureCode: summary.steps[1].failureCode, writes: writes - before,
      manifestSha256: manifest.sha256, report: join(runRoot, "report.html") });
  }
  const adapter = new WebAdapter({ baseUrl, headless: true, executablePath: runner.config.surfaces.web.executablePath });
  try {
    await adapter.connect();
    await adapter.act({ kind: "fill", selector: "#street", value: process.env[envName] });
    const expectedTarget = charter.actions[1].expectedTarget;
    await assert.rejects(adapter.act({ kind: "waitForValue", selector: "#street", value: process.env[envName], stableForMs: 200, timeoutMs: 1000, expectedTarget }, {
      recordTargetCheck: async () => { await adapter.activePage.locator("#street").evaluate((element) => element.setAttribute("aria-label", "Different after recorded check")); },
    }), (error) => error.code === "surface-value-target-changed");
    await adapter.act({ kind: "goto", url: baseUrl });
    const controller = new AbortController(); const reason = new Error("Cancel the read-only value checkpoint");
    const cancelled = adapter.act({ kind: "waitForValue", selector: "#street", value: "Not present", stableForMs: 200, timeoutMs: 1000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50);
    await assert.rejects(cancelled, (error) => error === reason);
    await adapter.activePage.locator("#street").evaluate((element) => element.setAttribute("type", "checkbox"));
    await assert.rejects(adapter.act({ kind: "waitForValue", selector: "#street", value: "on", stableForMs: 200, timeoutMs: 1000 }), (error) => error.code === "surface-value-unsupported");
  } finally { await adapter.close(); }
  console.log(JSON.stringify({ status: "passed", ...(keepArtifacts ? { workspaceRoot } : {}), cases, postGuardIdentityChangeBlocked: true, cancellationPreserved: true, unsupportedControlsRejected: true,
    independentStoredValueVerified: true, tamperedCheckpointWithdrawn: true, note: "Sampled value stability is a UI checkpoint, not future stability or independent business proof" }));
} finally {
  await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
  if (oldValue === undefined) delete process.env[envName]; else process.env[envName] = oldValue;
  if (!keepArtifacts) await rm(workspaceRoot, { recursive: true, force: true });
}
