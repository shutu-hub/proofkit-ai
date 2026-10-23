import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const output = await mkdtemp(join(tmpdir(), "proofkit-eval-harness-smoke-"));
let calls = 0;
let providerMode = "invalid";
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const prompt = JSON.parse(JSON.parse(raw).messages.find((message) => message.role === "user").content);
  calls++;
  const control = (role, name) => {
    const found = prompt.surfaceSnapshot.controls.filter((item) => item.role === role && item.name === name && item.selector);
    assert.equal(found.length, 1);
    return found[0].selector;
  };
  const url = prompt.constraints.url;
  const plans = {
    "save a catalog item": () => ({ actions: [{ kind: "goto", url }, { kind: "fill", selector: control("textbox", "Title"), value: "generic item" },
      { kind: "click", selector: control("button", "Save") }, { kind: "waitForText", text: "Saved" }], assertions: [{ kind: "text-visible", text: "Saved" }] }),
    "sign in and open the private dashboard": () => ({ actions: [{ kind: "goto", url }, { kind: "click", selector: control("button", "Sign in") },
      { kind: "goto", url: `${new URL(url).origin}/private` }], assertions: [{ kind: "text-visible", text: "Private dashboard" }, { kind: "text-not-visible", text: "Unauthorized" }] }),
    "start an asynchronous job": () => ({ actions: [{ kind: "goto", url }, { kind: "click", selector: control("button", "Start job") },
      { kind: "waitForText", text: "Job started" }], assertions: [{ kind: "text-visible", text: "Job started" }] }),
  };
  const plan = providerMode === "valid" ? plans[prompt.intent]?.() : { actions: [{ kind: "goto", url }, { kind: "click", selector: "#invented-control" }],
    assertions: [{ kind: "text-visible", text: "imagined success" }] };
  const charter = { intent: prompt.intent, level: "quick", mode: "deterministic", sideEffectPolicy: "allow", preconditions: [], metadata: {},
    oracles: prompt.constraints.oracleNames, ...plan };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(charter) } }] }));
});
const seenReports = new Set();
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture did not bind");
  const evaluate = async () => {
    let rejected = false;
    try {
      await execute(process.execPath, ["tests/model-web-evaluation.mjs", "--trials", "1", "--output-dir", output], {
      env: { ...process.env, PROOFKIT_PLANNER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PROOFKIT_PLANNER_MODEL: "invalid-selector-fixture" },
      timeout: 120_000, maxBuffer: 1024 * 1024,
      });
    } catch { rejected = true; }
    const files = await readdir(output);
    const reports = files.filter((file) => file.startsWith("evaluation-") && file.endsWith(".json"));
    const fresh = reports.filter((path) => !seenReports.has(path));
    assert.equal(fresh.length, 1);
    seenReports.add(fresh[0]);
    const report = JSON.parse(await readFile(join(output, fresh[0]), "utf8"));
    return { rejected, report };
  };
  const { rejected, report } = await evaluate();
  assert.equal(rejected, true, "An evaluator with failed cases must exit nonzero");
  assert.equal(report.evaluationStatus, "failed");
  assert.equal(report.plannedAttempts, 3);
  assert.equal(report.pendingAttempts, 0);
  assert.deepEqual(report.summary, { scheduled: 3, valid: 3, invalid: 0, completed: 0, claimedPassed: 0, falsePasses: 0, unverified: 0, unavailableBusiness: 0, completionRate: 0, falsePassRate: null });
  assert.deepEqual(report.attempts.map((attempt) => attempt.project), ["catalog-crud", "account-portal", "job-console"]);
  assert.ok(report.attempts.every((attempt) => attempt.status === "failed" && attempt.phase === "planning" && !attempt.independentBusinessPassed));
  const checkRetained = async (attempts) => { for (const attempt of attempts) {
    const receipt = JSON.parse(await readFile(attempt.receiptPath, "utf8"));
    assert.equal(receipt.status, attempt.status);
    const parent = dirname(attempt.workspaceRoot);
    assert.equal(parent, attempt.evaluationRoot);
    assert.equal(dirname(parent), output);
    assert.ok(basename(parent).startsWith("trial-"));
  } };
  await checkRetained(report.attempts);
  providerMode = "valid";
  const success = await evaluate();
  assert.equal(success.rejected, false, `Three evidenced successes must exit zero: ${JSON.stringify(success.report.attempts.map((attempt) => ({ project: attempt.project, status: attempt.status, phase: attempt.phase, verdict: attempt.verdict, failureKind: attempt.failureKind })))}`);
  assert.equal(success.report.evaluationStatus, "passed");
  assert.deepEqual(success.report.summary, { scheduled: 3, valid: 3, invalid: 0, completed: 3, claimedPassed: 3, falsePasses: 0, unverified: 0, unavailableBusiness: 0, completionRate: 1, falsePassRate: 0 });
  await checkRetained(success.report.attempts);
  assert.equal(calls, 6);
  console.log(JSON.stringify({ status: "passed", failedTrialsRetained: 3, evidencedSuccesses: 3, falseCompletionClaims: 0 }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
