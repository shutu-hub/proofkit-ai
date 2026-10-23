import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const script = fileURLToPath(import.meta.url);
const repository = dirname(dirname(script));
const setupPolicy = { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 };
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const charter = { intent: "Verify recovery of a registered isolated scope during partial setup", level: "quick", mode: "deterministic", sideEffectPolicy: "allow",
  actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }] };
function config(origin) { return ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin } }, policies: { environment: "test", sideEffects: "allow" }, run: { timeoutMs: 60000 } }); }
async function readScope(origin, scope, signal) {
  const response = await fetch(origin + "/scopes/" + scope, { signal, redirect: "error" }); const facts = await response.json();
  assert.equal(facts.scope, scope); assert.ok([200, 404].includes(response.status));
  return { status: response.status, facts };
}
function integration(origin) {
  return { name: "early-registration-recovery", version: "1", setupPolicy,
    async recover({ runId, signal, resources }) {
      assert.equal(resources.length, 1); const resource = resources[0];
      assert.equal(resource.scope, runId); assert.equal(resource.resourceId, "scope"); assert.equal(resource.kind, "synthetic-scope"); assert.equal(resource.evidence.owner, runId);
      const before = await readScope(origin, runId, signal); let deletion;
      if (before.status === 200) {
        assert.equal(before.facts.owner, runId);
        const response = await fetch(origin + "/scopes/" + runId, { method: "DELETE", headers: { "x-test-owner": runId }, signal, redirect: "error" });
        deletion = response.status; assert.equal(deletion, 204);
      }
      const after = await readScope(origin, runId, signal); assert.equal(after.status, 404);
      return [{ resourceId: "scope", status: "removed", evidence: { beforeStatus: before.status, deletionStatus: deletion ?? 0, afterStatus: after.status },
        readback: { reader: "fixture.scoped-get", scope: runId, exists: false, observedAt: new Date().toISOString() } }];
    } };
}

