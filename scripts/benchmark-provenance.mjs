/** Trusted controller metadata. Never persists raw host config or model messages. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const validBenchmarkModel = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);

/** Only documented Claude model fields are accepted; tool results cannot supply model identity. */
export function summarizeReportedModel(jsonl, host, requested = null) {
  const models = new Set(), sources = new Set();
  if (host === "claude-code") for (const line of jsonl.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const model = event?.type === "system" && event.subtype === "init" ? event.model
      : event?.type === "assistant" ? event.message?.model : null;
    if (validBenchmarkModel(model)) {
      models.add(model);
      sources.add(event.type === "system" ? "system-init" : "assistant-message");
    }
  }
  const reported = [...models].sort();
  return { requested, reported, sources: [...sources].sort(),
    status: reported.length ? "host-reported" : requested ? "requested-only" : "unknown",
    identifiers: reported.length > 1 ? "multiple-reported-identifiers"
      : requested && reported.length ? reported[0] === requested ? "same-identifier" : "different-identifiers" : "not-compared",
    providerIdentityVerified: false };
}

/** Hash the actual unbundled MCP runtime, not merely the separate npm distribution bundle. */
export async function runtimeFingerprint(root, launcher) {
  const paths = ["pnpm-lock.yaml", "scripts/webarena-mcp.mjs", "scripts/webarena-run-host.mjs",
    "scripts/host-runtime.mjs", "scripts/benchmark-provenance.mjs"];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) paths.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(join(root, "packages", entry.name, "dist"));
  }
  const files = {};
  for (const path of paths.sort()) files[path] = hash(await readFile(join(root, path)));
  const launcherPath = launcher.prefix[0] ?? launcher.executable;
  const launcherSha256 = isAbsolute(launcherPath) ? hash(await readFile(launcherPath)) : null;
  return { files, launcherSha256, digest: hash(JSON.stringify({ files, launcherSha256 })) };
}

export async function captureBenchmarkProvenance({ root, launcher, host, model, prompt, operatorPath, timeoutMs }) {
  const runtime = await runtimeFingerprint(root, launcher);
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim();
  const dirty = Boolean((await execute("git", ["status", "--porcelain"], { cwd: root, windowsHide: true })).stdout.trim());
  let cliVersion = null;
  try {
    const version = (await execute(launcher.executable, [...launcher.prefix, "--version"],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 })).stdout.trim();
    if (/^(?:codex-cli \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?(?: \(Claude Code\))?)$/.test(version)) cliVersion = version;
  } catch { /* Missing version is visible, never replaced with inferred identity. */ }
  let hostConfigSha256 = null;
  if (host === "codex" && process.env.CODEX_HOME) {
    try { hostConfigSha256 = hash(await readFile(join(process.env.CODEX_HOME, "config.toml"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { schemaVersion: 1, startedAt: new Date().toISOString(), proofkitCommit: head,
    proofkitDirty: dirty, nodeVersion: process.version, platform: process.platform, arch: process.arch,
    host, cliVersion, model: summarizeReportedModel("", host, model ?? null),
    timeoutMs, promptSha256: hash(prompt + "\n"), operatorSha256: hash(await readFile(operatorPath)),
    hostConfigSha256, runtime, comparisonStatus: "single-observation-not-causal-improvement" };
}

/** Preserve a terminal run even when files disappear or change during execution. */
export async function sealBenchmarkProvenance(input, { root, launcher, host, model, transcript, eventsPath, operatorPath }) {
  const result = { ...input, model: summarizeReportedModel(transcript, host, model ?? null),
    finishedAt: new Date().toISOString(), eventsSha256: null, runtimeStable: null,
    operatorStable: null, hostConfigStable: null, sealStatus: "complete", issues: [] };
  for (const [name, action] of [
    ["events-unavailable", async () => { result.eventsSha256 = hash(await readFile(eventsPath)); }],
    ["runtime-unavailable", async () => { result.runtimeStable = (await runtimeFingerprint(root, launcher)).digest === input.runtime.digest; }],
    ["operator-unavailable", async () => { result.operatorStable = hash(await readFile(operatorPath)) === input.operatorSha256; }],
    ["host-config-unavailable", async () => {
      if (input.hostConfigSha256 !== null) result.hostConfigStable =
        hash(await readFile(join(process.env.CODEX_HOME, "config.toml"))) === input.hostConfigSha256;
    }],
  ]) {
    try { await action(); } catch { result.issues.push(name); }
  }
  if (result.runtimeStable === false) result.issues.push("runtime-changed");
  if (result.operatorStable === false) result.issues.push("operator-changed");
  if (result.hostConfigStable === false) result.issues.push("host-config-changed");
  if (result.issues.length) result.sealStatus = "incomplete";
  return result;
}
