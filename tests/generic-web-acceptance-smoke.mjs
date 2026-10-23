import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { sanitizeEvidence } from "../packages/evidence/dist/index.js";

const executablePath = process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined);
const requireModel = process.argv.includes("--require-model");
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const caseName = argument("--case");
const resultPath = argument("--result-json");
const evaluationRoot = argument("--evaluation-root");
const keepArtifacts = process.argv.includes("--keep-artifacts");
if (process.argv.includes("--case") && !caseName) throw new Error("--case requires a known project name");
if (process.argv.includes("--evaluation-root") && (!evaluationRoot || !resultPath || !keepArtifacts)) throw new Error("--evaluation-root requires --result-json and --keep-artifacts");
const externalPlannerUrl = process.env.PROOFKIT_PLANNER_BASE_URL;
const externalPlannerModel = process.env.PROOFKIT_PLANNER_MODEL;
const useExternalPlanner = Boolean(externalPlannerUrl && externalPlannerModel);
if (requireModel && !useExternalPlanner) throw new Error("--require-model requires PROOFKIT_PLANNER_BASE_URL and PROOFKIT_PLANNER_MODEL");
const root = evaluationRoot ? resolve(evaluationRoot) : await mkdtemp(join(tmpdir(), "proofkit-generic-web-"));
if (evaluationRoot) await mkdir(root);
const services = [];
const states = { crudSaved: false, loginCount: 0, privateDashboardAuthenticated: false, asyncStarted: false };
let plannerCalls = 0;
const fixtures = [
  {
    name: "catalog-crud",
    intent: "save a catalog item",
    expect: ["Saved"],
    entry: "/catalog",
    buildPlan({ controls, url }) {
      return { actions: [{ kind: "goto", url }, { kind: "fill", selector: control(controls, "textbox", "Title"), value: "generic item" },
        { kind: "click", selector: control(controls, "button", "Save") }, { kind: "waitForText", text: "Saved" }],
        assertions: [{ kind: "text-visible", text: "Saved" }] };
    },
    handler(request, response, url) {
      if (url.pathname === "/save") { states.crudSaved = true; response.writeHead(201, { "content-type": "application/json" }); response.end('{"saved":true}'); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<h1>Catalog</h1><label for="title">Title</label><input id="title"><button id="save" onclick="fetch(\'/save\',{method:\'POST\',headers:{\'content-type\':\'application/json\'},body:JSON.stringify({title:document.querySelector(\'#title\').value})}).then(()=>document.querySelector(\'#result\').textContent=\'Saved\')">Save</button><p id="result"></p>');
    },
    readBusinessState: (state) => ({ itemPersisted: state.crudSaved }),
  },
  {
    name: "account-portal",
    intent: "sign in and open the private dashboard",
    expect: ["Private dashboard"],
    entry: "/sign-in",
    buildPlan({ controls, url }) {
      return { actions: [{ kind: "goto", url }, { kind: "click", selector: control(controls, "button", "Sign in") },
        { kind: "goto", url: `${new URL(url).origin}/private` }],
        assertions: [{ kind: "text-visible", text: "Private dashboard" }, { kind: "text-not-visible", text: "Unauthorized" }] };
    },
    handler(request, response, url) {
      if (url.pathname === "/authenticate") { states.loginCount++; response.writeHead(204, { "set-cookie": "generic-session=ready; HttpOnly; SameSite=Lax; Path=/" }); response.end(); return; }
      if (url.pathname === "/private") {
        const authenticated = request.headers.cookie?.includes("generic-session=ready");
        states.privateDashboardAuthenticated = Boolean(authenticated);
        response.writeHead(authenticated ? 200 : 401, { "content-type": "text/html; charset=utf-8" });
        response.end(`<h1>${authenticated ? "Private dashboard" : "Unauthorized"}</h1>`); return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<h1>Account portal</h1><button id="login" onclick="fetch(\'/authenticate\',{method:\'POST\'}).then(()=>document.querySelector(\'#result\').textContent=\'Signed in\')">Sign in</button><p id="result"></p>');
    },
    readBusinessState: (state) => ({ loginAccepted: state.loginCount === 1, privateDashboardAuthenticated: state.privateDashboardAuthenticated }),
  },
  {
    name: "job-console",
    intent: "start an asynchronous job",
    expect: ["Job started"],
    entry: "/jobs",
    buildPlan({ controls, url }) {
      return { actions: [{ kind: "goto", url }, { kind: "click", selector: control(controls, "button", "Start job") },
        { kind: "waitForText", text: "Job started" }], assertions: [{ kind: "text-visible", text: "Job started" }] };
    },
    handler(_request, response, url) {
      if (url.pathname === "/start") { states.asyncStarted = true; response.writeHead(202, { "content-type": "application/json" }); response.end('{"accepted":true}'); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<h1>Job console</h1><button id="run" onclick="fetch(\'/start\',{method:\'POST\'}).then(()=>document.querySelector(\'#result\').textContent=\'Job started\')">Start job</button><p id="result"></p>');
    },
    readBusinessState: (state) => ({ jobAccepted: state.asyncStarted }),
  },
];
if (caseName && !fixtures.some((fixture) => fixture.name === caseName)) throw new Error("Unknown generic Web acceptance case");
if (process.argv.includes("--result-json") && (!resultPath || !caseName || !keepArtifacts)) throw new Error("--result-json requires --case and --keep-artifacts");
const selectedFixtures = caseName ? fixtures.filter((fixture) => fixture.name === caseName) : fixtures;
let currentCase;
let currentPhase = "setup";
let currentRun;
let currentPlanningSummary;
const startedAt = Date.now();

function control(controls, role, name) {
  const matches = controls.filter((candidate) => candidate.role === role && candidate.name === name && candidate.selector);
  assert.equal(matches.length, 1, `Observed surface must expose one unique ${role} named ${name}`);
  return matches[0].selector;
}

const plannerServer = useExternalPlanner ? undefined : createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404); response.end(); return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw);
  const prompt = JSON.parse(payload.messages.find((message) => message.role === "user").content);
  plannerCalls++;
  if (prompt.intent === "probe unsupported selector") {
    const charter = { intent: prompt.intent, level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "goto", url: prompt.constraints.url }, { kind: "click", selector: "#never-observed" }],
      assertions: [{ kind: "text-visible", text: "Saved" }], sideEffectPolicy: prompt.constraints.sideEffectPolicy, metadata: {} };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(charter) } }] }));
    return;
  }
  if (prompt.intent === "probe omitted business oracle") {
    const plan = fixtures[0].buildPlan({ controls: prompt.surfaceSnapshot.controls, url: prompt.constraints.url });
    const charter = { intent: prompt.intent, level: "quick", mode: "deterministic", sideEffectPolicy: "allow", preconditions: [],
      ...plan, oracles: [], metadata: {} };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(charter) } }] }));
    return;
  }
  const fixture = fixtures.find((item) => item.intent === prompt.intent);
  if (!fixture || !prompt.surfaceSnapshot?.controls?.length) {
    response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Observed planning input missing" })); return;
  }
  const plan = fixture.buildPlan({ controls: prompt.surfaceSnapshot.controls, url: prompt.constraints.url });
  const charter = { intent: prompt.intent, level: "quick", mode: "deterministic", preconditions: ["isolated test data"], ...plan,
    oracles: prompt.constraints.oracleNames, sideEffectPolicy: prompt.constraints.sideEffectPolicy,
    metadata: { acceptance: "generic-web", application: fixture.name } };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(charter) } }] }));
});
if (plannerServer) {
  services.push(plannerServer);
  await new Promise((resolveServer) => plannerServer.listen(0, "127.0.0.1", resolveServer));
}
const plannerUrl = externalPlannerUrl ?? (() => {
  const plannerAddress = plannerServer?.address();
  if (!plannerAddress || typeof plannerAddress === "string") throw new Error("Acceptance planner failed to bind");
  return `http://127.0.0.1:${plannerAddress.port}/v1`;
})();

