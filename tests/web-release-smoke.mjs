import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const corruptNote = process.argv.includes("--corrupt-note");
const outputPrefix = corruptNote ? "web-release-defect" : "web-release";
const runtimeFiles = ["packages/contracts/dist/index.js", "packages/planner/dist/catalog.js", "packages/agent/dist/index.js",
  "packages/local-runner/dist/index.js", "packages/runner/dist/index.js", "packages/adapters/dist/web.js", "packages/evidence/dist/mission-report.js", "tests/web-release-smoke.mjs"];
const runtimeDigests = await Promise.all(runtimeFiles.map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(join(repository, path))).digest("hex") })));
const root = await mkdtemp(join(tmpdir(), "proofkit-web-release-acceptance-"));
const project = join(root, "source"), workspace = join(root, "workspace");
await mkdir(project); await mkdir(join(workspace, "charters"), { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ name: "web-release-acceptance", private: true, dependencies: { vite: "1" } }));
const initial = { title: "Private synthetic note", description: "Before the update", category: "Work", completed: false };
const updated = { title: "Updated synthetic note", description: "After the update", category: "Personal", completed: true };
const scopes = new Map([["sentinel", { owner: "unrelated", history: [], note: null, job: null, denied: 0, rejected: 0 }]]);
const operations = []; let activeScope = "unprepared", serial = 0;
const projection = (record) => ({ owner: record.owner, history: record.history, note: record.note, job: record.job, denied: record.denied, rejected: record.rejected });
function page(flow, scope) {
  const script = 'const scope=' + JSON.stringify(scope) + ';let noteId;const status=document.querySelector("#status");'
    + 'async function call(path,method="GET",body){const response=await fetch(path,{method,headers:{"content-type":"application/json","x-scope":scope},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();return {status:response.status,data};}'
    + 'const fields=()=>({title:document.querySelector("#title")?.value,description:document.querySelector("#description")?.value,category:document.querySelector("#category")?.value});'
    + (flow === "notes" ? [
      'document.querySelector("#create").onclick=async()=>{const result=await call("/api/note","POST",fields());noteId=result.data.id;status.textContent=result.status===201?"Created note":"Create failed";};',
      'document.querySelector("#update").onclick=async()=>{const result=await call("/api/note","PUT",{id:noteId,...fields()});status.textContent=result.status===200?"Updated note":"Update failed";};',
      'document.querySelector("#complete").onclick=async()=>{const result=await call("/api/note","PATCH",{id:noteId,completed:true});status.textContent=result.status===200?"Completed note":"Complete failed";};',
      'document.querySelector("#delete").onclick=async()=>{const result=await call("/api/note","DELETE",{id:noteId});status.textContent=result.status===200?"Deleted note":"Delete failed";};',
      'document.querySelector("#forbidden").onclick=async()=>{const result=await call("/api/note","PUT",{id:noteId,actor:"other",title:"Forbidden"});status.textContent=result.status===403?"Access denied":"Unexpected access";};',
      'call("/api/note").then(result=>{if(result.status===200&&result.data.note){noteId=result.data.note.id;status.textContent="Stored: "+result.data.note.title;}});',
    ].join("") : [
      'document.querySelector("#start").onclick=async()=>{const result=await call("/api/job","POST",{type:"review"});if(result.status!==201){status.textContent="Job failed";return;}status.textContent="Job pending";for(let index=0;index<50;index++){await new Promise(resolve=>setTimeout(resolve,40));const current=await call("/api/job");if(current.data.job?.status==="completed"){status.textContent="Job completed";return;}}};',
      'document.querySelector("#invalid").onclick=async()=>{const result=await call("/api/job","POST",{type:""});status.textContent=result.status===422?"Job rejected":"Unexpected job";};',
    ].join(""));
  return '<!doctype html><html><head><title>Web release fixture</title></head><body><h1>Release fixture</h1><h2>' + flow + '</h2>'
    + (flow === "notes" ? '<label for="title">Title</label><input id="title"><label for="description">Description</label><textarea id="description"></textarea><label for="category">Category</label><select id="category"><option>Work</option><option>Personal</option></select><button id="create">Create note</button><button id="update">Save changes</button><button id="complete">Complete note</button><button id="delete">Delete note</button><button id="forbidden">Try another actor</button>'
      : '<button id="start">Start review job</button><button id="invalid">Try invalid job</button>')
    + '<output id="status">Ready</output><script>' + script + '</script></body></html>';
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (request.method === "GET" && ["/", "/notes", "/jobs"].includes(url.pathname)) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page(url.pathname === "/jobs" ? "jobs" : "notes", activeScope)); return;
  }
  if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  if (url.pathname.startsWith("/scopes/")) {
    const scope = url.pathname.slice(8); operations.push({ method: request.method, scope });
    if (request.method === "POST" && /^[a-zA-Z0-9_-]+$/.test(scope) && !scopes.has(scope)) {
      scopes.set(scope, { owner: scope, history: [], note: null, job: null, denied: 0, rejected: 0 }); activeScope = scope; json(201, { scope }); return;
    }
    const record = scopes.get(scope);
    if (request.method === "DELETE") {
      if (request.headers["x-owner"] !== scope || record?.owner !== scope) { json(403, { error: "Foreign scope" }); return; }
      clearTimeout(record.timer); scopes.delete(scope); json(200, { removed: true }); return;
    }
    json(record ? 200 : 404, { scope, ...(record ? projection(record) : { exists: false }) }); return;
  }
  const scope = request.headers["x-scope"], record = scopes.get(scope);
  if (!record || record.owner !== scope) { json(404, { error: "Scope unavailable" }); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (url.pathname === "/api/note") {
    if (request.method === "GET") { json(200, { note: record.note }); return; }
    if (body.actor === "other") { record.denied++; json(403, { error: "access-denied" }); return; }
    if (request.method === "POST") {
      const note = { id: "note-" + ++serial, title: body.title, description: body.description, category: body.category, completed: false, owner: scope };
      record.note = note; record.history.push({ event: "created", ...note }); json(201, { ...note }); return;
    }
    if (!record.note || body.id !== record.note.id) { json(404, { error: "Note not found" }); return; }
    if (request.method === "PUT") { Object.assign(record.note, { title: corruptNote ? "Wrong stored title" : body.title, description: body.description, category: body.category }); record.history.push({ event: "updated", ...record.note }); json(200, record.note); return; }
    if (request.method === "PATCH") { record.note.completed = body.completed; record.history.push({ event: "completed", ...record.note }); json(200, record.note); return; }
    if (request.method === "DELETE") { const id = record.note.id; record.history.push({ event: "deleted", ...record.note }); record.note = null; json(200, { id, deleted: true }); return; }
  }
  if (url.pathname === "/api/job") {
    if (request.method === "GET") { json(200, { job: record.job }); return; }
    if (body.type !== "review") { record.rejected++; json(422, { error: "invalid-type" }); return; }
    record.job = { id: "job-" + ++serial, type: body.type, status: "pending", owner: scope }; record.history.push({ event: "started", ...record.job });
    record.timer = setTimeout(() => { record.job.status = "completed"; record.history.push({ event: "finished", ...record.job }); }, 160);
    json(201, record.job); return;
  }
  json(404, { error: "Unknown endpoint" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
async function readScope(runId, signal) { const response = await fetch(origin + "/scopes/" + runId, { redirect: "error", signal }); return { status: response.status, data: await response.json() }; }
async function cleanup({ runId, signal }) {
  const before = await readScope(runId, signal);
  if (before.status === 200) { assert.equal(before.data.owner, runId); const response = await fetch(origin + "/scopes/" + runId, { method: "DELETE", headers: { "x-owner": runId }, redirect: "error", signal }); assert.equal(response.status, 200); }
  const after = await readScope(runId, signal);
  return [{ resourceId: "namespace", status: after.status === 404 ? "removed" : "retained", evidence: { beforeStatus: before.status, afterStatus: after.status },
    readback: { reader: "fixture.scope-get", scope: runId, exists: after.status !== 404, observedAt: new Date().toISOString() } }];
}
const oracleNames = ["notes-lifecycle", "notes-denied", "job-terminal", "job-rejected"];
const oracles = oracleNames.map((name) => ({ name, async check(context) {
  const observed = await readScope(context.runId, context.signal); const data = observed.data;
  let passed = observed.status === 200 && data.owner === context.runId;
  const captured = context.steps.flatMap((step) => step.response ? [step.response] : []);
  if (name === "notes-lifecycle") {
    const id = captured.find((item) => item.name === "note-created")?.fields.id;
    passed &&= data.note === null && data.history.length === 4 && data.history.every((item) => item.id === id && item.owner === context.runId)
      && JSON.stringify(data.history.map((item) => item.event)) === JSON.stringify(["created", "updated", "completed", "deleted"])
      && ["title", "description", "category", "completed"].every((key) => data.history[0][key] === initial[key])
      && ["title", "description", "category"].every((key) => data.history[1][key] === updated[key])
      && data.history[1].completed === false && data.history[2].completed === true
      && ["title", "description", "category", "completed"].every((key) => data.history[3][key] === updated[key]);
  } else if (name === "notes-denied") passed &&= data.denied === 1 && data.note === null && data.history.length === 0;
  else if (name === "job-terminal") passed &&= data.job?.id === captured.find((item) => item.name === "job-created")?.fields.id && data.job.status === "completed" && data.job.owner === context.runId && data.history.length === 2;
  else passed &&= data.job === null && data.rejected === 1 && data.history.length === 0;
  const differentFields = name === "notes-lifecycle" && data.history?.length === 4
    ? ["title", "description", "category", "completed"].filter((key) => data.history[3][key] !== updated[key]).map((key) => "note." + key) : [];
  return { name, passed, verificationKind: "business", message: "Independent current namespace and backend transition history",
    ...(differentFields.length ? { fieldMismatches: differentFields } : {}),
    evidence: [JSON.stringify({ expected: name, runId: context.runId, ...observed })], observedAt: new Date().toISOString() };
} }));
const setupPolicy = { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 };
const integration = { name: "web-release-reviewed-fixture", version: "1", oracles, setupPolicy, recover: cleanup,
  async setup({ runId, signal, registerResources }) {
    const handle = { resources: [{ resourceId: "namespace", kind: "synthetic-namespace", scope: runId, evidence: { owner: runId } }], cleanup };
    assert.equal(typeof registerResources, "function"); await registerResources(handle);
    const response = await fetch(origin + "/scopes/" + runId, { method: "POST", redirect: "error", signal }); assert.equal(response.status, 201);
    return handle;
  } };
const config = ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  readyWhen: { text: "Release fixture", timeoutMs: 5000 } } }, run: { recordVideo: true, timeoutMs: 60000 }, policies: { environment: "test", sideEffects: "allow" },
  charters: ["notes", "jobs"].map((id) => ({ id, aliases: ["release " + id], level: "release", surfaces: ["web"], path: "charters/" + id + ".yaml" })),
  suites: [{ id: "web-release", aliases: ["web release"], level: "release", charterIds: ["notes", "jobs"], surfaces: ["web"] }] });
