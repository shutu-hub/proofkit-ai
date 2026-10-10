import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hash, parseMcpToolEvents, verifyHostSession } from "./host-evaluation-verifier.mjs";

async function fixture(t, verdict = "passed") {
  const workspace = await mkdtemp(join(tmpdir(), "proofkit-host-verifier-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const evidencePath = join(workspace, "oracle-source.json");
  const report = join(workspace, "report.html");
  const facts = '{"fileId":"101","jobId":"7","state":"complete"}';
  await writeFile(evidencePath, facts);
  await writeFile(report, "<html>Saved mission result</html>");
  const mission = { missionId: "mission-1", surface: "web", level: "core", status: "completed", verdict,
    plan: { planning: { coverage: { requested: "declared" } } },
    findings: verdict === "failed" ? [{ category: "product", status: "confirmed", evidence: [{ kind: "business", path: evidencePath }] }] : [] };
  const result = { report, summary: { verdict }, evidence: [{ kind: "business", path: evidencePath, sha256: hash(facts) }] };
  const call = (tool, arguments_, result_) => ({ tool, arguments: arguments_, result: result_, status: "completed" });
  return { workspace, expected: { verdict, level: "core", coverage: "declared" },
    answer: { missionId: mission.missionId, verdict, level: "core", coverage: "declared", surface: "web", report, evidencePaths: [evidencePath], gaps: verdict === "inconclusive" ? ["Terminal state unavailable"] : [] },
    calls: [call("inspect_test_scope", {}, {}), call("run_test", { level: "core", coverage: "declared", surface: "web" }, { missionId: mission.missionId }),
      call("get_mission_status", { missionId: mission.missionId }, { mission }), call("get_mission_evidence", { missionId: mission.missionId }, result)],
    missions: [mission], runs: [{ verdict, steps: [{ beforeSnapshot: { metadata: { adapter: "web" } } }],
      assertions: [{ passed: true }], oracles: [{ sourceEvidenceCount: 1 }] }], sourceUnchanged: true };
}
async function rejects(input, issue) {
  const result = await verifyHostSession(input);
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
}

test("accepts real linked facts for passed, failed and inconclusive host outcomes", async (t) => {
  for (const verdict of ["passed", "failed", "inconclusive"]) assert.deepEqual(await verifyHostSession(await fixture(t, verdict)), { passed: true, issues: [] });
});
test("a fluent passing answer cannot certify a saved business failure", async (t) => {
  const input = await fixture(t, "failed"); input.answer.verdict = "passed";
  await rejects(input, "answer-verdict-does-not-match-case");
});
test("rejects saved intensity/scope downgrades even when answer preserves the request", async (t) => {
  const input = await fixture(t); input.missions[0].level = "quick"; input.missions[0].plan.planning.coverage.requested = "declared";
  input.expected.coverage = "project"; input.answer.coverage = "project";
  await rejects(input, "saved-intensity-changed"); await rejects(input, "saved-acceptance-scope-changed");
});
test("rejects a requested Electron run silently downgraded to Web", async (t) => {
  const input = await fixture(t);
  input.expected.surface = "electron"; input.answer.surface = "electron";
  await rejects(input, "tool-surface-changed");
  await rejects(input, "saved-surface-changed");
  await rejects(input, "run-surface-changed");
});
test("requires status and terminal evidence for the same saved Mission", async (t) => {
  const input = await fixture(t); input.calls[2].arguments.missionId = "other-mission";
  await rejects(input, "same-mission-status-not-read");
  input.calls.pop(); await rejects(input, "terminal-evidence-not-read");
});
test("accepts a terminal bounded wait as the same-Mission status observation", async (t) => {
  const input = await fixture(t);
  input.calls[2] = { tool: "await_test_result", arguments: { missionId: input.answer.missionId },
    result: { state: "terminal", missionId: input.answer.missionId, verdict: "passed" }, status: "completed" };
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
  input.calls[2].result.state = "still-running";
  await rejects(input, "same-mission-status-not-read");
  input.calls[2].result.state = "terminal";
  input.calls[2].result.missionId = "another-mission";
  await rejects(input, "same-mission-status-not-read");
});
test("rejects missing independent proof and product failure without business facts", async (t) => {
  const input = await fixture(t, "failed"); input.runs[0].oracles = []; input.missions[0].findings[0].evidence = [];
  await rejects(input, "independent-business-proof-missing"); await rejects(input, "seeded-defect-not-evidenced");
});
test("detects changed evidence bytes and links invented by the host", async (t) => {
  const input = await fixture(t); await writeFile(input.answer.evidencePaths[0], "changed after observation");
  await rejects(input, "answer-evidence-digest-mismatch");
  input.answer.evidencePaths.push(join(input.workspace, "invented.json"));
  await rejects(input, "answer-evidence-not-observed");
});
test("rejects evidence redirected outside its bound external workspace", async (t) => {
  const input = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "proofkit-host-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, "fact.json"); await writeFile(path, "{}");
  input.answer.evidencePaths = [path]; input.calls[3].result.evidence = [{ path, kind: "business", sha256: hash("{}") }];
  await rejects(input, "answer-evidence-unavailable");
});
test("rejects source modification, repeated Missions and nonterminal claims", async (t) => {
  const input = await fixture(t); input.sourceUnchanged = false; input.missions[0].status = "running"; input.missions.push({ ...input.missions[0], missionId: "mission-2" });
  await rejects(input, "tested-source-changed"); await rejects(input, "unexpected-mission-restart"); await rejects(input, "mission-not-terminal");
});
test("a project coverage gap must preserve scope and must not execute a Run", async (t) => {
  const input = await fixture(t);
  input.expected = { verdict: "not-asserted", level: "core", coverage: "project" };
  input.answer = { missionId: null, verdict: "not-asserted", level: "core", coverage: "project", surface: "web", report: null, evidencePaths: [], gaps: ["全项目业务流程覆盖尚未实现"] };
  input.missions = []; input.runs = []; input.calls.splice(1);
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
  input.runs.push({ verdict: "passed" }); await rejects(input, "unready-request-executed");
});
test("surface reconnaissance does not count as product execution", async (t) => {
  const input = await fixture(t);
  const inspection = { verdict: "inconclusive", charter: { metadata: { purpose: "surface-inspection" },
    sideEffectPolicy: "deny", assertions: [], oracles: [], actions: [{ kind: "observe" }] } };
  input.runs.unshift(inspection);
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
  input.expected = { verdict: "not-asserted", level: "core", coverage: "project" };
  input.answer = { missionId: null, verdict: "not-asserted", level: "core", coverage: "project", surface: "web",
    report: null, evidencePaths: [], gaps: ["缺少全项目业务流程覆盖清单"] };
  input.missions = []; input.runs = [inspection]; input.calls.splice(1);
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
  inspection.charter.actions.push({ kind: "click", selector: "#submit" });
  await rejects(input, "unready-request-executed");
});
test("parses tool lifecycle events and preserves MCP errors rather than counting them as success", () => {
  const item = { id: "call-1", type: "mcp_tool_call", server: "proofkit-test", tool: "run_test", arguments: { intent: "test" }, status: "in_progress" };
  const events = [{ type: "item.started", item }, { type: "item.completed", item: { ...item, status: "completed", result: { content: [{ type: "text", text: '{"missionId":"m1"}' }] } } },
    { type: "item.completed", item: { ...item, id: "call-2", status: "failed", error: { message: "unavailable" } } }];
  const calls = parseMcpToolEvents(events.map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(calls.length, 2); assert.equal(calls[0].result.missionId, "m1"); assert.equal(calls[1].isError, true);
});
