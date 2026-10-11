import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { TargetBindingSchema, type TargetBinding } from "@proofkit/contracts";
import { sameProjectPath } from "./context.js";

const execFileAsync = promisify(execFile);
const CODE_EXTENSIONS = /\.(?:cjs|exe|jar|js|mjs|py)$/i;
const GENERIC_RUNTIMES = new Set(["chrome", "chrome.exe", "chromium", "chromium.exe", "electron", "electron.exe", "java", "java.exe", "msedge", "msedge.exe", "node", "node.exe", "python", "python.exe", "python3", "python3.exe"]);
const WINDOWS_LISTENER_TIMEOUT_MS = 25_000;

type ListenerProcess = { processId: number; executablePath?: string; commandLine?: string; codePaths?: string[] };
export type ProcessRootObservation = { processId: number; projectRoot?: string };
type LinuxInspectionStage = "socket-table" | "socket-parse" | "process-list" | "process-metadata" | "fd-list" | "fd-links" | "code-paths";

class LinuxListenerInspectionError extends Error {
  constructor(readonly stage: LinuxInspectionStage, readonly systemCode?: string) {
    super("Linux listener inspection could not be completed");
  }
}

/**
 * Inspect a loopback listener without executing any application-supplied text.
 * Only the owning PID and a derived Git root enter saved evidence. The process
 * command line stays in memory because it may contain credentials.
 */
export async function inspectTargetBinding(projectRoot: string, targetUrl?: string, signal?: AbortSignal): Promise<TargetBinding> {
  signal?.throwIfAborted();
  const expectedProjectRoot = resolve(projectRoot);
  const observedAt = new Date().toISOString();
  const unavailable = (reason: string, targetOrigin?: string): TargetBinding => TargetBindingSchema.parse({
    status: "unverified", method: "unavailable", expectedProjectRoot, targetOrigin, reason, observedAt,
  });
  if (!targetUrl) return unavailable("No HTTP target URL was configured for source association.");
  let target: URL;
  try { target = new URL(targetUrl); }
  catch { return unavailable("The configured target URL is invalid."); }
  if (!["http:", "https:"].includes(target.protocol)) {
    return unavailable("Only loopback HTTP targets support local listener inspection.");
  }
  if (!isLoopback(target.hostname)) return unavailable("Only loopback HTTP targets support local listener inspection.", target.origin);
  if (process.platform !== "win32" && process.platform !== "linux") {
    return unavailable("Local listener process inspection is not yet supported on this platform.", target.origin);
  }
  const expectedGitRoot = await gitRoot(expectedProjectRoot, signal);
  if (!expectedGitRoot || !sameProjectPath(expectedGitRoot, expectedProjectRoot)) {
    return unavailable("The selected source root is not a Git repository root.", target.origin);
  }
  try {
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const listeners = process.platform === "win32" ? await windowsListeners(port, target.hostname, signal) : await linuxListeners(port, target.hostname, signal);
    if (listeners.length === 0) return unavailable("No local listener process was found for the target address and port.", target.origin);
    const observed: ProcessRootObservation[] = [];
    for (const listener of listeners) {
      const roots = await Promise.all((listener.codePaths ?? runtimeCodePaths(listener)).map((path) => gitRoot(dirname(path), signal)));
      const distinct = uniqueRoots(roots.filter((root): root is string => Boolean(root)));
      observed.push({ processId: listener.processId, ...(distinct.length === 1 ? { projectRoot: distinct[0] } : {}) });
    }
    return classifyTargetBinding(expectedProjectRoot, target.origin, observed, observedAt,
      process.platform === "linux" ? "linux-proc-listener" : "windows-listener-process");
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof LinuxListenerInspectionError
      ? `Linux listener inspection stopped at ${error.stage}${error.systemCode ? ` (${error.systemCode})` : ""}; source ownership is unverified.`
      : "Local listener process inspection failed or exceeded its deadline.";
    return unavailable(reason, target.origin);
  }
}

/** An ambiguous listener or process command line never proves a mismatch. */
export function classifyTargetBinding(expectedProjectRoot: string, targetOrigin: string, observed: ProcessRootObservation[],
  observedAt = new Date().toISOString(), method: "windows-listener-process" | "linux-proc-listener" = "windows-listener-process"): TargetBinding {
  const base = { method, expectedProjectRoot: resolve(expectedProjectRoot), targetOrigin, observedAt };
  if (observed.length === 0 || observed.some((item) => !item.projectRoot)) {
    return TargetBindingSchema.parse({ ...base, status: "unverified", reason: "The listener's application code path could not be associated with one Git checkout." });
  }
  const roots = uniqueRoots(observed.map((item) => item.projectRoot!));
  if (roots.length !== 1) {
    return TargetBindingSchema.parse({ ...base, status: "unverified", reason: "Multiple listener code paths point to different Git checkouts." });
  }
  const observedProjectRoot = roots[0]!;
  const processId = observed.length === 1 ? observed[0]!.processId : undefined;
  if (sameProjectPath(observedProjectRoot, expectedProjectRoot)) {
    return TargetBindingSchema.parse({ ...base, status: "matching-process-path", observedProjectRoot, processId,
      reason: "The listener code path is under the selected Git checkout; served bytes are not attested." });
  }
  return TargetBindingSchema.parse({ ...base, status: "different-project", observedProjectRoot, processId,
    reason: "The target port is owned by a process whose code path belongs to a different Git checkout." });
}

