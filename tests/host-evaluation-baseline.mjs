import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHostFixture, hostCases } from "./host-evaluation-fixture.mjs";
import { verifyHostSession } from "./host-evaluation-verifier.mjs";

const requested = argument("--cases");
const selected = requested ? requested.split(",").map((id) => {
  const found = hostCases.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown host case: ${id}`);
  return found;
}) : hostCases.filter((item) => !item.optional);
const root = await mkdtemp(join(tmpdir(), "proofkit-host-baseline-"));
const cases = [];
console.log(JSON.stringify({ baselineRoot: root, cases: selected.map((item) => item.id),
  scope: "scripted native MCP and real Chrome/Electron where selected; no language model is evaluated" }));
for (const expected of selected) {
  const fixture = await createHostFixture(join(root, expected.id), expected);
  try {
    const result = await evaluate(fixture, expected);
    cases.push(result);
    console.log(JSON.stringify({ caseId: expected.id, ...result.validation, verdict: result.answer?.verdict }));
  } catch (error) {
    cases.push({ caseId: expected.id, validation: { passed: false, issues: ["baseline-execution-error"] }, error: String(error) });
    console.log(JSON.stringify({ caseId: expected.id, passed: false, error: String(error) }));
  } finally { await fixture.close(); }
}
const report = { schemaVersion: 1, evaluation: "scripted-mcp-baseline", productAcceptance: "synthetic-fixture-only",
  modelAdherence: "not-evaluated", root, total: cases.length,
  passed: cases.filter((item) => item.validation.passed).length, cases, generatedAt: new Date().toISOString() };
await writeFile(join(root, "baseline.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: join(root, "baseline.json"), passed: report.passed, total: report.total }));
if (report.passed !== report.total) process.exitCode = 1;

async function evaluate(fixture, expected) {
  const { command, args, env } = fixture.setup.connection;
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env,
    PROOFKIT_ALLOW_CAPABILITY_WRITES: "0" } });
  const client = new Client({ name: "proofkit-host-scripted-baseline", version: "1" });
  const calls = [];
  const call = async (tool, arguments_) => {
    const response = await withDeadline(client.callTool({ name: tool, arguments: arguments_ }), 30_000, tool);
    const body = response.content?.find((item) => item.type === "text")?.text;
    let result;
    try { result = body ? JSON.parse(body) : undefined; } catch { /* retain MCP error */ }
    calls.push({ tool, arguments: arguments_, status: response.isError ? "failed" : "completed",
      isError: Boolean(response.isError), result });
    if (response.isError) throw new Error(`${tool}: ${body?.slice(0, 500) ?? "MCP error"}`);
    return result;
  };
  let answer;
  try {
    await withDeadline(client.connect(transport), 15_000, "native MCP connection");
    const scope = await call("inspect_test_scope", { focus: "简历", level: expected.level, surface: expected.surface });
    if (scope.testVerdict !== "not-asserted") throw new Error("Scope inspection unexpectedly claims acceptance");
    const input = { intent: expected.prompt, level: expected.level, coverage: expected.coverage,
      ...(expected.omitSurfaceInScriptedBaseline ? {} : { surface: expected.surface }) };
    if (expected.candidatePath) {
      const candidate = scope.workspaceCandidates?.items.find((item) => item.path === expected.candidatePath);
      if (candidate?.parseStatus !== "valid" || !candidate.sha256 || candidate.issues.length) {
        throw new Error(`Reviewed workspace candidate is unavailable: ${expected.candidatePath}`);
      }
      input.charterPath = candidate.path;
      input.charterSha256 = candidate.sha256;
    } else if (expected.noCatalog || expected.coverage === "project") {
      input.charter = expected.noCatalog ? fixture.corePlan
        : JSON.parse(await readFile(join(fixture.workspace, ".proofkit", "charters", "resume-core.yml"), "utf8"));
    }
    const started = await call("run_test", input);
    if (started.testVerdict !== "not-asserted") throw new Error("Mission start receipt claimed an unaudited product outcome");
    if (expected.coverage === "project") {
      const status = await call("get_mission_status", { missionId: started.missionId });
      if (started.running || started.readiness?.ready || status.mission?.verdict === "passed" || status.testVerdict !== "not-asserted") {
        throw new Error("Project coverage gap unexpectedly became executable or passed");
      }
      answer = { missionId: started.missionId, verdict: "not-asserted",
        level: started.level, coverage: started.planning?.coverage?.requested, surface: expected.surface,
        report: null, evidencePaths: [], gaps: started.readiness?.missing ?? [],
        summary: "The saved Mission lacks whole-project workflow coverage proof." };
    } else {
      if (!started.running) throw new Error(`Expected a started Mission: ${JSON.stringify(started.readiness)}`);
      const terminal = await waitForMission(call, started.missionId);
      const evidence = await call("get_mission_evidence", { missionId: started.missionId });
      const savedSummary = JSON.parse(await readFile(join(dirname(evidence.report), "summary.json"), "utf8"));
      if (terminal.verdict !== evidence.summary?.verdict
        || terminal.testVerdict !== evidence.testVerdict
        || evidence.summary?.testVerdict !== evidence.testVerdict
        || savedSummary.testVerdict !== evidence.testVerdict
        || savedSummary.verdict !== evidence.verdict
        || savedSummary.acceptanceEvidenceIntegrity?.status !== evidence.acceptanceEvidenceIntegrity?.status
        || terminal.acceptanceEvidenceIntegrity?.status !== evidence.acceptanceEvidenceIntegrity?.status
        || terminal.evidenceIntegrity?.status !== evidence.evidenceIntegrity?.status
        || terminal.report !== evidence.report) {
        throw new Error("Bounded wait result differs from the audited Mission evidence");
      }
      if (evidence.testVerdict !== expected.verdict) {
        throw new Error(`Current audited verdict ${evidence.testVerdict} differs from expected ${expected.verdict}`);
      }
      const issues = (evidence.summary?.runs ?? []).flatMap((row) => row.issue ? [row.issue] : []);
      if (terminal.firstFailure?.message) issues.push(terminal.firstFailure.message);
      answer = { missionId: started.missionId, verdict: evidence.testVerdict,
        level: started.level, coverage: started.planning?.coverage?.requested, surface: expected.surface,
        report: evidence.report, evidencePaths: (evidence.evidence ?? []).filter((item) => typeof item.path === "string").map((item) => item.path),
        gaps: [...new Set(issues)], summary: `Audited Mission result: ${evidence.testVerdict}` };
    }
  } finally { await client.close(); }
  const missions = await records(join(fixture.workspace, ".proofkit", "missions"));
  const runRoot = join(fixture.workspace, ".proofkit", "runs");
  let runs = [];
  try { runs = await Promise.all((await readdir(runRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory()).map(async (item) => JSON.parse(await readFile(join(runRoot, item.name, "run.json"), "utf8")))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const validation = await verifyHostSession({ expected, answer, calls, missions, runs,
    workspace: fixture.workspace, sourceUnchanged: await fixture.sourceUnchanged(),
    workspaceContractsUnchanged: await fixture.workspaceContractsUnchanged() });
  return { caseId: expected.id, expected: { verdict: expected.verdict, level: expected.level, coverage: expected.coverage, surface: expected.surface },
    answer, tools: calls.map(({ tool, status }) => ({ tool, status })),
    missionIds: missions.map((item) => item.missionId), evidenceRoot: fixture.workspace, validation };
}

async function waitForMission(call, missionId) {
  const deadline = Date.now() + 30_000;
  let observation;
  while (Date.now() < deadline) {
    observation = await call("await_test_result", { missionId, timeoutMs: Math.max(500, Math.min(20_000, deadline - Date.now())) });
    if (observation.state === "terminal") return observation;
    if (observation.state === "needs-action") throw new Error(`Mission stopped without a terminal result: ${missionId}, status: ${observation.status}`);
  }
  throw new Error(`Mission did not settle: ${missionId}, latest status: ${observation?.status}`);
}
async function records(directory) {
  try { return await Promise.all((await readdir(directory)).filter((path) => path.endsWith(".json"))
    .map(async (path) => JSON.parse(await readFile(join(directory, path), "utf8")))); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return process.argv[index + 1];
}
async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
