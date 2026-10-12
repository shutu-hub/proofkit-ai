import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { TestCharterSchema } from "../packages/contracts/dist/index.js";
import { CancelledError, ExecutionRunner } from "../packages/runner/dist/index.js";
import { upstreamCommit } from "../scripts/webarena-benchmark-lib.mjs";

// Scripted live-browser protocol checks; never an autonomous WebArena score.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-live-har-"));
const executablePath = process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureToken = "fixture-token-ONLY_1e951";
const fixtureBody = "fixture-private-body-ONLY_43012";
let todoStatus = 200;
let abortOnPost;
const server = createServer(async (request, response) => {
  if (request.url === "/api/v1/items" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const received = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(201, { "content-type": "application/json", "x-fixture-response": "captured" });
    response.end(JSON.stringify({ itemId: "2", received, private: fixtureBody }));
    if (abortOnPost) setTimeout(abortOnPost, 100);
    return;
  }
  if (request.url === "/dashboard/todos") {
    response.writeHead(todoStatus, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Todos fixture</title><h1>Todos fixture</h1>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8",
    "set-cookie": `fixture_session=${fixtureToken}; Path=/; HttpOnly` });
  response.end(`<!doctype html><title>HAR fixture</title><h1>Start fixture</h1>
    <button id="submit">Submit</button><p id="result"></p><a href="/dashboard/todos">Todos</a>
    <script>document.querySelector('#submit').onclick=async()=>{
      const response=await fetch('/api/v1/items',{method:'POST',headers:{'content-type':'application/json',
        'authorization':'Bearer ${fixtureToken}'},body:JSON.stringify({title:'Fixture task'})});
      await response.json();document.querySelector('#result').textContent='Saved';};</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const captures = [];
const charter = (actions, assertions = [{ kind: "text-visible", text: "Todos fixture" }]) => TestCharterSchema.parse({
  intent: "Scripted live HAR protocol fixture", level: "quick", sideEffectPolicy: "allow", actions, assertions,
});

async function runCapture(runId, task, extra = {}) {
  const directory = join(output, runId);
  const adapter = new WebAdapter({ executablePath, baseUrl, benchmarkHar: { directory, runId } });
  const result = await new ExecutionRunner(adapter, { evidenceDir: join(output, "evidence"), timeoutMs: 15_000,
    runtimeQuality: { mode: "record" }, ...extra }).run(task, runId);
  const bytes = await readFile(join(directory, "network.har"));
  const manifest = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
  assert.equal(manifest.status, "recorded");
  assert.equal(manifest.runId, result.runId);
  assert.equal(manifest.sha256, digest(bytes));
  assert.equal(manifest.bytes, bytes.length);
  const entries = JSON.parse(bytes).log.entries;
  assert.equal(manifest.entries, entries.length);
  assert.ok(entries.some((entry) => entry.request.url === `${baseUrl}/`), "initial navigation must be captured");
  assert.deepEqual(adapter.benchmarkHarManifest(), manifest);
  await assert.rejects(adapter.snapshot(), /not connected/);
  await assert.rejects(adapter.connect(), /single-use/);
  await Promise.all([adapter.close(), adapter.close()]);
  assert.equal(await readFile(join(directory, "capture.json"), "utf8"), JSON.stringify(manifest, null, 2) + "\n");
  captures.push({ runId, directory, verdict: result.verdict, sha256: manifest.sha256, entries: entries.length });
  return { result, entries, directory };
}

try {
  const success = await runCapture("har-pass", charter([
    { kind: "click", selector: "#submit" }, { kind: "waitForText", text: "Saved" },
    { kind: "click", selector: 'a[href="/dashboard/todos"]' }, { kind: "waitForText", text: "Todos fixture" },
  ]));
  assert.equal(success.result.verdict, "passed");
  const post = success.entries.find((entry) => entry.request.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.request.postData.text), { title: "Fixture task" });
  assert.ok(post.request.headers.some(({ name, value }) => name.toLowerCase() === "authorization" && value.includes(fixtureToken)));
  assert.ok(post.request.cookies.some(({ value }) => value === fixtureToken));
  assert.equal(post.response.status, 201);
  const content = post.response.content;
  const body = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString() : content.text;
  assert.equal(JSON.parse(body).private, fixtureBody);
  const events = await readFile(join(output, "evidence/har-pass/events.jsonl"), "utf8");
  assert.ok(!events.includes(fixtureToken) && !events.includes(fixtureBody), "ordinary events must retain redaction");
  assert.ok(!JSON.stringify(success.result).includes(fixtureBody));

  const failed = await runCapture("har-failed-assertion", charter([
    { kind: "goto", url: `${baseUrl}/dashboard/todos` },
  ], [{ kind: "text-visible", text: "Missing expected content" }]));
  assert.equal(failed.result.verdict, "failed");

  todoStatus = 500;
  const httpFailure = await runCapture("har-http-500", charter([
    { kind: "goto", url: `${baseUrl}/dashboard/todos` },
  ]));
  assert.ok(httpFailure.entries.some((entry) => entry.request.url === `${baseUrl}/dashboard/todos` && entry.response.status === 500));
  todoStatus = 200;

  const controller = new AbortController();
  abortOnPost = () => controller.abort(new CancelledError("Scripted fixture cancellation"));
  const cancelled = await runCapture("har-cancelled", charter([
    { kind: "click", selector: "#submit" }, { kind: "waitForText", text: "Never appears", timeoutMs: 10_000 },
  ]), { signal: controller.signal });
  assert.equal(cancelled.result.verdict, "cancelled");
  assert.ok(cancelled.entries.some((entry) => entry.request.method === "POST" && entry.response.status === 201));
  abortOnPost = undefined;

  const plain = new WebAdapter({ executablePath, baseUrl });
  const plainResult = await new ExecutionRunner(plain, { evidenceDir: join(output, "evidence") }).run(
    charter([], [{ kind: "text-visible", text: "Start fixture" }]), "har-default-off");
  assert.equal(plainResult.verdict, "passed");
  assert.equal(plain.benchmarkHarManifest(), undefined);
  async function noRawFiles(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory()) await noRawFiles(join(directory, item.name));
      else assert.ok(!item.name.endsWith(".har") && !item.name.startsWith("capture"));
    }
  }
  await noRawFiles(join(output, "evidence"));

  const original = await readFile(join(success.directory, "network.har"));
  const duplicate = new WebAdapter({ executablePath, benchmarkHar: { directory: success.directory, runId: "duplicate" } });
  await assert.rejects(duplicate.connect(), { code: "EEXIST" });
  await duplicate.close();
  assert.deepEqual(await readFile(join(success.directory, "network.har")), original);

  // Optional pinned evaluator tests use real HAR from the fixture, not fabricated entries.
  let official = { status: "not-run", reason: "official-environment-not-configured" };
  const upstream = process.env.PROOFKIT_WEBARENA_UPSTREAM;
  const python = process.env.PROOFKIT_WEBARENA_PYTHON;
  if (upstream && python) {
    const execute = promisify(execFile);
    const { stdout: head } = await execute("git", ["rev-parse", "HEAD"], { cwd: upstream, windowsHide: true });
    assert.equal(head.trim(), upstreamCommit);
    const { stdout: dirty } = await execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: upstream, windowsHide: true });
    assert.equal(dirty.trim(), "");
    const datasetSha256 = digest(await readFile(join(upstream, "assets/dataset/webarena-verified.json")));
    assert.equal(datasetSha256, "315af52919d4afb5f5f168be58c796d35ff10d65cb49c9b762bf2b8b1c10b6cc");
    const response = join(output, "navigation-response.json");
    await writeFile(response, JSON.stringify({ task_type: "NAVIGATE", status: "SUCCESS", retrieved_data: null, error_details: null }), { flag: "wx" });
    const selected = [success, httpFailure, cancelled];
    const cases = await Promise.all(selected.map(async (item) => ({ caseId: item.result.runId, taskId: 44, response,
      responseSha256: digest(await readFile(response)), trace: join(item.directory, "network.har"),
      traceSha256: digest(await readFile(join(item.directory, "network.har"))) })));
    const request = join(output, "official-request.json");
    await writeFile(request, JSON.stringify({ operation: "evaluate", datasetSha256,
      environments: { __GITLAB__: { urls: [baseUrl] } }, cases }, null, 2), { flag: "wx" });
    const { stdout } = await execute(python, [join(root, "scripts/webarena-evaluator.py"), "--upstream", upstream, "--request", request],
      { cwd: root, timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    official = JSON.parse(stdout);
    await writeFile(join(output, "official-results.json"), JSON.stringify(official, null, 2), { flag: "wx" });
    assert.deepEqual(official.results.map(({ result }) => result.status), ["success", "failure", "failure"]);
    assert.equal(official.results[0].result.score, 1);
  }
  const report = { mode: "scripted-live-har-fixture", captures, official,
    proofkitEffectiveness: "not-measured", webArenaTasksExecuted: 0,
    verified: ["initial-navigation", "post-body-headers-cookie", "embedded-response-body", "http-500",
      "failed-run-flush", "cancelled-run-flush", "repeat-close", "default-redaction", "no-overwrite"] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, captures: captures.map(({ runId, verdict, entries }) => ({ runId, verdict, entries })),
    official: official.results?.map(({ caseId, result }) => ({ caseId, status: result.status })) ?? official,
    proofkitEffectiveness: report.proofkitEffectiveness }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