function runtimeCodePaths(listener: ListenerProcess): string[] {
  const candidates = [listener.executablePath, ...windowsCommandCodePaths(listener.commandLine ?? "")]
    .filter((path): path is string => typeof path === "string" && CODE_EXTENSIONS.test(path));
  return [...new Set(candidates.filter((path) => !GENERIC_RUNTIMES.has(basename(path).toLowerCase()) && existsSync(path)).map((path) => resolve(path)))].slice(0, 8);
}

export function windowsCommandCodePaths(commandLine: string): string[] {
  const arguments_: string[] = [];
  let argument = "";
  let quoted = false;
  for (const character of commandLine) {
    if (character === '"') { quoted = !quoted; continue; }
    if (/\s/.test(character) && !quoted) {
      if (argument) arguments_.push(argument);
      argument = "";
    } else argument += character;
  }
  if (quoted) return [];
  if (argument) arguments_.push(argument);
  return arguments_.filter((path) => /^[A-Za-z]:[\\/]/.test(path) && CODE_EXTENSIONS.test(path));
}

async function windowsListeners(port: number, hostname: string, signal?: AbortSignal): Promise<ListenerProcess[]> {
  const addresses = targetListenerAddresses(hostname).map((address) => `'${address}'`).join(",");
  const ipv4Target = /^127(?:\.\d{1,3}){3}$/.test(hostname) ? "$true" : "$false";
  const script = String.raw`
$port = ${port}
$addresses = @(${addresses})
$connections = @()
try { $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) }
catch { if ($_.FullyQualifiedErrorId -ne 'CmdletizationQuery_NotFound,Get-NetTCPConnection') { throw } }
$processIds = @($connections | Where-Object { $addresses -contains $_.LocalAddress } | Select-Object -ExpandProperty OwningProcess -Unique)
if ($processIds.Count -eq 0 -and ${ipv4Target}) {
  # Get-NetTCPConnection can expose a dual-stack socket only as ::. Netstat's
  # IPv4 row is needed before associating it with an IPv4 target.
  $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
  foreach ($line in @(& $netstatPath -ano -p TCP)) {
    if ($line -match '^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $endpoint = $Matches[1]
      $ownerId = [int]$Matches[2]
      if (($endpoint -eq "0.0.0.0:$port" -or $endpoint -eq "${hostname}:$port") -and $ownerId -gt 0) {
        $processIds += $ownerId
      }
    }
  }
}
$processIds = @($processIds | Sort-Object -Unique)
if ($processIds.Count -gt 8) { throw 'Too many listener processes' }
$items = @($processIds | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine
})
ConvertTo-Json -InputObject $items -Compress -Depth 3`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    // The first NetTCP/CIM query on a fresh hosted Windows runner can exceed 10s.
    encoding: "utf8", timeout: WINDOWS_LISTENER_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, signal,
  });
  const value: unknown = JSON.parse(stdout.trim() || "[]");
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((item): ListenerProcess[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const processId = Number(record.ProcessId);
    if (!Number.isInteger(processId) || processId <= 0) return [];
    return [{
      processId,
      ...(typeof record.ExecutablePath === "string" ? { executablePath: record.ExecutablePath } : {}),
      ...(typeof record.CommandLine === "string" ? { commandLine: record.CommandLine } : {}),
    }];
  });
}

function targetListenerAddresses(hostname: string): string[] {
  const host = hostname.toLowerCase();
  if (host === "localhost") return ["127.0.0.1", "0.0.0.0", "::1", "::"];
  if (host === "::1" || host === "[::1]") return ["::1", "::"];
  // inspectTargetBinding has already accepted only a numeric 127/8 host.
  return [host, "0.0.0.0"];
}

