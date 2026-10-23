import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-multi-session-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-multi-session-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
process.env.PROOFKIT_SESSION_KEY = "multi-session-smoke-secret";
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/account/a" || path === "/account/b") {
    const account = path.endsWith("/a") ? "a" : "b";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `proofkit-account=${account}; Path=/` });
    response.end(`<h1>Account ${account}</h1>`);
    return;
  }
  const cookie = request.headers.cookie ?? "";
  const account = cookie.match(/proofkit-account=([^;]+)/)?.[1] ?? "none";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<h1>Current account: ${account}</h1>`);
});

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Multi-session fixture server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browserPath = process.env.PROOFKIT_BROWSER_PATH
    ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
      ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({
    project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    policies: { sideEffects: "allow" },
    sessions: { persistence: "encrypted", keyEnv: "PROOFKIT_SESSION_KEY" },
  }) });
  const first = await runner.interactSurface({ adapter: "web", url: baseUrl, sessionLabel: "account-a", action: { kind: "goto", url: `${baseUrl}/account/a` }, keepSession: true });
  const second = await runner.interactSurface({ adapter: "web", url: baseUrl, sessionLabel: "account-b", action: { kind: "goto", url: `${baseUrl}/account/b` }, keepSession: true });
  assert.ok(first.sessionId && second.sessionId);
  assert.equal(first.sessionLabel, "account-a");
  assert.equal(second.sessionLabel, "account-b");
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal((await runner.wait(first.interactionId)).execution?.sessionId, first.sessionId);
  assert.equal((await runner.wait(second.interactionId)).execution?.sessionId, second.sessionId);
  assert.deepEqual(runner.listSurfaceSessions().sessions.map((session) => session.sessionLabel).sort(), ["account-a", "account-b"]);
  const firstIdentity = await runner.interactSurface({ adapter: "web", sessionId: first.sessionId, action: { kind: "goto", url: `${baseUrl}/whoami` } });
  const secondIdentity = await runner.interactSurface({ adapter: "web", sessionId: second.sessionId, action: { kind: "goto", url: `${baseUrl}/whoami` } });
  assert.match(firstIdentity.snapshot?.text ?? "", /Current account: a/);
  assert.match(secondIdentity.snapshot?.text ?? "", /Current account: b/);
  const formal = await runner.start({ adapter: "web", sessionId: first.sessionId, start: false, charter: {
    intent: "验收已登录账号身份",
    level: "quick",
    mode: "deterministic",
    preconditions: ["已在探索会话中登录"],
    actions: [{ kind: "observe" }],
    assertions: [{ kind: "text-visible", text: "Current account: a" }],
    sideEffectPolicy: "deny",
    metadata: { sourceSession: "exploratory" },
  } });
  const formalSummary = await runner.wait(formal.runId);
  assert.equal(formalSummary.verdict, "passed", JSON.stringify(formalSummary, null, 2));
  assert.equal(formalSummary.execution?.sessionId, first.sessionId);
  const secondAfterFormal = await runner.interactSurface({ adapter: "web", sessionId: second.sessionId, action: { kind: "goto", url: `${baseUrl}/whoami` } });
  assert.match(secondAfterFormal.snapshot?.text ?? "", /Current account: b/);
  const mission = await runner.createMission({
    intent: "验收第二个已登录账号身份",
    surface: "web",
    sessionId: second.sessionId,
    charter: {
      intent: "验收第二个已登录账号身份",
      level: "quick",
      mode: "deterministic",
      preconditions: ["已在探索会话中登录"],
      actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Current account: b" }],
      sideEffectPolicy: "deny",
      metadata: { sourceSession: "exploratory" },
    },
  });
  assert.equal(mission.surfaceSessionId, second.sessionId);
  assert.equal(mission.sessionContext?.sessionId, second.sessionId);
  assert.deepEqual(mission.sessionContext?.runs.map((run) => run.runId), [second.interactionId, secondIdentity.interactionId, secondAfterFormal.interactionId]);
  assert.ok(mission.sessionContext.runs.every((run) => run.evidence.some((ref) => ref.kind === "screenshot")));
  await runner.startMission(mission.missionId, { approve: true });
  let missionStatus = await runner.missionStatus(mission.missionId);
  for (let attempt = 0; attempt < 100 && missionStatus.running; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    missionStatus = await runner.missionStatus(mission.missionId);
  }
  assert.equal(missionStatus.mission.status, "completed", JSON.stringify(missionStatus.mission, null, 2));
  assert.equal(missionStatus.mission.verdict, "passed", JSON.stringify(missionStatus.mission, null, 2));
  const presented = await runner.missionEvidence(mission.missionId);
  assert.deepEqual(presented.summary.sessionContext, mission.sessionContext);
  assert.ok(presented.report);
  const missionReport = await readFile(presented.report, "utf8");
  assert.ok(missionReport.includes("Prior session context"));
  assert.ok(missionReport.includes(`../../runs/${second.interactionId}/report.html`));
  assert.ok(!missionReport.includes("Screenshot unavailable or changed"));
  const restarted = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({
    project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    policies: { sideEffects: "allow" },
    sessions: { persistence: "encrypted", keyEnv: "PROOFKIT_SESSION_KEY" },
  }) });
  const recovered = await restarted.interactSurface({ adapter: "web", sessionId: first.sessionId, sessionLabel: "account-a", action: { kind: "goto", url: `${baseUrl}/whoami` } });
  assert.match(recovered.snapshot?.text ?? "", /Current account: a/);
  const restoredFirstSession = restarted.listSurfaceSessions().sessions.find((session) => session.sessionId === first.sessionId);
  assert.ok(restoredFirstSession?.borrowedRunIds.includes(first.interactionId));
  assert.ok(restoredFirstSession?.borrowedRunIds.includes(firstIdentity.interactionId));
  for (const runId of [first.interactionId, firstIdentity.interactionId]) {
    const history = await restarted.wait(runId);
    assert.equal(history.execution?.sessionId, first.sessionId);
    const manifest = await restarted.evidenceManifest(runId);
    assert.equal((await restarted.verifyEvidenceManifest(runId, manifest.sha256)).status, "intact");
  }
  assert.equal(restarted.listSurfaceSessions().sessions.some((session) => session.sessionId === first.sessionId), true);
  const presentedAfterRestart = await restarted.missionEvidence(mission.missionId);
  assert.deepEqual(presentedAfterRestart.summary.sessionContext, mission.sessionContext);
  const childCode = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    const [runnerModule, contractsModule, projectRoot, workspaceRoot, baseUrl, browserPath, sessionId, originalRunId, missionId] = process.argv.slice(1);
    const { LocalRunnerService } = await import(runnerModule);
    const { ProofkitConfigSchema } = await import(contractsModule);
    const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({
      project: { root: projectRoot }, surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
      policies: { sideEffects: "allow" }, sessions: { persistence: "encrypted", keyEnv: "PROOFKIT_SESSION_KEY" },
    }) });
    try {
      const interaction = await runner.interactSurface({ adapter: "web", sessionId, action: { kind: "goto", url: baseUrl + "/whoami" } });
      assert.match(interaction.snapshot?.text ?? "", /Current account: a/);
      assert.ok(runner.listSurfaceSessions().sessions.find((session) => session.sessionId === sessionId)?.borrowedRunIds.includes(originalRunId));
      const presented = await runner.missionEvidence(missionId);
      assert.ok(presented.report);
      assert.ok((await readFile(presented.report, "utf8")).includes("Prior session context"));
      process.stdout.write(JSON.stringify({ sessionContext: presented.summary.sessionContext }));
    } finally { await runner.closeAllSurfaceSessions(); }
  `;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", childCode,
    new URL("../packages/local-runner/dist/index.js", import.meta.url).href,
    new URL("../packages/contracts/dist/index.js", import.meta.url).href,
    projectRoot, workspaceRoot, baseUrl, browserPath ?? "", first.sessionId, first.interactionId, mission.missionId],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(child.stdout).sessionContext, mission.sessionContext);
  await runner.closeAllSurfaceSessions();
  await restarted.closeAllSurfaceSessions();
  const cold = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({
    project: { root: projectRoot },
    surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
    policies: { sideEffects: "allow" },
  }) });
  const replayed = await cold.replayMission(mission.missionId, { approve: true });
  let replayStatus = await cold.missionStatus(replayed.mission.missionId);
  for (let attempt = 0; attempt < 100 && replayStatus.running; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    replayStatus = await cold.missionStatus(replayed.mission.missionId);
  }
  assert.notEqual(replayStatus.mission.verdict, "passed", "A restarted process must not silently replace a missing retained session");
  await cold.closeAllSurfaceSessions();
  console.log(JSON.stringify({ status: "passed", sessions: [first.sessionId, second.sessionId], isolated: true, formalRunReusedSession: true, missionReusedSession: true, encryptedSessionRecovered: true, sessionRunHistoryRecovered: true, historyEvidenceIntact: true, frozenSessionContextReported: true, separateProcessRecovery: true, restartFailsClosed: true,
    ...(keepArtifacts ? { workspaceRoot, projectRoot, report: presented.report } : {}) }, null, 2));
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
