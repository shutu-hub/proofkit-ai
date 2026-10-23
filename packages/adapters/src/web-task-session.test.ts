import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { chromium, type Browser } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { WebAdapter } from "./web.js";
import { WebTaskSession, type SessionNetworkEvent } from "./web-task-session.js";

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
  it("persists the selected page only for the active borrower and retains origin ownership", async () => {
    const origin = "http://fixture.test/";
    const first = { isClosed: () => false, url: () => origin };
    const second = { isClosed: () => false, url: () => `${origin}review` };
    const foreign = { isClosed: () => false, url: () => "http://foreign.test/" };
    const session = new WebTaskSession({ startUrl: origin });
    Object.assign(session, { connecting: Promise.resolve(), page: first, context: { pages: () => [first, second, foreign] }, browser: {} });
    const borrowed = await session.acquire("first");
    expect(() => borrowed.selectPage(foreign as never)).toThrow("active session borrow");
    borrowed.selectPage(second as never); borrowed.release();
    const next = await session.acquire("second"); expect(next.page).toBe(second);
    expect(() => borrowed.selectPage(first as never)).toThrow("active session borrow");
    next.release();
  });

  it.each(["complete", "budget-stop", "save-failure", "context-failure", "cleanup-failure"])("finalizes primary-page recording after context close: %s", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "proofkit-task-recording-"));
    const temporary = join(directory, "tmp");
    const recordingPath = join(directory, "recording.webm");
    await mkdir(temporary);
    const source = join(temporary, "primary.webm"); await writeFile(source, "recorded bytes");
    let contextClosed = false;
    let browserClosed = false;
    const primary = { path: async () => source, saveAs: vi.fn(async () => {
      expect(contextClosed).toBe(true);
      expect(browserClosed).toBe(false);
      if (mode === "save-failure") throw new Error("private save diagnostic");
      await writeFile(recordingPath, "recorded bytes");
    }), delete: vi.fn(async () => { if (mode === "cleanup-failure") throw new Error("private delete diagnostic"); }) };
    const popup = { delete: vi.fn(async () => {}) };
    const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => "http://fixture.test/", goto: async () => {}, video: () => primary });
    const context = Object.assign(new EventEmitter(), { pages: () => [], newPage: async () => { context.emit("page", page); return page; },
      close: vi.fn(async () => { contextClosed = true; if (mode === "context-failure") throw new Error("private close diagnostic"); context.emit("close"); }) });
    const newContext = vi.fn(async () => context);
    const browser = Object.assign(new EventEmitter(), { newContext,
      close: async () => { browserClosed = true; browser.emit("disconnected"); } });
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(browser as unknown as Browser);
    const session = new WebTaskSession({ startUrl: "http://fixture.test/", recordVideo: { directory: temporary, path: recordingPath, ...(mode === "budget-stop" ? { budget: { maxDurationMs: 1000 } } : {}) } });
    try {
      const borrowed = await session.acquire("video-run");
      expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ recordVideo: { dir: temporary } }));
      context.emit("page", { video: () => popup });
      borrowed.release();
      if (mode === "budget-stop") await vi.waitFor(() => expect(session.recordingStopReason()).toBe("duration-limit"), { timeout: 1800 });
      await session.close();
      expect(session.recordingStatus()).toBe(mode === "complete" ? "recorded" : mode === "budget-stop" ? "partial" : "unavailable");
      expect(primary.delete).toHaveBeenCalledOnce();
      expect(popup.delete).toHaveBeenCalledOnce();
      expect(browserClosed).toBe(true);
      expect(context.close).toHaveBeenCalledOnce();
      if (mode === "context-failure") expect(primary.saveAs).not.toHaveBeenCalled();
      else expect(primary.saveAs).toHaveBeenCalledWith(join(directory, "recording.webm"));
    } finally { await session.close(true); launch.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps network listeners across borrowers and invalidates unexpected browser disconnection", async () => {
    const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => "http://fixture.test/", goto: async () => {} });
    const context = Object.assign(new EventEmitter(), { newPage: async () => page, close: async () => { context.emit("close"); } });
    const browser = Object.assign(new EventEmitter(), { newContext: async () => context, close: async () => { browser.emit("disconnected"); } });
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(browser as unknown as Browser);
    const events: SessionNetworkEvent[] = [];
    const session = new WebTaskSession({ startUrl: "http://fixture.test/", restrictToOrigin: true, onNetworkEvent: (event) => events.push(event) });
    try {
      const first = await session.acquire("first-run");
      const request = { method: () => "POST", url: () => "http://fixture.test/pending" };
      context.emit("request", request);
      first.release();
      context.emit("response", { request: () => request, status: () => 202 });
      expect(events[1]).toMatchObject({ initiatingRunId: "first-run" });
      expect(events[1]?.observedDuringRunId).toBeUndefined();
      const second = await session.acquire("second-run");
      context.emit("requestfailed", request);
      expect(events.map((event) => event.requestId)).toEqual([events[0]!.requestId, events[0]!.requestId, events[0]!.requestId]);
      expect(events[2]).toMatchObject({ initiatingRunId: "first-run", observedDuringRunId: "second-run" });
      second.release();
      browser.emit("disconnected");
      expect(session.reusable).toBe(false);
      expect(session.unavailableReason).toBe("browser-disconnected");
      await session.close();
      expect(context.listenerCount("request")).toBe(0);
      expect(context.listenerCount("response")).toBe(0);
    } finally { await session.close(true); launch.mockRestore(); }
  });

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
    expect(() => new WebTaskSession({ startUrl: "http://fixture.test/", recordVideo: { directory: tmpdir(), path: join(tmpdir(), "video.webm") },
      benchmarkHar: { directory: tmpdir(), runId: "raw-har" } })).toThrow("cannot be combined");
    await f.session.close();
  });

  it("supports a non-HAR owned context and refuses reuse after it leaves its target origin", async () => {
    const session = new WebTaskSession({ startUrl: "http://127.0.0.1:8080/", restrictToOrigin: true });
    let location = "http://127.0.0.1:8080/private";
    let closed = 0;
    Object.assign(session, { connecting: Promise.resolve(), page: { isClosed: () => false, url: () => location },
      context: { close: async () => { closed++; } }, browser: { close: async () => { closed++; } } });
    const borrowed = await session.acquire("first");
    borrowed.release();
    expect(session.reusable).toBe(true);
    location = "http://127.0.0.1:9090/another-app";
    expect(session.reusable).toBe(false);
    await expect(session.acquire("second")).rejects.toThrow("target origin");
    expect(await session.close()).toBeUndefined();
    expect(closed).toBe(2);
  });
});
