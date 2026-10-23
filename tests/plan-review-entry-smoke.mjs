import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "proofkit-plan-entry-"));
const project = join(scratch, "source"), workspace = join(scratch, "workspace");
await mkdir(project); await mkdir(join(workspace, ".proofkit"), { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ name: "first-plan-fixture", private: true, dependencies: { vite: "*" } }));
await writeFile(join(project, "start.mjs"), 'import {writeFileSync} from "node:fs";writeFileSync("started-marker", "Started");');
let targetRequests = 0;
const server = createServer((_request, response) => { targetRequests++; response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Ready</h1>"); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
await writeFile(join(workspace, ".proofkit/config.yaml"), JSON.stringify({ project: { root: project, start: "node start.mjs" },
  surfaces: { web: { baseUrl: origin } }, policies: { sideEffects: "deny" } }));
async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repository, "bundle/main.js"), ...args, "--root", project, "--workspace", workspace], { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Plan entry command timeout")); }, 20000);
    child.stdout.on("data", (bytes) => { stdout += bytes.toString(); }); child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); }); child.once("exit", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}
let client;
try {
  const intent = "Create a private note, reload it and verify its stored contents.";
  const draft = await command(["plan", intent, "--level", "core", "--format", "json", "--out", "draft.yaml"]);
  assert.equal(draft.code, 2, draft.stderr); const missing = JSON.parse(draft.stdout);
  assert.equal(missing.status, "needs-input"); assert.equal(missing.testVerdict, "not-asserted"); assert.equal(missing.executionStarted, false);
  assert.ok(missing.gaps.includes("surface-assertion") && missing.gaps.includes("business-oracle"));
  assert.ok(missing.next.some((item) => item.action === "author-workflow"));
  assert.equal(parse(await readFile(join(workspace, "draft.yaml"), "utf8")).intent, intent);
  const yaml = await command(["plan", intent, "--level", "core"]);
  assert.equal(yaml.code, 2); assert.equal(parse(yaml.stdout).intent, intent); assert.match(yaml.stderr, /Plan: needs-input/); assert.match(yaml.stderr, /business-oracle/);
  const ready = await command(["plan", "Observe the Ready page", "--level", "quick", "--expect", "Ready", "--format", "json"]);
  assert.equal(ready.code, 0, ready.stderr); const reviewed = JSON.parse(ready.stdout);
  assert.equal(reviewed.status, "ready-for-review"); assert.equal(reviewed.testVerdict, "not-asserted"); assert.equal(reviewed.executionStarted, false);
  assert.ok(reviewed.notEstablished.includes("environment") && reviewed.notEstablished.includes("business-outcome"));
  client = new Client({ name: "plan-review-entry-smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repository, "bundle/server.js")], cwd: repository,
    env: { ...process.env, PROOFKIT_ROOT: project, PROOFKIT_WORKSPACE_ROOT: workspace } }));
  const call = async (name, args) => { const response = await client.callTool({ name, arguments: args }); assert.notEqual(response.isError, true, JSON.stringify(response)); return JSON.parse(response.content.find((item) => item.type === "text").text); };
  const mcpDraft = await call("plan_test", { intent, level: "core" });
  assert.equal(mcpDraft.status, "needs-input"); assert.equal(mcpDraft.testVerdict, "not-asserted"); assert.equal(mcpDraft.executionStarted, false);
  assert.deepEqual(mcpDraft.gaps, missing.gaps);
  const mcpReview = await call("plan_test", { intent: "Observe the Ready page", level: "quick", expect: ["Ready"] });
  assert.equal(mcpReview.status, "ready-for-review"); assert.equal(mcpReview.testVerdict, "not-asserted");
  const unready = await call("run_test", { intent, level: "core" });
  assert.equal(unready.running, false); assert.equal(unready.testVerdict, "not-asserted"); assert.equal(unready.readiness.ready, false);
  assert.equal(unready.status, "awaiting-approval"); assert.ok(!unready.next.includes("start_mission") && !unready.next.includes("approve_test_plan"));
  assert.equal(targetRequests, 0);
  await assert.rejects(access(join(project, "started-marker")));
  await assert.rejects(access(join(workspace, ".proofkit/runs")));
  const result = { checkedAt: new Date().toISOString(), scratch, newWorkspace: true, cliDraftExitCode: draft.code, cliYamlExitCode: yaml.code,
    cliReadyForReviewExitCode: ready.code, draftReview: missing, readyReview: reviewed, mcpDraftStatus: mcpDraft.status,
    mcpReadyStatus: mcpReview.status, unreadyMission: { missionId: unready.missionId, status: unready.status, running: false, readiness: unready.readiness, testVerdict: unready.testVerdict, next: unready.next },
    targetRequests, projectStarted: false, executionRunsCreated: false,
    limitation: "Planning-only first-use regression through real CLI and stdio MCP. No browser or business acceptance was executed." };
  await writeFile(join(repository, "outputs/plan-review-entry-validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ scratch, cliDraftExitCode: draft.code, cliReadyExitCode: ready.code, mcpDraft: mcpDraft.status,
    mcpReady: mcpReview.status, unreadyTestVerdict: unready.testVerdict, targetRequests, projectStarted: false, executionRunsCreated: false }));
} finally { await client?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
