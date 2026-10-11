import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { atomicWriteJson, EvidenceStore, sha256 } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("EvidenceStore event streaming", () => {
  it("bounds previews of large logs without splitting a UTF-8 character", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preview-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect preview", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "run-1", startedAt: "2026-10-12T00:00:00Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await writeFile(join(root, "run-1", "events.jsonl"), `简历测试${"x".repeat(2_000_000)}`);
    expect(await store.readPreview("run-1", "events", 4)).toEqual({ content: "简历测试", truncated: true });
    await writeFile(join(root, "run-1", "report.html"), "A🙂B");
    expect(await store.readPreview("run-1", "report", 2)).toEqual({ content: "A", truncated: true });
    expect(await store.readPreview("run-1", "summary", 100_000)).toMatchObject({ truncated: false });
    await expect(store.readPreview("run-1", "events", 100_001)).rejects.toThrow("1–100000");
    await expect(store.readPreview("run-1", "events", -1)).rejects.toThrow("1–100000");
  });

  it("rejects redirected Run evidence and mismatched summary identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-preview-")); roots.push(root);
    const store = new EvidenceStore(root);
    const charter = TestCharterSchema.parse({ intent: "Inspect preview", level: "quick", actions: [], assertions: [] });
    await store.startRun({ runId: "run-1", startedAt: "2026-10-12T00:00:00Z", status: "completed", verdict: "passed",
      charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    const outside = join(root, "private.txt");
    await writeFile(outside, "private evidence outside this Run");
    try {
      await symlink(outside, join(root, "run-1", "report.html"), "file");
      await expect(store.readPreview("run-1", "report", 100)).rejects.toThrow("redirected");
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    const summaryPath = join(root, "run-1", "run.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    await writeFile(summaryPath, JSON.stringify({ ...summary, runId: "run-2" }));
    await expect(store.loadSummary("run-1")).rejects.toThrow("identity mismatch");
    await truncate(summaryPath, 16 * 1024 * 1024 + 1);
    await expect(store.loadSummary("run-1")).rejects.toThrow("read limit");
    await mkdir(join(root, "other"));
    await symlink(join(root, "other"), join(root, "run-2"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.readPreview("run-2", "summary", 100)).rejects.toThrow("redirected");
  });

  it("keeps the previous atomic snapshot on serialization failure and removes its temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-atomic-evidence-")); roots.push(root);
    const path = join(root, "journal.json");
    await atomicWriteJson(path, { owner: "run-1" });
    const previous = await readFile(path);
    await expect(atomicWriteJson(path, { invalid: 1n })).rejects.toThrow();
    expect(await readFile(path)).toEqual(previous);
    expect(await readdir(root)).toEqual(["journal.json"]);
  });

  it("hashes the exact sanitized bytes committed to an atomic artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-atomic-artifact-")); roots.push(root);
    const store = new EvidenceStore(root);
    const path = await store.writeJsonAtomic("run-1", "registration", { owner: "run-1", password: "must-not-persist" });
    const bytes = await readFile(join(root, path));
    expect(bytes.toString()).not.toContain("must-not-persist");
    const events = await collect(store.readEvents("run-1"));
    expect(events[0]?.payload).toMatchObject({ path, bytes: bytes.length, sha256: sha256(bytes) });
  });

  it("reads typed events from a run without loading the whole log", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:00Z", type: "adapter.event", payload: { eventType: "response", method: "GET", status: 200 } });
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:01Z", type: "run.completed", payload: { verdict: "passed" } });
    const events = [];
    for await (const event of store.readEvents("run-1")) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["adapter.event", "run.completed"]);
  });

  it("rejects malformed or cross-run event records", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await store.appendEvent({ runId: "run-1", timestamp: "2026-10-09T00:00:00Z", type: "run.started", payload: {} });
    const path = join(root, "run-1", "events.jsonl");
    await writeFile(path, "not-json\n");
    await expect(collect(store.readEvents("run-1"))).rejects.toThrow();
    await writeFile(path, `${JSON.stringify({ runId: "run-2", timestamp: "2026-10-09T00:00:00Z", type: "run.started", payload: {} })}\n`);
    await expect(collect(store.readEvents("run-1"))).rejects.toThrow("another run");
  });

  it("rejects an unavailable log and unsafe run IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-events-"));
    roots.push(root);
    const store = new EvidenceStore(root);
    await expect(collect(store.readEvents("missing"))).rejects.toThrow();
    await expect(collect(store.readEvents("../other"))).rejects.toThrow("Invalid run id");
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}
