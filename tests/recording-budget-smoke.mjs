import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-recording-budget-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-recording-budget-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const runners = [];
let playbackBrowser;
const keyName = "PROOFKIT_RECORDING_BUDGET_TEST_KEY";
const previousKey = process.env[keyName];
process.env[keyName] = Buffer.alloc(32, 7).toString("base64");
const server = createServer((request, response) => {
  const noise = request.url?.startsWith("/noise");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<h1>Ready</h1>${noise ? `<canvas style="position:fixed;inset:0;width:100vw;height:100vh;image-rendering:pixelated" width="800" height="450"></canvas><script>
    const context = document.querySelector('canvas').getContext('2d');
    const image = context.createImageData(800, 450);
    const pixels = new Uint32Array(image.data.buffer);
    let random = 42;
    function frame() {
      for (let index = 0; index < pixels.length; index++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pixels[index] = 0xff000000 | (random & 0xffffff); }
      context.putImageData(image, 0, 0); requestAnimationFrame(frame);
    }
    frame();
  </script>` : ""}`);
});

async function until(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(message);
}

function runnerFor(baseUrl, settings) {
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({
    project: { root: projectRoot }, surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } },
    policies: { sideEffects: "allow" }, run: { timeoutMs: 15_000 }, ...settings,
  }) });
  runners.push(runner); return runner;
}

function charter(waiting = false) {
  return { intent: "Verify visible ready state", level: "quick", mode: "deterministic", actions: waiting ? [{ kind: "waitForText", text: "Never shown" }] : [{ kind: "observe" }],
    assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny", metadata: {} };
}

async function verifyCapture(runner, sessionId, reason, captureRunId) {
  const capture = await until(async () => {
    const item = runner.listSurfaceSessions().sessions.find((candidate) => candidate.sessionId === sessionId);
    if (item?.networkCapture?.manifest) return item.networkCapture;
    if (!captureRunId) return;
    try {
      const seal = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "sessions", "capture-seals", `${captureRunId}.json`), "utf8"));
      const saved = JSON.parse(await readFile(join(runner.evidenceDir, captureRunId, "artifacts", "session-network-capture.json"), "utf8"));
      return { ...saved, report: join(runner.evidenceDir, captureRunId, "report.html"), manifest: { path: join(runner.evidenceDir, captureRunId, "manifest.json"), sha256: seal.manifestSha256 } };
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
  }, "A stopped recording must publish a closed, independently verifiable capture");
  assert.notEqual(runner.listSurfaceSessions().sessions.find((item) => item.sessionId === sessionId)?.reusable, true);
  assert.equal(capture.status, "partial");
  assert.equal(capture.closed, true);
  const footageRetained = reason === "duration-limit";
  assert.equal(capture.recording?.status, footageRetained ? "partial" : "unavailable");
  assert.equal(capture.recording?.stopReason, reason);
  assert.equal((await runner.verifyEvidenceManifest(capture.runId, capture.manifest.sha256)).status, "intact");
  await assert.rejects(stat(join(runner.evidenceDir, capture.runId, "recording-tmp")), { code: "ENOENT" });
  const recordingPath = join(runner.evidenceDir, capture.runId, "artifacts", "recording.webm");
  if (footageRetained) {
    const bytes = (await stat(recordingPath)).size;
    assert.ok(bytes > 0 && bytes <= capture.recording.budget.maxBytes);
    assert.equal(capture.recording.artifact, `${capture.runId}/artifacts/recording.webm`);
  } else await assert.rejects(stat(recordingPath), { code: "ENOENT" });
  const markup = await readFile(capture.report, "utf8");
  assert.ok(markup.includes(`Recording stopped: ${reason}`));
  assert.equal(markup.includes("<video"), footageRetained);
  if (footageRetained) assert.ok(markup.includes("Partial footage only"));
  return capture;
}

async function verifyPlayback(report, name) {
  playbackBrowser ??= await chromium.launch({ executablePath, headless: true });
  const page = await playbackBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(pathToFileURL(report).href);
    const video = page.locator("video").first();
    assert.equal(await video.count(), 1);
    await video.evaluate(async (element) => { element.muted = true; await element.play(); });
    await page.waitForFunction(() => {
      const element = document.querySelector("video");
      return element && element.currentTime > 0.1 && element.videoWidth > 0 && Number.isFinite(element.duration);
    });
    await video.evaluate((element) => element.pause());
    await video.scrollIntoViewIfNeeded();
    if (keepArtifacts) {
      await mkdir(join(workspaceRoot, "review"), { recursive: true });
      await page.screenshot({ path: join(workspaceRoot, "review", `${name}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await video.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(workspaceRoot, "review", `${name}-mobile.png`) });
    }
    return await video.evaluate((element) => ({ duration: element.duration, width: element.videoWidth, height: element.videoHeight }));
  } finally { await page.close(); }
}

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Recording budget fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const results = [];
  const idle = runnerFor(baseUrl, { sessions: { recordVideo: true, recordNetwork: false, videoBudget: { maxDurationMs: 8000 }, persistence: "encrypted", keyEnv: keyName } });
  const first = await idle.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Ready" } });
  assert.ok(first.sessionId);
  const statePath = join(workspaceRoot, ".proofkit", "sessions", `${first.sessionId}.state.json`);
  assert.ok((await stat(statePath)).isFile());
  const mission = await idle.createMission({ intent: "Verify visible ready state", surface: "web", sessionId: first.sessionId, charter: charter() });
  await idle.startMission(mission.missionId, { approve: true }); await idle.waitMission(mission.missionId);
  const before = await idle.missionEvidence(mission.missionId);
  assert.equal(before.testVerdict, "passed");
  await until(() => Date.now() - Date.parse(idle.listSurfaceSessions().sessions.find((item) => item.sessionId === first.sessionId).createdAt) >= 5000,
    "The concurrent session must start later than the first recording");
  const survivor = await idle.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Ready" } });
  assert.ok(survivor.sessionId);
  const idleCapture = await verifyCapture(idle, first.sessionId, "duration-limit");
  await until(async () => !existsSync(statePath), "A stopped owned browser must discard recoverable credential state");
  const after = await idle.missionEvidence(mission.missionId);
  assert.equal(after.testVerdict, before.testVerdict);
  assert.equal(after.summary.sessionCaptures?.segments[0]?.integrity, "intact");
  assert.equal(after.summary.sessionCaptures?.segments[0]?.capture?.status, "partial");
  assert.ok((await readFile(after.report, "utf8")).includes("Recording stopped: duration-limit"));
  await assert.rejects(idle.interactSurface({ adapter: "web", sessionId: first.sessionId, action: { kind: "waitForText", text: "Ready" } }));
  const survivingCall = await idle.interactSurface({ adapter: "web", sessionId: survivor.sessionId, action: { kind: "waitForText", text: "Ready" } });
  assert.equal(survivingCall.status, "observed");
  assert.equal(survivingCall.sessionId, survivor.sessionId);
  await idle.closeSurfaceSession(survivor.sessionId);
  assert.equal((await idle.closeSurfaceSession(first.sessionId)).networkCapture?.runId, idleCapture.runId);
  const idlePlayback = await verifyPlayback(after.report, "idle-session-mission");
  const partialVideoPath = join(idle.evidenceDir, idleCapture.recording.artifact);
  const originalVideo = await readFile(partialVideoPath);
  try {
    await writeFile(partialVideoPath, "changed partial recording");
    const changed = await idle.missionEvidence(mission.missionId);
    assert.notEqual(changed.summary.sessionCaptures?.segments[0]?.integrity, "intact");
    assert.equal(changed.summary.sessionCaptures?.segments[0]?.evidence.length, 0);
    assert.equal((await readFile(changed.report, "utf8")).includes("<video"), false);
    assert.equal(changed.testVerdict, before.testVerdict);
  } finally { await writeFile(partialVideoPath, originalVideo); }
  const restoredPartial = await idle.missionEvidence(mission.missionId);
  assert.equal(restoredPartial.summary.sessionCaptures?.segments[0]?.integrity, "intact");
  assert.equal(restoredPartial.summary.sessionCaptures?.segments[0]?.capture?.recording?.status, "partial");
  results.push({ mode: "idle-session", reason: "duration-limit", capture: "partial", manifest: "intact", credentialsRemoved: true, concurrentSessionUnaffected: true, completedMissionVerdictPreserved: true,
    partialVideoPlays: true, tamperedPartialWithdrawsPlayback: true, ...idlePlayback,
    ...(keepArtifacts ? { report: after.report } : {}) });

  const active = runnerFor(baseUrl, { sessions: { recordVideo: true, recordNetwork: false, videoBudget: { maxDurationMs: 4000 } } });
  const opened = await active.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Ready" } });
  const interrupted = await active.createMission({ intent: "Verify visible ready state", surface: "web", sessionId: opened.sessionId, charter: charter(true) });
  await active.startMission(interrupted.missionId, { approve: true }); await active.waitMission(interrupted.missionId);
  const interruptedEvidence = await active.missionEvidence(interrupted.missionId);
  assert.equal(interruptedEvidence.testVerdict, "inconclusive");
  assert.equal(interruptedEvidence.summary.confirmedProductFindings, 0);
  await verifyCapture(active, opened.sessionId, "duration-limit", interrupted.sessionContext.captureRunId);
  const finalInterrupted = await active.missionEvidence(interrupted.missionId);
  assert.equal(finalInterrupted.summary.sessionCaptures?.segments[0]?.integrity, "intact");
  assert.equal(finalInterrupted.summary.sessionCaptures?.segments[0]?.capture?.recording?.stopReason, "duration-limit");
  const activePlayback = await verifyPlayback(finalInterrupted.report, "interrupted-session-mission");
  results.push({ mode: "active-session-mission", reason: "duration-limit", verdict: "inconclusive", noFalseProductFinding: true,
    partialVideoPlays: true, ...activePlayback, ...(keepArtifacts ? { report: finalInterrupted.report } : {}) });

  const diskSession = runnerFor(baseUrl, { sessions: { recordVideo: true, recordNetwork: false, videoBudget: { maxDurationMs: 12_000, maxBytes: 1024 * 1024 } } });
  const diskOpened = await diskSession.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Ready" } });
  assert.ok(diskOpened.sessionId);
  const diskCaptureId = diskSession.listSurfaceSessions().sessions.find((item) => item.sessionId === diskOpened.sessionId).networkCapture.runId;
  await diskSession.interactSurface({ adapter: "web", sessionId: diskOpened.sessionId, action: { kind: "goto", url: `${baseUrl}/noise` } });
  const diskCapture = await verifyCapture(diskSession, diskOpened.sessionId, "size-limit", diskCaptureId);
  results.push({ mode: "retained-session-disk", reason: "size-limit", capture: "partial", manifest: "intact", temporaryRecordingsRemoved: true,
    ...(keepArtifacts ? { report: diskCapture.report } : {}) });

  for (const [name, url, budget, reason] of [
    ["ordinary-run-duration", baseUrl, { maxDurationMs: 1500 }, "duration-limit"],
    ["ordinary-run-disk", `${baseUrl}/noise`, { maxDurationMs: 12_000, maxBytes: 1024 * 1024 }, "size-limit"],
  ]) {
    const runner = runnerFor(url, { run: { timeoutMs: 15_000, recordVideo: true, videoBudget: budget } });
    const started = await runner.start({ adapter: "web", headful, start: false, charter: charter(true) });
    const summary = await runner.wait(started.runId);
    assert.equal(summary.recording?.stopReason, reason, JSON.stringify(summary, null, 2));
    const footageRetained = reason === "duration-limit";
    assert.equal(summary.recording.status, footageRetained ? "partial" : "unavailable");
    assert.equal(summary.verdict, "inconclusive");
    await assert.rejects(stat(join(runner.evidenceDir, summary.runId, "recording-tmp")), { code: "ENOENT" });
    const manifest = await runner.evidenceManifest(summary.runId);
    assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    const report = join(runner.evidenceDir, summary.runId, "report.html");
    const markup = await readFile(report, "utf8");
    assert.ok(markup.includes(`Recording stopped: ${reason}`));
    assert.equal(markup.includes("<video"), footageRetained);
    const playback = footageRetained ? await verifyPlayback(report, name) : undefined;
    results.push({ mode: name, reason, verdict: summary.verdict, manifest: "intact", temporaryRecordingsRemoved: true,
      partialVideoPlays: footageRetained, ...(playback ?? {}), ...(keepArtifacts ? { report } : {}) });
  }
  console.log(JSON.stringify({ status: "passed", actualBrowserRecording: true, cases: results, ...(keepArtifacts ? { workspaceRoot, projectRoot } : {}) }, null, 2));
} finally {
  await Promise.all(runners.map((runner) => runner.closeAllSurfaceSessions()));
  await playbackBrowser?.close();
  server.closeAllConnections(); await new Promise((resolveServer) => server.close(resolveServer));
  if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey;
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
