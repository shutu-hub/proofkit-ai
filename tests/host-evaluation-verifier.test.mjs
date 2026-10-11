import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hash, lastStructuredHostAnswer, parseMcpToolEvents, verifyHostSession } from "./host-evaluation-verifier.mjs";

async function fixture(t, verdict = "passed") {
  const workspace = await mkdtemp(join(tmpdir(), "proofkit-host-verifier-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sourceArtifact = "run-1/artifacts/oracle-1-source.json";
  const evidencePath = join(workspace, ".proofkit", "runs", sourceArtifact);
  const report = join(workspace, "report.html");
  const facts = JSON.stringify({ oracle: "resume.terminal", facts: [{ captured: { fileId: "102", jobId: "7" },
    observed: { fileId: "102", jobId: verdict === "failed" ? "9" : "7", state: verdict === "inconclusive" ? "pending" : "complete" } }] });
  await mkdir(join(workspace, ".proofkit", "runs", "run-1", "artifacts"), { recursive: true });
  await writeFile(evidencePath, facts);
  await writeFile(report, "<html>Saved mission result</html>");
  const mission = { missionId: "mission-1", surface: "web", level: "core", status: "completed", verdict,
    plan: { planning: { coverage: { requested: "declared" } } },
    findings: verdict === "failed" ? [{ category: "product", status: "confirmed",
      evidence: [{ kind: "business", path: evidencePath, sha256: hash(facts) }] }] : [] };
  const result = { report, summary: { verdict }, evidence: [{ kind: "business", path: evidencePath, sha256: hash(facts) }] };
  const call = (tool, arguments_, result_) => ({ tool, arguments: arguments_, result: result_, status: "completed" });
  return { workspace, expected: { verdict, level: "core", coverage: "declared", wrongRelation: verdict === "failed" },
    answer: { missionId: mission.missionId, verdict, level: "core", coverage: "declared", surface: "web", report, evidencePaths: [evidencePath], gaps: verdict === "inconclusive" ? ["Terminal state unavailable"] : [] },
    calls: [call("inspect_test_scope", {}, {}), call("run_test", { level: "core", coverage: "declared", surface: "web" }, { missionId: mission.missionId }),
      call("get_mission_status", { missionId: mission.missionId }, { mission }), call("get_mission_evidence", { missionId: mission.missionId }, result)],
    missions: [mission], runs: [{ runId: "run-1", verdict, steps: [{ beforeSnapshot: { metadata: { adapter: "web" } } },
      { action: { kind: "captureResponse" }, status: "passed", response: { association: "action-window", requestCount: 1,
        fields: { fileId: "102", jobId: "7" } } }],
      assertions: [{ passed: true }], oracles: [{ name: "resume.terminal", passed: verdict === "failed" ? false : verdict === "passed" ? true : null,
        sourceEvidenceCount: 1,
        sourceEvidenceArtifacts: [sourceArtifact] }] }], sourceUnchanged: true, workspaceContractsUnchanged: true };
}
async function rejects(input, issue) {
  const result = await verifyHostSession(input);
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
}

async function candidateFixture(t) {
  const input = await fixture(t);
  const path = ".proofkit/charters/resume-core.yml";
  const content = "reviewed core charter";
  await mkdir(join(input.workspace, ".proofkit", "charters"), { recursive: true });
  await writeFile(join(input.workspace, path), content);
  const sha256 = hash(content);
  input.expected.noCatalog = true;
  input.expected.candidatePath = path;
  input.calls[0].result = { workspaceCandidates: { items: [{ path, sha256, parseStatus: "valid", focusMatched: true, issues: [] }] } };
  input.calls[1].arguments = { level: "core", coverage: "declared", surface: "web", charterPath: path, charterSha256: sha256 };
  input.missions[0].charter = { metadata: { proofkitCandidate: { path, sha256 } } };
  return input;
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
test("a confirmed defect must link the current action's audited business source", async (t) => {
  const input = await fixture(t, "failed");
  input.missions[0].findings[0].evidence[0].sha256 = hash("unrelated source");
  await rejects(input, "seeded-defect-not-evidenced");
  input.missions[0].findings[0].evidence[0].sha256 = input.calls[3].result.evidence[0].sha256;
  input.missions[0].findings[0].evidence[0].path = join(input.workspace, "another-run", "oracle-source.json");
  await rejects(input, "seeded-defect-not-evidenced");
});
test("a seeded wrong-job defect needs the actual mismatched job fact", async (t) => {
  const input = await fixture(t, "failed");
  const facts = JSON.stringify({ oracle: "resume.terminal", facts: [{ captured: { fileId: "102", jobId: "7" },
    observed: { fileId: "102", jobId: "7", state: "complete" } }] });
  await writeFile(input.answer.evidencePaths[0], facts);
  input.calls[3].result.evidence[0].sha256 = hash(facts);
  input.missions[0].findings[0].evidence[0].sha256 = hash(facts);
  await rejects(input, "oracle-not-bound-to-current-action");
  await rejects(input, "seeded-defect-not-evidenced");
});
test("a seeded business defect cannot be credited to a passing Oracle", async (t) => {
  const input = await fixture(t, "failed");
  input.runs[0].oracles[0].passed = true;
  await rejects(input, "oracle-not-bound-to-current-action");
  await rejects(input, "seeded-defect-not-evidenced");
});
test("requires a newly captured identity bound to the independent reader", async (t) => {
  const input = await fixture(t);
  input.runs[0].steps[1].response.fields.fileId = "101";
  await rejects(input, "current-action-identity-not-captured");
  input.runs[0].steps[1].response.fields.fileId = "103";
  await rejects(input, "oracle-not-bound-to-current-action");
  input.runs[0].steps[1].response.fields.fileId = "102";
  input.runs[0].oracles[0].sourceEvidenceArtifacts = ["run-1/../artifacts/oracle-1-source.json"];
  await rejects(input, "oracle-not-bound-to-current-action");
  input.runs[0].oracles[0].sourceEvidenceArtifacts = ["run-1/artifacts/oracle-1-source.json"];
  input.calls[3].result.evidence[0].sha256 = hash("different source");
  await rejects(input, "oracle-not-bound-to-current-action");
});
test("requires unchanged workspace contracts and an inline authored Charter", async (t) => {
  const input = await fixture(t);
  input.workspaceContractsUnchanged = false;
  await rejects(input, "test-contracts-changed");
  input.workspaceContractsUnchanged = true;
  input.expected.noCatalog = true;
  await rejects(input, "authored-charter-not-submitted-inline");
  input.calls[1].arguments.charter = { actions: [{ kind: "captureResponse" }] };
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
});

test("requires a reviewed digest-pinned workspace Charter and the same saved Mission source", async (t) => {
  const input = await candidateFixture(t);
  assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
  input.calls[1].arguments.charterSha256 = hash("different source");
  await rejects(input, "candidate-path-and-digest-not-used");
  input.calls[1].arguments.charterSha256 = input.calls[0].result.workspaceCandidates.items[0].sha256;
  delete input.calls[1].arguments.charterPath;
  input.calls[1].arguments.charter = { actions: [{ kind: "observe" }] };
  await rejects(input, "candidate-path-and-digest-not-used");
  delete input.calls[1].arguments.charter;
  input.calls[1].arguments.charterPath = input.expected.candidatePath;
  input.calls[0].result.workspaceCandidates.items[0].sha256 = hash("stale review");
  await rejects(input, "candidate-not-reviewed-from-current-scope");
  input.calls[0].result.workspaceCandidates.items[0].sha256 = input.calls[1].arguments.charterSha256;
  input.missions[0].charter.metadata.proofkitCandidate.path = "charters/other.yml";
  await rejects(input, "saved-candidate-source-mismatch");
});
test("requires a submitted response-bound reader and current identity in its independent HTTP facts", async (t) => {
  for (const wrongIdentity of [false, true]) {
    const input = await fixture(t, wrongIdentity ? "failed" : "passed");
    input.expected.noCatalog = true;
    input.expected.noReader = true;
    input.expected.wrongIdentity = wrongIdentity;
    input.calls[1].arguments.charter = { oracles: ["current-resume-status"], httpOracles: [{
      name: "current-resume-status", query: { fileId: { source: "response", stepId: "step-002",
        field: "fileId", matchPointer: "/data/fileId" } },
    }] };
    delete input.runs[0].steps[1].response.fields.jobId;
    input.runs[0].oracles[0].name = "current-resume-status";
    const facts = JSON.stringify({ oracle: "current-resume-status", facts: [{ observations: [{
      state: wrongIdentity ? "failed" : "passed", facts: { expected_fileId: "102",
        observed_fileId: wrongIdentity ? "101" : "102", scopeMatches: !wrongIdentity },
    }] }] });
    await writeFile(input.answer.evidencePaths[0], facts);
    input.calls[3].result.evidence[0].sha256 = hash(facts);
    if (wrongIdentity) input.missions[0].findings[0].evidence[0].sha256 = hash(facts);
    assert.deepEqual(await verifyHostSession(input), { passed: true, issues: [] });
    delete input.calls[1].arguments.charter.httpOracles;
    await rejects(input, "response-bound-inline-oracle-not-submitted");
    input.calls[1].arguments.charter.httpOracles = [{ name: "current-resume-status",
      query: { fileId: { source: "response", stepId: "step-002", field: "fileId", matchPointer: "/data/fileId" } } }];
    input.runs[0].steps[1].response.fields.fileId = "103";
    await rejects(input, "oracle-not-bound-to-current-action");
  }
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

test("only a completed, schema-shaped agent message is a provisional answer", () => {
  const answer = { missionId: "mission-1", verdict: "failed", level: "core", coverage: "declared",
    surface: "web", report: "report.html", evidencePaths: ["facts.json"], gaps: [], summary: "Confirmed" };
  const event = (type, text) => JSON.stringify({ type, item: { type: "agent_message", text } });
  const trace = [event("item.started", JSON.stringify(answer)),
    event("item.completed", JSON.stringify({ ...answer, verdict: "unknown" })),
    event("item.completed", JSON.stringify(answer)),
    event("item.completed", "A later plain-language summary")].join("\n");
  assert.deepEqual(lastStructuredHostAnswer(trace), answer);
  assert.equal(lastStructuredHostAnswer(event("item.started", JSON.stringify(answer))), undefined);
  assert.equal(lastStructuredHostAnswer(event("item.completed", JSON.stringify({ ...answer, extra: true }))), undefined);
  assert.equal(lastStructuredHostAnswer(event("item.completed", JSON.stringify({ ...answer, evidencePaths: [42] }))), undefined);
});
