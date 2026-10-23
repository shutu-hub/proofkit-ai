import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "proofkit-cli-plan-resume-"));
const project = join(scratch, "source"), workspace = join(scratch, "workspace");
await mkdir(project); await mkdir(join(workspace, ".proofkit"), { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ name: "planning-continuation-cli-fixture", private: true }));
const intent = "Inspect both observed pages and verify Ready. Preserve the complete request; do not create or delete records.";
let modelCalls = 0, appWrites = 0; const prompts = [];
const server = createServer(async (request, response) => {
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = JSON.parse(body.messages.find((message) => message.role === "user").content); prompts.push(prompt); modelCalls++;
    const output = modelCalls === 1 ? { status: "needs-observation", reason: "Need a second read-only observed state", expectedObservation: "Second page with Ready" }
      : { intent: "Narrowed text", mode: "deterministic", sideEffectPolicy: "deny", level: "quick", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], oracles: [] };
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] })); return;
  }
  if (request.method !== "GET") appWrites++;
  response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Ready</h1><p>" + (request.url === "/second" ? "Second observed page" : "Initial observed page") + "</p>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
await writeFile(join(workspace, ".proofkit/config.yaml"), JSON.stringify({ project: { root: project }, surfaces: { web: { baseUrl: origin,
  ...(process.env.PROOFKIT_BROWSER_PATH || process.platform === "win32" ? { executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } : {}) } },
  planning: { provider: "openai-compatible", baseUrl: origin + "/v1", model: "planning-continuation-fixture" }, policies: { sideEffects: "deny" } }));
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repository, "bundle/main.js"), ...args, "--root", project, "--workspace", workspace], { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI fixture command deadline")); }, 25000);
    child.stdout.on("data", (bytes) => { stdout += bytes.toString(); }); child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
try {
  const first = await cli(["plan", intent, "--url", origin, "--level", "quick", "--mode", "deterministic", "--side-effects", "deny", "--expect", "Ready", "--headful"]);
  assert.equal(first.code, 2, first.stderr); const receipt = JSON.parse(first.stdout); assert.equal(receipt.status, "needs-observation");
  const saved = receipt.observationRequest.continuation; assert.ok(saved?.id && saved.sha256); assert.equal(appWrites, 0);
  const next = await cli(["inspect", "--url", origin + "/second", "--headful"]); assert.equal(next.code, 0, next.stderr); const observed = JSON.parse(next.stdout);
  const resumed = await cli(["plan", "--continuation", saved.id + ":" + saved.sha256, "--inspection", observed.inspectionId + ":" + observed.manifest.sha256,
    "--out", ".proofkit/charters/resumed.yaml"]);
  assert.equal(resumed.code, 0, resumed.stderr); const charter = parse(resumed.stdout);
  assert.equal(charter.intent, intent); assert.equal(charter.mode, "deterministic"); assert.equal(charter.level, "quick"); assert.equal(charter.sideEffectPolicy, "deny");
  assert.equal(charter.surfaceObservation.sources.length, 2); assert.deepEqual(charter.assertions, [{ kind: "text-visible", text: "Ready" }]);
  assert.equal(prompts.length, 2); assert.equal(prompts[1].intent, intent); assert.equal(prompts[1].constraints.url, origin);
  assert.equal(prompts[1].surfaceObservations.length, 2); assert.equal(appWrites, 0);
  assert.deepEqual(parse(await readFile(join(workspace, ".proofkit/charters/resumed.yaml"), "utf8")), charter);
  const changed = await cli(["plan", "Narrowed request", "--continuation", saved.id + ":" + saved.sha256]);
  assert.notEqual(changed.code, 0); assert.equal(modelCalls, 2); assert.equal(appWrites, 0);
  const result = { checkedAt: new Date().toISOString(), scratch, newProcessPerCommand: true, omittedIntentAndRequirementsRestored: true,
    continuation: saved, originalIntent: intent, initialExitCode: first.code, resumedExitCode: resumed.code, modelCalls, appWrites,
    inspectionCount: charter.surfaceObservation.sources.length, originalRequirementsConflictRefused: true,
    limitation: "Local deterministic HTTP model fixture and read-only browser observations; no business execution or unknown-site model evaluation." };
  await writeFile(join(repository, "outputs/planning-continuation-cli-validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
