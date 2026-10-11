import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ExecutionRunner } from "../packages/runner/dist/index.js";
import { inspectTargetBinding } from "../packages/project/dist/index.js";

if (process.platform !== "linux") {
  console.log("Linux /proc listener smoke skipped on this platform.");
  process.exit(0);
}
if (!(await readFile("/proc/net/tcp", "utf8")).includes("local_address")) {
  if (process.env.PROOFKIT_REQUIRE_LINUX_PROC === "1") {
    throw new Error("Linux /proc socket table is required for this CI smoke");
  }
  console.log("Linux listener smoke skipped: this environment does not expose /proc/net/tcp (for example WSL 1).");
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), "proofkit-linux-listener-"));
const sourceRoot = join(tempRoot, "expected source");
const foreignRoot = join(tempRoot, "foreign source");
const evidenceDir = join(tempRoot, "evidence");
let serverChild;
try {
  for (const root of [sourceRoot, foreignRoot]) await mkdir(root, { recursive: true });
  const sourcePath = join(sourceRoot, "server.mjs");
  const foreignPath = join(foreignRoot, "server.mjs");
  await writeFile(sourcePath, `import { createServer } from "node:http";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<h1>Ready</h1>");
});
server.listen(Number(process.env.PROOFKIT_FIXTURE_PORT), "127.0.0.1", () => process.send?.({ ready: true }));
`);
  await copyFile(sourcePath, foreignPath);
  for (const root of [sourceRoot, foreignRoot]) {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", "server.mjs"]);
    execFileSync("git", ["-C", root, "-c", "user.name=ProofKit Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  }
  const port = await freePort();
  const target = `http://127.0.0.1:${port}/`;
  serverChild = await startServer(sourcePath, port);
  const initial = await inspectTargetBinding(sourceRoot, target);
  assert.equal(initial.status, "matching-process-path", JSON.stringify(initial));
  assert.equal(initial.method, "linux-proc-listener");
  assert.equal(initial.processId, serverChild.pid);

  const adapter = () => ({
    name: "fixture", connect: async () => {}, close: async () => {},
    subscribeEvents: async () => () => {},
    snapshot: async () => ({ capturedAt: new Date().toISOString(), url: target, text: "Ready", metadata: {} }),
    discover: async () => ({ capturedAt: new Date().toISOString(), url: target, text: "Ready", metadata: {} }),
    capture: async () => undefined,
    act: async (action) => ({ actionId: action.kind, kind: action.kind, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), durationMs: 0, metadata: {} }),
    assert: async (assertion) => ({ assertion, passed: true, message: "Ready", evidence: [] }),
  });
  const charter = { intent: "Check the Linux listener", level: "core", mode: "deterministic", preconditions: [],
    actions: [], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {} };
  let replaceDuringOracle = false;
  const run = async (runId) => new ExecutionRunner(adapter(), { evidenceDir,
    targetBinding: (signal) => inspectTargetBinding(sourceRoot, target, signal),
    oracles: [{ name: "fixture-terminal", check: async () => {
      if (replaceDuringOracle) {
        replaceDuringOracle = false;
        await stopServer(serverChild);
        serverChild = await startServer(sourcePath, port);
      }
      return { name: "fixture-terminal", passed: true, message: "Fixture ready",
        evidence: [JSON.stringify({ state: "ready" })] };
    } }],
  }).run(charter, runId);
  const stable = await run("linux-stable");
  assert.equal(stable.verdict, "passed", JSON.stringify(stable.findings));
  assert.equal(stable.targetContinuity, "stable");
  replaceDuringOracle = true;
  const changed = await run("linux-replaced");
  assert.equal(changed.verdict, "inconclusive", JSON.stringify(changed.findings));
  assert.equal(changed.targetContinuity, "changed");
  assert.notEqual(changed.targetBinding.processId, changed.targetBindingAfterRun.processId);

  await stopServer(serverChild);
  serverChild = await startServer(foreignPath, port);
  const foreign = await inspectTargetBinding(sourceRoot, target);
  assert.equal(foreign.status, "different-project", JSON.stringify(foreign));
  assert.equal(foreign.method, "linux-proc-listener");
  assert.equal(foreign.processId, serverChild.pid);
  for (const root of [sourceRoot, foreignRoot]) {
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  }
  console.log(JSON.stringify({ stablePid: stable.targetBinding.processId,
    changedPid: changed.targetBindingAfterRun.processId, foreignPid: foreign.processId,
    verified: ["linux-proc-listener", "run-continuity", "foreign-checkout"] }, null, 2));
} finally {
  await stopServer(serverChild);
  const resolved = await realpath(tempRoot);
  const location = relative(await realpath(tmpdir()), resolved);
  if (!location.startsWith("proofkit-linux-listener-") || location.includes(sep)
    || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new Error("Refusing to delete an unexpected fixture directory");
  }
  await rm(resolved, { recursive: true, force: true });
}

async function freePort() {
  const probe = createServer();
  await new Promise((accept) => probe.listen(0, "127.0.0.1", accept));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise((accept) => probe.close(accept));
  return address.port;
}

async function startServer(script, port) {
  const child = spawn(process.execPath, [script], { cwd: dirname(script),
    env: { ...process.env, PROOFKIT_FIXTURE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
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
  } catch (error) { child.kill(); throw error; }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture server did not stop")), 5_000);
    child.once("exit", () => { clearTimeout(timeout); accept(); });
    child.kill();
  });
}
