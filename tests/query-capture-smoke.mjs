import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-query-capture-"));
const source = join(root, "source"), workspace = join(root, "workspace");
await mkdir(source); await mkdir(workspace);
const records = new Map(); let writes = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/api/records") {
    const tenant = url.searchParams.get("tenant");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = "record-" + ++writes; records.set(id, { id, tenant, title: submitted.title });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, tenant, title: submitted.title, private: "UNSELECTED_RESPONSE" })); return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/records/")) {
    const record = records.get(url.pathname.slice("/api/records/".length));
    response.writeHead(record ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify(record ?? {})); return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/case/")) {
    const tenant = url.pathname.slice("/case/".length);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Selected query</title><h1>Record intake</h1><button id="submit">Create record</button><output>Ready</output>'
      + '<script>document.querySelector("#submit").onclick=async()=>{const response=await fetch("/api/records?tenant="+'
      + JSON.stringify(tenant) + ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"Reviewed record"})});'
      + 'if(response.ok)document.querySelector("output").textContent="Created"}</script>'); return;
  }
  response.writeHead(404); response.end();
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = "http://127.0.0.1:" + server.address().port;
const oracle = { name: "current-tenant-record", async check({ steps, signal }) {
  const capture = steps.find((step) => step.action.kind === "captureResponse")?.response;
  if (!capture?.fields.id) return { name: this.name, passed: null, verificationKind: "business", message: "No current response ID available", evidence: [], observedAt: new Date().toISOString() };
  const current = await fetch(origin + "/api/records/" + capture.fields.id, { signal });
  const record = current.status === 200 ? await current.json() : undefined;
  const passed = record?.id === capture.fields.id && record.tenant === "team42" && record.title === "Reviewed record"
    && capture.queryFields?.tenant === "team42" && capture.fields.tenant === "team42" && capture.requestFields?.title === "Reviewed record";
  return { name: this.name, passed, verificationKind: "business", observedAt: new Date().toISOString(),
    message: "Independent current ID and tenant/title match selected query, request and response fields",
    evidence: [JSON.stringify({ expected: { tenant: "team42", title: "Reviewed record", id: capture.fields.id },
      actual: { httpStatus: current.status, tenant: record?.tenant, title: record?.title, id: record?.id } })] };
} };
const runner = await LocalRunnerService.create({ root: source, workspaceRoot: workspace, oracles: [oracle], restrictWebOrigins: true,
  config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin + "/case/team42", executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } },
    run: { recordVideo: true, timeoutMs: 12000 }, policies: { environment: "test", sideEffects: "allow" } }) });
const charter = (tenant, selectQuery) => TestCharterSchema.parse({ intent: "Create a record for the reviewed tenant and independently verify its saved identity", level: "core",
  mode: "deterministic", sideEffectPolicy: "allow", actions: [
    { kind: "goto", url: origin + "/case/" + tenant },
    { kind: "captureResponse", name: "created", trigger: { kind: "click", selector: "#submit" }, requestWindowMs: 200, timeoutMs: 3000,
      response: { url: origin + "/api/records", method: "POST", statuses: [201],
        fields: { id: { pointer: "/id", type: "identifier" }, tenant: { pointer: "/tenant", type: "identifier" } },
        requestFields: { title: { pointer: "/title", type: "string" } },
        ...(selectQuery ? { queryFields: { tenant: { pointer: "/tenant", type: "identifier" } } } : {}) } },
    { kind: "waitForText", text: "Created" }], assertions: [{ kind: "text-visible", text: "Created" }], oracles: [oracle.name] });
const receipts = []; let browser;
try {
  for (const [tenant, selectQuery, expectedVerdict] of [["team42", true, "passed"], ["other", false, "inconclusive"], ["other", true, "failed"]]) {
    const before = writes;
    const started = await runner.start({ adapter: "web", charter: charter(tenant, selectQuery), headful: true, start: false });
    const summary = await runner.wait(started.runId);
    assert.equal(writes - before, 1, "Never replay an uncertain write");
    const capture = summary.steps[1];
    assert.equal(summary.verdict, expectedVerdict, JSON.stringify(summary.findings));
    if (selectQuery) {
      assert.equal(capture.response.queryFields.tenant, tenant);
      assert.equal(capture.response.url, origin + "/api/records");
      const content = await readFile(join(runner.evidenceDir, summary.runId, "run.json"), "utf8");
      assert.ok(!content.includes("?tenant=")); assert.ok(!content.includes("UNSELECTED_RESPONSE"));
    } else {
      assert.equal(capture.response, undefined);
      assert.equal(capture.failureCode, "request-query-unreviewed");
    }
    const manifest = await runner.evidenceManifest(summary.runId);
    assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    receipts.push({ tenant, selected: selectQuery, verdict: summary.verdict, runId: summary.runId, manifestSha256: manifest.sha256,
      captureFailure: capture.failureCode, writes: writes - before, recording: summary.recording?.status, recordingArtifact: summary.recording?.artifact,
      queryFields: capture.response?.queryFields });
  }
  browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  const report = join(runner.evidenceDir, receipts[0].runId, "report.html");
  await page.goto(pathToFileURL(report).href);
  await page.locator("summary").filter({ hasText: "Captured API facts" }).click();
  const text = await page.locator("body").innerText();
  assert.ok(text.includes("Selected query fields") && text.includes("team42"));
  assert.ok(!text.includes("?tenant=") && !text.includes("UNSELECTED_RESPONSE"));
  await page.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } });
  const decodedScreenshots = await page.locator("img").count(); assert.ok(decodedScreenshots >= 3);
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width);
  await page.goto(pathToFileURL(join(runner.evidenceDir, receipts[0].recordingArtifact)).href);
  await page.locator("video").evaluate(async (video) => { video.muted = true; video.playbackRate = 16; await video.play(); });
  await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.ended && video.duration > 0 && !video.error; }, null, { timeout: 30000 });
  const videoDuration = await page.locator("video").evaluate((video) => video.duration);
  const result = { checkedAt: new Date().toISOString(), root, origin, receipts, layout, decodedScreenshots, videoDuration,
    scope: "Controlled real Edge browser and in-memory independent reader; not unfamiliar-site autonomy or durable database acceptance" };
  await writeFile(join(repository, "outputs/query-capture-validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await runner.closeAllSurfaceSessions(); server.closeAllConnections(); await new Promise((done) => server.close(done));
}
