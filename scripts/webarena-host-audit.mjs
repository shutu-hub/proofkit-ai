import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { auditWebArenaSession } from "./webarena-audit.mjs";

const MAX_EVENTS = 16 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024;
const EXECUTION_TOOLS = new Set(["run_test", "start_mission"]);

/** Standalone surface runs remain valid task attempts only when the host trace names each saved Run. */
export function standaloneRunTraceIssues(runIds, successfulCalls) {
  const observed = new Set(successfulCalls.flatMap((call) => {
    if (call.tool === "inspect_surface" && typeof call.result?.inspectionId === "string") return [call.result.inspectionId];
    if (call.tool === "interact_surface" && typeof call.result?.interactionId === "string") return [call.result.interactionId];
    return [];
  }));
  return runIds.filter((runId) => !observed.has(runId)).map((runId) => `${runId}:host-standalone-run-not-observed`);
}

/** Associate a completed host CLI trace with saved task evidence; this is not agent authentication. */
export async function auditWebArenaHostTrace({ operatorPath, eventsPath, host, serverName }) {
  if (![operatorPath, eventsPath].every((path) => typeof path === "string" && isAbsolute(path))
    || !["codex", "claude-code"].includes(host) || !/^[A-Za-z0-9_-]+$/.test(serverName)) {
    throw new Error("Invalid WebArena host trace audit input");
  }
  const taskAudit = await auditWebArenaSession(operatorPath);
  const operator = JSON.parse((await bounded(operatorPath, MAX_RECORD)).toString("utf8"));
  const [task, response, events] = await Promise.all([
    bounded(join(operator.captureDirectory, "task.finished.json"), MAX_RECORD).then(json),
    bounded(join(operator.captureDirectory, "agent_response.json"), MAX_RECORD).then(json),
    bounded(eventsPath, MAX_EVENTS),
  ]);
  const issues = [...taskAudit.issues];
  const issue = (code) => { if (!issues.includes(code)) issues.push(code); };
  const parsed = host === "codex" ? codexEvents(events.toString("utf8"), serverName)
    : claudeEvents(events.toString("utf8"), serverName);
  for (const problem of parsed.issues) issue(problem);
  if (!parsed.completed) issue("host-turn-not-completed");
  const successful = parsed.calls.filter((call) => call.completed && !call.isError);
  const submissions = successful.filter((call) => call.tool === "submit_benchmark_task");
  if (submissions.length !== 1) issue("host-submission-count-mismatch");
  else {
    const submitted = submissions[0];
    if (!isDeepStrictEqual(submitted.arguments, response)) issue("host-submission-answer-mismatch");
    if (submitted.result?.status !== "captured" || submitted.result?.taskId !== task.taskId
      || !isDeepStrictEqual(submitted.result?.runIds, task.runIds)) issue("host-submission-result-mismatch");
  }
  const missionIds = new Set();
  const standaloneRunIds = [];
  for (const runId of taskAudit.runIds) {
    let started;
    try { started = json(await bounded(join(operator.captureDirectory, `${runId}.started.json`), MAX_RECORD)); }
    catch { issue("host-run-binding-unavailable"); continue; }
    if (typeof started.binding?.missionId === "string") missionIds.add(started.binding.missionId);
    else if (started.binding === undefined) standaloneRunIds.push(runId);
    else issue(`${runId}:host-run-binding-invalid`);
  }
  if (missionIds.size === 0 && standaloneRunIds.length === 0) issue("host-surface-execution-not-observed");
  for (const problem of standaloneRunTraceIssues(standaloneRunIds, successful)) issue(problem);
  for (const missionId of missionIds) {
    const executed = successful.some((call) => EXECUTION_TOOLS.has(call.tool)
      && (call.result?.missionId === missionId || call.result?.mission?.missionId === missionId));
    if (!executed) issue("host-mission-execution-not-observed");
    const terminalRead = successful.some((call) => call.tool === "await_test_result"
      && call.arguments?.missionId === missionId && call.result?.state === "terminal"
      && call.result?.missionId === missionId);
    if (!terminalRead) issue("host-mission-terminal-read-missing");
  }
  return { status: issues.length ? "incomplete" : "associated", taskId: taskAudit.taskId,
    runIds: taskAudit.runIds, missionIds: [...missionIds], issues,
    taskEvidence: taskAudit.status, hostExecution: issues.length ? "not-verified" : "trace-associated",
    testStandard: missionIds.size ? "mission-verified" : "surface-only",
    host, serverName, completedToolCalls: successful.length,
    hostEventsSha256: createHash("sha256").update(events).digest("hex"),
    officialScore: "not-run", proofkitEffectiveness: "not-measured" };
}

