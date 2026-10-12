import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Real browser/HTTP/CLI/MCP execution against a disposable product, never AIHR data.
const runFile = promisify(execFile), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = await mkdtemp(join(tmpdir(), "proofkit-repair-smoke-"));
const root = join(scratch, "source"), workspaceRoot = join(scratch, "workspace"), sourceFile = join(root, "binding.mjs");
const before = 'export function binding() { return { jobId: "wrong-job", expectedJobId: "expected-job" }; }\n';
const client = new Client({ name: "repair-smoke", version: "1" });
let mcp;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/v1/resume-binding") {
      const bytes = await readFile(sourceFile);
      const product = await import(`${pathToFileURL(sourceFile).href}?sha256=${hash(bytes)}`);
      const facts = product.binding();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SUCCESS", data: { ...facts, state: facts.jobId === facts.expectedJobId ? "done" : "wrong" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Resume binding fixture</title><h1>Resume</h1>
      <button id="check" onclick="fetch('/api/v1/resume-binding').then(r=>r.json()).then(()=>document.querySelector('#result').textContent='Resume checked')">Check binding</button><div id="result"></div>`);
  } catch { response.writeHead(500).end(); }
});

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function terminal(missionId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await call("await_test_result", { missionId, timeoutMs: 30000 });
    if (!result.running && result.testVerdict !== "not-asserted") return call("get_mission_evidence", { missionId, detail: "full" });
  }
  throw new Error("Repair smoke Mission did not produce a terminal audited result");
}

try {
  await mkdir(root); await mkdir(join(workspaceRoot, ".proofkit"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "repair-source-fixture", dependencies: { vite: "*" } }));
  await writeFile(sourceFile, before);
  await runFile("git", ["init", "-q"], { cwd: root }); await runFile("git", ["add", "."], { cwd: root });
  await runFile("git", ["-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({ project: { root },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    policies: { environment: "test", sideEffects: "allow", targetBinding: "record" },
    oracles: [{ name: "resume-binding", url: `${baseUrl}/api/v1/resume-binding`, statusPointer: "/data/state",
      successValues: ["done"], failureValues: ["wrong"], intervalMs: 100, deadlineMs: 3000 }],
  }));
  mcp = await createProofkitMcp({ root, workspaceRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "submit_repair_hypothesis"));
  const started = await call("run_test", { intent: "Test core resume binding", level: "core", surface: "web", charter: {
    intent: "Test core resume binding", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
    actions: [{ kind: "goto", url: baseUrl }, { kind: "click", selector: "#check" }, { kind: "waitForText", text: "Resume checked" }],
    assertions: [{ kind: "text-visible", text: "Resume checked" }], oracles: ["resume-binding"],
  } });
  const failed = await terminal(started.missionId);
  assert.equal(failed.testVerdict, "failed", failed.testVerdictReason);
  const finding = failed.findings.find((item) => item.category === "product" && item.status === "confirmed");
  assert.ok(finding);
  const input = { missionId: failed.missionId, expectedRevision: failed.summary.revision, findingId: finding.findingId,
    title: "Return the current expected job in the resume binding", confidence: 0.85,
    rationale: "The independent HTTP facts contain jobId=wrong-job and expectedJobId=expected-job. binding() returns the fixed wrong ID.",
    changes: ["Return expected-job for this fixture's current resume binding."], evidenceIds: finding.evidence.map((ref) => ref.evidenceId),
    sourceReferences: [{ path: "binding.mjs", sha256: hash(before), startLine: 1, endLine: 1,
      explanation: "binding() returns a hardcoded wrong-job value instead of the expected current job." }],
    regressionCheck: "Replay the same UI click and independently check the resume job binding reaches done." };
  const saved = await call("submit_repair_hypothesis", input);
  assert.equal(saved.testVerdict, "not-asserted"); assert.equal(saved.suggestion.status, "proposed");
  assert.equal(saved.sourceAudit.references[0].status, "matching");
  const brief = await call("get_mission_evidence", { missionId: failed.missionId });
  assert.equal(brief.summary.revision, saved.revision);
  assert.equal(brief.repairSuggestions[0].hypothesis.causeStatus, "hypothesis");
  assert.equal(brief.repairSourceAudits[0].references[0].status, "matching");
  assert.match(await readFile(brief.report, "utf8"), /Next change:/);
  // A second process uses the same API/storage, without creating a duplicate proposal.
  const inputFile = join(workspaceRoot, "hypothesis.json");
  await writeFile(inputFile, JSON.stringify({ ...input, expectedRevision: saved.revision }));
  const cli = await runFile(process.execPath, [resolve("bundle/main.js"), "mission", "propose-repair", failed.missionId,
    "--input", inputFile, "--root", root, "--workspace", workspaceRoot], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(JSON.parse(cli.stdout).revision, saved.revision);
  assert.equal(await readFile(sourceFile, "utf8"), before);
  assert.equal((await runFile("git", ["status", "--porcelain"], { cwd: root })).stdout, "");
  // Only the fixture owner changes the disposable product; ProofKit never edits it.
  await writeFile(sourceFile, before.replace("wrong-job", "expected-job"));
  const stale = await call("get_mission_evidence", { missionId: failed.missionId });
  assert.equal(stale.repairSourceAudits[0].references[0].status, "changed");
  // Core stops at the first failure, before mission.verify captures final source.
  // The independent historical failure remains valid; source freshness is unknown.
  assert.equal(failed.finalSourceState, undefined);
  assert.equal(stale.sourceFreshness, "unverified");
  assert.equal(stale.testVerdict, "failed", stale.testVerdictReason);
  const replay = await call("replay_mission", { missionId: failed.missionId, approve: true });
  const passed = await terminal(replay.mission.missionId);
  assert.equal(passed.testVerdict, "passed", passed.testVerdictReason);
  assert.equal(passed.comparison.status, "verified-in-scope", JSON.stringify(passed.comparison));
  assert.equal(passed.comparison.sourceChange, "changed");
  assert.equal(passed.comparison.defects[0].outcome, "not-reproduced");
  const original = await call("get_mission_status", { missionId: failed.missionId });
  assert.equal(original.mission.repairSuggestions[0].status, "proposed");
  console.log(JSON.stringify({ result: "passed", baseline: failed.testVerdict, replay: passed.testVerdict,
    comparison: passed.comparison.status, defect: passed.comparison.defects[0].outcome,
    checked: ["real-browser-click", "independent-business-facts", "MCP-submission", "CLI-same-store", "zero-source-writes", "stale-source-audit", "direct-replay"] }, null, 2));
} finally {
  await client.close().catch(() => {}); await mcp?.close().catch(() => {});
  await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  await rm(scratch, { recursive: true, force: true });
}
