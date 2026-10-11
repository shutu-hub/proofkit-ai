import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHostFixture, hostCases } from "./host-evaluation-fixture.mjs";
import { parseClaudeHostAnswer, parseClaudeToolEvents } from "./claude-host-events.mjs";
import { runHost } from "./host-evaluation-runtime.mjs";
import { lastStructuredHostAnswer, parseMcpToolEvents, verifyHostSession } from "./host-evaluation-verifier.mjs";

const requested = argument("--cases");
const host = argument("--host") ?? "codex";
if (!["codex", "claude-code"].includes(host)) throw new Error("--host must be codex or claude-code");
const windowsSandbox = argument("--windows-sandbox");
if (windowsSandbox && (process.platform !== "win32" || !["mxc", "elevated", "unelevated"].includes(windowsSandbox))) {
  throw new Error("--windows-sandbox requires Windows and one of: mxc, elevated, unelevated");
}
if (windowsSandbox && host !== "codex") throw new Error("--windows-sandbox applies only to Codex");
const selected = requested ? requested.split(",").map((id) => {
  const found = hostCases.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown host case: ${id}`);
  return found;
}) : hostCases.filter((item) => !item.optional);
if (!process.argv.includes("--run")) {
  console.log(JSON.stringify({ execution: "not-started", cases: selected.map(({ id, prompt, surface, level, coverage, verdict }) => ({ id, prompt, surface, level, coverage, expectedVerdict: verdict })),
    optionalCases: hostCases.filter((item) => item.optional).map((item) => item.id),
    next: "Add --run to use the selected host CLI and its configured model/auth. Model usage is separate from deterministic tests." }, null, 2));
} else {
  const root = await mkdtemp(join(tmpdir(), "proofkit-host-evaluation-"));
  const cli = await (host === "codex" ? codexLauncher() : claudeLauncher());
  const timeoutMs = Number(argument("--timeout-ms") ?? 240_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) throw new Error("Host deadline must be 10000–900000 milliseconds");
  const reports = [];
  console.log(JSON.stringify({ evaluationRoot: root, cases: selected.map((item) => item.id) }));
  let stoppedBy = null;
  for (const expected of selected) {
    const fixture = await createHostFixture(join(root, expected.id), expected, host);
    try {
      const result = await evaluate(fixture, expected, cli, timeoutMs, host);
      reports.push(result);
      console.log(JSON.stringify({ caseId: expected.id, hostOutcome: result.hostOutcome, ...result.validation, execution: result.execution }));
      if (result.hostOutcome === "infrastructure-blocked") stoppedBy = result.execution.blocker;
    } finally { await fixture.close(); }
    if (stoppedBy) break;
  }
  const report = { schemaVersion: 1, evaluation: `real-${host}-host`, productAcceptance: "synthetic-fixture-only", root,
    ...(host === "codex" ? { windowsSandbox: windowsSandbox ?? "configured" } : {}),
    total: selected.length, attempted: reports.length,
    evaluated: reports.filter((item) => item.hostOutcome === "evaluated").length,
    passed: reports.filter((item) => item.hostOutcome === "evaluated" && item.validation.passed).length,
    stoppedBy, notRun: selected.slice(reports.length).map((item) => item.id), cases: reports, generatedAt: new Date().toISOString() };
  await writeFile(join(root, "host-evaluation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(root, "host-evaluation.json"), passed: report.passed,
    evaluated: report.evaluated, total: report.total, stoppedBy, notRun: report.notRun }));
  if (report.passed !== report.total) process.exitCode = 1;
}

async function evaluate(fixture, expected, cli, timeoutMs, host) {
  const schemaPath = join(fixture.root, "answer-schema.json");
  const answerPath = join(fixture.root, "answer.json");
  await writeFile(schemaPath, JSON.stringify({ type: "object", additionalProperties: false,
    properties: {
      missionId: { type: ["string", "null"] }, verdict: { type: "string", enum: ["passed", "failed", "blocked", "cancelled", "inconclusive", "not-asserted"] },
      level: { type: "string", enum: ["quick", "core", "release"] }, coverage: { type: "string", enum: ["declared", "project"] },
      surface: { type: "string", enum: ["web", "electron", "mobile"] },
      report: { type: ["string", "null"] }, evidencePaths: { type: "array", items: { type: "string" } },
      gaps: { type: "array", items: { type: "string" } }, summary: { type: "string" },
    }, required: ["missionId", "verdict", "level", "coverage", "surface", "report", "evidencePaths", "gaps", "summary"] }));
  const { serverName, command, args, env } = fixture.setup.connection;
  let codexArgv;
  if (host === "codex") {
    const toml = (value) => JSON.stringify(value);
    const overrides = [`mcp_servers.${serverName}.command=${toml(command)}`, `mcp_servers.${serverName}.args=${toml(args)}`,
      `mcp_servers.${serverName}.required=true`, `mcp_servers.${serverName}.tool_timeout_sec=60`,
      // This server is bound to an isolated in-memory HTTP fixture.
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
      ...Object.entries(env).map(([key, value]) => `mcp_servers.${serverName}.env.${key}=${toml(value)}`)];
    if (windowsSandbox) overrides.push(`windows.sandbox=${toml(windowsSandbox)}`);
    // Isolate other user MCP servers without editing saved Codex settings.
    const configHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME, ".codex");
    try {
      const config = await readFile(join(configHome, "config.toml"), "utf8");
      for (const name of new Set([...config.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.[^\]]+)?\]/gm)].map((match) => match[1]))) {
        if (name !== serverName) overrides.push(`mcp_servers.${name}.enabled=false`);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    codexArgv = [...cli.prefix, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", fixture.harness,
      "--add-dir", fixture.workspace,
      "--output-schema", schemaPath, "--output-last-message", answerPath, "-c", 'approval_policy="never"', ...overrides.flatMap((value) => ["-c", value]),
      `${process.argv.includes("--implicit-skill") ? "" : "$proofkit-test "}${expected.prompt}`];
  }
  const argv = host === "codex" ? codexArgv : [...cli.prefix, "-p",
    `${process.argv.includes("--implicit-skill") ? "" : "/proofkit-test "}${expected.prompt}`,
    "--output-format", "stream-json", "--verbose", "--json-schema", await readFile(schemaPath, "utf8"),
    "--mcp-config", fixture.setup.connection.configPath, "--strict-mcp-config", "--no-session-persistence",
    "--permission-mode", "dontAsk", "--allowedTools",
    ["Read", "Glob", "Grep", "Skill", `mcp__${serverName}__*`].join(",")];
  const execution = await runHost(cli.executable, argv, fixture.harness, timeoutMs, join(fixture.root, "host-events.jsonl"));
  const calls = host === "codex" ? parseMcpToolEvents(execution.transcript)
    : parseClaudeToolEvents(execution.transcript, serverName);
  await writeFile(join(fixture.root, "tool-calls.json"), JSON.stringify(calls, null, 2));
  let answer;
  if (host === "codex") {
    try { answer = JSON.parse(await readFile(answerPath, "utf8")); } catch { /* incomplete host response */ }
  } else answer = parseClaudeHostAnswer(execution.transcript);
  const missions = await records(join(fixture.workspace, ".proofkit", "missions"));
  const runRoot = join(fixture.workspace, ".proofkit", "runs");
  let runs = [];
  try { runs = await Promise.all((await readdir(runRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map(async (item) => JSON.parse(await readFile(join(runRoot, item.name, "run.json"), "utf8")))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const hostOutcome = execution.blocker ? "infrastructure-blocked"
    : execution.timedOut || execution.code !== 0 ? "incomplete" : "evaluated";
  const sourceUnchanged = await fixture.sourceUnchanged();
  const workspaceContractsUnchanged = await fixture.workspaceContractsUnchanged();
  const session = { expected, calls, missions, runs, workspace: fixture.workspace,
    sourceUnchanged, workspaceContractsUnchanged };
  const validation = hostOutcome === "evaluated"
    ? await verifyHostSession({ ...session, answer })
    : { passed: false, issues: [execution.blocker ?? execution.stopReason ?? "host-process-failed"] };
  // A completed agent message can aid diagnosis, but only a completed host run
  // with its official answer file is eligible for a passing evaluation.
  const candidate = hostOutcome === "evaluated" ? undefined : host === "codex"
    ? lastStructuredHostAnswer(execution.transcript) : parseClaudeHostAnswer(execution.transcript);
  const provisional = candidate ? { answer: candidate,
    validation: await verifyHostSession({ ...session, answer: candidate }) } : null;
  return { caseId: expected.id, prompt: expected.prompt, skillActivation: process.argv.includes("--implicit-skill") ? "implicit" : "explicit",
    expected: { verdict: expected.verdict, level: expected.level, coverage: expected.coverage, surface: expected.surface }, answer, provisional,
    hostOutcome, execution: { code: execution.code, timedOut: execution.timedOut, durationMs: execution.durationMs,
      blocker: execution.blocker, stopReason: execution.stopReason, milestones: execution.milestones },
    tools: calls.map(({ tool, status }) => ({ tool, status })), missionIds: missions.map((item) => item.missionId),
    evidenceRoot: fixture.workspace, events: join(fixture.root, "host-events.jsonl"), validation };
}

async function records(directory) {
  try { return await Promise.all((await readdir(directory)).filter((path) => path.endsWith(".json")).map(async (path) => JSON.parse(await readFile(join(directory, path), "utf8")))); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function codexLauncher() {
  const configured = process.env.PROOFKIT_CODEX_CLI;
  const path = configured ?? (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js") : "codex");
  if (/\.m?js$/.test(path)) { await access(path); return { executable: process.execPath, prefix: [path] }; }
  if (/\.(cmd|bat|ps1)$/i.test(path)) throw new Error("Set PROOFKIT_CODEX_CLI to codex.js or a native executable; shell wrappers are not evaluated");
  return { executable: path, prefix: [] };
}
async function claudeLauncher() {
  const configured = process.env.PROOFKIT_CLAUDE_CLI;
  const path = configured ?? (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "claude");
  if (/\.m?js$/.test(path)) { await access(path); return { executable: process.execPath, prefix: [path] }; }
  if (/\.(cmd|bat|ps1)$/i.test(path)) throw new Error("Set PROOFKIT_CLAUDE_CLI to a JavaScript entrypoint or native executable");
  return { executable: path, prefix: [] };
}
function argument(name) { const index = process.argv.indexOf(name); if (index < 0) return undefined; if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`); return process.argv[index + 1]; }
