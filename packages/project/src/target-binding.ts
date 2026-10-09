import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { TargetBindingSchema, type TargetBinding } from "@proofkit/contracts";
import { sameProjectPath } from "./context.js";

const execFileAsync = promisify(execFile);
const CODE_EXTENSIONS = /\.(?:cjs|exe|jar|js|mjs|py)$/i;
const GENERIC_RUNTIMES = new Set(["chrome.exe", "chromium.exe", "electron.exe", "java.exe", "msedge.exe", "node.exe", "python.exe", "python3.exe"]);

type ListenerProcess = { processId: number; executablePath?: string; commandLine?: string };
export type ProcessRootObservation = { processId: number; projectRoot?: string };

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
  if (process.platform !== "win32") {
    return unavailable("Local listener process inspection is not yet supported on this platform.", target.origin);
  }
  const expectedGitRoot = await gitRoot(expectedProjectRoot, signal);
  if (!expectedGitRoot || !sameProjectPath(expectedGitRoot, expectedProjectRoot)) {
    return unavailable("The selected source root is not a Git repository root.", target.origin);
  }
  try {
    const listeners = await windowsListeners(Number(target.port || (target.protocol === "https:" ? 443 : 80)), signal);
    if (listeners.length === 0) return unavailable("No local listener process was found for the target port.", target.origin);
    const observed: ProcessRootObservation[] = [];
    for (const listener of listeners) {
      const roots = await Promise.all(runtimeCodePaths(listener).map((path) => gitRoot(dirname(path), signal)));
      const distinct = uniqueRoots(roots.filter((root): root is string => Boolean(root)));
      observed.push({ processId: listener.processId, ...(distinct.length === 1 ? { projectRoot: distinct[0] } : {}) });
    }
    return classifyTargetBinding(expectedProjectRoot, target.origin, observed, observedAt);
  } catch {
    signal?.throwIfAborted();
    return unavailable("Local listener process inspection failed or exceeded its deadline.", target.origin);
  }
}

/** An ambiguous listener or process command line never proves a mismatch. */
export function classifyTargetBinding(expectedProjectRoot: string, targetOrigin: string, observed: ProcessRootObservation[], observedAt = new Date().toISOString()): TargetBinding {
  const base = { method: "windows-listener-process" as const, expectedProjectRoot: resolve(expectedProjectRoot), targetOrigin, observedAt };
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
  const candidates = [listener.executablePath, ...quotedWindowsPaths(listener.commandLine ?? "")]
    .filter((path): path is string => typeof path === "string" && CODE_EXTENSIONS.test(path));
  return [...new Set(candidates.filter((path) => !GENERIC_RUNTIMES.has(basename(path).toLowerCase()) && existsSync(path)).map((path) => resolve(path)))].slice(0, 8);
}

function quotedWindowsPaths(commandLine: string): string[] {
  return [...commandLine.matchAll(/"([A-Za-z]:[\\/][^"]+)"/g)].map((match) => match[1]!).filter((path) => CODE_EXTENSIONS.test(path));
}

async function windowsListeners(port: number, signal?: AbortSignal): Promise<ListenerProcess[]> {
  const script = `$port=${port}; $items=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 8 | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine }); ConvertTo-Json -InputObject $items -Compress -Depth 3`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true, signal,
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
