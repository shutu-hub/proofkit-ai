import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeHostAnswer, parseClaudeToolEvents } from "./claude-host-events.mjs";

const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

test("pairs only the selected MCP server's completed Claude tool calls with their results", () => {
  const transcript = lines(
    { type: "assistant", message: { content: [
      { type: "tool_use", id: "one", name: "mcp__proofkit-fixture__inspect_test_scope", input: { level: "core" } },
      { type: "tool_use", id: "foreign", name: "mcp__other__run_test", input: {} },
      { type: "tool_use", id: "pending", name: "mcp__proofkit-fixture__run_test", input: {} },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "one", content: [{ type: "text", text: JSON.stringify({ content: [{ type: "text", text: '{"testVerdict":"not-asserted"}' }] }) }] },
      { type: "tool_result", tool_use_id: "foreign", content: "{}" },
    ] } },
  );
  assert.deepEqual(parseClaudeToolEvents(transcript, "proofkit-fixture"), [
    { id: "one", server: "proofkit-fixture", tool: "inspect_test_scope", arguments: { level: "core" },
      status: "completed", isError: false, result: { testVerdict: "not-asserted" } },
    { id: "pending", server: "proofkit-fixture", tool: "run_test", arguments: {},
      status: "in_progress", isError: false, result: undefined },
  ]);
});

test("does not score failed calls or an intermediate answer as successful evidence", () => {
  const transcript = lines(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "failed", name: "mcp__server__await_test_result", input: { missionId: "m" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "failed", is_error: true, content: "permission denied" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: '{"verdict":"passed"}' }] } },
  );
  assert.deepEqual(parseClaudeToolEvents(transcript, "server").map(({ status, isError }) => ({ status, isError })),
    [{ status: "failed", isError: true }]);
  assert.equal(parseClaudeHostAnswer(transcript), undefined);
  assert.equal(parseClaudeHostAnswer(lines({ type: "result", subtype: "error", result: '{"verdict":"passed"}' })), undefined);
  assert.deepEqual(parseClaudeHostAnswer(lines({ type: "result", subtype: "success", is_error: false,
    structured_output: { verdict: "passed" } })), { verdict: "passed" });
});