try {
  const results = [];
  for (const [index, fixture] of selectedFixtures.entries()) {
    currentRun = undefined;
    currentPlanningSummary = undefined;
    currentCase = fixture;
    currentPhase = "setup";
    const projectRoot = join(root, fixture.name);
    const workspaceRoot = join(root, `${fixture.name}-tests`);
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: fixture.name, private: true }), "utf8");
    const server = createServer((request, response) => fixture.handler(request, response, new URL(request.url ?? "/", "http://127.0.0.1")));
    services.push(server);
    await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error(`${fixture.name} fixture failed to bind`);
    const origin = `http://127.0.0.1:${address.port}`;
    const entryUrl = `${origin}${fixture.entry}`;
    const config = ProofkitConfigSchema.parse({
      project: { root: projectRoot },
      surfaces: { web: { baseUrl: entryUrl, ...(executablePath ? { executablePath } : {}) } },
      planning: { provider: "openai-compatible", baseUrl: plannerUrl, model: externalPlannerModel ?? "generic-acceptance-fixture",
        ...(process.env.PROOFKIT_PLANNER_API_KEY ? { apiKeyEnv: "PROOFKIT_PLANNER_API_KEY" } : {}), timeoutMs: 30_000 },
      policies: { sideEffects: "allow" },
      run: { timeoutMs: 20_000 },
    });
    const oracleName = `${fixture.name}-business-state`;
    const runner = await LocalRunnerService.create({ root: projectRoot, workspaceRoot, config, integration: {
      name: `${fixture.name}-acceptance-connector`, version: "1.0.0",
      oracles: [{ name: oracleName, async check() {
        const facts = fixture.readBusinessState(states);
        const passed = Object.values(facts).every(Boolean);
        return { name: oracleName, passed, verificationKind: "business",
          message: passed ? "Independent fixture business state matches the expected outcome" : "Independent fixture business state is incomplete",
          evidence: [JSON.stringify(facts)], observedAt: new Date().toISOString() };
      } }],
    } });
    currentPhase = "inspection";
    const inspection = await runner.inspectSurface({ adapter: "web", url: entryUrl });
    assert.equal(inspection.status, "observed", `${fixture.name}: ${JSON.stringify(inspection)}`);
    if (fixture.name === "catalog-crud" && !useExternalPlanner) {
      const runsBeforeUnverifiedPlan = await readdir(runner.evidenceDir);
      const unverified = await runner.plan("probe unsupported selector", { url: entryUrl, sideEffectPolicy: "allow", surfaceSnapshot: inspection.snapshot });
      assert.ok(unverified.planning?.evidenceGaps.includes("surface-selector"));
      assert.ok(unverified.planning?.missingInputs.some((item) => item.includes("#never-observed")));
      assert.deepEqual(await readdir(runner.evidenceDir), runsBeforeUnverifiedPlan,
        "planning with an unobserved selector must not create or start a Run");
      const unboundRun = await runner.start({ adapter: "web", start: false, charter: unverified });
      const unboundSummary = await runner.wait(unboundRun.runId);
      assert.equal(unboundSummary.verdict, "inconclusive");
      assert.equal(unboundSummary.steps.length, 0, "An observed plan with an unbound target must stop before any action");
      assert.ok(unboundSummary.findings.some((finding) => finding.includes("unique observed identity")));
      const beforeMissingOracle = await readdir(runner.evidenceDir);
      await assert.rejects(() => runner.plan("probe omitted business oracle", { url: entryUrl, sideEffectPolicy: "allow",
        surfaceSnapshot: inspection.snapshot, expect: fixture.expect, oracleNames: [oracleName] }), /requested business oracles/);
      assert.deepEqual(await readdir(runner.evidenceDir), beforeMissingOracle, "a plan that drops independent acceptance cannot create a Run");
      assert.equal(states.crudSaved, false);
    }
    currentPhase = "planning";
    const charter = await runner.plan(fixture.intent, { url: entryUrl, sideEffectPolicy: "allow", surfaceSnapshot: inspection.snapshot,
      expect: fixture.expect, oracleNames: [oracleName] });
    assert.equal(charter.planning?.source, "model");
    assert.ok(!charter.planning?.evidenceGaps.includes("surface-selector"));
    assert.deepEqual(charter.oracles, [oracleName], `${fixture.name}: model must preserve the independently reviewed Oracle`);
    assert.ok(fixture.expect.every((text) => charter.assertions.some((assertion) => assertion.kind === "text-visible" && assertion.text === text)));
    assert.ok(charter.actions.some((action) => action.kind === "click" && inspection.snapshot.controls.some((item) => item.selector === action.selector)));
    const plannedCharter = JSON.stringify(sanitizeEvidence(charter), null, 2) + "\n";
    const plannedCharterSha256 = createHash("sha256").update(plannedCharter).digest("hex");
    await writeFile(join(workspaceRoot, "planned-charter.json"), plannedCharter, { flag: "wx" });
    const planningSummary = { source: charter.planning?.source ?? "unassessed", confidence: charter.planning?.confidence ?? 0,
      actions: charter.actions.length, assertions: charter.assertions.length, oracles: charter.oracles?.length ?? 0,
      negativeCases: charter.negativeCases?.length ?? 0, evidenceGaps: charter.planning?.evidenceGaps ?? [],
      missingInputs: charter.planning?.missingInputs ?? [], plannedCharterSha256 };
    currentPlanningSummary = planningSummary;
    await writeFile(join(workspaceRoot, "planning-receipt.json"), JSON.stringify(planningSummary, null, 2) + "\n", { flag: "wx" });
    if (useExternalPlanner && planningSummary.source !== "model") throw new Error("Model fixture did not persist a model-sourced Charter");
    currentPhase = "execution";
    const started = await runner.start({ adapter: "web", start: false, charter });
    const summary = await runner.wait(started.runId);
    currentRun = summary;
    currentPhase = "verdict";
    assert.equal(summary.verdict, "passed", `${fixture.name}: ${JSON.stringify(summary, null, 2)}`);
    assert.equal(summary.projectRoot, projectRoot);
    assert.equal(summary.workspaceRoot, workspaceRoot);
    assert.equal(summary.steps.length, charter.actions.length);
    assert.equal(summary.oracles.find((oracle) => oracle.name === oracleName)?.passed, true, `${fixture.name}: independent business Oracle failed`);
    assert.ok((summary.oracles.find((oracle) => oracle.name === oracleName)?.sourceEvidenceCount ?? 0) > 0,
      `${fixture.name}: independent business facts were not recorded`);
    currentPhase = "evidence";
    assert.ok(summary.steps.every((step) => step.artifacts.length > 0));
    for (const [stepIndex, step] of summary.steps.entries()) {
      const screenshot = `${summary.runId}/artifacts/step-${String(stepIndex + 1).padStart(3, "0")}.png`;
      assert.ok(step.artifacts.includes(screenshot), `${fixture.name} ${step.stepId}: action screenshot missing`);
    }
    const report = await readFile(join(runner.evidenceDir, summary.runId, "report.html"), "utf8");
    assert.ok(report.includes("Plan execution"));
    assert.ok(report.includes("Evidence files"));
    assert.ok(report.includes(`Business — ${oracleName}`));
    assert.ok(report.includes("Network requests ("), `${fixture.name}: step-correlated network evidence missing`);
    assert.ok(report.includes("Started ") && report.includes("Ended "), `${fixture.name}: step timeline missing`);
    assert.ok(summary.steps.every((step, stepIndex) => report.includes(`step-${String(stepIndex + 1).padStart(3, "0")}.png`)),
      `${fixture.name}: report does not link every action screenshot`);
    const manifest = await runner.evidenceManifest(summary.runId);
    const manifestAudit = await runner.verifyEvidenceManifest(summary.runId, manifest.sha256);
    assert.equal(manifestAudit.status, "intact", `${fixture.name}: ${JSON.stringify(manifestAudit)}`);
    assert.ok(manifestAudit.files.length >= summary.artifacts.length);
    assert.ok(manifestAudit.files.every((file) => file.status === "verified"));
    results.push({ project: fixture.name, plannedFromObservedSurface: true, planningSummary, runId: summary.runId, verdict: summary.verdict,
      artifacts: summary.artifacts.length, screenshots: summary.steps.length, manifest: manifestAudit.status,
      verifiedFiles: manifestAudit.files.length });
    if (fixture.name === "catalog-crud") assert.equal(states.crudSaved, true);
  }
  if (selectedFixtures.some((fixture) => fixture.name === "account-portal")) assert.equal(states.loginCount, 1);
  if (selectedFixtures.some((fixture) => fixture.name === "job-console")) assert.equal(states.asyncStarted, true);
  if (!useExternalPlanner) assert.equal(plannerCalls, selectedFixtures.length + (selectedFixtures.some((fixture) => fixture.name === "catalog-crud") ? 2 : 0),
    "each live plan request must reach the configured OpenAI-compatible provider");
  if (resultPath) await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, project: caseName, evaluationScope: "fixture", status: "passed", phase: "completed",
    runId: currentRun?.runId, verdict: currentRun?.verdict, independentBusinessPassed: Object.values(currentCase.readBusinessState(states)).every(Boolean),
    manifest: results[0]?.manifest, workspaceRoot: join(root, `${caseName}-tests`), planningSummary: results[0]?.planningSummary, durationMs: Date.now() - startedAt }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ status: "passed", evaluationScope: "fixture", plannerMode: useExternalPlanner ? "openai-compatible" : "deterministic-fixture",
    independentProjects: results.length, ...(useExternalPlanner ? { model: externalPlannerModel } : { plannerCalls }),
    unobservedSelectorBlockedFromExecution: !useExternalPlanner && selectedFixtures.some((fixture) => fixture.name === "catalog-crud"),
    omittedBusinessOracleBlocked: !useExternalPlanner && selectedFixtures.some((fixture) => fixture.name === "catalog-crud"), cases: results }, null, 2));
} catch (error) {
  if (!resultPath) throw error;
  await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, project: caseName, status: "failed", phase: currentPhase,
    runId: currentRun?.runId, verdict: currentRun?.verdict, evaluationScope: "fixture", planningSummary: currentPlanningSummary, independentBusinessPassed: currentCase
      ? Object.values(currentCase.readBusinessState(states)).every(Boolean) : false,
    workspaceRoot: join(root, `${caseName}-tests`), durationMs: Date.now() - startedAt,
    failureKind: error instanceof Error ? error.name : "unknown" }, null, 2), { flag: "wx" });
  process.exitCode = 1;
} finally {
  await Promise.all(services.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
  if (!keepArtifacts) await rm(root, { recursive: true, force: true });
}