const planner = await LocalRunnerService.create({ root: project, workspaceRoot: workspace, config, restrictWebOrigins: true, integration: { name: "read-only-planning", oracles } });
const capture = (name, selector, method, fields, requestFields) => ({ kind: "captureResponse", name, trigger: { kind: "click", selector }, response: { url: origin + (name.startsWith("note") ? "/api/note" : "/api/job"), method, statuses: [name.includes("denied") ? 403 : name.includes("rejected") ? 422 : name.includes("created") ? 201 : 200], fields,
  ...(requestFields ? { requestFields } : {}) }, requestStartTimeoutMs: 5000, requestWindowMs: 200, timeoutMs: 10000 });
const idField = { id: { pointer: "/id", type: "identifier" } };
const noteFields = { ...idField, title: { pointer: "/title", type: "string" }, description: { pointer: "/description", type: "string" }, category: { pointer: "/category", type: "string" }, completed: { pointer: "/completed", type: "boolean" } };
const noteInput = Object.fromEntries(["title", "description", "category"].map((key) => [key, { pointer: "/" + key, type: "string" }]));
let runner;
try {
  for (const flow of ["notes", "jobs"]) {
    const inspection = await planner.inspectSurface({ url: origin + "/" + flow, headful: true }); assert.equal(inspection.status, "observed");
    const draft = flow === "notes" ? { intent: "Verify the private note create, reload, edit, complete and delete lifecycle", actions: [
      { kind: "goto", url: origin + "/notes" }, { kind: "fill", selector: "#title", value: initial.title }, { kind: "fill", selector: "#description", value: initial.description },
      { kind: "selectOption", selector: "#category", option: { label: initial.category } }, capture("note-created", "#create", "POST", noteFields, noteInput),
      { kind: "waitForText", text: "Created note" }, { kind: "goto", url: origin + "/notes" }, { kind: "waitForText", text: "Stored: " + initial.title },
      { kind: "fill", selector: "#title", value: updated.title }, { kind: "fill", selector: "#description", value: updated.description }, { kind: "selectOption", selector: "#category", option: { label: updated.category } },
      capture("note-updated", "#update", "PUT", noteFields, { id: { pointer: "/id", type: "identifier" }, ...noteInput }), { kind: "waitForText", text: "Updated note" },
      capture("note-completed", "#complete", "PATCH", noteFields, { id: { pointer: "/id", type: "identifier" }, completed: { pointer: "/completed", type: "boolean" } }), { kind: "waitForText", text: "Completed note" },
      capture("note-deleted", "#delete", "DELETE", { ...idField, deleted: { pointer: "/deleted", type: "boolean" } }, { id: { pointer: "/id", type: "identifier" } }), { kind: "waitForText", text: "Deleted note" } ],
      assertions: [{ kind: "text-visible", text: "Deleted note" }], oracles: ["notes-lifecycle"], negativeCases: [{ caseId: "forbidden", title: "Reject another actor", intent: "Verify forbidden note write does not change data", sideEffectPolicy: "allow", expectedVerdict: "passed",
        actions: [{ kind: "goto", url: origin + "/notes" }, capture("note-denied", "#forbidden", "PUT", { error: { pointer: "/error", type: "string" } }), { kind: "waitForText", text: "Access denied" }], assertions: [{ kind: "text-visible", text: "Access denied" }], oracles: ["notes-denied"] }] }
      : { intent: "Verify asynchronous review job reaches its independent terminal state", actions: [{ kind: "goto", url: origin + "/jobs" }, capture("job-created", "#start", "POST", { ...idField, status: { pointer: "/status", type: "string" } }, { type: { pointer: "/type", type: "string" } }), { kind: "waitForText", text: "Job completed", timeoutMs: 5000 }], assertions: [{ kind: "text-visible", text: "Job completed" }], oracles: ["job-terminal"],
        negativeCases: [{ caseId: "invalid", title: "Reject invalid job type", intent: "Verify invalid request creates no job", sideEffectPolicy: "allow", expectedVerdict: "passed", actions: [{ kind: "goto", url: origin + "/jobs" }, capture("job-rejected", "#invalid", "POST", { error: { pointer: "/error", type: "string" } }), { kind: "waitForText", text: "Job rejected" }], assertions: [{ kind: "text-visible", text: "Job rejected" }], oracles: ["job-rejected"] }] };
    const charter = await planner.plan(draft.intent, { charter: TestCharterSchema.parse({ ...draft, level: "release", surfaces: ["web"], mode: "deterministic", sideEffectPolicy: "allow" }),
      adapter: "web", inspections: [{ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }] });
    assert.deepEqual(charter.planning.evidenceGaps, []); await writeFile(join(workspace, "charters", flow + ".yaml"), JSON.stringify(charter));
  }
  runner = await LocalRunnerService.create({ root: project, workspaceRoot: workspace, config, integration, allowCapabilityWrites: true, restrictWebOrigins: true });
  const mission = await runner.createMission({ intent: "Verify the declared web release workflows and their negative cases", suiteId: "web-release", level: "release", surface: "web", headful: true });
  assert.deepEqual(mission.plan.executionProfile.surfaceMatrix, ["web"]); assert.equal(mission.plan.executionProfile.requireReplay, true);
  await runner.startMission(mission.missionId, { approve: true }); await runner.waitMission(mission.missionId);
  const evidence = await runner.missionEvidence(mission.missionId);
  assert.equal(evidence.testVerdict, corruptNote ? "failed" : "passed", JSON.stringify({ reason: evidence.testVerdictReason, runs: evidence.summary.runs, findings: evidence.findings }));
  assert.equal(evidence.summary.runs.length, 6); assert.equal(evidence.summary.checkOverview.inspectedRuns, 6);
  const runs = [];
  for (const entry of evidence.summary.runs) {
    const summary = await runner.wait(entry.runId);
    const failingBusiness = corruptNote && summary.oracles.some((oracle) => oracle.name === "notes-lifecycle");
    assert.equal(summary.verdict, failingBusiness ? "failed" : "passed"); assert.equal(summary.execution.adapter, "web"); assert.equal(summary.execution.visibility, "headful");
    assert.ok(summary.assertions.every((assertion) => assertion.passed), "UI assertions pass even in the injected stored-data defect");
    assert.equal(summary.integrationCleanup.status, "verified"); assert.equal(summary.integrationCleanup.verifiedResources, 1);
    assert.equal(summary.recording.status, "recorded"); assert.ok(summary.oracles.every((oracle) => oracle.passed === !failingBusiness && oracle.verificationKind === "business"));
    const manifest = await runner.evidenceManifest(summary.runId); assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    runs.push({ runId: summary.runId, kind: entry.runKind, verdict: summary.verdict, actions: summary.steps.length, oracle: summary.oracles[0].name, oraclePassed: summary.oracles[0].passed, allSurfaceAssertionsPassed: summary.assertions.every((item) => item.passed), cleanup: summary.integrationCleanup.status,
      recording: summary.recording.artifact, report: join(runner.evidenceDir, summary.runId, "report.html"), manifestSha256: manifest.sha256 });
  }
  assert.deepEqual([...scopes.keys()], ["sentinel"]);
  assert.equal(evidence.summary.checkOverview.counts.failed, corruptNote ? 2 : 0);
  if (corruptNote) {
    const failed = evidence.summary.checkOverview.items.filter((check) => check.status === "failed" && check.expected === "notes-lifecycle");
    assert.equal(failed.length, 2);
    assert.ok(failed.every((check) => check.fieldMismatches?.includes("note.title") && check.evidence.some((ref) => ref.kind === "business")));
    assert.ok((await readFile(evidence.report, "utf8")).includes("Oracle-declared different fields: note.title"));
  }
  if (corruptNote) assert.ok(evidence.summary.confirmedProductFindings > 0);
  assert.equal(operations.filter((item) => item.method === "POST").length, 6); assert.equal(operations.filter((item) => item.method === "DELETE").length, 6);
  const browser = await chromium.launch({ headless: true, executablePath: config.surfaces.web.executablePath });
  let mediaCount = 0, decodedScreenshots = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route(/^https?:/, (route) => route.abort());
    for (const run of runs) {
      await page.goto(pathToFileURL(run.report).href);
      await page.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } }); decodedScreenshots += await page.locator("img").count();
      await page.locator("video").evaluate(async (video) => { video.muted = true; video.playbackRate = 8; await video.play(); });
      await page.waitForFunction(() => document.querySelector("video").ended, {}, { timeout: 15000 });
      assert.equal(await page.locator("video").evaluate((video) => video.error), null); mediaCount++;
    }
    await page.goto(pathToFileURL(evidence.report).href);
    assert.equal(await page.locator("#checks tbody tr").count(), 12);
    const desktop = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.equal(desktop.width, desktop.scrollWidth);
    await page.screenshot({ path: join(repository, "outputs/" + outputPrefix + "-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.equal(mobile.width, mobile.scrollWidth);
    await page.screenshot({ path: join(repository, "outputs/" + outputPrefix + "-mobile.png") });
    const result = { checkedAt: new Date().toISOString(), root, missionId: mission.missionId, report: evidence.report, testVerdict: evidence.testVerdict,
      runtimeDigests,
      surfaceMatrix: mission.plan.executionProfile.surfaceMatrix, runs, corruptNote, recordedChecks: evidence.summary.checkOverview.counts,
      cleanupScopes: 6, foreignSentinelRetained: true, remainingSyntheticScopes: scopes.size - 1, desktop, mobile, mediaCount, decodedScreenshots,
      driverSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
      limitation: "Controlled local fixtures with host-authored observed Charters; not autonomous planning, a hosted website result, cross-account production authorization or whole-project coverage. Independent backend history verifies lifecycle transitions at final read, not intermediate business checkpoints." };
    for (const entry of runtimeDigests) assert.equal(createHash("sha256").update(await readFile(join(repository, entry.path))).digest("hex"), entry.sha256);
    await writeFile(join(repository, "outputs/" + outputPrefix + "-validation.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
} finally {
  await runner?.closeAllSurfaceSessions(); await planner.closeAllSurfaceSessions();
  for (const record of scopes.values()) clearTimeout(record.timer);
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
