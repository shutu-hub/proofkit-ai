import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkProfile, publicTask, renderScorecard, scorecard, selectTasks } from "../scripts/webarena-benchmark-lib.mjs";

test("single-site profiles have fixed denominators and preserve the cross-site pilot", () => {
  assert.deepEqual(benchmarkProfile("shopping-admin-4").taskIds, [0, 108, 157, 423]);
  assert.deepEqual(benchmarkProfile("shopping-admin-4").sites, ["shopping_admin"]);
  assert.deepEqual(benchmarkProfile("shopping-admin-12").taskIds,
    [0, 11, 77, 94, 108, 119, 374, 453, 470, 496, 501, 679]);
  assert.equal(benchmarkProfile("pilot-12").taskIds.length, 12);
  for (const name of ["pilot-12", "shopping-admin-4", "shopping-admin-12"]) {
    const profile = benchmarkProfile(name);
    const grouped = Object.values(profile.taskGroups).flat();
    assert.deepEqual([...grouped].sort((a, b) => a - b), [...profile.taskIds].sort((a, b) => a - b));
    assert.equal(new Set(grouped).size, grouped.length);
  }
  assert.throws(() => benchmarkProfile("unknown"), /Unknown WebArena/);
});

test("public agent inputs exclude answers, evaluator specs and unknown metadata", () => {
  const task = { task_id: 1, revision: 2, sites: ["gitlab"], intent: "Open todos", start_urls: ["__GITLAB__"],
    eval: [{ expected: { secret: "gold-answer" } }], futureAnswer: "gold-answer", instantiation_dict: { secret: "gold-answer" } };
  assert.deepEqual(publicTask(task), { taskId: 1, revision: 2, sites: ["gitlab"], intent: "Open todos", startUrls: ["__GITLAB__"] });
  assert.ok(!JSON.stringify(publicTask(task)).includes("gold-answer"));
});

test("selection refuses duplicate, unknown and missing task evaluators", () => {
  const dataset = [{ task_id: 1, intent: "Open todos", sites: ["gitlab"], start_urls: [], eval: [{}] }];
  assert.equal(selectTasks(dataset, [1]).length, 1);
  for (const ids of [[1, 1], [2], [], [-1]]) assert.throws(() => selectTasks(dataset, ids));
  assert.throws(() => selectTasks([...dataset, ...dataset], [1]));
  assert.throws(() => selectTasks([{ ...dataset[0], eval: [] }], [1]));
});

test("missing/error tasks retain the planned denominator; partial matches do not pass", () => {
  const summary = scorecard("imported-submissions", 4, [
    { status: "success", score: 1 }, { status: "partial_match", score: 0.5 }, { status: "error", score: 0 }, { status: "not-run" },
  ]);
  assert.equal(summary.taskSuccessOverPlanned, 0.25);
  assert.equal(summary.taskSuccessOverEvaluated, 0.5);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.notRun, 1);
  assert.equal(summary.proofkitEffectiveness, "not-measured");
  assert.equal(summary.defectDetectionRate, null);
});

test("replay calibration has no agent score and report escapes external identifiers", () => {
  const cases = [{ caseId: "<script>alert(1)</script>", status: "success", score: 1 }];
  const summary = scorecard("upstream-replay-controls", 1, cases);
  assert.equal(summary.taskSuccessOverPlanned, null);
  assert.equal(summary.taskSuccessOverEvaluated, null);
  const html = renderScorecard({ summary, cases, provenance: {} });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("unstarted batch and missing-only submissions have no measured success rate", () => {
  const cases = [{ status: "not-run" }];
  for (const mode of ["prepared-batch", "imported-submissions"]) {
    const summary = scorecard(mode, 1, cases);
    assert.equal(summary.attempted, 0);
    assert.equal(summary.taskSuccessOverPlanned, null);
    assert.equal(summary.taskSuccessOverEvaluated, null);
  }
});
