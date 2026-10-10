import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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

  const artifact = initial.evidence.find((item) => item.sha256 && item.path && existsSync(item.path));
  assert.ok(artifact, "Passing Mission did not retain a hashed evidence file");
  await writeFile(artifact.path, `${await readFile(artifact.path, "utf8")}\nchanged after the Mission completed\n`);
  const degraded = await command("mission", "check", created.missionId, ...location);
  assert.equal(degraded.code, 2, degraded.stderr || degraded.stdout);
  const result = JSON.parse(degraded.stdout);
  assert.equal(result.verdict, "passed");
  assert.equal(result.testVerdict, "inconclusive");
  assert.equal(result.summary.testVerdict, "inconclusive");
  assert.notEqual(result.acceptanceEvidenceIntegrity.status, "intact");

  const negative = JSON.parse((await command("mission", "create", "Check missing fixture text", "--level", "quick", "--url", url,
    "--expect", "This text is absent", ...location)).stdout);
  const failed = await command("mission", "run", negative.missionId, "--approve", ...location);
  assert.equal(failed.code, 1, failed.stderr || failed.stdout);
  assert.equal(JSON.parse(failed.stdout).testVerdict, "failed");
  const failedCheck = await command("mission", "check", negative.missionId, ...location);
  assert.equal(failedCheck.code, 1);
  assert.equal(JSON.parse(failedCheck.stdout).testVerdict, "failed");
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
