import { createHash } from "node:crypto";
import { open, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { benchmarkProfiles } from "./webarena-benchmark-lib.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Separate the observed failure stage from its unproven root cause. */
export function diagnoseBatch(grade, hosts) {
  if (!grade || !Array.isArray(grade.cases) || !Number.isSafeInteger(grade.summary?.planned)
    || grade.summary.planned !== grade.cases.length || !Array.isArray(hosts)) {
    throw new Error("Invalid fixed-denominator benchmark report");
  }
  const hostByTask = new Map();
  for (const host of hosts) {
    if (!Number.isSafeInteger(host?.taskId) || hostByTask.has(host.taskId)) {
      throw new Error("Duplicate or invalid host task report");
    }
    hostByTask.set(host.taskId, host);
  }
  const seen = new Set();
  const profile = Object.entries(benchmarkProfiles).find(([, value]) =>
    JSON.stringify(value.taskIds) === JSON.stringify(grade.cases.map((item) => item.taskId)));
  const taskGroup = new Map(profile ? Object.entries(profile[1].taskGroups)
    .flatMap(([group, ids]) => ids.map((id) => [id, group])) : []);
  const cases = grade.cases.map((item) => {
    if (!Number.isSafeInteger(item?.taskId) || seen.has(item.taskId)) throw new Error("Duplicate or invalid graded task");
    seen.add(item.taskId);
    const host = hostByTask.get(item.taskId);
    const classification = classify(item, host);
    return {
      taskId: item.taskId,
      taskGroup: taskGroup.get(item.taskId) ?? "unclassified",
      official: { status: item.status, score: item.score ?? null },
      host: host ? { status: host.status, durationMs: host.execution?.durationMs ?? null,
        timedOut: host.execution?.timedOut ?? false, blocker: host.execution?.blocker ?? null,
        toolCalls: host.toolStats?.completed ?? null, failedToolCalls: host.toolStats?.failed ?? null,
        inputRejections: host.toolStats?.inputRejections ?? null,
        toolStatsIntegrity: host.toolStatsIntegrity ?? "unavailable" } : null,
      classification,
    };
  });
  if ([...hostByTask.keys()].some((taskId) => !seen.has(taskId))) throw new Error("Host report outside graded batch");
  const counts = Object.fromEntries([...new Set(cases.map((item) => item.classification.code))]
    .sort().map((code) => [code, cases.filter((item) => item.classification.code === code).length]));
  const capabilityGroups = Object.fromEntries([...new Set(cases.map((item) => item.taskGroup))]
    .sort().map((group) => {
      const items = cases.filter((item) => item.taskGroup === group);
      return [group, { planned: items.length,
        officialEvaluated: items.filter((item) => ["success", "failure", "partial_match"].includes(item.official.status)).length,
        officialSuccess: items.filter((item) => item.official.status === "success" && item.official.score === 1).length,
        hostTimeout: items.filter((item) => item.classification.code === "host-timeout").length,
        outcomeFailed: items.filter((item) => item.classification.code === "task-outcome-failed").length,
        inputRejections: items.reduce((sum, item) => sum + (item.host?.inputRejections ?? 0), 0),
        traceVerified: items.filter((item) => item.host?.toolStatsIntegrity === "verified").length }];
    }));
  return { schemaVersion: 1, planned: grade.summary.planned,
    officialEvaluated: cases.filter((item) => ["success", "failure", "partial_match"].includes(item.official.status)).length,
    officialSuccess: cases.filter((item) => item.official.status === "success" && item.official.score === 1).length,
    ...(profile ? { profile: profile[0] } : {}),
    classificationCounts: counts,
    capabilityGroups,
    friction: { verifiedHostTraces: cases.filter((item) => item.host?.toolStatsIntegrity === "verified").length,
      unknownHostTraces: cases.filter((item) => item.host && item.host.toolStatsIntegrity !== "verified").length,
      failedToolCalls: cases.reduce((sum, item) => sum + (item.host?.failedToolCalls ?? 0), 0),
      inputRejections: cases.reduce((sum, item) => sum + (item.host?.inputRejections ?? 0), 0) },
    cases,
    interpretation: "Observed stage only. Product, model, tool and evaluator root causes require evidence review and controlled rerun." };
}

function classify(grade, host) {
  const result = (code, stage, nextCheck) => ({ code, stage, rootCause: "unconfirmed", nextCheck });
  if (!host) return result("no-host-record", "admission", "Locate the task attempt or run it with a recorded host session.");
  if (host.toolStatsIntegrity === "changed") return result("trace-integrity-gap", "evidence", "Verify the saved host JSONL against its recorded SHA-256 before attribution.");
  if (host.execution?.blocker || host.status === "infrastructure-blocked") {
    return result("host-infrastructure-blocked", "host", "Check provider access, MCP availability and host startup separately from task quality.");
  }
  if (host.execution?.timedOut) return result("host-timeout", "agent-loop", "Inspect navigation, selector and tool-call timeline; rerun with the same fixed deadline.");
  if (host.status !== "associated") return result("submission-gap", "capture", "Inspect terminal submission, task audit and host tool trace.");
  if (grade.status === "not-run" || grade.status === "error") {
    return result("evaluation-gap", "evaluator", "Check staged response/HAR and official evaluator diagnostics.");
  }
  if (grade.status === "success" && grade.score === 1) return result("passed", "complete", "Repeat under the same pinned environment to measure stability.");
  return result("task-outcome-failed", "task-or-evaluator", "Compare browser actions and independent state with the official rubric; inspect rubric quality before assigning blame.");
}

export function summarizeHostEvents(jsonl) {
  let completed = 0, failed = 0, inputRejections = 0;
  const tools = new Map();
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
    completed += 1;
    if (event.item.status === "failed") {
      failed += 1;
      const message = (event.item.result?.content ?? []).filter((item) => item?.type === "text")
        .map((item) => item.text).filter((item) => typeof item === "string").join("\n").slice(0, 8192);
      if (/Input validation error|cannot be combined with ad-hoc planning options/i.test(message)) inputRejections += 1;
    }
    const name = typeof event.item.tool === "string" ? event.item.tool : "unknown";
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return { completed, failed, inputRejections,
    tools: Object.fromEntries([...tools].sort(([a], [b]) => a.localeCompare(b))) };
}

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderDiagnosis(report) {
  const groups = Object.entries(report.capabilityGroups).map(([group, value]) =>
    `<tr><td>${escape(group)}</td><td>${value.officialEvaluated ? `${value.officialSuccess}/${value.planned}` : "未评分"}</td>`
    + `<td>${value.officialEvaluated}/${value.planned}</td>`
    + `<td>${value.hostTimeout}</td><td>${value.outcomeFailed}</td>`
    + `<td>${value.inputRejections}</td><td>${value.traceVerified}/${value.planned}</td></tr>`).join("\n");
  const rows = report.cases.map((item) => `<tr><td>${item.taskId}</td><td>${escape(item.official.status)}</td>`
    + `<td>${escape(item.host?.status ?? "missing")}</td><td>${escape(item.classification.code)}</td>`
    + `<td>${item.host?.failedToolCalls ?? "—"}/${item.host?.toolCalls ?? "—"}</td>`
    + `<td>${escape(item.classification.nextCheck)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ProofKit 基准诊断</title>`
    + `<style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#18212b}`
    + `table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:12px;text-align:left}`
    + `.score{font-size:2rem;font-weight:700}.muted{color:#586470}</style>`
    + `<h1>基准诊断</h1><p class="score">${report.officialEvaluated ? `${report.officialSuccess}/${report.planned} 官方成功` : "官方成绩未测量"}</p>`
    + `<p class="muted">官方已评判 ${report.officialEvaluated}/${report.planned}；未运行题目仍留在固定分母。</p>`
    + `<p class="muted">${report.friction.inputRejections} 次工具入参拒绝；失败类别表示观察到的阶段，根因须复核证据并重复运行。</p>`
    + `<h2>任务能力组</h2><p class="muted">按预先固定的任务意图分组；低分是调查线索，不等于已确认的框架根因。</p>`
    + `<table><thead><tr><th>任务组</th><th>官方成功</th><th>已评判/计划</th><th>宿主超时</th><th>结果失败</th><th>入参拒绝</th><th>已核验轨迹</th></tr></thead>`
    + `<tbody>${groups}</tbody></table><h2>逐题诊断</h2>`
    + `<table><thead><tr><th>任务</th><th>官方</th><th>宿主</th><th>观察类别</th><th>工具失败/总数</th><th>下一步核查</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></html>`;
}

async function bounded(path, maximum) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(`Benchmark input too large: ${basename(path)}`);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error(`Benchmark input changed while reading: ${basename(path)}`);
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--grade", "--host", "--output"].includes(args[i]) || !args[i + 1]) throw new Error("Invalid diagnosis argument");
    if (args[i] !== "--host" && values.has(args[i])) throw new Error("Duplicate diagnosis argument");
    values.set(args[i], args[i] === "--host" ? [...(values.get(args[i]) ?? []), args[i + 1]] : args[i + 1]);
  }
  const gradePath = values.get("--grade"), output = values.get("--output");
  if (!gradePath || !output || !isAbsolute(gradePath) || !isAbsolute(output)) {
    throw new Error("Usage: node scripts/webarena-diagnose.mjs --grade <absolute-report.json> --host <absolute-host-run.json> [--host ...] --output <new-absolute-directory>");
  }
  const gradeBytes = await bounded(gradePath, MAX_REPORT_BYTES);
  const hosts = [];
  const provenance = { gradeSha256: sha256(gradeBytes), hostReports: [] };
  for (const hostPath of values.get("--host") ?? []) {
    if (!isAbsolute(hostPath)) throw new Error("Host report paths must be absolute");
    const bytes = await bounded(hostPath, MAX_REPORT_BYTES);
    const host = JSON.parse(bytes.toString("utf8"));
    const eventsPath = join(dirname(hostPath), "host-events.jsonl");
    try {
      const events = await bounded(eventsPath, MAX_EVENTS_BYTES);
      host.toolStatsIntegrity = host.eventsSha256 === sha256(events) ? "verified" : "changed";
      if (host.toolStatsIntegrity === "verified") host.toolStats = summarizeHostEvents(events.toString("utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      host.toolStatsIntegrity = "unavailable";
    }
    hosts.push(host);
    provenance.hostReports.push({ taskId: host.taskId, sha256: sha256(bytes) });
  }
  const report = { ...diagnoseBatch(JSON.parse(gradeBytes.toString("utf8")), hosts), provenance };
  await mkdir(resolve(output));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(output, "report.html"), renderDiagnosis(report), { flag: "wx" });
  process.stdout.write(JSON.stringify({ output, officialSuccess: report.officialSuccess,
    planned: report.planned, classificationCounts: report.classificationCounts }) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
