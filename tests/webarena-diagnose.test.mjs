import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseBatch, renderDiagnosis, summarizeHostEvents, summarizeOfficialChecks } from "../scripts/webarena-diagnose.mjs";

test("merges every planned task with the host attempt and keeps root causes unconfirmed", () => {
  const grade = { summary: { planned: 4 }, cases: [
    { taskId: 0, status: "not-run", score: null },
    { taskId: 108, status: "success", score: 1 },
    { taskId: 157, status: "success", score: 1 },
    { taskId: 423, status: "failure", score: 0 },
  ] };
  const hosts = [
    { taskId: 0, status: "incomplete", execution: { timedOut: true, durationMs: 900000 },
      toolStats: { completed: 19, failed: 2, inputRejections: 2 }, toolStatsIntegrity: "verified" },
    { taskId: 108, status: "associated", toolStats: { completed: 28, failed: 4, inputRejections: 3 }, toolStatsIntegrity: "verified" },
    { taskId: 157, status: "associated", toolStats: { completed: 28, failed: 3, inputRejections: 3 }, toolStatsIntegrity: "verified" },
    { taskId: 423, status: "associated", toolStats: { completed: 8, failed: 0, inputRejections: 0 }, toolStatsIntegrity: "verified" },
  ];
  const report = diagnoseBatch(grade, hosts);
  assert.equal(report.officialSuccess, 2);
  assert.equal(report.officialEvaluated, 3);
  assert.deepEqual(report.officialDetailCoverage, { available: 0, evaluated: 3 });
  assert.equal(report.profile, "shopping-admin-4");
  assert.deepEqual(report.classificationCounts, { "host-timeout": 1, passed: 2, "task-outcome-failed": 1 });
  assert.deepEqual(report.capabilityGroups, {
    mutate: { planned: 1, officialEvaluated: 1, officialSuccess: 0, hostTimeout: 0, outcomeFailed: 1,
      answerCheckFailed: 0, networkCheckFailed: 0, missingNetworkEvent: 0, inputRejections: 0,
      resourceDiscoveryFailures: 0, taskToolFailures: 0, preToolStreamReconnects: 0,
      missionVerified: 0, surfaceOnly: 0, traceVerified: 1 },
    navigate: { planned: 1, officialEvaluated: 1, officialSuccess: 1, hostTimeout: 0, outcomeFailed: 0,
      answerCheckFailed: 0, networkCheckFailed: 0, missingNetworkEvent: 0, inputRejections: 3,
      resourceDiscoveryFailures: 0, taskToolFailures: 0, preToolStreamReconnects: 0,
      missionVerified: 0, surfaceOnly: 0, traceVerified: 1 },
    retrieve: { planned: 2, officialEvaluated: 1, officialSuccess: 1, hostTimeout: 1, outcomeFailed: 0,
      answerCheckFailed: 0, networkCheckFailed: 0, missingNetworkEvent: 0, inputRejections: 5,
      resourceDiscoveryFailures: 0, taskToolFailures: 0, preToolStreamReconnects: 0,
      missionVerified: 0, surfaceOnly: 0, traceVerified: 2 },
  });
  assert.equal(report.cases[3].taskGroup, "mutate");
  assert.equal(report.cases[0].classification.stage, "agent-loop");
  assert.equal(report.cases[3].classification.rootCause, "unconfirmed");
  assert.equal(report.cases[1].host.failedToolCalls, 4);
  assert.equal(report.friction.inputRejections, 8);
  assert.deepEqual(report.investigationCounts, { "host-deadline": 1, "tool-input-contract": 3 });
  assert.match(renderDiagnosis(report), /2\/4 官方成功/);
  assert.match(renderDiagnosis(report), /任务能力组/);
});

test("official evaluator details identify missing action evidence without leaking answers", () => {
  const grade = { summary: { planned: 1 }, cases: [{ taskId: 423, status: "failure", score: 0 }] };
  const official = { results: [{ caseId: "423", result: { task_id: 423, status: "failure", score: 0,
    evaluators_results: [
      { evaluator_name: "AgentResponseEvaluator", status: "failure", actual: "candidate private text",
        expected: { secret: "gold answer" } },
      { evaluator_name: "NetworkEventEvaluator", status: "failure", actual: [],
        expected: { post_data: { token: "private" } }, assertions: [
          { assertion_name: "missing_navigation_event", status: "failure", assertion_msgs: ["private details"] },
        ] },
    ] } }] };
  const checks = summarizeOfficialChecks(official, grade);
  const report = diagnoseBatch(grade, [{ taskId: 423, status: "associated", toolStatsIntegrity: "verified" }], checks);
  assert.equal(report.cases[0].classification.code, "network-evidence-missing");
  assert.deepEqual(report.officialDetailCoverage, { available: 1, evaluated: 1 });
  assert.deepEqual(report.cases[0].official.checks,
    { answer: "failure", network: { passed: 0, failed: 1, errors: 0 }, missingNetworkEvent: true });
  assert.equal(report.capabilityGroups.unclassified.answerCheckFailed, 1);
  assert.equal(report.capabilityGroups.unclassified.networkCheckFailed, 1);
  assert.deepEqual(report.cases[0].investigationSignals,
    ["action-network-evidence", "answer-oracle-mismatch"]);
  assert.doesNotMatch(JSON.stringify(report) + renderDiagnosis(report), /candidate private|gold answer|private details|token/);
  assert.throws(() => summarizeOfficialChecks({ results: [{ ...official.results[0], caseId: "424" }] }, grade), /conflict/);
  assert.throws(() => summarizeOfficialChecks({ results: [...official.results, official.results[0]] }, grade), /conflict/);
  assert.throws(() => summarizeOfficialChecks({ results: [] }, grade), /omit a scored task/);
});

