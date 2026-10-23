import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-planned-target-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-planned-target-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
let label = "Save draft";
let buttonId = "action";
let writes = 0;
const server = createServer((request, response) => {
  if (request.url === "/write") { writes++; response.writeHead(200, { "content-type": "application/json" }); response.end('{"saved":true}'); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<h1>Draft editor</h1><button id="${buttonId}">${label}</button><output id="result">Ready</output><script>
    document.querySelector('button').onclick = async () => { await fetch('/write', { method: 'POST' }); document.querySelector('#result').textContent = 'Done'; };
  </script>`);
});

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Planned target fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" } }),
    plannerProvider: { name: "observed-target-fixture", plan: async () => ({ intent: "Save the draft", level: "quick", mode: "deterministic", actions: [
      { kind: "goto", url: baseUrl }, { kind: "click", selector: "#action" }, { kind: "waitForText", text: "Done" }],
      assertions: [{ kind: "text-visible", text: "Done" }], sideEffectPolicy: "allow", metadata: {} }) } });
  const inspection = await runner.inspectSurface({ adapter: "web", headful });
  const charter = await runner.plan("Save the draft", { url: baseUrl, level: "quick", sideEffectPolicy: "allow", surfaceSnapshot: inspection.snapshot });
  label = "Delete draft";
  const started = await runner.start({ adapter: "web", headful, start: false, charter });
  const summary = await runner.wait(started.runId);
  assert.equal(writes, 0, `A reused selector must not execute a different observed control; actual verdict: ${summary.verdict}`);
  assert.equal(summary.verdict, "inconclusive");
  assert.equal(summary.steps[1]?.failureCode, "surface-target-changed");
  const checkPath = summary.steps[1].artifacts.find((path) => path.endsWith("target-check.json"));
  assert.ok(checkPath);
  const check = JSON.parse(await readFile(join(runner.evidenceDir, checkPath), "utf8"));
  assert.equal(check.status, "changed");
  assert.equal(check.expected.name, "Save draft");
  assert.equal(check.actual.name, "Delete draft");
  const report = join(runner.evidenceDir, summary.runId, "report.html");
  assert.ok((await readFile(report, "utf8")).includes("target-check.json"));
  assert.ok((await readFile(report, "utf8")).includes("Target identity: changed"));
  const mission = await runner.createMission({ intent: "Save the draft", surface: "web", headful, charter });
  await runner.startMission(mission.missionId, { approve: true }); await runner.waitMission(mission.missionId);
  const missionEvidence = await runner.missionEvidence(mission.missionId);
  assert.equal(missionEvidence.testVerdict, "inconclusive");
  assert.equal(missionEvidence.summary.confirmedProductFindings, 0);
  assert.equal(writes, 0);
  assert.equal(missionEvidence.summary.runs.find((run) => run.runKind === "primary").verdict, "inconclusive");
  label = "Save draft";
  const matchingRun = await runner.start({ adapter: "web", headful, start: false, charter });
  const matching = await runner.wait(matchingRun.runId);
  assert.equal(matching.verdict, "passed");
  assert.equal(writes, 1);
  assert.equal(matching.steps[1].targetChecks[0].status, "matched");
  writes = 0;
  class RepaintingAdapter extends WebAdapter {
    async act(action, context) {
      return super.act(action, { ...context, recordTargetCheck: async (check) => {
        await context.recordTargetCheck(check);
        await this.page().evaluate(() => {
          const old = document.querySelector('#action');
          const replacement = old.cloneNode(true); replacement.textContent = 'Delete draft';
          replacement.onclick = () => fetch('/write', { method: 'POST' }); old.replaceWith(replacement);
        });
      } });
    }
  }
  const repainted = await new ExecutionRunner(new RepaintingAdapter({ baseUrl, headless: !headful, ...(executablePath ? { executablePath } : {}) }),
    { evidenceDir: runner.evidenceDir, projectRoot, workspaceRoot }).run(charter);
  assert.equal(repainted.verdict, "inconclusive");
  assert.equal(writes, 0, "The adapter must act on the checked element instead of retargeting its replacement");
  assert.equal(repainted.steps[1].status, "failed");
  buttonId = "new-action";
  const driftRun = await runner.start({ adapter: "web", headful, start: false, charter });
  const drift = await runner.wait(driftRun.runId);
  assert.equal(drift.verdict, "inconclusive");
  assert.equal(drift.steps[1].failureCode, "surface-selector-drift");
  assert.equal(writes, 0);
  const pending = await runner.approveSurfaceReplan({ runId: drift.runId, stepId: "step-002", selector: "#new-action" });
  assert.equal(pending.status, "awaiting-approval");
  const approved = await runner.approveSurfaceReplan({ runId: drift.runId, stepId: "step-002", selector: "#new-action", approve: true });
  assert.equal(approved.charter.actions[1].expectedTarget.name, "Save draft");
  const replacement = await runner.wait(approved.run.runId);
  assert.equal(replacement.verdict, "passed", JSON.stringify(replacement, null, 2));
  assert.equal(replacement.execution.replayOfRunId, drift.runId);
  assert.equal(replacement.execution.visibility, headful ? "headful" : "headless");
  assert.equal(writes, 1);
  const manifest = await runner.evidenceManifest(summary.runId);
  assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
  console.log(JSON.stringify({ status: "passed", reusedSelectorBlocked: true, matchingPlanPassed: true, replacementAfterCheckNotClicked: true, approvedReplanRetainsNewIdentity: true,
    unreviewedWrites: 0, approvedWrites: writes, verdict: summary.verdict, missionVerdict: missionEvidence.testVerdict, noFalseProductFinding: true, manifest: "intact",
    ...(keepArtifacts ? { workspaceRoot, projectRoot, report, missionReport: missionEvidence.report } : {}) }, null, 2));
} finally {
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
