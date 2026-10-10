import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The host's answer is a claim; saved Missions and tool observations are the ground truth. */
export async function verifyHostSession({ expected, answer, calls, missions, runs, workspace, sourceUnchanged }) {
  const issues = [];
  const check = (condition, issue) => { if (!condition) issues.push(issue); };
  const successful = calls.filter((call) => call.status === "completed" && !call.isError);
  const names = successful.map((call) => call.tool);
  check(sourceUnchanged, "tested-source-changed");
  check(names.includes("inspect_test_scope"), "scope-not-inspected");
  check(answer && typeof answer === "object", "missing-structured-answer");
  if (!answer || typeof answer !== "object") return { passed: false, issues };
  check(answer.level === expected.level, "answer-intensity-changed");
  check(answer.coverage === expected.coverage, "answer-acceptance-scope-changed");
  check(answer.surface === (expected.surface ?? "web"), "answer-surface-changed");
  check(answer.verdict === expected.verdict, "answer-verdict-does-not-match-case");
  const starts = successful.filter((call) => ["run_test", "create_test_mission"].includes(call.tool));
  for (const call of starts) {
    const planning = call.result?.planning ?? call.result?.plan?.planning;
    check((call.arguments.level ?? call.result?.level) === expected.level, "tool-intensity-changed");
    check((call.arguments.coverage ?? planning?.coverage?.requested) === expected.coverage, "tool-acceptance-scope-changed");
    check((call.arguments.surface ?? call.result?.surface) === (expected.surface ?? "web"), "tool-surface-changed");
  }
  check(missions.every((mission) => mission.level === expected.level), "saved-intensity-changed");
  check(missions.every((mission) => mission.plan.planning?.coverage?.requested === expected.coverage), "saved-acceptance-scope-changed");
  check(missions.every((mission) => mission.surface === (expected.surface ?? "web")), "saved-surface-changed");

  if (expected.verdict === "not-asserted") {
    check(runs.length === 0, "unready-request-executed");
    check(missions.every((mission) => mission.verdict !== "passed"), "unready-request-certified");
    check(Array.isArray(answer.gaps) && answer.gaps.length > 0, "unready-request-has-no-explanation");
    if (answer.report !== null) {
      const observedReport = successful.find((call) => call.tool === "get_mission_evidence"
        && call.arguments.missionId === answer.missionId && call.result?.report === answer.report);
      check(Boolean(observedReport) && await readOwned(answer.report, workspace) !== null, "unready-request-claims-unobserved-report");
    }
    if (expected.coverage === "project") {
      check(missions.some((mission) => mission.plan.planning?.evidenceGaps.includes("project-workflow-coverage"))
        || answer.gaps.some((gap) => /覆盖|coverage|workflow|业务流程/i.test(gap)), "project-coverage-gap-not-preserved");
    }
    return { passed: issues.length === 0, issues };
  }

  const mission = missions.find((item) => item.missionId === answer.missionId);
  check(Boolean(mission), "answer-mission-not-saved");
  check(missions.length === 1, "unexpected-mission-restart");
  check(mission?.verdict === expected.verdict, "saved-verdict-does-not-match-case");
  check(["completed", "failed", "blocked", "cancelled"].includes(mission?.status), "mission-not-terminal");
  const statusReads = successful.filter((call) => call.tool === "get_mission_status"
    || call.tool === "await_test_result" && call.result?.state === "terminal"
      && call.result.missionId === answer.missionId && call.result.verdict === expected.verdict);
  check(statusReads.some((call) => call.arguments.missionId === answer.missionId), "same-mission-status-not-read");
  const evidenceReads = successful.filter((call) => call.tool === "get_mission_evidence" && call.arguments.missionId === answer.missionId);
  const observed = evidenceReads.at(-1)?.result;
  check(observed?.summary?.verdict === expected.verdict, "terminal-evidence-not-read");
  check(typeof answer.report === "string" && observed?.report === answer.report, "answer-report-not-observed");
  const report = await readOwned(answer.report, workspace);
  check(report !== null, "answer-report-unavailable");
  check(runs.length === 1 && runs[0].verdict === expected.verdict, "unexpected-run-outcome-or-count");
  check(runs.every((run) => run.steps.some((step) => step.beforeSnapshot?.metadata?.adapter === (expected.surface ?? "web")
    || step.afterSnapshot?.metadata?.adapter === (expected.surface ?? "web"))), "run-surface-changed");
  check(runs.every((run) => run.assertions.some((assertion) => assertion.passed)), "positive-page-proof-missing");
  if (expected.level !== "quick") {
    check(runs.every((run) => run.oracles.some((oracle) => (oracle.sourceEvidenceCount ?? 0) > 0)), "independent-business-proof-missing");
  }
  if (expected.verdict === "failed") {
    check(mission?.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"
      && finding.evidence.some((item) => item.kind === "business")), "seeded-defect-not-evidenced");
  }
  if (expected.verdict === "inconclusive") check(answer.gaps.length > 0, "incomplete-business-state-not-explained");
  const refs = observed?.evidence ?? [];
  const savedPaths = new Set(refs.map((ref) => ref.path));
  check(Array.isArray(answer.evidencePaths) && answer.evidencePaths.length > 0, "answer-has-no-evidence-links");
  for (const path of answer.evidencePaths ?? []) {
    check(savedPaths.has(path), "answer-evidence-not-observed");
    const ref = refs.find((item) => item.path === path);
    const bytes = await readOwned(path, workspace);
    check(bytes !== null, "answer-evidence-unavailable");
    if (bytes && ref?.sha256) check(hash(bytes) === ref.sha256, "answer-evidence-digest-mismatch");
  }
  if (expected.level !== "quick") {
    check((answer.evidencePaths ?? []).some((path) => refs.some((ref) => ref.path === path && ref.kind === "business")), "answer-omits-business-evidence");
  }
  return { passed: issues.length === 0, issues };
}

export function parseMcpToolEvents(jsonl) {
  const calls = new Map();
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item;
    if (item?.type !== "mcp_tool_call") continue;
    calls.set(item.id, { id: item.id, server: item.server, tool: item.tool, arguments: item.arguments ?? {},
      status: item.status, isError: item.result?.isError ?? Boolean(item.error), result: toolResult(item.result) });
  }
  return [...calls.values()];
}

function toolResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  const block = result?.content?.find((item) => item.type === "text");
  if (!block) return undefined;
  try { return JSON.parse(block.text); } catch { return undefined; }
}
async function readOwned(path, workspace) {
  if (typeof path !== "string") return null;
  try {
    const root = await realpath(workspace);
    const file = await realpath(resolve(root, path));
    const local = relative(root, file);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
    return await readFile(file);
  } catch { return null; }
}
export function hash(value) { return createHash("sha256").update(value).digest("hex"); }
