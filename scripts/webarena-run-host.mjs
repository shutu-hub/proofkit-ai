import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { auditWebArenaHostTrace } from "./webarena-host-audit.mjs";
import { benchmarkProfiles, upstreamCommit } from "./webarena-benchmark-lib.mjs";
import { runHost } from "./host-runtime.mjs";
import { captureBenchmarkProvenance, sealBenchmarkProvenance, validBenchmarkModel } from "./benchmark-provenance.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const MCP_SCRIPT = join(dirname(SCRIPT), "webarena-mcp.mjs");
const SERVER = "proofkit_benchmark";
const SITE_TOKENS = { shopping: "__SHOPPING__", shopping_admin: "__SHOPPING_ADMIN__",
  reddit: "__REDDIT__", gitlab: "__GITLAB__" };
const DATASET_SHA256 = "315af52919d4afb5f5f168be58c796d35ff10d65cb49c9b762bf2b8b1c10b6cc";
const execute = promisify(execFile);

/** Execute one prepared public task through a real host CLI; scoring remains a separate trusted step. */
export async function runWebArenaHost({ sessionPath, batchPath, output, host = "codex", cliPath, model, timeoutMs = 600_000 }) {
  if (![sessionPath, batchPath, output].every((path) => typeof path === "string" && isAbsolute(path))
    || !["codex", "claude-code"].includes(host) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 10_000 || timeoutMs > 900_000
    || model !== undefined && !validBenchmarkModel(model)) throw new Error("Invalid benchmark host run options");
  const operator = json(await bounded(sessionPath, 1024 * 1024));
  for (const key of ["root", "workspaceRoot", "captureDirectory", "publicInputPath"]) {
    if (typeof operator[key] !== "string" || !isAbsolute(operator[key])) throw new Error("Invalid benchmark operator paths");
  }
  if (!Number.isSafeInteger(operator.taskId) || operator.taskId < 0
    || !/^[a-f0-9]{64}$/.test(operator.publicInputSha256)) throw new Error("Invalid benchmark task identity");
  const publicBytes = await bounded(operator.publicInputPath, 1024 * 1024);
  if (hash(publicBytes) !== operator.publicInputSha256) throw new Error("Benchmark public task input changed");
  const batch = json(await bounded(join(batchPath, "report.json"), 1024 * 1024));
  const profile = Object.values(benchmarkProfiles).find((entry) => entry.benchmark === batch.benchmark);
  if (!profile || !profile.taskIds.includes(operator.taskId)
    || batch.provenance?.upstreamCommit !== upstreamCommit
    || batch.provenance?.datasetSha256 !== DATASET_SHA256
    || !Array.isArray(batch.taskIds) || JSON.stringify(batch.taskIds) !== JSON.stringify(profile.taskIds)
    || batch.publicInputSha256 !== operator.publicInputSha256
    || resolve(operator.publicInputPath) !== resolve(batchPath, "agent-input", "tasks.json")) {
    throw new Error("Prepared public benchmark batch does not match the operator");
  }
  const tasks = JSON.parse(publicBytes.toString("utf8"));
  const task = Array.isArray(tasks) && tasks.filter((value) => value?.taskId === operator.taskId);
  if (!task || task.length !== 1) throw new Error("Benchmark task selection is ambiguous");
  const selected = task[0];
  const allowed = new Set(["taskId", "revision", "sites", "intent", "startUrls", "startUrlContext", "formatSpecification"]);
  if (tasks.some((value) => !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key)))) throw new Error("Unprojected benchmark task input");
  const token = selected.sites?.length === 1 ? SITE_TOKENS[selected.sites[0]] : undefined;
  if (!token || selected.startUrls?.length !== 1 || typeof selected.startUrls[0] !== "string"
    || !selected.startUrls[0].startsWith(token) || typeof selected.intent !== "string") {
    throw new Error("Host runner requires one projected pilot site and start URL");
  }
  const start = new URL(operator.browser?.startUrl);
  if (!["http:", "https:"].includes(start.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(start.hostname)
    || start.username || start.password || start.hash) throw new Error("Benchmark browser must start at a loopback site");
  const taskSuffix = selected.startUrls[0].slice(token.length);
  const expectedPath = selected.sites[0] === "shopping_admin" ? `/admin${taskSuffix}` : taskSuffix || "/";
  if (`${start.pathname}${start.search}` !== expectedPath) {
    throw new Error("Benchmark browser start URL does not match the selected public task");
  }
  try { await access(operator.captureDirectory); throw new Error("Benchmark capture directory must be new"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const outputRoot = resolve(output);
  const parent = await realpath(dirname(outputRoot));
  const canonicalOutput = join(parent, basename(outputRoot));
  for (const path of [operator.root, operator.workspaceRoot, operator.captureDirectory,
    batchPath, dirname(dirname(SCRIPT))]) {
    const forbidden = await realpath(path).catch(() => resolve(path));
    if (within(canonicalOutput, forbidden) || within(forbidden, canonicalOutput)) {
      throw new Error("Benchmark host output must be separate from source, workspace, capture and public inputs");
    }
  }
  const launcher = await resolveLauncher(cliPath, host);
  if (host === "codex") await ensureCodexMcpIsolation(launcher);
  await mkdir(outputRoot); // Immutable run directory. Never resume a possibly partial host attempt.
  const agentDir = join(outputRoot, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "task.json"), JSON.stringify(selected, null, 2) + "\n", { flag: "wx" });
  const prompt = `Use the ProofKit MCP server ${SERVER} to complete one WebArena-Verified public task.\n`
    + `Task ID: ${selected.taskId}\nIntent: ${selected.intent}\n`
    + `The owned browser starts at ${start.href}. Use only this ProofKit MCP for browser actions.\n`
    + `This server exposes tools, not MCP resources or resource templates; do not call resource discovery APIs.\n`
    + `Inspect the page, then use interact_surface for individual goto/click/fill/press/selectOption/selectOptions/setChecked actions; it preserves task browser state and returns a compact observation, not a success verdict. Prefer unique control.selector hints from the latest inspection. If an action fails with surface-target-ambiguous or runner-action-timeout, inspect again and change the target instead of repeating the failed selector. Native form hints distinguish single and multiple selects; selectOptions replaces the complete selected set. `
    + `After the requested end state is visible, use run_test for a Mission that checks the actual task claim, not just incidental page text. `
    + `For an inline Charter, put action/assertion kinds inside charter and do not also supply top-level url, expect, mode or sideEffectPolicy. `
    + `A click Charter needs sideEffectPolicy=allow. If the requested end state is visible, stop repeating the workflow.\n`
    + `For RETRIEVE, derive the answer from observed results. Check the relevant scope, filters, ordering, pagination and ties before claiming an aggregate or top result; use inspect_surface.readText on a unique result region with continuation when the overview is incomplete. `
    + `A passing text-visible assertion proves only that the text appeared. If the exact answer remains unsupported, submit an error status and explain the uncertainty. `
    + `Reserve time to submit before the host deadline; stop open-ended exploration when there is not enough time to verify the result.\n`
    + `You MUST call submit_benchmark_task exactly once before your final message, even if the task fails. `
    + `Infer task_type as RETRIEVE, NAVIGATE or MUTATE from the intent. Submit status SUCCESS only when the observed `
    + `result supports it; use an error status otherwise. For RETRIEVE, SUCCESS requires an observed nonempty answer. `
    + `If the correctly scoped search is verified empty, use NOT_FOUND_ERROR with retrieved_data=null; `
    + `if the search scope or answer remains uncertain, use UNKNOWN_ERROR with retrieved_data=null. `
    + `For NAVIGATE use retrieved_data=null; always include error_details.\n`
    + `await_test_result timeoutMs must be at most 30000; repeat the call for longer Missions. `
    + `Report uncertainty in your final explanation.\n`
    + `Do not use shell or filesystem tools to perform the task or alter benchmark artifacts.`;
  await writeFile(join(agentDir, "prompt.txt"), prompt + "\n", { flag: "wx" });
  const eventsPath = join(outputRoot, "host-events.jsonl");
  const args = host === "codex" ? await codexArgs(launcher.prefix, sessionPath, agentDir, operator.workspaceRoot, prompt, model)
    : await claudeArgs(launcher.prefix, sessionPath, agentDir, prompt, model);
  let provenance;
  try { provenance = await captureBenchmarkProvenance({ root: dirname(dirname(SCRIPT)), launcher,
    host, model, prompt, operatorPath: sessionPath, timeoutMs }); }
  catch {
    const report = { schemaVersion: 1, taskId: selected.taskId, host, status: "infrastructure-blocked",
      reason: "execution-provenance-unavailable", officialScore: "not-run", proofkitEffectiveness: "not-measured" };
    await save(join(outputRoot, "host-run.json"), report);
    return report;
  }
  await save(join(outputRoot, "execution-input.json"), provenance);
  let execution;
  try { execution = await runHost(launcher.executable, args, agentDir, timeoutMs, eventsPath); }
  catch (error) {
    const report = { schemaVersion: 1, taskId: selected.taskId, host, status: "incomplete",
      reason: "host-process-unavailable", detail: String(error.message).slice(0, 300),
      officialScore: "not-run", proofkitEffectiveness: "not-measured" };
    await save(join(outputRoot, "host-run.json"), report);
    return report;
  }
  provenance = await sealBenchmarkProvenance(provenance, { root: dirname(dirname(SCRIPT)), launcher,
    host, model, transcript: execution.transcript, eventsPath, operatorPath: sessionPath });
  await save(join(outputRoot, "execution-provenance.json"), provenance);
  let audit;
  if (provenance.sealStatus === "complete" && !execution.timedOut && execution.code === 0 && !execution.blocker) {
    try { audit = await auditWebArenaHostTrace({ operatorPath: sessionPath, eventsPath, host, serverName: SERVER }); }
    catch (error) { audit = { status: "incomplete", issues: ["benchmark-capture-not-auditable"],
      detail: String(error.message).slice(0, 300) }; }
  }
  let status = audit?.status === "associated" ? "associated"
    : execution.blocker ? "infrastructure-blocked" : "incomplete";
  let submission;
  let stagingIssue;
  if (status === "associated") {
    try {
      const saved = json(await bounded(join(operator.captureDirectory, "task.finished.json"), 1024 * 1024));
      const responseBytes = await bounded(join(operator.captureDirectory, "agent_response.json"), 1024 * 1024);
      const traceBytes = await bounded(join(operator.captureDirectory, "task", "network.har"), 128 * 1024 * 1024);
      if (hash(responseBytes) !== saved.submissionSha256 || hash(traceBytes) !== saved.capture?.sha256) {
        throw new Error("Benchmark submission changed after audit");
      }
      const destination = join(outputRoot, "submissions", String(selected.taskId));
      await mkdir(dirname(destination));
      await mkdir(destination);
      await writeFile(join(destination, "agent_response.json"), responseBytes, { flag: "wx" });
      await writeFile(join(destination, "network.har"), traceBytes, { flag: "wx" });
      submission = { directory: destination, responseSha256: hash(responseBytes), traceSha256: hash(traceBytes) };
    } catch (error) { status = "incomplete"; stagingIssue = String(error.message).slice(0, 300); }
  }
  const report = { schemaVersion: 1, taskId: selected.taskId, host, status,
    sessionInputSha256: operator.publicInputSha256, eventsSha256: provenance.eventsSha256,
    provenance: { path: join(outputRoot, "execution-provenance.json"),
      sha256: hash(await readFile(join(outputRoot, "execution-provenance.json"))),
      model: provenance.model, runtimeStable: provenance.runtimeStable, sealStatus: provenance.sealStatus,
      issues: provenance.issues },
    execution: { code: execution.code, timedOut: execution.timedOut, blocker: execution.blocker,
      stopReason: execution.stopReason, durationMs: execution.durationMs, milestones: execution.milestones },
    ...(audit ? { audit } : {}), ...(submission ? { submission } : {}),
    ...(stagingIssue ? { stagingIssue } : {}),
    officialScore: "not-run", proofkitEffectiveness: "not-measured" };
  await save(join(outputRoot, "host-run.json"), report);
  return report;
}

async function codexArgs(prefix, sessionPath, agentDir, workspaceRoot, prompt, model) {
  const toml = (value) => JSON.stringify(value);
  const overrides = [`mcp_servers.${SERVER}.command=${toml(process.execPath)}`,
    `mcp_servers.${SERVER}.args=${toml([MCP_SCRIPT, "--session", sessionPath])}`,
    `mcp_servers.${SERVER}.required=true`, `mcp_servers.${SERVER}.tool_timeout_sec=60`,
    `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`];
  return [...prefix, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "--cd", agentDir, "--add-dir", workspaceRoot,
    "--output-last-message", join(agentDir, "last-message.txt"), "-c", 'approval_policy="never"',
    ...overrides.flatMap((value) => ["-c", value]), ...(model ? ["--model", model] : []), prompt];
}

async function ensureCodexMcpIsolation(launcher) {
  let servers;
  try {
    const { stdout } = await execute(launcher.executable, [...launcher.prefix, "mcp", "list", "--json"],
      { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 });
    servers = JSON.parse(stdout);
  } catch {
    throw new Error("Cannot verify Codex MCP isolation; use a CLI with `mcp list --json`");
  }
  if (!Array.isArray(servers) || servers.some((server) => typeof server?.name !== "string"
    || typeof server.enabled !== "boolean")) throw new Error("Invalid Codex MCP inventory");
  const ambient = servers.filter((server) => server.enabled && server.name !== SERVER).map((server) => server.name);
  if (ambient.length) throw new Error(`Codex host has enabled ambient MCP servers (${ambient.join(", ")}); use an isolated CODEX_HOME`);
}

async function claudeArgs(prefix, sessionPath, agentDir, prompt, model) {
  const configPath = join(agentDir, "mcp.json");
  await save(configPath, { mcpServers: { [SERVER]: { command: process.execPath,
    args: [MCP_SCRIPT, "--session", sessionPath] } } });
  return [...prefix, "-p", prompt, "--output-format", "stream-json", "--verbose",
    "--mcp-config", configPath, "--strict-mcp-config", "--no-session-persistence",
    "--permission-mode", "dontAsk", "--allowedTools", `mcp__${SERVER}__*`, ...(model ? ["--model", model] : [])];
}

async function resolveLauncher(cliPath, host) {
  const path = cliPath ?? process.env[host === "codex" ? "PROOFKIT_CODEX_CLI" : "PROOFKIT_CLAUDE_CLI"]
    ?? (process.platform === "win32" ? host === "codex"
      ? join(dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js")
      : join(dirname(process.execPath), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
      : host === "codex" ? "codex" : "claude");
  if (!path || /\.(cmd|bat|ps1)$/i.test(path)) throw new Error("Use a native host executable or JavaScript entrypoint, not a shell wrapper");
  if (/\.m?js$/i.test(path)) {
    if (!isAbsolute(path)) throw new Error("Host JavaScript entrypoint must be absolute");
    await access(path);
    return { executable: process.execPath, prefix: [path] };
  }
  if (isAbsolute(path)) await access(path);
  return { executable: path, prefix: [] };
}

function within(path, root) {
  const local = relative(root, path);
  return local === "" || local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function json(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value;
}
async function bounded(path, limit) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid benchmark input size");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("Benchmark input changed while reading");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--session", "--batch", "--output", "--host", "--cli", "--model", "--timeout-ms"].includes(process.argv[i])
      || !process.argv[i + 1] || options.has(process.argv[i])) throw new Error("Invalid host runner arguments");
    options.set(process.argv[i], process.argv[i + 1]);
  }
  if (!options.has("--session") || !options.has("--batch") || !options.has("--output")) {
    throw new Error("Usage: node scripts/webarena-run-host.mjs --session <operator-json> --batch <prepared-dir> --output <new-external-dir> [--host codex|claude-code] [--cli <executable>] [--model <identifier>] [--timeout-ms 600000]");
  }
  const report = await runWebArenaHost({ sessionPath: resolve(options.get("--session")),
    batchPath: resolve(options.get("--batch")), output: resolve(options.get("--output")),
    host: options.get("--host") ?? "codex",
    cliPath: options.get("--cli"), model: options.get("--model"), timeoutMs: Number(options.get("--timeout-ms") ?? 600_000) });
  console.log(JSON.stringify({ status: report.status, taskId: report.taskId,
    report: join(resolve(options.get("--output")), "host-run.json"), officialScore: "not-run" }));
  if (report.status !== "associated") process.exitCode = 1;
}
