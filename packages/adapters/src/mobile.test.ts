import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileAdapter } from "./mobile.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("MobileAdapter", () => {
  it("runs a bounded W3C WebDriver session and maps actions to driver commands", async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "/session" && init?.method === "POST") return response({ value: {}, sessionId: "session-1" });
      if (path.endsWith("/source")) return response({ value: "<hierarchy><node text=\"Ready\"/></hierarchy>" });
      if (path.endsWith("/url")) return response({ value: "http://device.local/home" });
      if (path.endsWith("/title")) return response({ value: "ProofKit" });
      if (path.endsWith("/screenshot")) return response({ value: Buffer.from("png").toString("base64") });
      if (path.endsWith("/element") && init?.method === "POST") return response({ value: { "element-6066-11e4-a52e-4f735466cecf": "element-1" } });
      if (path.includes("/element/")) return response({ value: null });
      if (path.endsWith("/actions") || path.endsWith("/url")) return response({ value: null });
      if (path.includes("/session/session-1") && init?.method === "DELETE") return response({ value: null });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const adapter = new MobileAdapter({
      serverUrl: "http://127.0.0.1:4723",
      capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2" },
    });
    await adapter.connect();
    const snapshot = await adapter.snapshot();
    expect(snapshot).toMatchObject({ text: expect.stringContaining("Ready"), title: "ProofKit", url: "http://device.local/home" });
    const receipt = await adapter.act({ kind: "click", selector: "accessibility=Continue" });
    expect(receipt.kind).toBe("click");
    await adapter.act({ kind: "fill", selector: "id=email", value: "test@example.com" });
    expect((await adapter.assert({ kind: "text-visible", text: "Ready" })).passed).toBe(true);
    expect((await adapter.assert({ kind: "text-not-visible", text: "Ready" })).passed).toBe(false);
    expect((await adapter.assert({ kind: "text-not-visible", text: "Configuration failed" })).passed).toBe(true);
    expect((await adapter.assert({ kind: "title-contains", text: "Proof" })).passed).toBe(true);
    expect((await adapter.assert({ kind: "url-matches", pattern: "device\\.local" })).passed).toBe(true);
    const screenshot = await adapter.capture("screen.png");
    expect(screenshot).toBeDefined();
    expect(Buffer.from(screenshot!).toString()).toBe("png");
    await adapter.close();
    expect(requests.some((request) => request.path.endsWith("/session/session-1") && request.method === "DELETE")).toBe(true);
    expect(requests.some((request) => request.path.endsWith("/element") && request.body?.includes("accessibility id"))).toBe(true);
  });

  it("uses accessibility id by default and can attach to an existing session", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method ?? "GET" });
      if (path.endsWith("/source")) return response({ value: "ready" });
      if (path.endsWith("/url")) return response({ value: "about:blank" });
      if (path.endsWith("/title")) return response({ value: "" });
      if (path.endsWith("/element") && init?.method === "POST") return response({ value: { ELEMENT: "legacy-element" } });
      if (path.includes("/element/")) return response({ value: null });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: true });
    await adapter.connect();
    await adapter.act({ kind: "click", selector: "Continue" });
    await adapter.close();
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
