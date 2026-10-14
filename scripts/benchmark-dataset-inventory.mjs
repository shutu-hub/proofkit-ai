import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDatasetLock, repoRoot, verifyDataset } from "./fetch-benchmark-datasets.mjs";

const lock = await readDatasetLock();
const source = lock.datasets["webarena-verified"];
const directory = await verifyDataset("webarena-verified", source);
const tasks = JSON.parse(await readFile(join(directory, "assets/dataset/webarena-verified.json"), "utf8"));
const hard = JSON.parse(await readFile(join(directory, "assets/dataset/subsets/webarena-verified-hard.json"), "utf8"));
assert.equal(tasks.length, 812, "Unexpected full dataset count at locked revision");
assert.equal(hard.task_ids.length, 258, "Unexpected hard subset count at locked revision");
const ids = new Set(tasks.map((task) => task.task_id));
assert.equal(ids.size, tasks.length, "Duplicate task IDs");
assert.equal(new Set(hard.task_ids).size, hard.task_ids.length);
assert.ok(hard.task_ids.every((id) => ids.has(id)), "Hard subset references a missing task");
const report = { dataset: "webarena-verified", repository: source.repository, revision: source.revision, license: source.license,
  total: tasks.length, hardSubset: hard.task_ids.length, sites: {}, taskTypes: {}, evaluators: {}, execution: "not-run" };
for (const task of tasks) {
  assert.ok(Number.isSafeInteger(task.task_id) && task.task_id >= 0);
  assert.ok(typeof task.intent === "string" && task.intent.length > 0);
  assert.ok(Array.isArray(task.start_urls) && task.start_urls.length > 0);
  assert.ok(Array.isArray(task.sites) && task.sites.length > 0);
  assert.ok(Array.isArray(task.eval) && task.eval.length > 0);
  for (const site of task.sites) count(report.sites, site);
  const types = new Set();
  for (const evaluator of task.eval) {
    count(report.evaluators, evaluator.evaluator);
    if (evaluator.expected?.task_type) types.add(evaluator.expected.task_type);
  }
  for (const type of types) count(report.taskTypes, type);
}
const outputDir = join(repoRoot, ".proofkit", "benchmarks", `dataset-inventory-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
await mkdir(outputDir, { recursive: true });
// Prompt records contain no eval/reference-answer fields. Retain the original
// dataset separately so a future external evaluator can score real executions.
const prompts = tasks.map(({ task_id, intent_template_id, sites, start_urls, intent, revision }) =>
  ({ task_id, intent_template_id, sites, start_urls, intent, revision, datasetRevision: source.revision }));
const hardIds = new Set(hard.task_ids);
await writeFile(join(outputDir, "task-prompts.jsonl"), jsonl(prompts), { flag: "wx" });
await writeFile(join(outputDir, "hard-task-prompts.jsonl"), jsonl(prompts.filter((task) => hardIds.has(task.task_id))), { flag: "wx" });
await writeFile(join(outputDir, "inventory.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report, outputDir,
  nextStep: "Configure resettable local sites, capture per-task response/network traces, and use the official evaluator. Dataset inventory is not an execution result." }, null, 2));

function count(counts, key) { assert.ok(typeof key === "string" && /^[\w-]+$/.test(key)); counts[key] = (counts[key] ?? 0) + 1; }
function jsonl(records) { return records.map((record) => JSON.stringify(record)).join("\n") + "\n"; }
