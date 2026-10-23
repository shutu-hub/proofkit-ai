import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { verifyMissionArchive } from "../packages/evidence/dist/index.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const liveRoot = resolve((await readFile(join(repository, "outputs/toolshop-current-checkout-root.txt"), "utf8")).trim());
const live = JSON.parse(await readFile(join(liveRoot, "current-checkout-result.json"), "utf8"));
const sample = live.samples[0]; assert.equal(sample.status, "passed");
const mission = sample.finalMissions.find((item) => item.missionId === sample.formalMissionId); assert.ok(mission);
const source = resolve(sample.workspace); const held = resolve(liveRoot, "sample-1-held-" + randomUUID());
function within(root, target) { const child = relative(root, target); return child !== "" && child !== ".." && !child.startsWith("..\\") && !child.startsWith("../") && !isAbsolute(child); }
assert.ok(within(liveRoot, source) && within(liveRoot, held));
assert.equal(relative(liveRoot, source), "sample-1");
const stagingParent = join(repository, "outputs/archive-staging"); const deliveryParent = join(repository, "outputs/deliveries");
await mkdir(stagingParent, { recursive: true }); await mkdir(deliveryParent, { recursive: true });
const name = mission.missionId + "-" + randomUUID().slice(0, 8); const staging = resolve(stagingParent, name); const delivered = resolve(deliveryParent, name);
assert.ok(within(stagingParent, staging) && within(deliveryParent, delivered));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const summaryPath = join(source, ".proofkit/missions", mission.missionId, "summary.json"); const originalSummary = await readFile(summaryPath);
const savedResult = JSON.parse(originalSummary.toString("utf8"));
const sourceReport = await readFile(mission.report);
const runtimeFiles = ["packages/evidence/dist/mission-archive.js", "packages/evidence/dist/manifest.js", "packages/contracts/dist/index.js", "bundle/main.js", "tests/mission-archive-live-smoke.mjs"];
const build = Object.fromEntries(await Promise.all(runtimeFiles.map(async (path) => [path, hash(await readFile(join(repository, path)))])));
const exported = JSON.parse(execFileSync(process.execPath, [join(repository, "bundle/main.js"), "mission", "export", mission.missionId, "--root", live.root + "/reviewed-target",
  "--workspace", source, "--out", staging, "--summary-sha256", hash(originalSummary)], { encoding: "utf8" }));
assert.equal(exported.testVerdict, "not-asserted"); assert.equal(exported.savedTestVerdict, "passed");
assert.equal(exported.savedScope.acceptance, "declared"); assert.equal(exported.savedScope.workflowCoverage, "unmeasured");
assert.equal(exported.savedScope.omittedContextRuns, savedResult.sessionContext.omittedRuns);
assert.equal(exported.savedScope.sessionCaptures[0].status, "partial");
const descriptor = JSON.parse(await readFile(join(staging, "archive.json"), "utf8"));
await rename(staging, delivered);
let sourceHidden = false, browser;
const verification = { checkedAt: new Date().toISOString(), stageVerified: false, goalComplete: false, source, missionId: mission.missionId,
  executionRunId: mission.summary.runId, savedExecutionBuildNote: "Saved checkout execution precedes this archive implementation; no new application execution is claimed",
  exporterBuild: build, exported: { ...exported, directory: delivered, index: join(delivered, "index.html") }, descriptorRuns: descriptor.runs.length, descriptorFiles: descriptor.files.length };
