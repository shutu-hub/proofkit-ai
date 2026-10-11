import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { inspectTargetBinding } from "../packages/project/dist/index.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";

if (process.platform !== "win32") {
  console.log("Windows listener inspection smoke skipped on this platform.");
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), "proofkit-listener-smoke-"));
const sourceRoot = join(tempRoot, "source fixture");
const workspaceRoot = join(tempRoot, "workspace");
const serverPath = join(sourceRoot, "server.mjs");
const chromePath = process.env.PROOFKIT_BROWSER_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let serverChild;
try {
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(workspaceRoot, ".proofkit"), { recursive: true });
  await writeFile(serverPath, `import { createServer } from "node:http";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>ProofKit target</title><h1>Ready</h1>");
});
server.listen(Number(process.env.PROOFKIT_FIXTURE_PORT), "127.0.0.1", () => process.send?.({ ready: true }));
`);
  execFileSync("git", ["init", "-q", sourceRoot], { windowsHide: true });
  execFileSync("git", ["-C", sourceRoot, "-c", "core.autocrlf=false", "add", "server.mjs"], { windowsHide: true });
  execFileSync("git", ["-C", sourceRoot, "-c", "user.name=ProofKit Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { windowsHide: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  serverChild = await startServer(port);

  const initialBinding = await inspectTargetBinding(sourceRoot, baseUrl);
  assert.equal(initialBinding.status, "matching-process-path", JSON.stringify(initialBinding));
  assert.equal(initialBinding.processId, serverChild.pid, JSON.stringify(initialBinding));

  const config = ProofkitConfigSchema.parse({
    project: { root: sourceRoot },
    surfaces: { web: { baseUrl, executablePath: chromePath } },
    policies: { environment: "test", sideEffects: "deny" },
    run: { timeoutMs: 30_000 },
  });
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(config));
  let replaceDuringOracle = false;
  const service = await LocalRunnerService.create({ root: sourceRoot, workspaceRoot, oracles: [{
    name: "fixture-terminal",
    check: async ({ runId }) => {
      if (replaceDuringOracle) {
        replaceDuringOracle = false;
        await stopServer(serverChild);
        serverChild = await startServer(port);
      }
      return { name: "fixture-terminal", passed: true, message: "The fixture business state is ready.",
        evidence: [JSON.stringify({ runId, state: "ready" })] };
    },
  }] });
  const charter = {
    intent: "Check one local listener and its business state", level: "core", mode: "deterministic",
    preconditions: [], actions: [{ kind: "goto", url: baseUrl }],
    assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["fixture-terminal"],
    sideEffectPolicy: "deny", metadata: {},
  };

  const stable = await runMission(charter);
  assert.equal(stable.result.testVerdict, "passed", JSON.stringify(stable.result.summary?.gaps));
  assert.equal(stable.result.summary?.scope?.sourceStability, "stable");
  assert.equal(stable.run.targetContinuity, "stable");
  assert.equal(stable.run.targetBinding.processId, stable.run.targetBindingAfterRun.processId);

  replaceDuringOracle = true;
  const changed = await runMission(charter);
  assert.equal(changed.run.targetContinuity, "changed", JSON.stringify(changed.run));
  assert.notEqual(changed.run.targetBinding.processId, changed.run.targetBindingAfterRun.processId);
  assert.equal(changed.run.verdict, "inconclusive");
  assert.equal(changed.result.testVerdict, "inconclusive");
  assert.equal(changed.result.summary?.runs[0]?.targetContinuity, "changed");
  assert.equal(changed.result.summary?.scope?.sourceStability, "stable");
  const report = await readFile(changed.result.report, "utf8");
  assert.match(report, /Target continuity: changed/);
  assert.equal(execFileSync("git", ["-C", sourceRoot, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(), "");
  console.log(JSON.stringify({ stableMission: stable.result.missionId, changedMission: changed.result.missionId,
    stablePid: stable.run.targetBinding.processId, changedPid: changed.run.targetBindingAfterRun.processId,
    verified: ["real-windows-listener", "real-browser", "oracle-time-replacement", "run-and-mission-verdict", "report"] }, null, 2));

  async function runMission(selectedCharter) {
    const created = await service.createMission({ intent: selectedCharter.intent, surface: "web", charter: selectedCharter });
    await service.startMission(created.missionId, { approve: true });
    await service.waitMission(created.missionId);
    const result = await service.missionEvidence(created.missionId);
    const runId = result.summary?.runs[0]?.runId;
    assert.ok(runId, JSON.stringify(result.summary?.runs));
    const run = (await service.status(runId)).summary;
    assert.ok(run);
    return { result, run };
  }

  async function startServer(targetPort) {
    const child = spawn(process.execPath, [serverPath], { cwd: sourceRoot, windowsHide: true,
      env: { ...process.env, PROOFKIT_FIXTURE_PORT: String(targetPort) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    try {
      await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Fixture server did not start: ${stderr}`)), 5_000);
        child.once("message", (message) => { if (message?.ready) { clearTimeout(timeout); accept(); } });
        child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Fixture server exited ${code}: ${stderr}`)); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      return child;
    } catch (error) {
      child.kill();
      throw error;
    }
  }
} finally {
  await stopServer(serverChild);
  const resolved = await realpath(tempRoot);
  const temporaryParent = await realpath(tmpdir());
  const location = relative(temporaryParent, resolved);
  if (!location.startsWith("proofkit-listener-smoke-") || location.includes(sep)
    || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new Error("Refusing to delete an unexpected fixture directory");
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function freePort() {
  const probe = createServer();
  await new Promise((accept) => probe.listen(0, "127.0.0.1", accept));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise((accept) => probe.close(accept));
  return address.port;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture server did not stop")), 5_000);
    child.once("exit", () => { clearTimeout(timeout); accept(); });
    child.kill();
  });
}
