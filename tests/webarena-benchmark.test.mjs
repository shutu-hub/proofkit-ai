import assert from "node:assert/strict";
import test from "node:test";
import { auditProfileTasks, benchmarkProfile, publicTask, renderScorecard, scorecard, selectTasks } from "../scripts/webarena-benchmark-lib.mjs";

test("single-site profiles have fixed denominators and preserve the cross-site pilot", () => {
  assert.deepEqual(benchmarkProfile("shopping-admin-4").taskIds, [0, 108, 157, 423]);
  assert.deepEqual(benchmarkProfile("shopping-admin-4").sites, ["shopping_admin"]);
  assert.deepEqual(benchmarkProfile("shopping-admin-12").taskIds,
    [0, 11, 77, 94, 108, 119, 374, 453, 470, 496, 501, 679]);
  assert.equal(benchmarkProfile("shopping-admin-24").taskIds.length, 24);
  assert.deepEqual(benchmarkProfile("shopping-admin-24").taskIds.filter((id) =>
    benchmarkProfile("shopping-admin-12").taskIds.includes(id)), benchmarkProfile("shopping-admin-12").taskIds);
  assert.equal(benchmarkProfile("pilot-12").taskIds.length, 12);
  for (const name of ["pilot-12", "shopping-admin-4", "shopping-admin-12", "shopping-admin-24"]) {
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

test("task design audit rejects missing action evidence and mismatched task groups", () => {
  const profile = benchmarkProfile("shopping-admin-4");
  const dataset = profile.taskIds.map((id) => {
    const group = Object.entries(profile.taskGroups).find(([, ids]) => ids.includes(id))[0];
    return { task_id: id, intent: `Task ${id}`, sites: ["shopping_admin"],
      start_urls: ["__SHOPPING_ADMIN__"], eval: [
        { evaluator: "AgentResponseEvaluator", expected: { task_type: group } },
        ...(group === "retrieve" ? [] : [{ evaluator: "NetworkEventEvaluator" }]),
      ] };
  });
  assert.deepEqual(auditProfileTasks(dataset, "shopping-admin-4").groups,
    { retrieve: 2, navigate: 1, mutate: 1 });
  assert.throws(() => auditProfileTasks(dataset.map((task) => task.task_id === 423
    ? { ...task, eval: task.eval.slice(0, 1) } : task), "shopping-admin-4"), /lacks an action evaluator/);
  assert.throws(() => auditProfileTasks(dataset.map((task) => task.task_id === 157
    ? { ...task, eval: [{ ...task.eval[0], expected: { task_type: "retrieve" } }, task.eval[1]] } : task),
  "shopping-admin-4"), /matching answer evaluator/);
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
