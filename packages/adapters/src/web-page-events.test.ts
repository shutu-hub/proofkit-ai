import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import type { AdapterEvent } from "@proofkit/runner";
import { WebAdapter } from "./web.js";

function page(title: string) {
  return Object.assign(new EventEmitter(), { url: () => "http://fixture.local/", title: async () => title, isClosed: () => false, bringToFront: async () => {} });
}

describe("network evidence across selected Web pages", () => {
  it("retains late responses from the prior selected page without duplicating or leaking listeners", async () => {
    const portal = page("Portal"), review = page("Review");
    const adapter = new WebAdapter({ baseUrl: "http://fixture.local/" });
    const state = adapter as unknown as { activePage: Page; ownedContext: boolean; attachPageEvents(page: Page): void };
    Object.assign(adapter, { activePage: portal, ownedContext: true, context: { pages: () => [portal, review], close: async () => {} } });
    state.attachPageEvents(portal as unknown as Page);
    const events: AdapterEvent[] = []; const unsubscribe = await adapter.subscribeEvents((event) => events.push(event));
    const request = { method: () => "GET", url: () => "http://fixture.local/late" };
    portal.emit("request", request);
    await adapter.act({ kind: "switchPage", title: "Review", timeoutMs: 100 });
    portal.emit("response", { request: () => request, status: () => 200, url: () => request.url() });
    expect(events.map((event) => event.type)).toEqual(["request", "response"]);
    expect(events[0]!.payload.requestId).toBe(events[1]!.payload.requestId);
    await adapter.act({ kind: "switchPage", title: "Portal", timeoutMs: 100 });
    expect(portal.listenerCount("request")).toBe(1); expect(review.listenerCount("request")).toBe(1);
    await unsubscribe(); await adapter.close();
    expect(portal.listenerCount("request")).toBe(0); expect(review.listenerCount("response")).toBe(0);
  });
});
