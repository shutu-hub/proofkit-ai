import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { MissionReportStore } from "../packages/evidence/dist/mission-report.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = (await readFile(join(repository, "outputs/notes-host-root.txt"), "utf8")).trim();
const workspace = join(root, "attempt-6/workspace");
const sourceMissionId = "mission-2f36ec22-e6e";
const sourcePath = join(workspace, ".proofkit/missions", sourceMissionId, "summary.json");
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes.toString("utf8"));
assert.equal(source.testVerdict, "failed");
const originalRunPaths = source.runs.flatMap((run) => run.evidence.map((ref) => ref.path));
const before = new Map(await Promise.all(originalRunPaths.map(async (path) => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
const rendered = await new MissionReportStore(workspace).writeReportSnapshot({ ...source,
  missionId: sourceMissionId + "-check-review", intent: "Saved evidence presentation review · " + source.intent });
assert.equal(rendered.result.testVerdict, source.testVerdict);
assert.deepEqual(rendered.result.checkOverview.counts, { passed: 2, failed: 1, inconclusive: 0, "not-recorded": 0, unverified: 0 });
assert.equal(rendered.result.checkOverview.items[0].status, "failed");
assert.equal(rendered.result.checkOverview.items.find((item) => item.kind === "business").status, "passed");
const browser = await chromium.launch({ headless: true, executablePath: process.env.PROOFKIT_BROWSER_PATH
  ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) });
const httpRequests = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("request", (request) => { if (/^https?:/.test(request.url())) httpRequests.push(request.url()); });
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(rendered.path).href);
  const overview = page.locator("#checks");
  assert.equal(await overview.locator("tbody tr").count(), 3);
  assert.equal(await overview.locator("tbody tr").first().getAttribute("data-check-status"), "failed");
  assert.ok((await overview.innerText()).includes("1/1 notes completed"));
  assert.ok((await overview.innerText()).includes("Independent business check"));
  assert.equal(await overview.getByRole("link", { name: "Saved result", exact: true }).count(), 3);
  assert.equal(await overview.getByRole("link", { name: "Run evidence", exact: true }).count(), 3);
  const observedSource = overview.getByRole("link", { name: "Observed source", exact: true });
  assert.equal(await observedSource.count(), 1);
  const observedPath = fileURLToPath(new URL(await observedSource.getAttribute("href"), pathToFileURL(rendered.path)));
  const observedFacts = JSON.parse(await readFile(observedPath, "utf8"));
  assert.equal(observedFacts.facts[0].passed, true); assert.equal(observedFacts.facts[0].isolated, true);
  const desktop = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overviewBeforeActions: document.querySelector("#checks").compareDocumentPosition(document.querySelector("#workflow-detail")) === Node.DOCUMENT_POSITION_FOLLOWING }));
  assert.equal(desktop.width, desktop.scrollWidth); assert.equal(desktop.overviewBeforeActions, true);
  await page.screenshot({ path: join(repository, "outputs/check-overview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(mobile.width, mobile.scrollWidth);
  await page.screenshot({ path: join(repository, "outputs/check-overview-mobile.png") });
  const runHref = await overview.getByRole("link", { name: "Run evidence", exact: true }).first().getAttribute("href");
  await page.goto(new URL(runHref, pathToFileURL(rendered.path)).href);
  await page.locator("img").evaluateAll(async (images) => { for (const image of images) { image.loading = "eager"; await image.decode(); } });
  const decodedScreenshots = await page.locator("img").count(); assert.ok(decodedScreenshots > 0);
  assert.equal(httpRequests.length, 0);
  for (const [path, digest] of before) assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), digest);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  const receipt = { checkedAt: new Date().toISOString(), sourceMissionId,
    sourceSnapshotSha256: createHash("sha256").update(sourceBytes).digest("hex"), derivedPresentationId: rendered.result.missionId,
    report: rendered.path, originalSnapshotAndEvidenceUnchanged: true, originalVerdict: source.testVerdict,
    checkOverview: rendered.result.checkOverview, desktop, mobile, decodedScreenshots, httpRequests: httpRequests.length,
    limitation: "Read-only regeneration of historical failed evidence; no new application execution, no cleanup recovery, session footage still unsealed. Derived presentation id is not a new executed Mission." };
  await writeFile(join(repository, "outputs/check-overview-validation.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ report: receipt.report, counts: receipt.checkOverview.counts, desktop, mobile, decodedScreenshots, httpRequests: 0 }));
} finally { await browser.close(); }
