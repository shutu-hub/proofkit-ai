import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { SourceStateSchema, type SourceState } from "@proofkit/contracts";
import { sameProjectPath } from "./context.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_CAPTURE_MS = 12_000;
const SOURCE_EXTENSIONS = new Set([".cjs", ".css", ".go", ".html", ".java", ".js", ".json", ".jsx", ".mjs", ".py", ".rs", ".scss", ".sql", ".ts", ".tsx", ".vue", ".yaml", ".yml"]);
const EXCLUDED_DIRECTORIES = new Set([".agents", ".cache", ".codex", ".git", ".pnpm", ".proofkit", ".turbo", ".venv", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);

/**
 * Capture a privacy-preserving Git source fingerprint. Only hashes and counts
 * enter Mission state; diff bytes and untracked file contents stay in memory.
 * The bound makes an incomplete snapshot explicit instead of suggesting that
 * an unexamined worktree is unchanged.
 */
export async function captureSourceState(projectRoot: string): Promise<SourceState> {
  const root = resolve(projectRoot);
  const deadline = Date.now() + MAX_CAPTURE_MS;
  const capturedAt = new Date().toISOString();
  const unavailable = (reason: string): SourceState => SourceStateSchema.parse({ method: "unavailable", complete: false, reason, capturedAt });
  try {
    const topLevel = (await git(root, ["rev-parse", "--show-toplevel"], 4096, deadline)).toString("utf8").trim();
    if (!sameProjectPath(topLevel, root)) return unavailable("The selected project root is not its own Git repository root.");
    const headSha = (await git(root, ["rev-parse", "HEAD"], 4096, deadline)).toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/i.test(headSha)) return unavailable("Git HEAD is unavailable.");
    const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], MAX_DIFF_BYTES, deadline);
    const listed = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], 4 * 1024 * 1024, deadline);
    const untracked = listed.toString("utf8").split("\0").filter(relevantUntrackedPath).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const hash = createHash("sha256").update("proofkit-source-state-v1\0").update(headSha).update("\0tracked-diff\0").update(diff);
    let totalBytes = 0;
    let complete = untracked.length <= MAX_UNTRACKED_FILES;
    for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      const absolute = resolve(root, path);
      const within = relative(root, absolute);
      if (!within || outside(within) || Date.now() >= deadline) { complete = false; break; }
      try {
        const before = await lstat(absolute);
        if (!before.isFile() || before.size > MAX_UNTRACKED_FILE_BYTES || totalBytes + before.size > MAX_UNTRACKED_BYTES) {
          complete = false;
          break;
        }
        const content = await readFile(absolute);
        const after = await lstat(absolute);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || content.byteLength !== before.size) { complete = false; break; }
        hash.update("\0untracked\0").update(path).update("\0").update(content);
        totalBytes += content.byteLength;
      } catch {
        complete = false;
        break;
      }
    }
    return SourceStateSchema.parse({
      method: "git",
      headSha,
      worktreeSha256: hash.digest("hex"),
      complete,
      trackedDiffBytes: diff.byteLength,
      untrackedFiles: untracked.length,
      ...(complete ? {} : { reason: "Source capture exceeded a file, byte, or time bound, or changed while being read." }),
      capturedAt,
    });
  } catch {
    return unavailable("Git source capture is unavailable or exceeded its bounded command deadline.");
  }
}

async function git(root: string, args: string[], maxBuffer: number, deadline: number): Promise<Buffer> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Source capture timed out");
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer,
    timeout: remaining,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function relevantUntrackedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const file = segments.at(-1)?.toLowerCase() ?? "";
  return !isAbsolute(path) && !segments.includes(".") && !segments.includes("..")
    && segments.slice(0, -1).every((part) => !part.startsWith(".") && !EXCLUDED_DIRECTORIES.has(part.toLowerCase()))
    && !file.startsWith(".env") && SOURCE_EXTENSIONS.has(extname(file));
}

function outside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}
