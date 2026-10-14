import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cacheRoot = join(repoRoot, ".proofkit", "datasets");
export const lockPath = join(repoRoot, "tests", "datasets", "sources.lock.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readDatasetLock() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(lock.schemaVersion, 1);
  for (const [id, dataset] of Object.entries(lock.datasets)) {
    assert.match(id, /^[a-z][a-z0-9-]+$/);
    assert.match(dataset.repository, /^[\w-]+\/[\w.-]+$/);
    assert.match(dataset.revision, /^[a-f0-9]{40}$/);
    assert.ok(dataset.files.length > 0 && dataset.files.length <= 100);
    assert.equal(new Set(dataset.files.map((file) => file.path)).size, dataset.files.length);
    for (const file of dataset.files) {
      assert.ok(file.path.split("/").every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== ".."), "Invalid dataset path");
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 10_000_000);
    }
    assert.ok(dataset.files.reduce((sum, file) => sum + file.bytes, 0) <= 20_000_000);
    assert.ok(dataset.files.some((file) => file.path === "LICENSE"), "Missing upstream license");
  }
  return lock;
}

export function datasetDirectory(id, dataset) {
  return join(cacheRoot, id, dataset.revision);
}

export function verifyBytes(file, bytes) {
  assert.equal(bytes.length, file.bytes, `Size mismatch: ${file.path}`);
  assert.equal(hash(bytes), file.sha256, `SHA-256 mismatch: ${file.path}`);
}

export async function verifyDataset(id, dataset) {
  const directory = datasetDirectory(id, dataset);
  for (const file of dataset.files) {
    let bytes;
    try { bytes = await readFile(join(directory, file.path)); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`Missing ${id}/${file.path}. Run pnpm benchmark:datasets:fetch --dataset ${id}.`);
      throw error;
    }
    verifyBytes(file, bytes);
  }
  return directory;
}

async function fetchDataset(id, dataset, checkOnly) {
  const directory = datasetDirectory(id, dataset);
  let downloaded = 0;
  for (const file of dataset.files) {
    const target = join(directory, file.path);
    try {
      verifyBytes(file, await readFile(target));
      continue;
    } catch (error) {
      // A modified cache is preserved for review; never silently overwrite it.
      if (error.code !== "ENOENT") throw error;
      if (checkOnly) throw new Error(`Missing ${id}/${file.path}. Run pnpm benchmark:datasets:fetch --dataset ${id}.`);
    }
    const url = `https://raw.githubusercontent.com/${dataset.repository}/${dataset.revision}/${file.path}`;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Dataset download failed (${response.status}): ${id}/${file.path}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > file.bytes) throw new Error(`Download exceeds locked size: ${id}/${file.path}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyBytes(file, bytes);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    downloaded++;
  }
  return { dataset: id, revision: dataset.revision, directory, files: dataset.files.length,
    bytes: dataset.files.reduce((sum, file) => sum + file.bytes, 0), downloaded, verified: true, execution: "not-run" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { dataset: { type: "string", default: "all" }, check: { type: "boolean", default: false } } });
  const lock = await readDatasetLock();
  const ids = values.dataset === "all" ? Object.keys(lock.datasets) : [values.dataset];
  for (const id of ids) if (!lock.datasets[id]) throw new Error(`Unknown dataset: ${id}`);
  const results = [];
  for (const id of ids) results.push(await fetchDataset(id, lock.datasets[id], values.check));
  console.log(JSON.stringify({ datasets: results }, null, 2));
}