test("an answer-only failure stays separate from network action failures", () => {
  const grade = { summary: { planned: 1 }, cases: [{ taskId: 108, status: "failure", score: 0 }] };
  const details = summarizeOfficialChecks({ results: [{ caseId: "108", result: {
    task_id: 108, status: "failure", score: 0,
    evaluators_results: [{ evaluator_name: "AgentResponseEvaluator", status: "failure" }],
  } }] }, grade);
  const report = diagnoseBatch(grade, [{ taskId: 108, status: "associated", toolStatsIntegrity: "verified" }], details);
  assert.equal(report.cases[0].classification.code, "answer-check-failed");
  assert.equal(report.capabilityGroups.unclassified.answerCheckFailed, 1);
  assert.equal(report.capabilityGroups.unclassified.networkCheckFailed, 0);
});

test("an admission blocker never appears as a measured zero score", () => {
  const report = diagnoseBatch({ summary: { planned: 4 }, cases: [0, 108, 157, 423]
    .map((taskId) => ({ taskId, status: "not-run", score: null })) }, [
    { taskId: 0, status: "infrastructure-blocked", execution: { blocker: "provider-access" } },
  ]);
  assert.equal(report.officialEvaluated, 0);
  assert.equal(report.classificationCounts["host-infrastructure-blocked"], 1);
  assert.match(renderDiagnosis(report), /官方成绩未测量/);
  assert.doesNotMatch(renderDiagnosis(report), /0\/4 官方成功/);
});

test("does not turn an unaudited host or changed trace into a scored capability failure", () => {
  const grade = { summary: { planned: 2 }, cases: [
    { taskId: 1, status: "failure", score: 0 }, { taskId: 2, status: "not-run", score: null },
  ] };
  const result = diagnoseBatch(grade, [
    { taskId: 1, status: "associated", toolStatsIntegrity: "changed" },
    { taskId: 2, status: "infrastructure-blocked", execution: { blocker: "provider-access" } },
  ]);
  assert.equal(result.cases[0].classification.code, "trace-integrity-gap");
  assert.equal(result.cases[1].classification.code, "host-infrastructure-blocked");
  assert.throws(() => diagnoseBatch(grade, [{ taskId: 1 }, { taskId: 1 }]), /Duplicate/);
});

test("summarizes tool calls without copying arguments, results or error content", () => {
  const events = [
    { type: "error", message: "stream disconnected - Reconnecting" },
    { type: "item.completed", item: { type: "mcp_tool_call", tool: "run_test", status: "failed", arguments: { secret: "hidden" },
      result: { content: [{ type: "text", text: "Input validation error: private" }] } } },
    { type: "item.completed", item: { type: "mcp_tool_call", tool: "inspect_surface", status: "completed" } },
    { type: "item.completed", item: { type: "mcp_tool_call", tool: "list_mcp_resources", status: "failed" } },
    { type: "item.started", item: { type: "mcp_tool_call", tool: "ignored", status: "failed" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const stats = summarizeHostEvents(events);
  assert.deepEqual(stats, { completed: 3, failed: 2, inputRejections: 1, resourceDiscoveryFailures: 1,
    taskToolFailures: 1, preToolStreamReconnects: 1,
    tools: { inspect_surface: 1, list_mcp_resources: 1, run_test: 1 } });
  assert.doesNotMatch(JSON.stringify(stats), /hidden|private/);
});

test("keeps independent host, tool, action and answer investigation signals", () => {
  const report = diagnoseBatch({ summary: { planned: 1 }, cases: [{ taskId: 0, status: "not-run", score: null }] }, [
    { taskId: 0, status: "incomplete", execution: { timedOut: true },
      toolStats: { preToolStreamReconnects: 10, resourceDiscoveryFailures: 14, inputRejections: 1 },
      toolStatsIntegrity: "verified" },
  ]);
  assert.deepEqual(report.cases[0].investigationSignals,
    ["provider-stream-reconnect", "unsupported-resource-discovery", "tool-input-contract", "host-deadline"]);
  assert.equal(report.investigationCounts["unsupported-resource-discovery"], 1);
  assert.equal(report.cases[0].classification.rootCause, "unconfirmed");
});

test("separates a failed capture from a later batch reset blocker", () => {
  const grade = { summary: { planned: 2 }, cases: [
    { taskId: 119, status: "not-run", score: null }, { taskId: 470, status: "not-run", score: null },
  ] };
  const report = diagnoseBatch(grade, [{ taskId: 119, status: "incomplete",
    audit: { issues: ["task-capture-unavailable", "task-capture-artifact-unavailable"] },
    toolStatsIntegrity: "verified" }], new Map(), { planned: 2, attempts: [
    { taskId: 119, status: "incomplete" }, { taskId: 470, status: "batch-blocked", reason: "private Docker stderr" },
  ] });
  assert.deepEqual(report.classificationCounts, { "batch-environment-blocked": 1, "capture-unavailable": 1 });
  assert.deepEqual(report.cases[0].investigationSignals, ["capture-artifact-unavailable"]);
  assert.deepEqual(report.cases[1].investigationSignals, ["benchmark-environment-admission"]);
  assert.equal(report.officialEvaluated, 0);
  assert.doesNotMatch(JSON.stringify(report), /private Docker stderr/);
  assert.throws(() => diagnoseBatch(grade, [], new Map(), { planned: 2, attempts: [
    { taskId: 470, status: "batch-blocked" }, { taskId: 470, status: "batch-blocked" },
  ] }), /duplicate batch admission/);
});
