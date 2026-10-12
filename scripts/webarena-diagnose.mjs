import { createHash } from "node:crypto";
import { open, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { benchmarkProfiles } from "./webarena-benchmark-lib.mjs";

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_OFFICIAL_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Keep only pass/fail signals; upstream actual, expected and assertion text stay in the trusted grade directory. */
export function summarizeOfficialChecks(official, grade) {
  if (!official || !Array.isArray(official.results) || !Array.isArray(grade?.cases)) {
    throw new Error("Invalid official evaluator details");
  }
  const graded = new Map(grade.cases.map((item) => [item.taskId, item]));
  if (graded.size !== grade.cases.length) throw new Error("Duplicate graded task");
  const checks = new Map();
  for (const entry of official.results) {
    const taskId = Number(entry?.caseId);
    const result = entry?.result;
    const item = graded.get(taskId);
    if (!Number.isSafeInteger(taskId) || String(taskId) !== entry.caseId || checks.has(taskId)
      || !item || result?.task_id !== taskId || result.status !== item.status || result.score !== item.score
      || !["success", "failure", "partial_match", "error"].includes(item.status)
      || !Array.isArray(result.evaluators_results)) {
      throw new Error("Official evaluator details conflict with the graded batch");
    }
    const answer = result.evaluators_results.filter((check) => check?.evaluator_name === "AgentResponseEvaluator");
    const network = result.evaluators_results.filter((check) => check?.evaluator_name === "NetworkEventEvaluator");
    if (answer.length !== 1 || answer.length + network.length !== result.evaluators_results.length
      || [...answer, ...network].some((check) =>
      !["success", "failure", "partial_match", "error"].includes(check.status))) {
      throw new Error(`Invalid evaluator checks for task ${taskId}`);
    }
    checks.set(taskId, {
      answer: answer[0].status,
      network: { passed: network.filter((check) => check.status === "success").length,
        failed: network.filter((check) => ["failure", "partial_match"].includes(check.status)).length,
        errors: network.filter((check) => check.status === "error").length },
      missingNetworkEvent: network.some((check) => check.assertions?.some((assertion) =>
        assertion?.assertion_name === "missing_navigation_event" && assertion.status === "failure")),
    });
  }
  if (grade.cases.some((item) => ["success", "failure", "partial_match"].includes(item.status)
    && !checks.has(item.taskId))) throw new Error("Official evaluator details omit a scored task");
  return checks;
}

/** Separate the observed failure stage from its unproven root cause. */
export function diagnoseBatch(grade, hosts, officialChecks = new Map()) {
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
    const checks = officialChecks.get(item.taskId) ?? null;
    const classification = classify(item, host, checks);
    const investigationSignals = [];
    if ((host?.toolStats?.preToolStreamReconnects ?? 0) > 0) investigationSignals.push("provider-stream-reconnect");
    if ((host?.toolStats?.resourceDiscoveryFailures ?? 0) > 0) investigationSignals.push("unsupported-resource-discovery");
    if ((host?.toolStats?.inputRejections ?? 0) > 0) investigationSignals.push("tool-input-contract");
    if (host?.execution?.timedOut) investigationSignals.push("host-deadline");
    if (checks?.missingNetworkEvent) investigationSignals.push("action-network-evidence");
    if (["failure", "partial_match"].includes(checks?.answer)) investigationSignals.push("answer-oracle-mismatch");
    if (host?.audit?.testStandard === "surface-only" && item.status !== "success") investigationSignals.push("surface-only-verification");
    return {
      taskId: item.taskId,
      taskGroup: taskGroup.get(item.taskId) ?? "unclassified",
      official: { status: item.status, score: item.score ?? null, checks },
      host: host ? { status: host.status, durationMs: host.execution?.durationMs ?? null,
        timedOut: host.execution?.timedOut ?? false, blocker: host.execution?.blocker ?? null,
        toolCalls: host.toolStats?.completed ?? null, failedToolCalls: host.toolStats?.failed ?? null,
        inputRejections: host.toolStats?.inputRejections ?? null,
        resourceDiscoveryFailures: host.toolStats?.resourceDiscoveryFailures ?? null,
        taskToolFailures: host.toolStats?.taskToolFailures ?? null,
        preToolStreamReconnects: host.toolStats?.preToolStreamReconnects ?? null,
        firstToolCallAtMs: host.execution?.milestones?.firstToolCallAtMs ?? null,
        testStandard: host.audit?.testStandard ?? null,
        toolStatsIntegrity: host.toolStatsIntegrity ?? "unavailable" } : null,
      classification, investigationSignals,
    };
  });
  if ([...hostByTask.keys()].some((taskId) => !seen.has(taskId))) throw new Error("Host report outside graded batch");
  const counts = Object.fromEntries([...new Set(cases.map((item) => item.classification.code))]
    .sort().map((code) => [code, cases.filter((item) => item.classification.code === code).length]));
  const investigationCounts = Object.fromEntries([...new Set(cases.flatMap((item) => item.investigationSignals))]
    .sort().map((signal) => [signal, cases.filter((item) => item.investigationSignals.includes(signal)).length]));
  const capabilityGroups = Object.fromEntries([...new Set(cases.map((item) => item.taskGroup))]
    .sort().map((group) => {
      const items = cases.filter((item) => item.taskGroup === group);
      return [group, { planned: items.length,
        officialEvaluated: items.filter((item) => ["success", "failure", "partial_match"].includes(item.official.status)).length,
        officialSuccess: items.filter((item) => item.official.status === "success" && item.official.score === 1).length,
        hostTimeout: items.filter((item) => item.classification.code === "host-timeout").length,
        outcomeFailed: items.filter((item) => ["failure", "partial_match"].includes(item.official.status)).length,
        answerCheckFailed: items.filter((item) => ["failure", "partial_match"].includes(item.official.checks?.answer)).length,
        networkCheckFailed: items.filter((item) => (item.official.checks?.network.failed ?? 0) > 0).length,
        missingNetworkEvent: items.filter((item) => item.official.checks?.missingNetworkEvent).length,
        missionVerified: items.filter((item) => item.host?.testStandard === "mission-verified").length,
        surfaceOnly: items.filter((item) => item.host?.testStandard === "surface-only").length,
        inputRejections: items.reduce((sum, item) => sum + (item.host?.inputRejections ?? 0), 0),
        resourceDiscoveryFailures: items.reduce((sum, item) => sum + (item.host?.resourceDiscoveryFailures ?? 0), 0),
        taskToolFailures: items.reduce((sum, item) => sum + (item.host?.taskToolFailures ?? 0), 0),
        preToolStreamReconnects: items.reduce((sum, item) => sum + (item.host?.preToolStreamReconnects ?? 0), 0),
        traceVerified: items.filter((item) => item.host?.toolStatsIntegrity === "verified").length }];
    }));
  return { schemaVersion: 1, planned: grade.summary.planned,
    officialEvaluated: cases.filter((item) => ["success", "failure", "partial_match"].includes(item.official.status)).length,
    officialSuccess: cases.filter((item) => item.official.status === "success" && item.official.score === 1).length,
    officialDetailCoverage: { available: cases.filter((item) => item.official.checks !== null).length,
      evaluated: cases.filter((item) => ["success", "failure", "partial_match"].includes(item.official.status)).length },
    ...(profile ? { profile: profile[0] } : {}),
    classificationCounts: counts, investigationCounts,
    capabilityGroups,
    friction: { verifiedHostTraces: cases.filter((item) => item.host?.toolStatsIntegrity === "verified").length,
      unknownHostTraces: cases.filter((item) => item.host && item.host.toolStatsIntegrity !== "verified").length,
      failedToolCalls: cases.reduce((sum, item) => sum + (item.host?.failedToolCalls ?? 0), 0),
      inputRejections: cases.reduce((sum, item) => sum + (item.host?.inputRejections ?? 0), 0),
      resourceDiscoveryFailures: cases.reduce((sum, item) => sum + (item.host?.resourceDiscoveryFailures ?? 0), 0),
      taskToolFailures: cases.reduce((sum, item) => sum + (item.host?.taskToolFailures ?? 0), 0),
      preToolStreamReconnects: cases.reduce((sum, item) => sum + (item.host?.preToolStreamReconnects ?? 0), 0) },
    cases,
    interpretation: "Observed stage only. Product, model, tool and evaluator root causes require evidence review and controlled rerun." };
}

