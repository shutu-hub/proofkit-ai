import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "proofkit-anonymous-controls-"));
const projectRoot = join(root, "application"), workspaceRoot = join(root, "workspace");
await mkdir(projectRoot);
let writes = 0, wrongWrites = 0, changed = false;
const server = createServer((request, response) => {
  if (request.url === "/selected") { writes++; response.writeHead(204); response.end(); return; }
  if (request.url === "/wrong") { wrongWrites++; response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<h1>Anonymous controls</h1>
    <input class="primary-choice" type="${changed ? "radio" : "checkbox"}" onchange="fetch('/selected').then(()=>document.querySelector('output').textContent='Selection saved')">
    <input class="secondary-choice" type="checkbox" onchange="fetch('/wrong')">
    <input class="ambiguous-choice" type="checkbox"><input class="ambiguous-choice" type="checkbox">
    <output>Not saved</output>`);
});
let runner;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
  runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" } }),
    integration: { name: "anonymous-checkbox-fixture", oracles: [{ name: "selected-current-choice", async check() {
      return { name: "selected-current-choice", verificationKind: "business", passed: writes === 1 && wrongWrites === 0,
        message: "Independent fixture writes", evidence: [JSON.stringify({ writes, wrongWrites })], observedAt: new Date().toISOString() };
    } }] } });
  const observed = await runner.inspectSurface({ adapter: "web" });
  assert.equal(observed.status, "observed");
  const controls = observed.snapshot.controls.filter((item) => item.role === "checkbox");
  assert.equal(controls.length, 4);
  assert.ok(controls.some((item) => item.selector === "input.primary-choice" && item.selectorKind === "css" && item.nativeActions.includes("setChecked")));
  assert.ok(controls.some((item) => item.selector === "input.secondary-choice"));
  assert.equal(controls.filter((item) => !item.selector && item.nativeActions.length === 0).length, 2, "Repeated classes cannot become positional guesses");
  const charter = await runner.plan("Select the independently checked option", { charter: { intent: "Select the independently checked option", level: "core", mode: "deterministic",
    actions: [{ kind: "setChecked", selector: "input.primary-choice", checked: true }, { kind: "waitForText", text: "Selection saved" }],
    assertions: [{ kind: "text-visible", text: "Selection saved" }], oracles: ["selected-current-choice"], sideEffectPolicy: "allow" },
    inspections: [{ runId: observed.inspectionId, manifestSha256: observed.manifest.sha256 }], expect: ["Selection saved"], oracleNames: ["selected-current-choice"], sideEffectPolicy: "allow" });
  const passed = await runner.wait((await runner.start({ adapter: "web", start: false, charter })).runId);
  assert.equal(passed.verdict, "passed"); assert.equal(writes, 1); assert.equal(wrongWrites, 0);
  changed = true;
  const drifted = await runner.wait((await runner.start({ adapter: "web", start: false, charter })).runId);
  assert.equal(drifted.verdict, "inconclusive");
  assert.equal(drifted.steps[0].failureCode, "surface-target-changed");
  assert.equal(writes, 1, "Changed anonymous control identity must stop before writing"); assert.equal(wrongWrites, 0);
  console.log(JSON.stringify({ status: "passed", uniqueAnonymousControlsObserved: 2, ambiguousControlsUnbound: 2,
    correctBusinessWrite: 1, wrongBusinessWrites: 0, liveIdentityDriftBlocked: true }));
} finally {
  await runner?.closeAllSurfaceSessions();
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
