import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-session-video-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-session-video-project-"));
const keepArtifacts = process.argv.includes("--keep-artifacts");
const headful = process.argv.includes("--headful");
const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32"
  && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const runners = [];
let clip = Buffer.alloc(0);
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/clip.webm") {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
    if (start > end) { response.writeHead(416); response.end(); return; }
    response.writeHead(range ? 206 : 200, { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": end - start + 1,
      ...(range ? { "content-range": `bytes ${start}-${end}/${clip.length}` } : {}) });
    response.end(clip.subarray(start, end + 1)); return;
  }
  if (path === "/playback") { response.writeHead(200, { "content-type": "text/html" }); response.end('<video preload="auto" src="/clip.webm"></video>'); return; }
  if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<style>body{background:rgb(30,50,180);font:24px sans-serif}</style><h1 id="state">Ready</h1><button id="red">Red stage</button><button id="green">Green stage</button><script>
    let redObserved = false;
    document.querySelector('#red').onclick = () => { redObserved = true; document.body.style.background = 'rgb(220,30,30)'; document.querySelector('#state').textContent = 'Red stage'; };
    document.querySelector('#green').onclick = () => { document.body.style.background = 'rgb(30,180,80)'; document.querySelector('#state').textContent = redObserved ? 'Green after red' : 'Green without red'; };
  </script>`);
});

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Session video fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const results = [];
  for (const networkEnabled of [true, false]) {
    const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot },
      surfaces: { web: { baseUrl, ...(executablePath ? { executablePath } : {}) } }, policies: { sideEffects: "allow" },
      sessions: { recordVideo: true, recordNetwork: networkEnabled } }) }); runners.push(runner);
    const first = await runner.interactSurface({ adapter: "web", headful, keepSession: true, action: { kind: "waitForText", text: "Ready" } });
    assert.ok(first.sessionId);
    assert.equal(runner.listSurfaceSessions().sessions[0]?.networkCapture?.recording?.status, "recording");
    const red = await runner.interactSurface({ adapter: "web", sessionId: first.sessionId, action: { kind: "click", selector: "#red" } });
    assert.match(red.snapshot?.text ?? "", /Red stage/);
    const green = await runner.interactSurface({ adapter: "web", sessionId: first.sessionId, action: { kind: "click", selector: "#green" } });
    assert.match(green.snapshot?.text ?? "", /Green after red/);
    const mission = await runner.createMission({ intent: "Verify retained green stage", surface: "web", sessionId: first.sessionId,
      charter: { intent: "Verify retained green stage", level: "quick", mode: "deterministic", actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Green after red" }], sideEffectPolicy: "deny", metadata: {} } });
    await runner.startMission(mission.missionId, { approve: true });
    let missionStatus = await runner.missionStatus(mission.missionId);
    for (let attempt = 0; attempt < 150 && missionStatus.running; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      missionStatus = await runner.missionStatus(mission.missionId);
    }
    assert.equal(missionStatus.mission.verdict, "passed");
    const beforeClose = await runner.missionEvidence(mission.missionId);
    assert.equal(beforeClose.summary.sessionCaptures?.segments[0]?.integrity, "not-sealed");
    assert.ok(!(await readFile(beforeClose.report, "utf8")).includes("<video"));
    const closed = await runner.closeSurfaceSession(first.sessionId);
    const capture = closed.networkCapture;
    assert.equal(capture?.status, "sealed", JSON.stringify(closed));
    assert.equal(capture.networkEnabled, networkEnabled);
    assert.equal(capture.recording?.status, "recorded");
    if (!networkEnabled) assert.equal(capture.events, 0);
    const summary = await runner.wait(capture.runId);
    assert.equal(summary.verdict, "inconclusive");
    assert.equal(summary.execution?.sessionId, first.sessionId);
    assert.equal(summary.recording?.status, "recorded");
    clip = await readFile(join(runner.evidenceDir, capture.recording.artifact));
    assert.ok(clip.length > 1000);
    assert.equal((await runner.verifyEvidenceManifest(capture.runId, capture.manifest.sha256)).status, "intact");
    assert.ok((await readFile(capture.report, "utf8")).includes('src="artifacts/recording.webm"'));
    const manifest = JSON.parse(await readFile(capture.manifest.path, "utf8"));
    assert.ok(manifest.files.some((file) => file.path.endsWith("/artifacts/recording.webm")));
    assert.ok(!manifest.files.some((file) => file.path.includes("/recording-tmp/")));
    const presented = await runner.missionEvidence(mission.missionId);
    assert.equal(presented.summary.sessionCaptures?.segments[0]?.integrity, "intact");
    assert.equal(presented.testVerdict, beforeClose.testVerdict);
    assert.ok((await readFile(presented.report, "utf8")).includes(`<video controls preload="metadata"`));
    const missionRun = presented.summary.runs.find((run) => run.runId);
    assert.equal((await runner.wait(missionRun.runId)).execution?.sessionCaptureRunId, capture.runId);
    const childCode = `
      const [runnerModule, contractsModule, projectRoot, workspaceRoot, missionId] = process.argv.slice(1);
      const { LocalRunnerService } = await import(runnerModule);
      const { ProofkitConfigSchema } = await import(contractsModule);
      const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config: ProofkitConfigSchema.parse({ project: { root: projectRoot } }) });
      const presented = await runner.missionEvidence(missionId);
      process.stdout.write(JSON.stringify({ captures: presented.summary.sessionCaptures, testVerdict: presented.testVerdict }));
    `;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", childCode,
      new URL("../packages/local-runner/dist/index.js", import.meta.url).href, new URL("../packages/contracts/dist/index.js", import.meta.url).href,
      projectRoot, workspaceRoot, mission.missionId], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(child.stdout).captures, presented.summary.sessionCaptures);
    assert.equal(JSON.parse(child.stdout).testVerdict, presented.testVerdict);
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(capture.report).href);
      await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && video.duration > 0 && Number.isFinite(video.duration); }, undefined, { timeout: 10_000 });
      await page.locator("video").evaluate(async (video) => { video.muted = true; await video.play(); });
      await page.waitForFunction(() => document.querySelector("video")?.ended, undefined, { timeout: 15_000 });
      await page.goto(pathToFileURL(presented.report).href);
      await page.waitForFunction(() => { const video = document.querySelector("#session-evidence video"); return video && video.readyState >= 2 && video.duration > 0 && Number.isFinite(video.duration); }, undefined, { timeout: 10_000 });
      await page.locator("#session-evidence video").evaluate(async (video) => { video.muted = true; await video.play(); });
      await page.waitForFunction(() => document.querySelector("#session-evidence video")?.ended, undefined, { timeout: 15_000 });
      if (keepArtifacts) await page.locator("#session-evidence").screenshot({ path: join(workspaceRoot, `mission-session-evidence-${networkEnabled}.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "Mission report must fit a narrow viewport");
      if (keepArtifacts) await page.locator("#session-evidence").screenshot({ path: join(workspaceRoot, `mission-session-evidence-mobile-${networkEnabled}.png`) });
      await page.goto(`${baseUrl}/playback`);
      await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && Number.isFinite(video.duration); }, undefined, { timeout: 10_000 });
      const decoded = await page.locator("video").evaluate(async (video) => {
        const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Video sampling canvas unavailable");
        const colors = [];
        const samples = Math.min(200, Math.max(80, Math.ceil(video.duration / 0.04)));
        for (let index = 0; index < samples; index++) {
          const time = video.duration * index / samples;
          if (Math.abs(video.currentTime - time) > 0.002) {
            await new Promise((done, fail) => {
              const timer = setTimeout(() => { video.removeEventListener("seeked", onSeek); fail(new Error("Video frame seek timed out")); }, 2_000);
              const onSeek = () => { clearTimeout(timer); done(); };
              video.addEventListener("seeked", onSeek, { once: true });
              video.currentTime = time;
            });
          }
          context.drawImage(video, 0, 0);
          colors.push([...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3));
        }
        return { duration: video.duration, width: video.videoWidth, height: video.videoHeight,
          redObserved: colors.some((pixel) => pixel[0] > 150 && pixel[1] < 90 && pixel[2] < 90),
          greenObserved: colors.some((pixel) => pixel[0] < 90 && pixel[1] > 120 && pixel[2] < 130) };
      });
      assert.ok(decoded.redObserved && decoded.greenObserved, `One continuous clip must contain both separately executed stages: ${JSON.stringify(decoded)}`);
      const videoPath = join(runner.evidenceDir, capture.recording.artifact);
      await writeFile(videoPath, "deliberately changed video");
      const changed = await runner.missionEvidence(mission.missionId);
      assert.equal(changed.summary.sessionCaptures?.segments[0]?.integrity, "changed");
      assert.ok(!(await readFile(changed.report, "utf8")).includes("<video"));
      assert.equal(changed.testVerdict, presented.testVerdict);
      await writeFile(videoPath, clip);
      const restored = await runner.missionEvidence(mission.missionId);
      assert.equal(restored.summary.sessionCaptures?.segments[0]?.integrity, "intact");
      results.push({ networkEnabled, ...decoded, manifest: "intact", missionInlinePlayback: true, separateProcessRecovery: true, tamperWithdrawsPlayback: true,
        ...(keepArtifacts ? { report: capture.report, missionReport: presented.report } : {}) });
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ status: "passed", continuousAcrossCalls: true, noProductVerdict: true, cases: results,
    ...(keepArtifacts ? { workspaceRoot, projectRoot } : {}) }, null, 2));
} finally {
  await Promise.all(runners.map((runner) => runner.closeAllSurfaceSessions()));
  server.closeAllConnections();
  await new Promise((resolveServer) => server.close(resolveServer));
  if (!keepArtifacts) await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