function codexEvents(jsonl, serverName) {
  const calls = [];
  const seen = new Set();
  const issues = [];
  let completed = false;
  for (const event of lines(jsonl, issues)) {
    if (event?.type === "turn.completed") completed = true;
    if (event?.type !== "item.completed" || event.item?.type !== "mcp_tool_call"
      || event.item.server !== serverName) continue;
    const item = event.item;
    if (typeof item.id !== "string" || seen.has(item.id)) { issues.push("host-tool-call-identity-ambiguous"); continue; }
    seen.add(item.id);
    calls.push({ tool: item.tool, arguments: item.arguments, completed: item.status === "completed",
      isError: Boolean(item.error || item.result?.isError), result: decode(item.result) });
  }
  return { calls, completed, issues };
}

function claudeEvents(jsonl, serverName) {
  const prefix = `mcp__${serverName}__`;
  const calls = new Map();
  const issues = [];
  let completed = false;
  for (const event of lines(jsonl, issues)) {
    if (event?.type === "result" && event.subtype === "success" && !event.is_error) completed = true;
    for (const block of Array.isArray(event?.message?.content) ? event.message.content : []) {
      if (event.type === "assistant" && block.type === "tool_use" && typeof block.name === "string"
        && block.name.startsWith(prefix)) {
        if (typeof block.id !== "string" || calls.has(block.id)) { issues.push("host-tool-call-identity-ambiguous"); continue; }
        calls.set(block.id, { tool: block.name.slice(prefix.length), arguments: block.input,
          completed: false, isError: false, result: undefined });
      }
      if (event.type === "user" && block.type === "tool_result" && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id);
        if (call.completed) { issues.push("host-tool-result-duplicated"); continue; }
        call.completed = true;
        call.isError = Boolean(block.is_error);
        call.result = decode(block.content);
      }
    }
  }
  return { calls: [...calls.values()], completed, issues };
}

function* lines(jsonl, issues) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    try { yield JSON.parse(line); }
    catch { issues.push("host-event-line-invalid"); }
  }
}

function decode(value) {
  if (Array.isArray(value)) return decode(value.find((item) => item?.type === "text")?.text);
  if (typeof value === "string") {
    try { return decode(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.structuredContent) return value.structuredContent;
  if (value.content) return decode(value.content);
  return value;
}

function json(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected benchmark JSON object");
  return value;
}

async function bounded(path, limit) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid benchmark host audit file");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("Benchmark host audit input changed while reading");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fields = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--session", "--events", "--host", "--server"].includes(process.argv[i])
      || !process.argv[i + 1] || fields.has(process.argv[i])) throw new Error("Invalid host audit arguments");
    fields.set(process.argv[i], process.argv[i + 1]);
  }
  if (fields.size !== 4) throw new Error("Usage: node scripts/webarena-host-audit.mjs --session <operator-json> --events <host-jsonl> --host <codex|claude-code> --server <MCP-name>");
  const result = await auditWebArenaHostTrace({ operatorPath: resolve(fields.get("--session")),
    eventsPath: resolve(fields.get("--events")), host: fields.get("--host"), serverName: fields.get("--server") });
  console.log(JSON.stringify(result));
  if (result.status !== "associated") process.exitCode = 1;
}
