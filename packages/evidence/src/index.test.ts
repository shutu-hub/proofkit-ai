import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("EvidenceStore event streaming", () => {
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
