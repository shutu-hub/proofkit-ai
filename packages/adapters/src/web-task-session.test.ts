import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebAdapter } from "./web.js";
import { WebTaskSession } from "./web-task-session.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "proofkit-task-owner-"));
  const session = new WebTaskSession({ startUrl: "http://127.0.0.1:1/", benchmarkHar: { directory: join(directory, "har"), runId: "task-44" } });
  let contextsClosed = 0, browsersClosed = 0;
  const page = { isClosed: () => false, on: () => {}, off: () => {} };
  Object.assign(session, { connecting: Promise.resolve(), page,
    context: { close: async () => { contextsClosed++; } }, browser: { close: async () => { browsersClosed++; } } });
  return { session, closed: () => ({ contextsClosed, browsersClosed }) };
}

describe("persistent task context ownership", () => {
  it("serializes borrowers and keeps the context open after each Run adapter closes", async () => {
    const f = await fixture();
    const first = new WebAdapter({ taskSession: { session: f.session, runId: "first" } });
    await first.connect();
    await expect(f.session.acquire("overlapping")).rejects.toThrow("already borrowed");
    await expect(f.session.close()).rejects.toThrow("active Run");
    await first.close();
    expect(f.closed()).toEqual({ contextsClosed: 0, browsersClosed: 0 });
    const second = new WebAdapter({ taskSession: { session: f.session, runId: "second" } });
    await second.connect(); await second.close();
    expect(f.session.borrowedRunIds()).toEqual(["first", "second"]);
    await expect(f.session.acquire("first")).rejects.toThrow();
    const closing = f.session.close(); expect(f.session.close()).toBe(closing); await closing;
    expect(f.closed()).toEqual({ contextsClosed: 1, browsersClosed: 1 });
    await expect(f.session.acquire("after-close")).rejects.toThrow();
  });

  it("releases late resources on abandonment and forbids continuing an interrupted context", async () => {
    const f = await fixture();
    let release!: () => void;
    Object.assign(f.session, { connecting: new Promise<void>((resolve) => { release = resolve; }) });
    const acquire = f.session.acquire("late");
    const failure = expect(acquire).rejects.toThrow("unavailable");
    const close = f.session.close(true); release();
    await failure; await close;
    expect(f.session.unavailableReason).toBe("run-interrupted");
    expect(f.closed()).toEqual({ contextsClosed: 1, browsersClosed: 1 });
    await expect(f.session.acquire("retry")).rejects.toThrow();
  });

  it("rejects CDP or duplicate recording before borrowing a task context", async () => {
    const f = await fixture();
    await expect(new WebAdapter({ taskSession: { session: f.session, runId: "cdp" }, cdpUrl: "http://127.0.0.1:1" }).connect()).rejects.toThrow("without CDP");
    await expect(new WebAdapter({ taskSession: { session: f.session, runId: "har" },
      benchmarkHar: { directory: tmpdir(), runId: "har" } }).connect()).rejects.toThrow("per-Run HAR");
    expect(f.session.borrowedRunIds()).toEqual([]);
    await f.session.close();
  });
});
