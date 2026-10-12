import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseBatch, renderDiagnosis, summarizeHostEvents } from "../scripts/webarena-diagnose.mjs";

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
  assert.equal(report.profile, "shopping-admin-4");
  assert.deepEqual(report.classificationCounts, { "host-timeout": 1, passed: 2, "task-outcome-failed": 1 });
  assert.deepEqual(report.capabilityGroups, {
    mutate: { planned: 1, officialSuccess: 0, hostTimeout: 0, outcomeFailed: 1, inputRejections: 0, traceVerified: 1 },
    navigate: { planned: 1, officialSuccess: 1, hostTimeout: 0, outcomeFailed: 0, inputRejections: 3, traceVerified: 1 },
    retrieve: { planned: 2, officialSuccess: 1, hostTimeout: 1, outcomeFailed: 0, inputRejections: 5, traceVerified: 2 },
  });
  assert.equal(report.cases[3].taskGroup, "mutate");
  assert.equal(report.cases[0].classification.stage, "agent-loop");
  assert.equal(report.cases[3].classification.rootCause, "unconfirmed");
  assert.equal(report.cases[1].host.failedToolCalls, 4);
  assert.equal(report.friction.inputRejections, 8);
  assert.match(renderDiagnosis(report), /2\/4 官方成功/);
  assert.match(renderDiagnosis(report), /任务能力组/);
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
    { type: "item.completed", item: { type: "mcp_tool_call", tool: "run_test", status: "failed", arguments: { secret: "hidden" },
      result: { content: [{ type: "text", text: "Input validation error: private" }] } } },
    { type: "item.completed", item: { type: "mcp_tool_call", tool: "inspect_surface", status: "completed" } },
    { type: "item.started", item: { type: "mcp_tool_call", tool: "ignored", status: "failed" } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const stats = summarizeHostEvents(events);
  assert.deepEqual(stats, { completed: 2, failed: 1, inputRejections: 1, tools: { inspect_surface: 1, run_test: 1 } });
  assert.doesNotMatch(JSON.stringify(stats), /hidden|private/);
});