/** Match listening socket inodes before inspecting processes. No command line is persisted. */
async function linuxListeners(port: number, hostname: string, signal?: AbortSignal): Promise<ListenerProcess[]> {
  let stage: LinuxInspectionStage = "socket-table";
  try {
    const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async (path) => {
      try { return await readLinuxSocketTable(path, signal); }
      catch (error) { if (vanished(error)) return undefined; throw error; }
    }));
    if (tables.every((table) => table === undefined)) throw new Error("Linux socket tables are unavailable");
    const ownUid = process.getuid?.();
    stage = "socket-parse";
    const inodes = parseLinuxListeningInodes(tables.filter((table): table is string => table !== undefined), port, ownUid, hostname);
    if (inodes.size === 0) return [];

    const deadline = Date.now() + 8_000;
    stage = "process-list";
    const entries = (await readdir("/proc", { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
    if (entries.length > 4_096) throw new Error("Linux process inspection exceeds its bound");
    const listeners: ListenerProcess[] = [];
    let inspectedFds = 0;
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error("Linux process inspection exceeded its deadline");
      const pid = Number(entry.name);
      const procDir = `/proc/${entry.name}`;
      stage = "process-metadata";
      try {
        if (ownUid !== undefined && ownUid !== 0 && (await stat(procDir)).uid !== ownUid) continue;
      } catch (error) {
        if (vanished(error)) continue;
        throw error;
      }
      let fds: string[];
      stage = "fd-list";
      try { fds = await readdir(`${procDir}/fd`); }
      catch (error) { if (vanished(error)) continue; throw error; }
      if (fds.length > 4_096 || (inspectedFds += fds.length) > 131_072) {
        throw new Error("Linux file descriptor inspection exceeds its bound");
      }
      let ownsSocket = false;
      for (let index = 0; index < fds.length && !ownsSocket; index += 32) {
        stage = "fd-links";
        signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error("Linux process inspection exceeded its deadline");
        const links = await Promise.allSettled(fds.slice(index, index + 32).map((fd) => readlink(`${procDir}/fd/${fd}`)));
        for (const link of links) {
          if (link.status === "rejected") { if (!vanished(link.reason)) throw link.reason; continue; }
          const match = /^socket:\[(\d+)\]$/.exec(link.value);
          if (match && inodes.has(match[1]!)) ownsSocket = true;
        }
      }
      if (ownsSocket) {
        stage = "code-paths";
        listeners.push({ processId: pid, codePaths: await linuxRuntimeCodePaths(procDir) });
      }
    }
    return listeners;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new LinuxListenerInspectionError(stage, typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined);
  }
}

async function readLinuxSocketTable(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(65_536);
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > 8 * 1024 * 1024) throw new Error("Linux socket table exceeds its read bound");
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await handle.close(); }
}

/** Pure parser for /proc/net/tcp{,6}; unknown or foreign owners cannot prove one local target. */
export function parseLinuxListeningInodes(tables: string[], port: number, ownUid?: number, hostname?: string): Set<string> {
  const inodes = new Set<string>();
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const localPort = Number.parseInt(fields[1]?.split(":").at(-1) ?? "", 16);
      if (fields[3] !== "0A" || localPort !== port || !linuxAddressMatchesTarget(fields[1] ?? "", hostname)) continue;
      const uid = Number(fields[7]);
      if (!Number.isInteger(uid) || !/^\d+$/.test(fields[9] ?? "")) throw new Error("Linux listener socket metadata is incomplete");
      if (ownUid !== undefined && ownUid !== 0 && uid !== ownUid) throw new Error("Linux listener socket belongs to another user");
      inodes.add(fields[9]!);
    }
  }
  return inodes;
}

function linuxAddressMatchesTarget(local: string, hostname?: string): boolean {
  if (!hostname) return true;
  const address = local.split(":")[0]?.toUpperCase();
  const host = hostname.toLowerCase();
  if (address?.length === 8) {
    if (address === "00000000") return host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host);
    const ipv4 = host === "localhost" ? "127.0.0.1" : host;
    if (!/^127(?:\.\d{1,3}){3}$/.test(ipv4)) return false;
    const octets = ipv4.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return address === octets.reverse().map((octet) => octet.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  if (address?.length === 32 && (host === "localhost" || host === "::1" || host === "[::1]")) {
    return address === "00000000000000000000000000000000" || address === "00000000000000000000000001000000";
  }
  return false;
}

async function linuxRuntimeCodePaths(procDir: string): Promise<string[]> {
  let argv: string[];
  let cwd: string | undefined;
  let executable: string | undefined;
  try {
    const [rawArgv, rawCwd, rawExecutable] = await Promise.all([
      readFile(`${procDir}/cmdline`), readlink(`${procDir}/cwd`), readlink(`${procDir}/exe`),
    ]);
    if (rawArgv.length > 65_536) throw new Error("Linux process command line exceeds its bound");
    argv = rawArgv.toString("utf8").split("\0").filter(Boolean);
    cwd = rawCwd;
    executable = rawExecutable;
  } catch (error) {
    if (vanished(error)) return [];
    throw error;
  }
  const rawPaths = [executable, ...argv.filter((arg) => CODE_EXTENSIONS.test(arg))].filter((path): path is string => Boolean(path));
  const paths: string[] = [];
  for (const candidate of rawPaths) {
    if (GENERIC_RUNTIMES.has(basename(candidate).toLowerCase())) continue;
    if (!isAbsolute(candidate) && !cwd) continue;
    try {
      const path = await realpath(isAbsolute(candidate) ? candidate : resolve(cwd!, candidate));
      if ((await stat(path)).isFile() && !paths.includes(path)) paths.push(path);
    } catch (error) { if (!vanished(error)) throw error; }
    if (paths.length > 8) throw new Error("Linux process code-path inspection exceeds its bound");
  }
  return paths;
}

function vanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

async function gitRoot(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, windowsHide: true, signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trim() || undefined;
  } catch { signal?.throwIfAborted(); return undefined; }
}

function uniqueRoots(roots: string[]): string[] {
  const unique: string[] = [];
  for (const root of roots) if (!unique.some((item) => sameProjectPath(item, root))) unique.push(root);
  return unique;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