function classify(grade, host, checks) {
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
  if (checks?.missingNetworkEvent) return result("network-evidence-missing", "network-evidence",
    "Inspect the browser action trace and HAR against the official network requirement; verify the rubric before assigning blame.");
  if (["failure", "partial_match"].includes(checks?.answer)
    && checks?.network.failed === 0 && checks.network.errors === 0) {
    return result("answer-check-failed", "answer", "Compare the submitted answer with observed page and independent state; inspect the official answer schema.");
  }
  return result("task-outcome-failed", "task-or-evaluator", "Compare browser actions and independent state with the official rubric; inspect rubric quality before assigning blame.");
}

export function summarizeHostEvents(jsonl) {
  let completed = 0, failed = 0, inputRejections = 0;
  let resourceDiscoveryFailures = 0, taskToolFailures = 0, preToolStreamReconnects = 0;
  let firstToolCompleted = false;
  const tools = new Map();
  for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!firstToolCompleted && event?.type === "error" && typeof event.message === "string"
      && /stream disconnected|reconnecting/i.test(event.message)) preToolStreamReconnects += 1;
    if (event?.type !== "item.completed" || event.item?.type !== "mcp_tool_call") continue;
    firstToolCompleted = true;
    const name = typeof event.item.tool === "string" ? event.item.tool : "unknown";
    const resourceDiscovery = name === "list_mcp_resources" || name === "list_mcp_resource_templates";
    completed += 1;
    if (event.item.status === "failed") {
      failed += 1;
      if (resourceDiscovery) resourceDiscoveryFailures += 1;
      else taskToolFailures += 1;
      const message = (event.item.result?.content ?? []).filter((item) => item?.type === "text")
        .map((item) => item.text).filter((item) => typeof item === "string").join("\n").slice(0, 8192);
      if (/Input validation error|cannot be combined with (?:ad-hoc planning options|top-level)|Submitted Charter .* conflicts with top-level/i.test(message)) inputRejections += 1;
    }
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return { completed, failed, inputRejections, resourceDiscoveryFailures, taskToolFailures, preToolStreamReconnects,
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
    + `<td>${value.hostTimeout}</td><td>${value.outcomeFailed}</td><td>${value.answerCheckFailed}</td><td>${value.networkCheckFailed}</td>`
    + `<td>${value.inputRejections}</td><td>${value.missionVerified}/${value.surfaceOnly}</td><td>${value.traceVerified}/${value.planned}</td></tr>`).join("\n");
  const rows = report.cases.map((item) => `<tr><td>${item.taskId}</td><td>${escape(item.official.status)}</td>`
    + `<td>${escape(item.host?.status ?? "missing")}</td><td>${escape(item.host?.testStandard ?? "—")}</td><td>${escape(item.classification.code)}</td>`
    + `<td>${escape(item.official.checks?.answer ?? "—")}</td><td>${item.official.checks ? `${item.official.checks.network.passed}/${item.official.checks.network.failed}/${item.official.checks.network.errors}` : "—"}</td>`
    + `<td>${item.host?.failedToolCalls ?? "—"}/${item.host?.toolCalls ?? "—"}</td><td>${item.host?.resourceDiscoveryFailures ?? "—"}</td>`
    + `<td>${item.host?.preToolStreamReconnects ?? "—"} / ${item.host?.firstToolCallAtMs ?? "—"} ms</td>`
    + `<td>${escape(item.investigationSignals.join(", ") || "—")}</td>`
    + `<td>${escape(item.classification.nextCheck)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ProofKit 基准诊断</title>`
    + `<style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#18212b}`
    + `table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:12px;text-align:left}`
    + `.score{font-size:2rem;font-weight:700}.muted{color:#586470}</style>`
    + `<h1>基准诊断</h1><p class="score">${report.officialEvaluated ? `${report.officialSuccess}/${report.planned} 官方成功` : "官方成绩未测量"}</p>`
    + `<p class="muted">官方已评判 ${report.officialEvaluated}/${report.planned}；未运行题目仍留在固定分母。</p>`
    + `<p class="muted">官方子评判可用 ${report.officialDetailCoverage.available}/${report.officialDetailCoverage.evaluated}；仅保留状态，不复制答案和请求内容。</p>`
    + `<p class="muted">${report.friction.inputRejections} 次工具入参拒绝；${report.friction.resourceDiscoveryFailures} 次 MCP resources 探测失败；首次已完成工具调用前有 ${report.friction.preToolStreamReconnects} 次模型流重连。失败类别表示观察到的阶段，根因须复核证据并重复运行。</p>`
    + `<h2>调查信号</h2><p class="muted">一题可有多个信号；计数是受影响题数，不是已确认根因。</p>`
    + `<p>${Object.entries(report.investigationCounts).map(([signal, count]) => `${escape(signal)}: ${count}`).join(" · ") || "暂无"}</p>`
    + `<h2>任务能力组</h2><p class="muted">按预先固定的任务意图分组；低分是调查线索，不等于已确认的框架根因。</p>`
    + `<table><thead><tr><th>任务组</th><th>官方成功</th><th>已评判/计划</th><th>宿主超时</th><th>结果失败</th><th>回答判分失败</th><th>网络判分失败</th><th>入参拒绝</th><th>Mission/仅表面</th><th>已核验轨迹</th></tr></thead>`
    + `<tbody>${groups}</tbody></table><h2>逐题诊断</h2>`
    + `<table><thead><tr><th>任务</th><th>官方</th><th>宿主</th><th>测试标准</th><th>观察类别</th><th>回答判分</th><th>网络通过/失败/错误</th><th>工具失败/总数</th><th>resources 失败</th><th>首工具前重连/首工具时间</th><th>调查信号</th><th>下一步核查</th></tr></thead>`
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
  const grade = JSON.parse(gradeBytes.toString("utf8"));
  let officialChecks = new Map();
  let officialDetailsSha256 = null;
  try {
    const bytes = await bounded(join(dirname(gradePath), "official-results.json"), MAX_OFFICIAL_BYTES);
    officialChecks = summarizeOfficialChecks(JSON.parse(bytes.toString("utf8")), grade);
    officialDetailsSha256 = sha256(bytes);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
  const report = { ...diagnoseBatch(grade, hosts, officialChecks), provenance: {
    ...provenance, ...(officialDetailsSha256 ? { officialDetailsSha256 } : {}) } };
  await mkdir(resolve(output));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(output, "report.html"), renderDiagnosis(report), { flag: "wx" });
  process.stdout.write(JSON.stringify({ output, officialSuccess: report.officialSuccess,
    planned: report.planned, classificationCounts: report.classificationCounts }) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
