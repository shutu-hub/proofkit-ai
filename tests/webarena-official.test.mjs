import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = process.env.PROOFKIT_WEBARENA_UPSTREAM;
const python = process.env.PROOFKIT_WEBARENA_PYTHON;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);

test("official evaluator: controls, planned denominator, invalid input and immutable batches", {
  skip: !upstream || !python ? "Set PROOFKIT_WEBARENA_UPSTREAM and PROOFKIT_WEBARENA_PYTHON for pinned official evaluation" : false,
  timeout: 180_000,
}, async () => {
  const temporary = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-webarena-"));
  console.log(`Official benchmark regression artifacts: ${temporary}`);
  const cli = async (command, directory, extra = [], expectedExit = 0) => {
    let code = 0;
    try {
      await execute(process.execPath, [join(root, "scripts/webarena-benchmark.mjs"), command,
        "--upstream", upstream, "--python", python, "--output", join(temporary, directory), ...extra],
      { cwd: root, timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) { code = error.code; }
    assert.equal(code, expectedExit, `${command}/${directory} exit`);
    return join(temporary, directory);
  };
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const controls = await cli("replay", "controls");
  const calibration = await json(join(controls, "report.json"));
  assert.equal(calibration.summary.controlsMatched, 7);
  assert.equal(calibration.summary.controlsMismatched, 0);
  assert.equal(calibration.summary.taskSuccessOverPlanned, null);
  assert.equal(calibration.cases.find((item) => item.caseId === "missing-network-108").status, "error");
  assert.equal(calibration.runtime.installedSourceMatches, true);

  const batch = await cli("prepare", "batch");
  const manifest = await json(join(batch, "report.json"));
  assert.equal(manifest.summary.attempted, 0);
  assert.equal(manifest.summary.taskSuccessOverPlanned, null);
  const submissions = join(temporary, "submissions");
  await mkdir(submissions);
  const config = join(temporary, "environment.json");
  await writeFile(config, JSON.stringify({ environments: { __SHOPPING_ADMIN__: { urls: ["http://192.168.1.35:7780"] } } }));
  const gradeOptions = ["--batch", batch, "--submissions", submissions, "--config", config];
  const empty = await cli("grade", "missing", gradeOptions, 1);
  const missing = await json(join(empty, "report.json"));
  assert.equal(missing.summary.notRun, 12);
  assert.equal(missing.summary.taskSuccessOverPlanned, null);

  await mkdir(join(submissions, "108"));
  for (const name of ["agent_response.json", "network.har"]) {
    await copyFile(join(upstream, "examples/agent_logs/demo/108", name), join(submissions, "108", name));
  }
  await mkdir(join(submissions, "0"));
  await writeFile(join(submissions, "0/agent_response.json"), "{malformed");
  await writeFile(join(submissions, "0/network.har"), JSON.stringify({ log: { entries: [] } }));
  const partial = await cli("grade", "partial", gradeOptions, 1);
  const imported = await json(join(partial, "report.json"));
  assert.equal(imported.summary.successful, 1);
  assert.equal(imported.summary.errors, 1);
  assert.equal(imported.summary.notRun, 10);
  assert.equal(imported.summary.taskSuccessOverPlanned, 1 / 12);
  assert.equal(imported.summary.proofkitEffectiveness, "not-measured");
  assert.equal(imported.cases.find((item) => item.taskId === 0).reason, "invalid-input");
  assert.equal(await readFile(join(partial, "submissions/0/agent_response.json"), "utf8"), "{malformed");
  const captured = await readFile(join(partial, "submissions/108/agent_response.json"));
  await writeFile(join(submissions, "108/agent_response.json"), "{}");
  assert.deepEqual(await readFile(join(partial, "submissions/108/agent_response.json")), captured);
  const requests = await json(join(partial, "request-evaluate.json"));
  assert.equal(requests.cases[0].response, join(partial, "submissions/108/agent_response.json"));

  const originalTasks = await readFile(join(batch, "agent-input/tasks.json"));
  await writeFile(join(batch, "agent-input/tasks.json"), "[]");
  const tampered = await cli("grade", "tampered", gradeOptions, 1);
  assert.match((await json(join(tampered, "blocked.json"))).reason, /Public tasks changed/);
  await writeFile(join(batch, "agent-input/tasks.json"), originalTasks);
  await cli("prepare", "batch", [], 1);
  assert.deepEqual(await json(join(batch, "report.json")), manifest, "existing run was not overwritten");
});
