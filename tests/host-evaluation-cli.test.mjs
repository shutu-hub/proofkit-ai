import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("host evaluator stops after a provider blocker and does not score later cases", async (t) => {
  const toolsRoot = await mkdtemp(join(tmpdir(), "proofkit-fake-host-"));
  let evaluationRoot;
  t.after(async () => {
    if (evaluationRoot) await rm(evaluationRoot, { recursive: true, force: true });
    await rm(toolsRoot, { recursive: true, force: true });
  });
  const cli = join(toolsRoot, "fake-codex.js");
  const argvPath = join(toolsRoot, "argv.json");
  await writeFile(cli, `require("node:fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({type:"error",message:"403 Forbidden: insufficient balance"})+"\\n"); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, ["tests/host-evaluation.mjs", "--run", "--cases", "core-pass,core-defect", "--timeout-ms", "10000",
    ...(process.platform === "win32" ? ["--windows-sandbox", "unelevated"] : [])], {
    cwd: repo, windowsHide: true, shell: false,
    env: { ...process.env, PROOFKIT_CODEX_CLI: cli }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const lines = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  evaluationRoot = lines[0]?.evaluationRoot;
  assert.equal(code, 1, stderr);
  assert.ok(evaluationRoot);
  const report = JSON.parse(await readFile(join(evaluationRoot, "host-evaluation.json"), "utf8"));
  assert.equal(report.total, 2);
  assert.equal(report.attempted, 1);
  assert.equal(report.evaluated, 0);
  assert.equal(report.stoppedBy, "provider-balance");
  assert.deepEqual(report.notRun, ["core-defect"]);
  assert.equal(report.cases[0].hostOutcome, "infrastructure-blocked");
  assert.deepEqual(report.cases[0].validation.issues, ["provider-balance"]);
  if (process.platform === "win32") {
    assert.equal(report.windowsSandbox, "unelevated");
    assert.ok(JSON.parse(await readFile(argvPath, "utf8")).includes('windows.sandbox="unelevated"'));
  }
});

test("a timed-out host preserves a candidate answer without scoring it as a pass", async (t) => {
  const toolsRoot = await mkdtemp(join(tmpdir(), "proofkit-fake-host-timeout-"));
  let evaluationRoot;
  t.after(async () => {
    if (evaluationRoot) await rm(evaluationRoot, { recursive: true, force: true });
    await rm(toolsRoot, { recursive: true, force: true });
  });
  const cli = join(toolsRoot, "fake-codex.js");
  const candidate = { missionId: "mission-candidate", verdict: "passed", level: "core", coverage: "declared",
    surface: "web", report: "report.html", evidencePaths: ["facts.json"], gaps: [], summary: "Candidate only" };
  await writeFile(cli, `
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
  text: ${JSON.stringify(JSON.stringify(candidate))} } }) + "\\n");
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, ["tests/host-evaluation.mjs", "--run", "--cases", "core-pass", "--timeout-ms", "10000",
    ...(process.platform === "win32" ? ["--windows-sandbox", "unelevated"] : [])], {
    cwd: repo, windowsHide: true, shell: false,
    env: { ...process.env, PROOFKIT_CODEX_CLI: cli }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const lines = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  evaluationRoot = lines[0]?.evaluationRoot;
  assert.equal(code, 1, stderr);
  const report = JSON.parse(await readFile(join(evaluationRoot, "host-evaluation.json"), "utf8"));
  assert.equal(report.passed, 0);
  assert.equal(report.evaluated, 0);
  assert.equal(report.cases[0].hostOutcome, "incomplete");
  assert.equal(report.cases[0].execution.timedOut, true);
  assert.equal(report.cases[0].execution.milestones.turnCompletedAtMs, null);
  assert.ok(report.cases[0].execution.milestones.lastAgentMessageAtMs >= 0);
  assert.equal(report.cases[0].validation.passed, false);
  assert.deepEqual(report.cases[0].provisional.answer, candidate);
  assert.equal(report.cases[0].provisional.validation.passed, false);
});
