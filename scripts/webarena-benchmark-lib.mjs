import { createHash } from "node:crypto";

export const upstreamCommit = "6473f72db5dcefc97b5725b59e734504edc28a21";
export const pilotTaskIds = [0, 21, 27, 44, 108, 118, 132, 157, 389, 399, 423, 431];
export const benchmarkProfiles = Object.freeze({
  "pilot-12": Object.freeze({ benchmark: "webarena-verified-pilot-v1", taskIds: pilotTaskIds,
    sites: ["shopping_admin", "shopping", "reddit", "gitlab"] }),
  "shopping-admin-4": Object.freeze({ benchmark: "webarena-verified-shopping-admin-4-v1",
    taskIds: [0, 108, 157, 423], sites: ["shopping_admin"] }),
  "shopping-admin-12": Object.freeze({ benchmark: "webarena-verified-shopping-admin-12-v1",
    taskIds: [0, 11, 77, 94, 108, 119, 374, 453, 470, 496, 501, 679], sites: ["shopping_admin"] }),
});
export function benchmarkProfile(name = "pilot-12") {
  const profile = benchmarkProfiles[name];
  if (!profile) throw new Error(`Unknown WebArena benchmark profile: ${name}`);
  return profile;
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Explicit projection: new upstream evaluator fields must not leak into an
// agent task simply because they were added to the dataset.
export function publicTask(task) {
  return {
    taskId: task.task_id, revision: task.revision, sites: task.sites,
    intent: task.intent, startUrls: task.start_urls,
    ...(task.start_url_context ? { startUrlContext: task.start_url_context } : {}),
    ...(task.format_specification ? { formatSpecification: task.format_specification } : {}),
  };
}

export function selectTasks(dataset, ids = pilotTaskIds) {
  if (!Array.isArray(dataset) || !ids.length || new Set(ids).size !== ids.length
    || ids.some((id) => !Number.isInteger(id) || id < 0)) throw new Error("Invalid task selection");
  const byId = new Map(dataset.map((task) => [task.task_id, task]));
  if (byId.size !== dataset.length) throw new Error("Duplicate dataset task ID");
  return ids.map((id) => {
    const task = byId.get(id);
    if (!task || !Array.isArray(task.eval) || !task.eval.length || typeof task.intent !== "string"
      || !Array.isArray(task.start_urls) || !Array.isArray(task.sites)) throw new Error(`Invalid or missing task ${id}`);
    return task;
  });
}

export function scorecard(mode, planned, cases) {
  if (!["prepared-batch", "upstream-replay-controls", "imported-submissions"].includes(mode)) throw new Error("Unknown evaluation mode");
  const evaluated = cases.filter((item) => ["success", "failure", "partial_match"].includes(item.status));
  const success = evaluated.filter((item) => item.status === "success" && item.score === 1).length;
  return {
    mode, planned, attempted: cases.filter((item) => item.status !== "not-run").length,
    evaluated: evaluated.length, successful: success,
    errors: cases.filter((item) => item.status === "error").length,
    notRun: cases.filter((item) => item.status === "not-run").length,
    taskSuccessOverPlanned: mode === "imported-submissions" && planned && cases.some((item) => item.status !== "not-run") ? success / planned : null,
    taskSuccessOverEvaluated: mode === "imported-submissions" && evaluated.length ? success / evaluated.length : null,
    proofkitEffectiveness: "not-measured", defectDetectionRate: null,
    liveAgentExecution: "not-verified", productVerdict: "not-asserted",
    ...(mode === "upstream-replay-controls" ? {
      controlsMatched: cases.filter((item) => item.controlMatched).length,
      controlsMismatched: cases.filter((item) => !item.controlMatched).length,
    } : {}),
  };
}

export function renderScorecard(report) {
  const escape = (value) => String(value ?? "—").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const rows = report.cases.map((item) => `<tr><td>${escape(item.caseId ?? item.taskId)}</td><td>${escape(item.status)}</td><td>${escape(item.score)}</td><td>${escape(item.controlMatched)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ProofKit · WebArena</title>
<style>body{font:16px system-ui;max-width:960px;margin:48px auto;padding:0 24px;color:#20252b}small{color:#58616c}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}code{word-break:break-all}</style>
<h1>WebArena-Verified 评测</h1><p>模式：${escape(report.summary.mode)}</p>
<p>计划 ${report.summary.planned} · 已评判 ${report.summary.evaluated} · 成功 ${report.summary.successful} · 错误 ${report.summary.errors} · 未运行 ${report.summary.notRun}</p>
${report.summary.mode === "upstream-replay-controls" ? `<p>评判对照：${report.summary.controlsMatched}/${report.summary.planned} 符合预期（包括预期错误）。</p>` : ""}
${report.environment ? `<p>环境：${escape(report.environment.docker?.reason ?? report.environment.docker?.status)} · 真实执行：${escape(report.environment.liveExecution)}</p>` : ""}
<p>ProofKit 自主测试水平：尚未测量。产品验收：未声明。</p>
<p><small>回放对照仅验证官方评判接口；导入成绩不证明模型使用了 ProofKit。缺失任务保留在分母中。</small></p>
<table><thead><tr><th>任务/对照</th><th>官方结果</th><th>任务得分</th><th>对照符合预期</th></tr></thead><tbody>${rows}</tbody></table>
<p><small>上游 <code>${escape(report.provenance.upstreamCommit)}</code><br>数据 SHA-256 <code>${escape(report.provenance.datasetSha256)}</code></small></p></html>`;
}
