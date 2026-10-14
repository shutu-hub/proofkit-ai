import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";
import { TestCharterSchema } from "../packages/contracts/dist/index.js";
import { readDatasetLock, repoRoot, verifyDataset } from "../scripts/fetch-benchmark-datasets.mjs";
import { buildTaskActions, classifyEpisode } from "./datasets/miniwob-cases.mjs";

const { values } = parseArgs({ options: { tasks: { type: "string" }, seeds: { type: "string", default: "0,42,123" } } });
const dataset = (await readDatasetLock()).datasets.miniwob;
const tasks = values.tasks ? values.tasks.split(",") : dataset.taskIds;
const seeds = values.seeds.split(",").map(Number);
assert.ok(tasks.length > 0 && tasks.every((task) => dataset.taskIds.includes(task)), "Unknown MiniWoB task");
assert.equal(new Set(tasks).size, tasks.length, "Duplicate tasks");
assert.ok(seeds.length > 0 && seeds.length <= 20 && seeds.every((seed) => Number.isSafeInteger(seed) && seed >= 0), "Seeds must be 1-20 nonnegative integers");
assert.equal(new Set(seeds).size, seeds.length, "Duplicate seeds");
const directory = await verifyDataset("miniwob", dataset);
const assets = new Map();
for (const file of dataset.files) {
  if (file.path.startsWith("miniwob/html/")) assets.set(`/${file.path.slice("miniwob/html/".length)}`, await readFile(join(directory, file.path)));
}
const mime = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css", png: "image/png" };
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const bytes = assets.get(path);
  response.writeHead(bytes ? 200 : 404, { "content-type": mime[path.split(".").at(-1)] ?? "application/octet-stream" });
  response.end(bytes ?? "Not found");
});

// Environment reset occurs before Runner execution. The idempotent connection
// preserves this fresh seeded episode when the Runner connects to the adapter.
class EpisodeAdapter extends WebAdapter {
  async connect() { if (!this.activePage) await super.connect(); }
  currentPage() { return this.page(); }
}

const outputDir = join(repoRoot, ".proofkit", "benchmarks", `miniwob-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
await mkdir(outputDir, { recursive: true });
const report = { benchmark: "miniwob-proofkit-regression", driver: "scripted-visible-instruction",
  scope: "WebAdapter/ExecutionRunner compatibility and verdict regression; not a model score or full MiniWoB score",
  dataset: { repository: dataset.repository, revision: dataset.revision, license: dataset.license },
  tasks, seeds, cases: [], total: tasks.length * seeds.length * 3, passed: 0, falsePasses: 0, complete: false };
let adapter;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const task of tasks) {
    for (const seed of seeds) {
      for (const variant of ["correct", "incorrect", "unfinished"]) {
        const row = { task, seed, variant, expectedVerdict: variant === "correct" ? "passed" : variant === "incorrect" ? "failed" : "inconclusive", passed: false };
        try {
          adapter = new EpisodeAdapter({ baseUrl: `${baseUrl}/miniwob/${task}.html`, executablePath: process.env.PROOFKIT_BROWSER_PATH
            ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined), headless: true });
          await adapter.connect();
          const page = adapter.currentPage();
          page.setDefaultTimeout(3_000);
          // All assets are local; deny unexpected remote requests in task code.
          await page.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
          await page.evaluate((seed) => Math.seedrandom(String(seed)), seed);
          await adapter.act({ kind: "click", selector: "#sync-task-cover" });
          const observation = { query: await page.locator("#query").innerText(), choices: await page.locator("#boxes label").evaluateAll((nodes) =>
            nodes.map((node) => ({ id: node.querySelector("input").id, text: node.textContent.trim() }))) };
          const initialState = await readEpisode(page);
          assert.equal(initialState.done, false);
          assert.equal(initialState.episodeId, 0);
          let finalState;
          const oracle = { name: "miniwob-exact-completion", async check() {
            finalState = await readEpisode(page);
            return { name: this.name, passed: classifyEpisode(finalState),
              // Same-page benchmark state is a task contract, not independent
              // backend proof sufficient for a core business acceptance claim.
              verificationKind: "http-contract", message: "Upstream episode must finish once with raw reward exactly 1",
              evidence: [JSON.stringify({ datasetRevision: dataset.revision, task, seed, runState: finalState })], observedAt: new Date().toISOString() };
          } };
          const charter = TestCharterSchema.parse({ intent: observation.query, level: "quick", mode: "deterministic", sideEffectPolicy: "allow",
            actions: buildTaskActions(task, observation, variant), assertions: [{ kind: "text-visible", text: "Last reward:" }], oracles: [oracle.name],
            metadata: { benchmark: "miniwob", task, seed, variant, datasetRevision: dataset.revision,
              initialization: { url: `${baseUrl}/miniwob/${task}.html`, seed: String(seed), action: "click START", initialState, observation } } });
          const summary = await new ExecutionRunner(adapter, { evidenceDir: join(outputDir, "runs"), oracles: [oracle], timeoutMs: 15_000 }).run(charter);
          row.runId = summary.runId;
          row.verdict = summary.verdict;
          row.finalState = finalState;
          row.evidence = summary.oracles[0]?.sourceEvidenceArtifacts ?? [];
          const recorded = summary.oracles[0];
          assert.equal(summary.verdict, row.expectedVerdict, JSON.stringify(summary));
          assert.equal(summary.steps.length, charter.actions.length);
          assert.ok(summary.steps.every((step) => step.status === "passed"), "Action failure cannot stand in for task rejection");
          assert.ok(summary.assertions.every((result) => result.passed === true));
          assert.ok(recorded && recorded.sourceEvidenceCount > 0 && recorded.sourceEvidenceArtifacts.length > 0, "Missing upstream state evidence");
          const proof = JSON.parse(await readFile(join(outputDir, "runs", recorded.sourceEvidenceArtifacts[0]), "utf8"));
          assert.deepEqual(proof.facts[0].runState, finalState);
          assert.equal(proof.facts[0].task, task);
          assert.equal(proof.facts[0].seed, seed);
          if (variant !== "unfinished") {
            assert.equal(finalState.done, true);
            assert.equal(finalState.episodeId, 1);
            assert.notEqual(finalState.reason, "timed out", "A timeout cannot stand in for an incorrect submission");
          } else {
            assert.equal(finalState.done, false);
            assert.equal(finalState.episodeId, 0);
            assert.equal(recorded.passed, null);
          }
          row.passed = true;
        } catch (error) {
          row.error = error.message;
        } finally {
          await adapter?.close().catch(() => {});
          adapter = undefined;
        }
        report.cases.push(row);
        report.passed += Number(row.passed);
        report.falsePasses += Number(variant !== "correct" && row.verdict === "passed");
        await saveReport();
        console.log(`${task} seed=${seed} ${variant}: ${row.verdict ?? "setup-error"} (${row.passed ? "OK" : "FAIL"})`);
      }
    }
  }
  report.complete = true;
} finally {
  await adapter?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await saveReport();
}
console.log(JSON.stringify({ total: report.total, passed: report.passed, falsePasses: report.falsePasses,
  complete: report.complete, reportPath: join(outputDir, "report.json") }, null, 2));
if (!report.complete || report.passed !== report.total) process.exitCode = 1;

async function readEpisode(page) {
  return page.evaluate(() => ({ done: WOB_DONE_GLOBAL, episodeId: WOB_EPISODE_ID,
    rawReward: WOB_RAW_REWARD_GLOBAL, reward: WOB_REWARD_GLOBAL, reason: WOB_REWARD_REASON ?? null }));
}
async function saveReport() { await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n"); }
