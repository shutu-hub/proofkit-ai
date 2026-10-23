import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-bound-controls-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-bound-controls-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const envName = "PROOFKIT_TEST_TARGET_EMAIL";
const previousValue = process.env[envName]; process.env[envName] = "private-target-input";
let sends = 0, confirmations = 0;
const server = createServer((request, response) => {
  if (request.url === "/send") { sends++; response.writeHead(200, { "content-type": "application/json" }); response.end('{"id":"42"}'); return; }
  if (request.url === "/confirm") { confirmations++; response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<h1>Observed form</h1><fieldset><legend>Contact</legend><label for="email">Email</label><input id="email" type="email"></fieldset>
    <label for="single">Priority</label><select id="single"><option value="low">Low</option><option value="high">High</option></select>
    <label for="multiple">Channels</label><select id="multiple" multiple><option value="email">Email</option><option value="sms">SMS</option></select>
    <label><input id="checked" type="checkbox">Include summary</label>
    <input id="document" type="file" aria-label="Document" style="display:none">
    <input id="enter" aria-label="Confirm text"><output id="pressed">Not entered</output>
    <button id="send">Send</button><button id="confirm">Confirm</button><output id="result">Ready</output><script>
    document.querySelector('#enter').onkeydown = (event) => { if (event.key === 'Enter') document.querySelector('#pressed').textContent = 'Entered'; };
    document.querySelector('#send').onclick = async () => {
      if (document.querySelector('#email').value !== 'private-target-input' || document.querySelector('#single').value !== 'high'
        || document.querySelector('#multiple').selectedOptions.length !== 2 || !document.querySelector('#checked').checked
        || document.querySelector('#document').files.length !== 1 || document.querySelector('#pressed').textContent !== 'Entered') return;
      await fetch('/send', { method: 'POST' });
    };
    document.querySelector('#confirm').onclick = async () => { await fetch('/confirm', { method: 'POST' }); document.querySelector('#result').textContent = 'Done'; };
  </script>`);
});

try {
  await mkdir(join(workspaceRoot, ".proofkit", "fixtures"), { recursive: true });
  await writeFile(join(workspaceRoot, ".proofkit", "fixtures", "sample.txt"), "Reviewed fixture");
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Controls fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" } }),
    plannerProvider: { name: "observed-controls-fixture", plan: async () => ({ intent: "Verify observed form controls", level: "quick", mode: "deterministic", sideEffectPolicy: "allow", actions: [
      { kind: "goto", url: baseUrl }, { kind: "fill", selector: "#email", value: { env: envName } },
      { kind: "selectOption", selector: "#single", option: { value: "high" } }, { kind: "selectOptions", selector: "#multiple", options: [{ value: "email" }, { value: "sms" }] },
      { kind: "setChecked", selector: "#checked", checked: true }, { kind: "setInputFiles", selector: "#document", files: [".proofkit/fixtures/sample.txt"] },
      { kind: "press", selector: "#enter", key: "Enter" }, { kind: "captureResponse", name: "sent", trigger: { kind: "click", selector: "#send" },
        followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 2000 }, response: { url: `${baseUrl}/send`, method: "POST", statuses: [200], fields: { id: { pointer: "/id", type: "id" } } },
        requestWindowMs: 100, timeoutMs: 5000 }, { kind: "waitForText", text: "Done" }], assertions: [{ kind: "text-visible", text: "Done" }], metadata: {} }) } });
  const inspection = await runner.inspectSurface({ adapter: "web", headful });
  const charter = await runner.plan("Verify observed form controls", { url: baseUrl, level: "quick", sideEffectPolicy: "allow", surfaceSnapshot: inspection.snapshot });
  assert.ok(!charter.planning.evidenceGaps.includes("surface-selector"));
  const started = await runner.start({ adapter: "web", headful, start: false, charter });
  const summary = await runner.wait(started.runId);
  assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
  assert.equal(sends, 1); assert.equal(confirmations, 1);
  assert.equal(summary.steps[1].targetChecks[0].actual.groupName, "Contact");
  assert.equal(summary.steps[5].targetChecks[0].actual.role, "file-input");
  assert.equal(summary.steps[7].targetChecks.length, 2);
  assert.equal(summary.steps[7].response.followUp, "clicked");
  assert.equal(summary.steps[7].response.fields.id, "42");
  for (const step of summary.steps.slice(1, 8)) {
    assert.ok(step.targetChecks.length > 0);
    assert.ok(step.targetChecks.every((check) => check.status === "matched"));
    assert.ok(step.artifacts.some((path) => path.endsWith("target-check.json")));
  }
  const report = join(runner.evidenceDir, summary.runId, "report.html");
  const serialized = JSON.stringify(summary) + await readFile(report, "utf8") + await readFile(join(runner.evidenceDir, summary.runId, "events.jsonl"), "utf8");
  assert.ok(!serialized.includes("private-target-input"), "Identity checks must not retain input values");
  const manifest = await runner.evidenceManifest(summary.runId);
  assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
  console.log(JSON.stringify({ status: "passed", nativeControls: true, hiddenFileInput: true, press: true, responseTriggerAndFollowUp: true, identityChecks: 8,
    noInputValueInStructuredEvidence: true, manifest: "intact", ...(keepArtifacts ? { workspaceRoot, projectRoot, report } : {}) }, null, 2));
} finally {
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (previousValue === undefined) delete process.env[envName]; else process.env[envName] = previousValue;
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
