import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_TREE_ENTRIES = 20_000;

type ManifestFile = { path: string; bytes: number; sha256: string };
type Manifest = { schemaVersion: 1; runId: string; generatedAt: string; files: ManifestFile[] };
type FileStatus = "verified" | "changed" | "missing" | "unverified";
export type ManifestVerification = {
  runId: string;
  manifestSha256: string;
  manifestVerified: boolean;
  status: "intact" | "changed" | "missing" | "unverified";
  files: Array<{ path: string; expectedBytes: number; actualBytes?: number; expectedSha256: string; actualSha256?: string; status: FileStatus }>;
  omittedFiles: number;
  unexpectedFiles: string[];
};

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validPath(path: string, runId: string): boolean {
  const parts = path.split("/");
  return path.length <= 1024 && parts.length >= 2 && parts[0] === runId
    && parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\\:\u0000-\u001f]/.test(part))
    && path !== `${runId}/manifest.json`;
}

async function ownedDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || !samePath(await realpath(path), path)) throw new Error("Evidence directory is redirected");
}

async function readEvidenceFile(root: string, runId: string, path: string, limit: number, retain = false): Promise<{
  bytes: number; sha256: string; content: Buffer;
}> {
  const parts = path.split("/");
  if (path !== `${runId}/manifest.json` && !validPath(path, runId)) throw new Error("Invalid evidence path");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    await ownedDirectory(parent);
  }
  const target = resolve(root, ...parts);
  const direct = await lstat(target);
  if (!direct.isFile() || !samePath(await realpath(target), target)) throw new Error("Evidence file is redirected");
  if (direct.size > limit) throw new Error("Evidence file exceeds its byte budget");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes = 0;
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size > limit) throw new Error("Evidence file changed during opening");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (bytes <= limit) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, limit - bytes + 1), bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limit) throw new Error("Evidence file exceeds its byte budget");
      digest.update(chunk.subarray(0, bytesRead));
      if (retain) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await file.stat();
    const current = await lstat(target);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new Error("Evidence file changed while hashing");
    }
  } finally { await file.close(); }
  return { bytes, sha256: digest.digest("hex"), content: retain ? Buffer.concat(chunks, bytes) : Buffer.alloc(0) };
}

async function inventory(root: string, runId: string): Promise<string[]> {
  const runRoot = join(root, runId);
  await ownedDirectory(runRoot);
  const files: string[] = [];
  let entriesSeen = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error("Evidence inventory exceeds its depth limit");
    await ownedDirectory(directory);
    for await (const entry of await opendir(directory)) {
      entriesSeen++;
      if (entriesSeen > MAX_TREE_ENTRIES) throw new Error("Evidence inventory exceeds its entry limit");
      if (entry.isSymbolicLink()) throw new Error("Evidence inventory refuses symbolic links");
      const target = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(target, depth + 1); continue; }
      if (!entry.isFile()) throw new Error("Evidence inventory found a non-regular entry");
      if (directory === runRoot && entry.name === "manifest.json") continue;
      const path = relative(root, target).split(sep).join("/");
      if (!validPath(path, runId)) throw new Error("Evidence inventory found an unsafe path");
      if (files.length >= MAX_FILES) throw new Error("Evidence inventory exceeds its file limit");
      files.push(path);
    }
  };
  await walk(runRoot, 0);
  return files.sort();
}

export async function buildRunManifest(rootDir: string, runId: string): Promise<Manifest> {
  const root = await realpath(rootDir);
  const paths = await inventory(root, runId);
  const files: ManifestFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = await readEvidenceFile(root, runId, path, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes));
    totalBytes += file.bytes;
    files.push({ path, bytes: file.bytes, sha256: file.sha256 });
  }
  const currentPaths = await inventory(root, runId);
  if (currentPaths.length !== paths.length || currentPaths.some((path, index) => path !== paths[index])) throw new Error("Evidence inventory changed during capture");
  const manifest: Manifest = { schemaVersion: 1, runId, generatedAt: new Date().toISOString(), files };
  if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) + 1 > MAX_MANIFEST_BYTES) throw new Error("Evidence manifest exceeds its byte budget");
  return manifest;
}

function parseManifest(value: unknown, runId: string): Manifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const manifest = value as Partial<Manifest>;
  if (manifest.schemaVersion !== 1 || manifest.runId !== runId || typeof manifest.generatedAt !== "string"
    || !Number.isFinite(Date.parse(manifest.generatedAt)) || !Array.isArray(manifest.files)
    || manifest.files.length < 1 || manifest.files.length > MAX_FILES) return;
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !validPath(file.path, runId)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) return;
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (paths.has(key)) return;
    paths.add(key);
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) return;
  }
  if (!paths.has(process.platform === "win32" ? `${runId}/run.json`.toLowerCase() : `${runId}/run.json`)) return;
  return manifest as Manifest;
}

export async function verifyRunManifest(rootDir: string, runId: string, expectedManifestSha256?: string): Promise<ManifestVerification> {
  if (expectedManifestSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(expectedManifestSha256)) throw new Error("Invalid expected manifest SHA-256");
  const result: ManifestVerification = { runId, manifestSha256: "", manifestVerified: false, status: "unverified", files: [], omittedFiles: 0, unexpectedFiles: [] };
  let root: string;
  let value: unknown;
  try {
    root = await realpath(rootDir);
    const file = await readEvidenceFile(root, runId, `${runId}/manifest.json`, MAX_MANIFEST_BYTES, true);
    result.manifestSha256 = file.sha256;
    value = JSON.parse(file.content.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") result.status = "missing";
    return result;
  }
  const manifest = parseManifest(value, runId);
  if (!manifest) {
    const files = (value as Partial<Manifest> | null)?.files;
    result.omittedFiles = Array.isArray(files) ? files.length : 0;
    return result;
  }
  result.manifestVerified = expectedManifestSha256 === undefined || expectedManifestSha256.toLowerCase() === result.manifestSha256;
  result.status = result.manifestVerified ? "intact" : "changed";
  let remaining = MAX_TOTAL_BYTES;
  for (const expected of manifest.files) {
    const row: ManifestVerification["files"][number] = { path: expected.path, expectedBytes: expected.bytes, expectedSha256: expected.sha256.toLowerCase(), status: "unverified" };
    try {
      const file = await readEvidenceFile(root, runId, expected.path, Math.min(MAX_FILE_BYTES, remaining));
      remaining -= file.bytes;
      row.actualBytes = file.bytes;
      row.actualSha256 = file.sha256;
      row.status = file.bytes === expected.bytes && file.sha256 === row.expectedSha256 ? "verified" : "changed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") row.status = "missing";
    }
    if (row.status === "changed") result.status = "changed";
    else if (row.status === "missing" && result.status !== "changed") result.status = "missing";
    else if (row.status === "unverified" && result.status === "intact") result.status = "unverified";
    result.files.push(row);
  }
  try {
    const expected = new Set(manifest.files.map((file) => process.platform === "win32" ? file.path.toLowerCase() : file.path));
    result.unexpectedFiles = (await inventory(root, runId)).filter((path) => !expected.has(process.platform === "win32" ? path.toLowerCase() : path));
    if (result.unexpectedFiles.length && result.status === "intact") result.status = "changed";
  } catch {
    if (result.status === "intact") result.status = "unverified";
  }
  return result;
}
