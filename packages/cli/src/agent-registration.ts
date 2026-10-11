import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import type { setupAgent } from "./agent-setup.js";

type AgentSetup = Awaited<ReturnType<typeof setupAgent>>;
type HostCommand = { executable: string; prefix: string[] };
type CommandResult = { code: number | null; output: string; stdout: string; timedOut: boolean; oversized: boolean };

export type HostRegistration = {
  status: "registered" | "review-required" | "blocked" | "unverified";
  phase: "inspect" | "add" | "verify";
  serverName: string;
  issue?: string;
};

/** Register only after an explicit CLI opt-in and a successful local connection check. */
export async function registerAgentHost(setup: AgentSetup, options: { hostCliPath?: string; timeoutMs?: number } = {}): Promise<HostRegistration> {
  const { harness, connection } = setup;
  if (!connection.registration) throw new Error("This harness requires its own MCP configuration workflow");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Host registration timeout must be 1000–60000 milliseconds");
  const host = await resolveHostCommand(connection.registration.command, options.hostCliPath);
  const base = { serverName: connection.serverName };
  const getArgs = harness === "codex" ? ["mcp", "get", "--json", connection.serverName] : ["mcp", "get", connection.serverName];
  const before = await run(host, getArgs, timeoutMs);
  if (before.timedOut || before.oversized) return { ...base, status: "blocked", phase: "inspect", issue: before.timedOut ? "host-inspection-timeout" : "host-inspection-output-limit" };
  if (before.code === 0) return { ...base, status: "review-required", phase: "inspect", issue: "host-server-name-already-present" };
  if (!/No MCP server named\b/i.test(before.output)) return { ...base, status: "blocked", phase: "inspect", issue: "host-inspection-failed" };

  const added = await run(host, connection.registration.args, timeoutMs);
  if (added.timedOut || added.oversized) return { ...base, status: "unverified", phase: "add", issue: added.timedOut ? "host-add-timeout" : "host-add-output-limit" };
  if (added.code !== 0) return { ...base, status: "unverified", phase: "add", issue: "host-add-failed" };
  const verified = await run(host, getArgs, timeoutMs);
  if (verified.code !== 0 || verified.timedOut || verified.oversized) return { ...base, status: "unverified", phase: "verify", issue: "host-registration-not-verified" };
  if (!matchesRegistration(harness, verified.stdout, setup)) {
    return { ...base, status: "unverified", phase: "verify", issue: "host-registration-mismatch" };
  }
  return { ...base, status: "registered", phase: "verify" };
}

function matchesRegistration(harness: AgentSetup["harness"], output: string, setup: AgentSetup): boolean {
  const { connection } = setup;
  if (harness === "codex") {
    try {
      const entry = JSON.parse(output) as { name?: unknown; transport?: { type?: unknown; command?: unknown; args?: unknown; env?: unknown } };
      const transport = entry.transport;
      return entry.name === connection.serverName && transport?.type === "stdio"
        && transport.command === connection.command
        && JSON.stringify(transport.args) === JSON.stringify(connection.args)
        && sameEnvironment(transport.env, connection.env);
    } catch { return false; }
  }
  // Claude Code's `mcp get` has no JSON option. Match its named user-scope
  // stdio entry and every launcher field, without treating connection health
  // as proof of a product test.
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const expected = [
    `${connection.serverName}:`,
    "  Scope: User config (available in all your projects)",
    "  Type: stdio",
    `  Command: ${connection.command}`,
    `  Args: ${connection.args.join(" ")}`,
    ...Object.entries(connection.env).map(([key, value]) => `    ${key}=${value}`),
  ];
  return expected.every((line) => lines.includes(line));
}

function sameEnvironment(actual: unknown, expected: Record<string, string>): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual);
  return entries.length === Object.keys(expected).length
    && entries.every(([key, value]) => expected[key] === value);
}

async function resolveHostCommand(name: string, explicit?: string): Promise<HostCommand> {
  if (explicit) {
    const path = resolve(explicit);
    if (!(await isFile(path))) throw new Error("Host CLI path must name an existing file");
    return executable(path);
  }
  if (process.platform !== "win32") return { executable: name, prefix: [] };
  const search = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of search) {
    const candidates = name === "claude"
      ? [join(directory, "claude.exe"), join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")]
      : [join(directory, "codex.exe"), join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")];
    for (const path of candidates) if (await isFile(path)) return executable(path);
  }
  throw new Error(`No shell-free ${name} executable was found; provide --host-cli with a native executable or JavaScript entrypoint`);
}

function executable(path: string): HostCommand {
  const extension = extname(path).toLowerCase();
  if (extension === ".js" || extension === ".mjs") return { executable: process.execPath, prefix: [path] };
  if ([".cmd", ".bat", ".ps1"].includes(extension)) throw new Error("Shell wrapper host CLIs are not executed; provide a native executable or JavaScript entrypoint");
  if (process.platform === "win32" && extension !== ".exe") {
    throw new Error("On Windows, --host-cli must be a native .exe or JavaScript entrypoint; shell wrappers are not executed");
  }
  return { executable: path, prefix: [] };
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function run(host: HostCommand, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(host.executable, [...host.prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let stdout = "";
    let outputBytes = 0;
    let oversized = false;
    let timedOut = false;
    let settled = false;
    let forceFinish: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceFinish) clearTimeout(forceFinish);
      resolveResult({ code, output, stdout, timedOut, oversized });
    };
    const stop = () => {
      child.kill();
      forceFinish ??= setTimeout(() => finish(null), 1_000);
    };
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      outputBytes += chunk.length;
      if (outputBytes > 16 * 1024) {
        oversized = true;
        stop();
      } else {
        const value = chunk.toString("utf8");
        output += value;
        if (stream === "stdout") stdout += value;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    const deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
}
