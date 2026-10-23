import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const execute = promisify(execFile);
const keepArtifacts = process.argv.includes("--keep-artifacts");
const root = await mkdtemp(join(tmpdir(), "proofkit-external-eval-"));
const output = join(root, "results");
const suitePath = join(root, "reviewed-cases.mjs");
const source = `import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const cases = [{ id:'external-notes', intent:'Save a note and verify persistence', expect:['Note saved'] },
  { id:'reader-gap', intent:'Save a note and verify persistence', expect:['Note saved'] },
  { id:'preexisting', intent:'Save a note and verify persistence', expect:['Note saved'] }];
export async function prepare({caseId, root}) {
  const projectRoot = join(root, 'application'); await mkdir(projectRoot);
  await writeFile(join(projectRoot,'package.json'), JSON.stringify({name:'outside-proofkit',private:true}));
  let saved=caseId==='preexisting', writes=saved?1:0;
  const input='note-'+randomUUID(), button='commit-'+randomUUID();
  const server=createServer((request,response)=>{
    if(request.url==='/save' && request.method==='POST'){ saved=true;writes++;response.writeHead(201);response.end('{}');return; }
    response.writeHead(200,{'content-type':'text/html'});
    response.end('<label for="'+input+'">Note</label><input id="'+input+'"><button id="'+button+'">Save note</button><output></output><script>document.querySelector("button").onclick=async()=>{await fetch("/save",{method:"POST"});document.querySelector("output").textContent="Note saved"}</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return { projectRoot,url:'http://127.0.0.1:'+server.address().port,
    config:{sessions:{recordVideo:true},surfaces:{web:{...(process.platform==='win32'?{executablePath:process.env.PROOFKIT_BROWSER_PATH??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})}}},
    verify:async()=>({passed:caseId==='reader-gap'&&saved?null:saved&&writes===1,facts:{notePersisted:saved,writes}}),
    dispose:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} };
}`;
await writeFile(suitePath, source, { flag: "wx" });
const sha256 = createHash("sha256").update(source).digest("hex");
let calls = 0;
let initialAggregateObserved = false;
const provider = createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  const prompt = JSON.parse(JSON.parse(raw).messages.find((item) => item.role === "user").content);
  const input = prompt.surfaceSnapshot.controls.find((item) => item.role === "textbox" && item.name === "Note");
  const button = prompt.surfaceSnapshot.controls.find((item) => item.role === "button" && item.name === "Save note");
  assert.ok(input?.selector && button?.selector);
  if (!calls) {
    const files = await readdir(output);
    const initial = JSON.parse(await readFile(join(output, files.find((file) => file.startsWith("evaluation-") && file.endsWith(".json"))), "utf8"));
    assert.equal(initial.evaluationStatus, "running");
    assert.equal(initial.plannedAttempts, 3);
    assert.equal(initial.pendingAttempts, 3);
    initialAggregateObserved = true;
  }
  calls++;
  const charter = { intent: prompt.intent, level: "core", mode: "deterministic", sideEffectPolicy: "allow", preconditions: [], metadata: {},
    actions: [{ kind: "fill", selector: input.selector, value: "reviewed note" }, { kind: "click", selector: button.selector }, { kind: "waitForText", text: "Note saved" }],
    assertions: [{ kind: "text-visible", text: "Note saved" }], oracles: prompt.constraints.oracleNames };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(charter) } }] }));
});
try {
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  let rejected = false;
  try {
    await execute(process.execPath, ["tests/model-web-evaluation.mjs", "--trials", "1", "--suite", suitePath, "--suite-sha256", sha256, "--output-dir", output,
      ...(process.argv.includes("--headful") ? ["--headful"] : [])],
      { timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, PROOFKIT_PLANNER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PROOFKIT_PLANNER_MODEL: "external-fixture" } });
  } catch { rejected = true; }
  assert.equal(rejected, true, "A missing business read must keep the aggregate non-successful");
  const files = await readdir(output);
  const report = JSON.parse(await readFile(join(output, files.find((file) => file.startsWith("evaluation-") && file.endsWith(".json"))), "utf8"));
  assert.equal(report.kind, "external-model-task-evaluation");
  assert.equal(report.evaluationScope, "reviewed-external");
  assert.equal(report.attempts.every((attempt) => attempt.evaluationScope === "reviewed-external"), true);
  assert.equal(report.evaluationStatus, "failed");
  assert.equal(report.plannedAttempts, 3);
  assert.equal(report.pendingAttempts, 0);
  assert.equal(report.suite.sha256, sha256);
  assert.equal(report.summary.completed, 1, JSON.stringify(report.attempts));
  assert.equal(report.summary.unavailableBusiness, 2, JSON.stringify(report.attempts));
  assert.equal(report.summary.falsePasses, 0);
  assert.equal(report.summary.valid, 3);
  assert.equal(calls, 2);
  assert.equal(initialAggregateObserved, true);
  assert.equal(report.attempts[0].verdict, "passed");
  assert.equal(report.attempts[1].verdict, "inconclusive");
  assert.equal(report.attempts[2].phase, "setup");
  assert.equal(report.attempts[2].verdict, "not-run", "An already-met baseline must not reach planning or execution");
  for (const attempt of report.attempts.slice(0, 2)) {
    assert.equal(attempt.captureStatus, "sealed");
    assert.equal(attempt.captureIntegrity, "intact");
    assert.ok((await readFile(join(attempt.evaluationRoot, "independent-outcome.json"))).length > 0);
    assert.ok((await readFile(join(attempt.evaluationRoot, "independent-baseline.json"))).length > 0);
    const plannedPath = join(attempt.evaluationRoot, `${attempt.project}-tests`, "planned-charter.json");
    const plannedBytes = await readFile(plannedPath);
    const planningReceipt = JSON.parse(await readFile(join(attempt.evaluationRoot, `${attempt.project}-tests`, "planning-receipt.json"), "utf8"));
    assert.ok(plannedBytes.length > 0);
    assert.equal(planningReceipt.plannedCharterSha256, createHash("sha256").update(plannedBytes).digest("hex"));
    assert.deepEqual(planningReceipt, attempt.planningSummary);
    assert.ok((await readFile(join(attempt.evaluationRoot, "run-manifest-pin.json"))).length > 0);
    const baseline = JSON.parse(await readFile(join(attempt.evaluationRoot, "independent-baseline.json"), "utf8"));
    assert.equal(baseline.passed, false);
    assert.equal(baseline.facts.writes, 0);
    const outcome = JSON.parse(await readFile(join(attempt.evaluationRoot, "independent-outcome.json"), "utf8"));
    assert.equal(outcome.facts.writes, 1);
    const missionReport = await readFile(attempt.missionReport, "utf8");
    assert.ok(missionReport.includes("Workflow actions and checks"));
    assert.ok(missionReport.includes("Expected visible text: Note saved"));
    assert.ok(missionReport.includes("Session evidence"));
    assert.ok(missionReport.includes(`Web execution: ${process.argv.includes("--headful") ? "headful" : "headless"}`));
    assert.ok(missionReport.includes("<video"), "External retained-session clips must reach the final Mission report");
  }
  const browser = await chromium.launch({ ...(process.platform === "win32" ? { executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } : {}), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(pathToFileURL(report.attempts[0].missionReport).href);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator("#workflow-detail").scrollIntoViewIfNeeded();
      assert.ok(await page.locator("#workflow-detail").innerText().then((text) => text.includes("Click · Save note")));
      const images = page.locator("#workflow-detail img");
      assert.ok(await images.count() > 0);
      for (const image of await images.all()) await image.evaluate((element) => element.decode());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.getByRole("link", { name: "Open step-001 evidence", exact: true }).click();
    assert.equal(await page.locator("#step-001").count(), 1);
  } finally { await browser.close(); }
  console.log(JSON.stringify({ status: "passed", outOfTreeTrials: 3, evidencedCompletion: 1, independentReaderGap: 1, preexistingStateBlocked: 1, falsePasses: 0,
    ...(keepArtifacts ? { root, report: report.attempts[0].missionReport } : {}) }));
} finally {
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  if (!keepArtifacts) await rm(root, { recursive: true, force: true });
}
