import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function benchmarkHash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function benchmarkWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function canonicalFuturePath(path: string): string {
  let parent = resolve(path);
  const segments: string[] = [];
  while (!existsSync(parent)) { segments.unshift(basename(parent)); parent = dirname(parent); }
  return resolve(realpathSync.native(parent), ...segments);
}

/** Refuse redirected files and changed sizes, with an explicit byte ceiling. */
export async function readBenchmarkArtifact(root: string, path: string, limit: number): Promise<Buffer> {
  const canonicalRoot = realpathSync.native(root);
  const expected = resolve(canonicalRoot, path);
  if (!benchmarkWithin(canonicalRoot, expected)) throw new Error("Outside capture context");
  const actual = realpathSync.native(expected);
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(expected)) throw new Error("Redirected capture artifact");
  const file = await open(actual, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid capture artifact");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("Changed capture artifact");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