if (process.argv.includes("--worker")) {
  const origin = argument("--origin"), projectRoot = argument("--project"), workspaceRoot = argument("--workspace"), phase = argument("--phase");
  const connector = integration(origin);
  connector.setup = async ({ runId, registerResources, signal }) => {
    const resources = [{ resourceId: "scope", kind: "synthetic-scope", scope: runId, evidence: { owner: runId } }];
    const handle = { resources, cleanup: (context) => connector.recover({ ...context, resources }) };
    await registerResources(handle);
    if (phase === "provisioned" || phase === "in-flight") {
      if (phase === "in-flight") console.log(JSON.stringify({ phase, runId }));
      const response = await fetch(origin + "/scopes/" + runId + (phase === "in-flight" ? "?hold=1" : ""), { method: "POST", signal, headers: { "x-test-owner": runId }, redirect: "error" });
      assert.equal(response.status, 201);
    }
    if (phase !== "in-flight") console.log(JSON.stringify({ phase, runId }));
    await new Promise(() => {});
  };
  const runner = await LocalRunnerService.create({ root: projectRoot, workspaceRoot, config: config(origin), integration: connector, allowCapabilityWrites: true });
  const started = await runner.start({ adapter: "web", start: false, charter }); await runner.wait(started.runId);
} else {
  const runtimeFiles = ["packages/runner/dist/index.js", "packages/runner/dist/integration-lifecycle.js",
    "packages/local-runner/dist/resource-recovery.js", "packages/contracts/dist/index.js", "tests/setup-registration-recovery-smoke.mjs"];
  const runtimeDigests = await Promise.all(runtimeFiles.map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(join(repository, path))).digest("hex") })));
  const scratch = await mkdtemp(join(tmpdir(), "proofkit-early-recovery-"));
  const scopes = new Map([["sentinel", { owner: "someone-else" }]]), operations = [], results = [], children = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = requestUrl.pathname;
    const scope = route.slice("/scopes/".length); if (!route.startsWith("/scopes/") || !/^[a-zA-Z0-9_-]+$/.test(scope)) { response.writeHead(404).end(); return; }
    operations.push({ scope, method: request.method });
    if (request.method === "POST") {
      if (request.headers["x-test-owner"] !== scope || scopes.has(scope)) { response.writeHead(409).end(); return; }
      scopes.set(scope, { owner: scope });
      if (requestUrl.searchParams.get("hold") === "1") return;
      response.writeHead(201).end(); return;
    }
    if (request.method === "DELETE") {
      if (request.headers["x-test-owner"] !== scope || scopes.get(scope)?.owner !== scope) { response.writeHead(403).end(); return; }
      scopes.delete(scope); response.writeHead(204).end(); return;
    }
    const record = scopes.get(scope); response.writeHead(record ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ scope, exists: Boolean(record), ...(record ?? {}) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    for (const phase of ["registered", "provisioned", "in-flight"]) {
      const projectRoot = join(scratch, phase, "source"), workspaceRoot = join(scratch, phase, "workspace");
      await mkdir(projectRoot, { recursive: true }); await mkdir(workspaceRoot);
      await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "early-resource-" + phase, private: true }));
      const child = spawn(process.execPath, [script, "--worker", "--origin", origin, "--project", projectRoot, "--workspace", workspaceRoot, "--phase", phase], { cwd: repository, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      children.push(child); let errorText = ""; child.stderr.on("data", (bytes) => { errorText += bytes.toString(); });
      const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
      const ready = await new Promise((resolveReady, reject) => {
        let buffer = ""; const timeout = setTimeout(() => reject(new Error("Worker registration deadline: " + errorText)), 15000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Worker ended before checkpoint: " + errorText)); });
        child.stdout.on("data", (bytes) => { buffer += bytes.toString(); const newline = buffer.indexOf("\n"); if (newline >= 0) { clearTimeout(timeout); resolveReady(JSON.parse(buffer.slice(0, newline))); } });
      });
      if (phase === "in-flight") {
        for (let attempt = 0; attempt < 100 && !scopes.has(ready.runId); attempt++) await delay(25);
      }
      const fresh = await LocalRunnerService.create({ root: projectRoot, workspaceRoot, config: config(origin), integration: integration(origin), allowCapabilityWrites: true });
      assert.equal((await fresh.inspectRunResources(ready.runId)).status, "active");
      await assert.rejects(fresh.recoverRunResources(ready.runId), /active/);
      assert.equal(scopes.has(ready.runId), phase !== "registered");
      child.kill("SIGKILL"); const exit = await exited;
      let inspection;
      for (let attempt = 0; attempt < 100; attempt++) { inspection = await fresh.inspectRunResources(ready.runId); if (inspection.status !== "active") break; await delay(25); }
      assert.equal(inspection.status, "recoverable", JSON.stringify(inspection));
      const runRoot = join(workspaceRoot, ".proofkit/runs", ready.runId);
      const original = new Map(await Promise.all(["run.json", "events.jsonl", "artifacts/integration-setup.json"].map(async (relative) => [relative, await readFile(join(runRoot, relative))])));
      assert.equal(JSON.parse(original.get("run.json").toString("utf8")).status, "running");
      const recovered = await fresh.recoverRunResources(ready.runId);
      assert.equal(recovered.status, "verified"); assert.equal(recovered.testVerdict, "not-asserted"); assert.equal(scopes.has(ready.runId), false); assert.equal(scopes.has("sentinel"), true);
      assert.equal((await fresh.inspectRunResources(ready.runId)).status, "cleaned");
      const deletes = operations.filter((operation) => operation.scope === ready.runId && operation.method === "DELETE").length;
      assert.equal(deletes, phase === "registered" ? 0 : 1);
      const repeated = await fresh.recoverRunResources(ready.runId); assert.equal(repeated.attemptId, recovered.attemptId);
      assert.equal(operations.filter((operation) => operation.scope === ready.runId && operation.method === "DELETE").length, deletes);
      for (const [relative, bytes] of original) assert.deepEqual(await readFile(join(runRoot, relative)), bytes);
      results.push({ phase, runId: ready.runId, exit, provisioningAcknowledged: phase === "provisioned", originalRunStatus: "running", recoveryStatus: recovered.status, cleanup: recovered.cleanup,
        deletes, sentinelRetained: true, originalEvidenceUnchanged: true, originalJournalSha256: createHash("sha256").update(original.get("artifacts/integration-setup.json")).digest("hex"), recoveryEvidence: recovered.evidence.map((ref) => ref.path) });
    }
    for (const entry of runtimeDigests) assert.equal(createHash("sha256").update(await readFile(join(repository, entry.path))).digest("hex"), entry.sha256);
    assert.deepEqual([...scopes.keys()], ["sentinel"]);
    const receipt = { checkedAt: new Date().toISOString(), scratch, runtimeDigests, runtimeUnchanged: true,
      onlySentinelRemains: true, cases: results, limitation: "Controlled local HTTP resources; no browser, real remote account or credential recovery acceptance. Forced setup termination does not become product test success." };
    await writeFile(join(repository, "outputs/setup-registration-recovery-validation.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