try {
  await rename(source, held); sourceHidden = true; await assert.rejects(lstat(source), { code: "ENOENT" }); verification.originalSourceAbsent = true;
  verification.api = await verifyMissionArchive(delivered, exported.archiveSha256); assert.equal(verification.api.status, "intact");
  verification.cli = JSON.parse(execFileSync(process.execPath, [join(repository, "bundle/main.js"), "verify-archive", delivered, "--archive-sha256", exported.archiveSha256], { encoding: "utf8" }));
  assert.equal(verification.cli.status, "intact"); assert.equal(verification.cli.testVerdict, "not-asserted");
  assert.deepEqual(verification.cli.savedScope, exported.savedScope);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, offline: true }); const requests = [];
  context.on("request", (request) => requests.push(request.url()));
  await context.route(/^https?:\/\//, (route) => route.abort()); const page = await context.newPage();
  const ownedUrl = (value) => { const url = new URL(value); assert.equal(url.protocol, "file:"); assert.ok(within(delivered, fileURLToPath(url))); return value; };
  await page.goto(pathToFileURL(join(delivered, "index.html")).href); await page.getByRole("link", { name: "Open original Mission report" }).click();
  ownedUrl(page.url()); const links = await page.locator('.workflow-card a[href*="#step-"]').evaluateAll((links) => links.map((link) => link.href));
  assert.equal(links.length, 34); for (const url of links) ownedUrl(url);
  await page.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } });
  verification.mission = { actionLinks: links.length, images: await page.locator("img").count() };
  const video = page.locator("video").first(); ownedUrl(await video.evaluate((video) => video.src));
  const captureRunId = sample.closed.networkCapture.runId;
  const captureSummary = JSON.parse(await readFile(join(delivered, ".proofkit/runs", captureRunId, "run.json"), "utf8"));
  const start = (Date.parse(mission.summary.startedAt) - Date.parse(captureSummary.startedAt)) / 1000;
  const end = (Date.parse(mission.summary.endedAt) - Date.parse(captureSummary.startedAt)) / 1000;
  await video.evaluate(async (video) => { video.muted = true; await video.play(); }); await page.waitForFunction(() => document.querySelector("video").currentTime > 0.1);
  const duration = await video.evaluate((video) => { video.pause(); return video.duration; }); assert.ok(Number.isFinite(duration) && duration >= end);
  await video.evaluate(async (video, start) => { video.currentTime = Math.max(0, start - 2); await video.play(); }, start);
  await page.waitForFunction((end) => { const video = document.querySelector("video"); return !video.seeking && video.currentTime > end; }, end);
  verification.playback = await video.evaluate((video) => { video.pause(); return { duration: video.duration, currentTime: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames, error: video.error?.message ?? null }; });
  assert.equal(verification.playback.error, null); assert.ok(verification.playback.frames > 0); verification.playback.formalStart = start; verification.playback.formalEnd = end;
  await video.screenshot({ path: join(repository, "outputs/mission-archive-video-frame.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => scrollTo(0, 0));
  verification.mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.equal(verification.mobile.width, verification.mobile.scrollWidth);
  await page.screenshot({ path: join(repository, "outputs/mission-archive-mobile.png"), fullPage: false });
  await page.goto(links.find((url) => url.endsWith("#step-033"))); assert.equal(await page.locator("#step-033").count(), 1);
  await page.locator("details").evaluateAll((details) => { for (const item of details) item.open = true; });
  await page.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } });
  const invoice = mission.summary.steps.find((step) => step.response?.name === "invoice-created").response;
  const request = await page.locator("#step-033 code").evaluateAll((elements) => elements.map((element) => { try { return JSON.parse(element.textContent); } catch { return null; } }).find((item) => item?.cartId));
  assert.deepEqual(request, invoice.requestFields); assert.equal(await page.locator("img").count(), 34);
  verification.run = { screenshots: 34, invoiceActionResolved: true, selectedRequestFields: Object.keys(request).length, invoiceNumber: invoice.fields.invoiceNumber };
  const pngs = descriptor.files.filter((file) => file.path.endsWith(".png")); const decoded = [];
  await page.goto(links[0].split("#")[0]);
  for (let offset = 0; offset < pngs.length; offset += 8) {
    const urls = pngs.slice(offset, offset + 8).map((file) => ownedUrl(pathToFileURL(join(delivered, file.path)).href));
    decoded.push(...await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; })), urls));
  }
  assert.ok(decoded.length >= 34 && decoded.every((image) => image.width > 0 && image.height > 0)); verification.allArchivedPngsDecoded = decoded.length;
  for (const request of requests.filter((url) => url.startsWith("file:"))) ownedUrl(request);
  assert.equal(requests.filter((url) => /^https?:/.test(url)).length, 0); verification.externalHttpRequests = 0;
  const factPath = join(delivered, ".proofkit/runs", mission.summary.oracles[0].sourceEvidenceArtifacts[0]); const originalFacts = await readFile(factPath);
  try { await writeFile(factPath, "changed archived business facts"); verification.tampered = await verifyMissionArchive(delivered, exported.archiveSha256); assert.equal(verification.tampered.status, "changed"); }
  finally { await writeFile(factPath, originalFacts); }
  verification.restored = await verifyMissionArchive(delivered, exported.archiveSha256); assert.equal(verification.restored.status, "intact");
  verification.sessionNetwork = savedResult.sessionCaptures.segments[0].capture.status; assert.equal(verification.sessionNetwork, "partial");
} finally {
  await browser?.close(); if (sourceHidden) { assert.ok(within(liveRoot, held) && within(liveRoot, source)); await rename(held, source); }
}
assert.equal(hash(await readFile(summaryPath)), hash(originalSummary)); assert.equal(hash(await readFile(mission.report)), hash(sourceReport));
verification.sourceRestoredUnchanged = true;
verification.exporterBuildUnchanged = (await Promise.all(Object.entries(build).map(async ([path, digest]) => hash(await readFile(join(repository, path))) === digest))).every(Boolean);
assert.equal(verification.exporterBuildUnchanged, true); verification.stageVerified = true;
await writeFile(join(repository, "outputs/mission-archive-validation.json"), JSON.stringify(verification, null, 2) + "\n");
console.log(JSON.stringify({ stageVerified: true, directory: delivered, archiveSha256: exported.archiveSha256, runs: exported.runs, files: exported.files,
  originalSourceAbsent: verification.originalSourceAbsent, actionLinks: verification.mission.actionLinks, screenshotsDecoded: verification.allArchivedPngsDecoded, playback: verification.playback }));
