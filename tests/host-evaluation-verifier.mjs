import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The host's answer is a claim; saved Missions and tool observations are the ground truth. */
export async function verifyHostSession({ expected, answer, calls, missions, runs, workspace, sourceUnchanged, workspaceContractsUnchanged }) {
  const issues = [];
  const check = (condition, issue) => { if (!condition) issues.push(issue); };
  const productRuns = runs.filter((run) => !isSurfaceInspection(run));
  const successful = calls.filter((call) => call.status === "completed" && !call.isError);
  const names = successful.map((call) => call.tool);
  check(sourceUnchanged, "tested-source-changed");
  check(workspaceContractsUnchanged, "test-contracts-changed");
  check(names.includes("inspect_test_scope"), "scope-not-inspected");
  check(answer && typeof answer === "object", "missing-structured-answer");
  if (!answer || typeof answer !== "object") return { passed: false, issues };
  check(answer.level === expected.level, "answer-intensity-changed");
  check(answer.coverage === expected.coverage, "answer-acceptance-scope-changed");
  check(answer.surface === (expected.surface ?? "web"), "answer-surface-changed");
  check(answer.verdict === expected.verdict, "answer-verdict-does-not-match-case");
  const starts = successful.filter((call) => ["run_test", "create_test_mission"].includes(call.tool));
  let reviewedCandidate;
  if (expected.candidatePath) {
    const scope = successful.find((call) => call.tool === "inspect_test_scope")?.result;
    reviewedCandidate = scope?.workspaceCandidates?.items?.find((item) => item.path === expected.candidatePath);
    const source = await readOwned(join(workspace, expected.candidatePath), workspace);
    check(reviewedCandidate?.parseStatus === "valid" && reviewedCandidate?.focusMatched === true
      && reviewedCandidate.issues?.length === 0 && typeof reviewedCandidate.sha256 === "string"
      && source !== null && reviewedCandidate.sha256 === hash(source), "candidate-not-reviewed-from-current-scope");
    check(starts.length > 0 && starts.every((call) => call.arguments.charterPath === expected.candidatePath
      && call.arguments.charterSha256 === reviewedCandidate?.sha256 && !call.arguments.charter
      && !call.arguments.charterId && !call.arguments.suiteId), "candidate-path-and-digest-not-used");
  } else if (expected.noCatalog) {
    check(starts.some((call) => call.tool === "run_test" && call.arguments.charter
      && typeof call.arguments.charter === "object" && !call.arguments.charterId && !call.arguments.suiteId), "authored-charter-not-submitted-inline");
  }
  if (expected.noReader) {
    check(starts.some((call) => call.arguments.charter?.httpOracles?.some((oracle) =>
      call.arguments.charter.oracles?.includes(oracle.name) && Object.values(oracle.query ?? {}).some((binding) =>
        binding.source === "response" && binding.matchPointer))), "response-bound-inline-oracle-not-submitted");
  }
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
    check(productRuns.length === 0, "unready-request-executed");
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
  if (expected.candidatePath) {
    check(mission?.charter?.metadata?.proofkitCandidate?.path === expected.candidatePath
      && mission?.charter?.metadata?.proofkitCandidate?.sha256 === reviewedCandidate?.sha256,
    "saved-candidate-source-mismatch");
  }
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
  check(productRuns.length === 1 && productRuns[0].verdict === expected.verdict, "unexpected-run-outcome-or-count");
  check(productRuns.every((run) => run.steps.some((step) => step.beforeSnapshot?.metadata?.adapter === (expected.surface ?? "web")
    || step.afterSnapshot?.metadata?.adapter === (expected.surface ?? "web"))), "run-surface-changed");
  check(productRuns.every((run) => run.assertions.some((assertion) => assertion.passed)), "positive-page-proof-missing");
  const linkedBusinessEvidence = new Map();
  if (expected.level !== "quick") {
    check(productRuns.every((run) => run.oracles.some((oracle) => (oracle.sourceEvidenceCount ?? 0) > 0)), "independent-business-proof-missing");
    for (const run of productRuns) {
      const captured = run.steps?.filter((step) => step.action?.kind === "captureResponse" && step.status === "passed"
        && step.response?.association === "action-window" && step.response?.requestCount === 1) ?? [];
      const response = captured.find((step) => typeof step.response.fields?.fileId === "string"
        && step.response.fields.fileId !== "101" && (expected.noReader || typeof step.response.fields?.jobId === "string"))?.response;
      check(Boolean(response), "current-action-identity-not-captured");
      if (!response) continue;
      let matchedSource = false;
      for (const oracle of run.oracles ?? []) {
        for (const artifact of oracle.sourceEvidenceArtifacts ?? []) {
          if (typeof artifact !== "string" || !artifact.startsWith(`${run.runId}/artifacts/`)
            || artifact.split("/").some((part) => part === ".." || part === ".") || artifact.includes("\\")) continue;
          const sourcePath = join(workspace, ".proofkit", "runs", artifact);
          const bytes = await readOwned(sourcePath, workspace);
          if (!bytes) continue;
          const sourceRef = observed?.evidence?.find((ref) => ref.path === sourcePath && ref.kind === "business" && ref.sha256 === hash(bytes));
          if (!sourceRef || !(answer.evidencePaths ?? []).includes(sourcePath)) continue;
          let source;
          try { source = JSON.parse(bytes.toString("utf8")); } catch { continue; }
          if (source.oracle !== oracle.name || !Array.isArray(source.facts)) continue;
          const matchesRegistered = source.facts.some((fact) => fact.captured?.fileId === response.fields.fileId
            && fact.captured?.jobId === response.fields.jobId && fact.observed?.fileId === response.fields.fileId
            && fact.observed?.jobId === (expected.wrongRelation ? "9" : response.fields.jobId));
          const matchesInline = expected.noReader && source.facts.some((fact) => fact.observations?.some((observation) =>
            observation.facts?.expected_fileId === response.fields.fileId
            && observation.facts?.observed_fileId === (expected.wrongIdentity ? "101" : response.fields.fileId)
            && observation.facts?.scopeMatches === !expected.wrongIdentity
            && observation.state === (expected.wrongIdentity ? "failed" : "passed")));
          if ((matchesRegistered || matchesInline) && (expected.verdict !== "failed" || oracle.passed === false)) {
            matchedSource = true;
            linkedBusinessEvidence.set(sourcePath, sourceRef.sha256);
          }
        }
      }
      check(matchedSource, "oracle-not-bound-to-current-action");
    }
  }
  if (expected.verdict === "failed") {
    check(mission?.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"
      && finding.evidence.some((item) => item.kind === "business"
        && linkedBusinessEvidence.get(item.path) === item.sha256)), "seeded-defect-not-evidenced");
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

function isSurfaceInspection(run) {
  const charter = run.charter;
  return charter?.metadata?.purpose === "surface-inspection" && charter.sideEffectPolicy === "deny"
    && charter.assertions?.length === 0 && (charter.oracles?.length ?? 0) === 0
    && Array.isArray(charter.actions) && charter.actions.length > 0
    && charter.actions.every((action) => action.kind === "observe" || action.kind === "waitForText");
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

/** A completed message is only a candidate until the host exits and writes its official answer. */
export function lastStructuredHostAnswer(jsonl) {
  const required = ["missionId", "verdict", "level", "coverage", "surface", "report", "evidencePaths", "gaps", "summary"];
  const verdicts = new Set(["passed", "failed", "blocked", "cancelled", "inconclusive", "not-asserted"]);
  const lines = jsonl.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try { event = JSON.parse(lines[index]); } catch { continue; }
    if (event.type !== "item.completed" || event.item?.type !== "agent_message"
      || typeof event.item.text !== "string") continue;
    let answer;
    try { answer = JSON.parse(event.item.text); } catch { continue; }
    if (!answer || Array.isArray(answer) || typeof answer !== "object"
      || Object.keys(answer).length !== required.length || required.some((key) => !(key in answer))
      || !(answer.missionId === null || typeof answer.missionId === "string")
      || !verdicts.has(answer.verdict) || !["quick", "core", "release"].includes(answer.level)
      || !["declared", "project"].includes(answer.coverage)
      || !["web", "electron", "mobile"].includes(answer.surface)
      || !(answer.report === null || typeof answer.report === "string")
      || !Array.isArray(answer.evidencePaths) || !answer.evidencePaths.every((path) => typeof path === "string")
      || !Array.isArray(answer.gaps) || !answer.gaps.every((gap) => typeof gap === "string")
      || typeof answer.summary !== "string") continue;
    return answer;
  }
  return undefined;
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
