import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { captureSourceState, collectWorkflowReviewMaterials, inspectWorkflowInventory, scanProject, signWorkflowReview } from "../packages/project/dist/index.js";

const runFile = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "proofkit-reviewed-run-"));
const source = join(scratch, "source");
const workspace = join(scratch, "workspace");
const trustRoot = join(scratch, "trust");
const browserPath = process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
let server;
const priorTrust = process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
try {
  if (browserPath) assert.ok(existsSync(browserPath), `Browser not found: ${browserPath}`);
  await Promise.all([mkdir(join(source, "src"), { recursive: true }), mkdir(join(workspace, "charters"), { recursive: true }),
    mkdir(join(workspace, ".proofkit"), { recursive: true }), mkdir(trustRoot)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "reviewed-fixture", type: "module", devDependencies: { vite: "1" } }));
  await writeFile(join(source, "src", "main.ts"), "export const routes = [{ path: '/resumes' }];\n");
  await writeFile(join(source, "test-server.mjs"), `import { createServer } from "node:http";
createServer((request, response) => {
  if (request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { status: "done", run: "current" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Reviewed fixture</title><h1>Resume ready</h1>");
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`);
  await git("init", "-q");
  await git("-c", "core.autocrlf=false", "add", ".");
  await git("-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");
  const sourceState = await captureSourceState(source);
  assert.ok(sourceState.complete && sourceState.headSha && sourceState.worktreeSha256);
  const map = await scanProject(source);
  assert.ok(map.inventory.entryPoints.length > 0, "Fixture must have a scanned source entry");
  assert.equal(map.inventory.truncated, false);
  const routes = map.inventory.routeHints.filter((route) => route.kind === "web" && route.path === "/resumes");
  assert.equal(routes.length, 1, "Fixture must expose a scanned resume route");
  server = spawn(process.execPath, [join(source, "test-server.mjs")], { cwd: source, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const port = await serverPort(server);
  const origin = `http://127.0.0.1:${port}`;
  const baseUrl = `${origin}/resumes`;
  const config = { project: { root: source },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    charters: [{ id: "resume-core", path: "charters/resume.yaml", aliases: ["resume"], level: "core", surfaces: ["web"],
      routeTargets: routes.map((route) => ({ kind: "web", path: route.path, source: route.source })) }],
    oracles: [{ name: "resume-terminal", url: `${origin}/state`, statusPointer: "/data/status", successValues: ["done"] }],
    run: { timeoutMs: 20_000 }, policies: { targetBinding: "record" } };
  await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
  await writeFile(join(workspace, "charters", "resume.yaml"), JSON.stringify({ intent: "Verify resume workflow", level: "core",
    actions: [{ kind: "goto", url: baseUrl }], assertions: [{ kind: "text-visible", text: "Resume ready" }],
    oracles: ["resume-terminal"], sideEffectPolicy: "deny" }));
  const inventory = { schemaVersion: 1, source: { headSha: sourceState.headSha, worktreeSha256: sourceState.worktreeSha256 },
    review: { by: "operator", at: new Date().toISOString(), method: "Reviewed every scanned entry and fixture workflow" },
    workflows: [{ id: "resume", title: "Resume", sourcePaths: [...new Set(map.inventory.entryPoints.map((entry) => entry.path))],
      charterIds: ["resume-core"], surfaces: ["web"] }], exclusions: [] };
  await writeFile(join(workspace, ".proofkit", "workflows.yaml"), JSON.stringify(inventory));
  const inspected = await inspectWorkflowInventory(source, workspace, config, sourceState, map, {});
  assert.deepEqual(inspected.inspection.candidateAudit?.gaps, []);
  const materials = await collectWorkflowReviewMaterials(inventory, config, map, workspace);
  const keys = generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  await writeFile(join(workspace, ".proofkit", "workflow-review.json"), JSON.stringify(signWorkflowReview(inventory,
    inspected.inspection.candidateAudit, materials, "fixture-reviewer", privatePem)));
  const trustPath = join(trustRoot, "keys.json");
  await writeFile(trustPath, JSON.stringify({ "fixture-reviewer": publicPem }));
  delete process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
  const untrustedRunner = await LocalRunnerService.create({ root: source, workspaceRoot: workspace });
  const untrustedMission = await untrustedRunner.createMission({ intent: "测试整个项目核心流程", level: "core", surface: "web" });
  assert.equal(untrustedMission.workflowReviewAdmission, undefined);
  assert.ok(untrustedMission.plan.planning?.evidenceGaps.includes("project-workflow-coverage"));
  process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = trustPath;

  const runner = await LocalRunnerService.create({ root: source, workspaceRoot: workspace });
  const mission = await runner.createMission({ intent: "测试整个项目核心流程", level: "core", surface: "web" });
  assert.equal(mission.workflowReviewAdmission?.keyId, "fixture-reviewer");
  assert.deepEqual(mission.plan.planning?.evidenceGaps, []);
  await runner.startMission(mission.missionId, { approve: true });
  const completed = await runner.waitMission(mission.missionId);
  const result = await runner.missionEvidence(mission.missionId);
  assert.equal(completed.verdict, "passed", JSON.stringify(result, null, 2));
  assert.equal(result.testVerdict, "passed", JSON.stringify(result, null, 2));
  assert.equal(result.workflowReviewAudit?.status, "verified");
  assert.equal(result.proofClassification?.status, "explicit");
  assert.equal(result.summary.executionAudit?.status, "complete");
  assert.deepEqual(result.targetBindings.map(({ binding }) => binding.status), ["matching-process-path"], JSON.stringify(result.targetBindings));
  const cliCheck = ["bundle/main.js", "mission", "check", mission.missionId, "--root", source, "--workspace", workspace];
  const passedCheck = await runFile(process.execPath, cliCheck, { timeout: 20_000 });
  assert.equal(JSON.parse(passedCheck.stdout).testVerdict, "passed");
  const readAgain = await (await LocalRunnerService.create({ root: source, workspaceRoot: workspace })).missionEvidence(mission.missionId);
  assert.equal(readAgain.testVerdict, "passed");

  const missionPath = join(workspace, ".proofkit", "missions", `${mission.missionId}.json`);
  const savedMission = await readFile(missionPath, "utf8");
  const withoutRoute = JSON.parse(savedMission);
  const savedRun = withoutRoute.observations.find((item) => item.kind === "surface.run");
  assert.deepEqual(savedRun?.data.matchedRoutePaths, ["/resumes"]);
  savedRun.data.matchedRoutePaths = [];
  await writeFile(missionPath, JSON.stringify(withoutRoute));
  const missingRoute = await runner.missionEvidence(mission.missionId);
  assert.equal(missingRoute.workflowReviewAudit?.reason, "route-coverage-incomplete");
  assert.equal(missingRoute.testVerdict, "inconclusive");
  await writeFile(missionPath, savedMission);
  assert.equal((await runner.missionEvidence(mission.missionId)).testVerdict, "passed");

  const business = result.summary.runs[0]?.evidence.find((ref) => ref.kind === "business");
  assert.ok(business, "A passing core Run must cite an independent business source artifact");
  const originalBusiness = await readFile(business.path);
  await writeFile(business.path, "altered business evidence");
  const altered = await runner.missionEvidence(mission.missionId);
  assert.equal(altered.verdict, "passed");
  assert.equal(altered.testVerdict, "inconclusive");
  await writeFile(business.path, originalBusiness);
  assert.equal((await runner.missionEvidence(mission.missionId)).testVerdict, "passed");

  await untrustedRunner.startMission(untrustedMission.missionId, { approve: true });
  const legacyCompleted = await untrustedRunner.waitMission(untrustedMission.missionId);
  const legacyResult = await untrustedRunner.missionEvidence(untrustedMission.missionId);
  assert.equal(legacyCompleted.verdict, "inconclusive");
  assert.equal(legacyResult.testVerdict, "inconclusive");
  assert.equal(legacyResult.workflowReviewAudit?.reason, "missing-admission");

  const otherSource = join(scratch, "other-source");
  await mkdir(otherSource);
  const originalServer = await readFile(join(source, "test-server.mjs"), "utf8");
  await writeFile(join(otherSource, "test-server.mjs"), originalServer.replace(".listen(0,", ".listen(Number(process.argv[2]),"));
  await runFile("git", ["-C", otherSource, "init", "-q"], { timeout: 10_000 });
  const stopped = new Promise((done) => server.once("exit", done));
  server.kill();
  await stopped;
  server = spawn(process.execPath, [join(otherSource, "test-server.mjs"), String(port)],
    { cwd: otherSource, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  assert.equal(await serverPort(server), port);
  const foreignMission = await runner.createMission({ intent: "测试整个项目核心流程", level: "core", surface: "web" });
  assert.equal(foreignMission.workflowReviewAdmission?.keyId, "fixture-reviewer");
  await runner.startMission(foreignMission.missionId, { approve: true });
  const foreignCompleted = await runner.waitMission(foreignMission.missionId);
  const foreignResult = await runner.missionEvidence(foreignMission.missionId);
  assert.equal(foreignCompleted.verdict, "passed", JSON.stringify(foreignResult, null, 2));
  assert.equal(foreignResult.workflowReviewAudit?.status, "verified");
  assert.deepEqual(foreignResult.targetBindings.map(({ binding }) => binding.status), ["different-project"]);
  assert.equal(foreignResult.summary.executionAudit?.status, "incomplete");
  assert.ok(foreignResult.summary.executionAudit?.issues.some((issue) => issue.includes("reviewed source checkout")));
  assert.equal(foreignResult.testVerdict, "inconclusive");
  await assert.rejects(runFile(process.execPath, ["bundle/main.js", "mission", "check", foreignMission.missionId,
    "--root", source, "--workspace", workspace], { timeout: 20_000 }), (error) =>
    error.code === 2 && JSON.parse(error.stdout).testVerdict === "inconclusive");

  await writeFile(trustPath, "{}");
  const revoked = await runner.missionEvidence(mission.missionId);
  assert.equal(revoked.verdict, "passed");
  assert.equal(revoked.testVerdict, "inconclusive");
  assert.equal(revoked.workflowReviewAudit?.reason, "review-untrusted");
  await assert.rejects(runFile(process.execPath, cliCheck, { timeout: 20_000 }), (error) =>
    error.code === 2 && JSON.parse(error.stdout).testVerdict === "inconclusive");
  console.log(JSON.stringify({ missionId: mission.missionId, runId: result.summary.runs[0]?.runId,
    verdict: result.testVerdict, afterRevocation: revoked.testVerdict, scope: result.workflowReviewAudit?.scope }, null, 2));
} finally {
  if (priorTrust === undefined) delete process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH;
  else process.env.PROOFKIT_WORKFLOW_REVIEW_TRUST_PATH = priorTrust;
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((done) => { server.once("exit", done); setTimeout(done, 3000).unref(); });
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function git(...args) { await runFile("git", ["-C", source, ...args], { timeout: 10_000 }); }
async function serverPort(child) {
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    const timer = setTimeout(() => rejectPort(new Error("Fixture server did not report a port")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/)[0];
      if (/^\d+$/.test(line)) { clearTimeout(timer); resolvePort(Number(line)); }
    });
    child.once("exit", (code) => { clearTimeout(timer); rejectPort(new Error(`Fixture server exited ${code}`)); });
  });
}
