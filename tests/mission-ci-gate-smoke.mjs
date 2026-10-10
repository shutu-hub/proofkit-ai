import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const runFile = promisify(execFile);
const cli = resolve("bundle/main.js");
const scratch = await mkdtemp(join(tmpdir(), "proofkit-ci-gate-"));
const source = join(scratch, "source");
const workspace = join(scratch, "workspace");
const browserPath = process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>ProofKit CI fixture</title><h1>Fixture ready</h1>");
});

try {
  const action = parseYaml(await readFile(resolve("action.yml"), "utf8"));
  assert.equal(action.runs.using, "composite");
  assert.equal(action.runs.steps.at(-1).env.PROOFKIT_ACTION_INTENT, "${{ inputs.intent }}");
  assert.equal(action.runs.steps.at(-1).env.PROOFKIT_ACTION_MISSION_ID, "${{ inputs.mission-id }}");
  assert.equal(action.outputs["test-verdict"].value, "${{ steps.gate.outputs.test-verdict }}");
  if (browserPath) assert.ok(existsSync(browserPath), `Browser not found: ${browserPath}`);
  await Promise.all([mkdir(source), mkdir(join(workspace, ".proofkit"), { recursive: true })]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "ci-gate-fixture", dependencies: { vite: "*" } }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({
    project: { root: source },
    surfaces: { web: { baseUrl: url, ...(browserPath ? { executablePath: browserPath } : {}) } },
  }));

  const location = ["--root", source, "--workspace", workspace];
  const created = JSON.parse((await command("mission", "create", "Check fixture ready", "--level", "quick", "--url", url,
    "--expect", "Fixture ready", ...location)).stdout);
  const unstarted = await command("mission", "check", created.missionId, ...location);
  assert.equal(unstarted.code, 2);
  assert.equal(JSON.parse(unstarted.stdout).testVerdict, "not-asserted");
  const passed = await command("mission", "run", created.missionId, "--approve", ...location);
  assert.equal(passed.code, 0, passed.stderr || passed.stdout);
  const initial = JSON.parse(passed.stdout);
  assert.equal(initial.verdict, "passed");
  assert.equal(initial.testVerdict, "passed");
  const checked = await command("mission", "check", created.missionId, ...location);
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).testVerdict, "passed");
  const replay = await command("mission", "replay", created.missionId, ...location);
  assert.equal(replay.code, 0, replay.stderr || replay.stdout);
  assert.equal(JSON.parse(replay.stdout).testVerdict, "passed");

  const negative = JSON.parse((await command("mission", "create", "Check missing fixture text", "--level", "quick", "--url", url,
    "--expect", "This text is absent", ...location)).stdout);
  const failed = await command("mission", "run", negative.missionId, "--approve", ...location);
  assert.equal(failed.code, 1, failed.stderr || failed.stdout);
  assert.equal(JSON.parse(failed.stdout).testVerdict, "failed");

  await mkdir(join(workspace, "charters"));
  await writeFile(join(workspace, "charters", "ready.yml"), JSON.stringify({
    intent: "Fixture ready", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "goto", url }], assertions: [{ kind: "text-visible", text: "Fixture ready" }],
    sideEffectPolicy: "deny", metadata: {},
  }));
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify({
    project: { root: source },
    surfaces: { web: { baseUrl: url, ...(browserPath ? { executablePath: browserPath } : {}) } },
    charters: [{ id: "fixture-ready", path: "charters/ready.yml", aliases: ["Fixture ready"], level: "quick", surfaces: ["web"] }],
  }));
  const actionOutput = join(scratch, "github-output.txt");
  const actionSummary = join(scratch, "github-summary.md");
  const actionRun = await actionCommand({
    PROOFKIT_ACTION_INTENT: "Fixture ready", PROOFKIT_ACTION_MODE: "run",
    PROOFKIT_ACTION_LEVEL: "quick", PROOFKIT_ACTION_CHARTER_ID: "fixture-ready",
    PROOFKIT_BROWSER_PATH: join(scratch, "missing-browser"),
  }, actionOutput, actionSummary);
  assert.equal(actionRun.code, 0, actionRun.stderr || actionRun.stdout);
  const actionResult = JSON.parse(actionRun.stdout);
  assert.equal(actionResult.testVerdict, "passed");
  assert.equal(JSON.parse(await readFile(actionResult.summaryPath, "utf8")).testVerdict, "passed");
  assert.match(await readFile(actionOutput, "utf8"), new RegExp(`mission-id=${actionResult.missionId}`));
  assert.match(await readFile(actionSummary, "utf8"), /Current test verdict \| passed/);
  const adHocRun = await actionCommand({
    PROOFKIT_ACTION_INTENT: "Quick fixture check", PROOFKIT_ACTION_MODE: "run",
    PROOFKIT_ACTION_LEVEL: "quick", PROOFKIT_ACTION_URL: url,
    PROOFKIT_ACTION_EXPECT_TEXT: "Fixture ready",
  }, actionOutput, actionSummary);
  assert.equal(adHocRun.code, 0, adHocRun.stderr || adHocRun.stdout);
  assert.equal(JSON.parse(adHocRun.stdout).testVerdict, "passed");
  const freshWorkspace = join(scratch, "fresh-workspace");
  const firstUse = await actionCommand({
    PROOFKIT_ACTION_WORKSPACE_ROOT: freshWorkspace,
    PROOFKIT_ACTION_INTENT: "First-use quick check", PROOFKIT_ACTION_MODE: "run",
    PROOFKIT_ACTION_LEVEL: "quick", PROOFKIT_ACTION_URL: url,
    PROOFKIT_ACTION_EXPECT_TEXT: "Fixture ready",
  }, actionOutput, actionSummary);
  if (firstUse.code !== 0) {
    const firstResult = JSON.parse(await readFile(JSON.parse(firstUse.stdout).summaryPath, "utf8"));
    const firstRun = firstResult.runs[0]?.runId;
    throw new Error(firstRun ? await readFile(join(freshWorkspace, ".proofkit", "runs", firstRun, "run.json"), "utf8") : firstUse.stdout);
  }
  assert.equal(JSON.parse(firstUse.stdout).testVerdict, "passed");
  assert.ok(existsSync(join(freshWorkspace, ".proofkit", "config.yaml")));
  assert.deepEqual(await readdir(source), ["package.json"]);
  const coreWithoutOracle = await actionCommand({
    PROOFKIT_ACTION_WORKSPACE_ROOT: freshWorkspace,
    PROOFKIT_ACTION_INTENT: "Core flow without business proof", PROOFKIT_ACTION_MODE: "run",
    PROOFKIT_ACTION_LEVEL: "core", PROOFKIT_ACTION_URL: url,
    PROOFKIT_ACTION_EXPECT_TEXT: "Fixture ready",
  }, actionOutput, actionSummary);
  assert.equal(coreWithoutOracle.code, 2);
  const coreOutcome = JSON.parse(coreWithoutOracle.stdout);
  assert.equal(coreOutcome.testVerdict, "inconclusive");
  assert.match(coreOutcome.reason, /Oracle|业务/);
  const conflictingInputs = await actionCommand({
    PROOFKIT_ACTION_MISSION_ID: created.missionId, PROOFKIT_ACTION_INTENT: "Unexpected second source",
    PROOFKIT_ACTION_MODE: "run",
  }, actionOutput, actionSummary);
  assert.equal(conflictingInputs.code, 2);
  assert.equal(JSON.parse(conflictingInputs.stdout).testVerdict, "inconclusive");
  const terminalRerun = await actionCommand({
    PROOFKIT_ACTION_MISSION_ID: created.missionId, PROOFKIT_ACTION_MODE: "run",
  }, actionOutput, actionSummary);
  assert.equal(terminalRerun.code, 2);
  assert.match(JSON.parse(terminalRerun.stdout).reason, /terminal Mission/);

  // Historical evidence remains auditable even if the project's trusted connector can no longer load.
  await writeFile(join(workspace, ".proofkit", "integration.mjs"), 'throw new Error("connector must not load during a saved-result check");\n');
  const actionCheck = await actionCommand({ PROOFKIT_ACTION_MISSION_ID: created.missionId,
    PROOFKIT_ACTION_MODE: "check" }, actionOutput, actionSummary);
  assert.equal(actionCheck.code, 0, actionCheck.stderr || actionCheck.stdout);
  assert.equal(JSON.parse(actionCheck.stdout).testVerdict, "passed");
  const isolatedCheck = await command("mission", "check", created.missionId, ...location);
  assert.equal(isolatedCheck.code, 0, isolatedCheck.stderr || isolatedCheck.stdout);
  assert.equal(JSON.parse(isolatedCheck.stdout).testVerdict, "passed");
  const failedCheck = await command("mission", "check", negative.missionId, ...location);
  assert.equal(failedCheck.code, 1);
  assert.equal(JSON.parse(failedCheck.stdout).testVerdict, "failed");

  const artifact = initial.evidence.find((item) => item.sha256 && item.path && existsSync(item.path));
  assert.ok(artifact, "Passing Mission did not retain a hashed evidence file");
  await writeFile(artifact.path, `${await readFile(artifact.path, "utf8")}\nchanged after the Mission completed\n`);
  const degraded = await command("mission", "check", created.missionId, ...location);
  assert.equal(degraded.code, 2, degraded.stderr || degraded.stdout);
  const result = JSON.parse(degraded.stdout);
  assert.equal(result.verdict, "passed");
  assert.equal(result.testVerdict, "inconclusive");
  assert.equal(result.summary.schemaVersion, "1");
  assert.equal(result.summary.testVerdict, "inconclusive");
  assert.notEqual(result.acceptanceEvidenceIntegrity.status, "intact");
  const actionDegraded = await actionCommand({ PROOFKIT_ACTION_MISSION_ID: created.missionId,
    PROOFKIT_ACTION_MODE: "check" }, actionOutput, actionSummary);
  assert.equal(actionDegraded.code, 2);
  const actionDegradedResult = JSON.parse(actionDegraded.stdout);
  assert.equal(actionDegradedResult.testVerdict, "inconclusive");
  assert.equal(JSON.parse(await readFile(actionDegradedResult.summaryPath, "utf8")).testVerdict, "inconclusive");

  console.log(JSON.stringify({ missionId: created.missionId, savedVerdict: result.verdict,
    auditedVerdict: result.testVerdict, exitCode: degraded.code }));
} finally {
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}

async function command(...args) {
  try {
    const output = await runFile(process.execPath, [cli, ...args], { cwd: process.cwd(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, ...output };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function actionCommand(input, outputPath, summaryPath) {
  const env = { ...process.env, GITHUB_ACTION_PATH: process.cwd(), GITHUB_WORKSPACE: scratch,
    GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
    PROOFKIT_ACTION_PROJECT_ROOT: source, PROOFKIT_ACTION_WORKSPACE_ROOT: workspace,
    ...(browserPath ? { PROOFKIT_BROWSER_PATH: browserPath } : {}), ...input };
  try {
    const output = await runFile(process.execPath, [resolve("scripts/github-action-gate.mjs")],
      { cwd: process.cwd(), env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, ...output };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
