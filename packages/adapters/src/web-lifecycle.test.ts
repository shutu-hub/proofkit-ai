import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "./web.js";

const chromium = vi.hoisted(() => ({ launch: vi.fn(), connectOverCDP: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium }));

function fixture(initialUrl = "about:blank") {
  let url = initialUrl;
  let closed = false;
  const events = new EventEmitter();
  const page = Object.assign(events, {
    url: () => url, title: async () => "Fixture", isClosed: () => closed,
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async (next: string) => { url = next; }),
    context: () => context,
    close: async () => { closed = true; },
  });
  const context = { pages: () => [page as unknown as Page], newPage: vi.fn(async () => page as unknown as Page) };
  const stalePage = { url: () => "http://other-app/", isClosed: () => false } as unknown as Page;
  const staleContext = { pages: () => [stalePage] };
  const browser = {
    contexts: vi.fn(() => [staleContext as unknown as BrowserContext]),
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    close: vi.fn(async () => { closed = true; }),
  };
  return { page, context, browser, events, stalePage };
}

class ObservedWebAdapter extends WebAdapter {
  currentPage() { return this.page(); }
}

beforeEach(() => vi.resetAllMocks());

describe("Web connection lifecycle", () => {
  it("creates a fresh visible page even when launch exposes an existing context", async () => {
    const f = fixture();
    chromium.launch.mockResolvedValue(f.browser);
    const adapter = new ObservedWebAdapter({ headless: false, baseUrl: "http://fixture/" });
    await adapter.connect();
    expect(adapter.currentPage()).toBe(f.page);
    expect(adapter.currentPage()).not.toBe(f.stalePage);
    expect(f.browser.newContext).toHaveBeenCalledWith({ viewport: null });
    expect(f.context.newPage).toHaveBeenCalledOnce();
    expect(f.page.bringToFront).toHaveBeenCalledOnce();
    expect(f.page.goto).toHaveBeenCalledWith("http://fixture/", { waitUntil: "domcontentloaded" });
    await adapter.close();
    expect(f.events.eventNames()).toEqual([]);
  });

  it("keeps the default headless viewport and does not foreground a headless page", async () => {
    const f = fixture();
    chromium.launch.mockResolvedValue(f.browser);
    const adapter = new WebAdapter();
    await adapter.connect();
    expect(chromium.launch).toHaveBeenCalledWith({ headless: true, executablePath: undefined });
    expect(f.browser.newContext).toHaveBeenCalledWith(undefined);
    expect(f.page.bringToFront).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("coalesces overlapping connections into one browser and one page", async () => {
    const f = fixture();
    chromium.launch.mockResolvedValue(f.browser);
    const adapter = new WebAdapter();
    await Promise.all([adapter.connect(), adapter.connect()]);
    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(f.context.newPage).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("attaches to the selected CDP page without creating or navigating another page", async () => {
    const f = fixture("http://fixture/app");
    f.browser.contexts.mockReturnValue([f.context as unknown as BrowserContext]);
    chromium.connectOverCDP.mockResolvedValue(f.browser);
    const adapter = new ObservedWebAdapter({ cdpUrl: "http://127.0.0.1:9222", baseUrl: "http://fixture/" });
    await adapter.connect();
    expect(adapter.currentPage()).toBe(f.page);
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(f.browser.newContext).not.toHaveBeenCalled();
    expect(f.context.newPage).not.toHaveBeenCalled();
    expect(f.page.goto).not.toHaveBeenCalled();
    expect(f.page.bringToFront).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("foregrounds a CDP page only when a visible session is explicitly requested", async () => {
    const f = fixture("http://fixture/app");
    f.browser.contexts.mockReturnValue([f.context as unknown as BrowserContext]);
    chromium.connectOverCDP.mockResolvedValue(f.browser);
    const adapter = new WebAdapter({ cdpUrl: "http://127.0.0.1:9222", headless: false });
    await adapter.connect();
    expect(f.page.bringToFront).toHaveBeenCalledOnce();
    expect(f.context.newPage).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("rejects a closed page immediately and releases its old browser on reconnect", async () => {
    const first = fixture();
    const next = fixture();
    chromium.launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(next.browser);
    const adapter = new ObservedWebAdapter();
    await adapter.connect();
    await first.page.close();
    await expect(adapter.snapshot()).rejects.toThrow("page is closed");
    await adapter.connect();
    expect(first.browser.close).toHaveBeenCalledOnce();
    expect(first.events.eventNames()).toEqual([]);
    expect(adapter.currentPage()).toBe(next.page);
    await adapter.close();
  });

  it("cleans up a failed navigation while preserving the original connection error", async () => {
    const f = fixture();
    const error = new Error("fixture navigation failed");
    f.page.goto.mockRejectedValue(error);
    chromium.launch.mockResolvedValue(f.browser);
    const adapter = new WebAdapter({ baseUrl: "http://fixture/" });
    await expect(adapter.connect()).rejects.toBe(error);
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(f.events.eventNames()).toEqual([]);
    await expect(adapter.snapshot()).rejects.toThrow("not connected");
  });

  it("clears page references even when browser cleanup fails", async () => {
    const f = fixture();
    chromium.launch.mockResolvedValue(f.browser);
    const adapter = new WebAdapter();
    await adapter.connect();
    f.browser.close.mockRejectedValue(new Error("fixture cleanup failed"));
    await expect(adapter.close()).rejects.toThrow("fixture cleanup failed");
    await expect(adapter.snapshot()).rejects.toThrow("not connected");
    expect(f.events.eventNames()).toEqual([]);
  });
});
