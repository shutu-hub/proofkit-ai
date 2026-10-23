import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { prepareSessionResources } from "../packages/local-runner/dist/session-resource-preparation.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const phase = process.argv[2];
const root = phase === "--worker" ? dirname(process.argv[4]) : await mkdtemp(join(tmpdir(), "proofkit-session-preparation-"));
const source = join(root, "source"), workspace = join(root, "workspace");
if (phase !== "--worker") { await mkdir(source); await mkdir(workspace); }
const scopes = new Map([["sentinel", { owner: "foreign" }]]), requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1"), scope = url.pathname.split("/")[2];
  if (!scope || !url.pathname.startsWith("/scopes/")) { response.writeHead(404); response.end(); return; }
  requests.push({ method: request.method, scope });
  const owned = scopes.get(scope);
  if (request.method === "GET") {
    response.writeHead(owned ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(owned ?? { scope })); return;
  }
  if (request.method === "POST" && !owned && request.headers["x-test-owner"] === scope) {
    scopes.set(scope, { owner: scope }); response.writeHead(201); response.end(); return;
  }
  if (request.method === "DELETE" && owned?.owner === scope && request.headers["x-test-owner"] === scope) {
    scopes.delete(scope); response.writeHead(204); response.end(); return;
  }
  response.writeHead(409); response.end();
});
if (phase !== "--worker") await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = phase === "--worker" ? process.argv[3] : "http://127.0.0.1:" + server.address().port;
const config = ProofkitConfigSchema.parse({ policies: { environment: "test", sideEffects: "allow" } });
const charter = TestCharterSchema.parse({ intent: "Prepare an isolated Web scope and verify its safe removal", level: "core", surfaces: ["web"],
  sideEffectPolicy: "allow", actions: [], assertions: [] });
const policy = { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 };
async function readScope(scope, signal) {
  const response = await fetch(origin + "/scopes/" + scope, { signal });
  assert.ok([200, 404].includes(response.status));
  return { status: response.status, data: await response.json() };
}
async function recover({ resources, signal }) {
  assert.equal(resources.length, 1);
  const resource = resources[0], scope = resource.scope;
  assert.equal(resource.resourceId, "scope"); assert.equal(resource.kind, "isolated-scope"); assert.equal(resource.evidence.owner, scope);
  const before = await readScope(scope, signal);
  if (before.status === 200) {
    assert.equal(before.data.owner, scope);
    const removed = await fetch(origin + "/scopes/" + scope, { method: "DELETE", headers: { "x-test-owner": scope }, signal });
    assert.equal(removed.status, 204);
  }
  const after = await readScope(scope, signal); assert.equal(after.status, 404);
  return [{ resourceId: "scope", status: "removed", evidence: { beforeStatus: before.status, afterStatus: after.status },
    readback: { reader: "fixture.scoped-get", scope, exists: false, observedAt: new Date().toISOString() } }];
}
const integration = { name: "session-resource-recovery-fixture", version: "1", setupPolicy: policy, recover };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
if (phase === "--worker") {
  const workerOrigin = process.argv[3], workerSource = process.argv[4], workerWorkspace = process.argv[5], workerPhase = process.argv[6];
  const workerIntegration = { ...integration, async setup({ runId, registerResources, signal }) {
    const resources = [{ resourceId: "scope", kind: "isolated-scope", scope: runId, evidence: { owner: runId } }];
    const handle = { resources, cleanup: ({ signal: cleanupSignal }) => recover({ resources, signal: cleanupSignal }) };
    await registerResources(handle);
    if (workerPhase === "registered") {
      console.log(JSON.stringify({ phase: workerPhase, runId }));
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    }
    const response = await fetch(workerOrigin + "/scopes/" + runId, { method: "POST", signal, headers: { "x-test-owner": runId } });
    assert.equal(response.status, 201);
    return handle;
  } };
  const worker = await prepareSessionResources({ sessionId: "00000000-0000-4000-8000-000000000001", projectRoot: workerSource,
    workspaceRoot: workerWorkspace, evidenceDir: join(workerWorkspace, ".proofkit", "runs"), config, integration: workerIntegration, charter });
  console.log(JSON.stringify({ phase: workerPhase, runId: worker.runId }));
  setInterval(() => {}, 60_000);
} else {
  const runner = await LocalRunnerService.create({ root: source, workspaceRoot: workspace, config, integration, allowCapabilityWrites: true });
  const results = [];
  try {
    for (const workerPhase of ["registered", "provisioned"]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", origin, source, workspace, workerPhase],
        { cwd: repository, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "", errorOutput = "";
      child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8"); });
      const ready = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Preparation worker did not register: " + errorOutput.slice(0, 500))), 15000);
        child.stdout.on("data", (chunk) => {
          output += chunk.toString("utf8");
          const line = output.split("\n").find((item) => item.trim().startsWith("{"));
          if (!line) return;
          clearTimeout(deadline); resolve(JSON.parse(line));
        });
        child.once("exit", (code) => { clearTimeout(deadline); reject(new Error("Preparation worker exited " + code + ": " + errorOutput.slice(0, 500))); });
      });
      let announced;
      try {
        announced = await ready;
        assert.equal(announced.phase, workerPhase);
        assert.equal((await runner.inspectRunResources(announced.runId)).status, "active");
      } finally {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill(); await exited;
      }
      const runId = announced.runId;
      const before = await readFile(join(workspace, ".proofkit", "runs", runId, "run.json"));
      const events = await readFile(join(workspace, ".proofkit", "runs", runId, "events.jsonl"));
      assert.equal((await runner.inspectRunResources(runId)).status, "recoverable");
      const recovered = await runner.recoverRunResources(runId);
      assert.equal(recovered.status, "verified"); assert.equal(recovered.testVerdict, "not-asserted");
      assert.equal((await readScope(runId)).status, 404);
      assert.equal((await runner.inspectRunResources(runId)).status, "cleaned");
      assert.deepEqual(await runner.recoverRunResources(runId), recovered);
      assert.equal(sha256(await readFile(join(workspace, ".proofkit", "runs", runId, "run.json"))), sha256(before));
      assert.equal(sha256(await readFile(join(workspace, ".proofkit", "runs", runId, "events.jsonl"))), sha256(events));
      results.push({ phase: workerPhase, runId, recoveryAttemptId: recovered.attemptId, beforeStatus: workerPhase === "registered" ? 404 : 200,
        afterStatus: 404, cleanup: recovered.cleanup.status, originalRunSha256: sha256(before), originalEventsSha256: sha256(events) });
    }
    assert.deepEqual([...scopes], [["sentinel", { owner: "foreign" }]]);
    assert.equal(requests.filter((item) => item.method === "POST").length, 1);
    assert.equal(requests.filter((item) => item.method === "DELETE").length, 1);
    const receipt = { checkedAt: new Date().toISOString(), root, results, foreignSentinelRetained: true, originalEvidenceUnchanged: true,
      scope: "Controlled child-process crash and recovery of task-owned resources; not a production external account or browser crash recording" };
    await writeFile(join(repository, "outputs/session-preparation-recovery-validation.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt, null, 2));
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
}
