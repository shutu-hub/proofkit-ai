import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileAdapter } from "./mobile.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("MobileAdapter", () => {
  it("explicitly blocks browser file selection without calling the mobile driver", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await expect(adapter.act({ kind: "setInputFiles", selector: "#file", files: [".proofkit/fixtures/resume.pdf"] })).rejects.toThrow("not supported");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
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
      if (path.endsWith("/elements") && init?.method === "POST") {
        const query = JSON.parse(String(init.body)).value as string;
        if (query.includes("Configuration failed")) return response({ value: [] });
        if (query === "Continue" || query === "email") return response({ value: [{ "element-6066-11e4-a52e-4f735466cecf": "element-1" }] });
        return response({ value: [{ "element-6066-11e4-a52e-4f735466cecf": "visible-element" }] });
      }
      if (path.endsWith("/element/visible-element/displayed")) return response({ value: true });
      if (path.endsWith("/element/element-1/displayed")) return response({ value: true });
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
    expect(snapshot).toMatchObject({ text: expect.stringContaining("Ready"), title: "ProofKit", url: "http://device.local/__redacted__" });
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
    expect(requests.some((request) => request.path.endsWith("/elements") && request.body?.includes("accessibility id"))).toBe(true);
  });

  it("uses accessibility id by default and can attach to an existing session", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method ?? "GET" });
      if (path.endsWith("/source")) return response({ value: "ready" });
      if (path.endsWith("/url")) return response({ value: "about:blank" });
      if (path.endsWith("/title")) return response({ value: "" });
      if (path.endsWith("/elements") && init?.method === "POST") return response({ value: [{ ELEMENT: "legacy-element" }] });
      if (path.endsWith("/element/legacy-element/displayed")) return response({ value: true });
      if (path.includes("/element/")) return response({ value: null });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: true });
    await adapter.connect();
    await adapter.act({ kind: "click", selector: "Continue" });
    await adapter.close();
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("keeps a fill bound to the original element when clearing changes the locator result", async () => {
    const requests: string[] = [];
    let cleared = false;
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/url")) return response({ value: "app://proofkit/form" });
      if (path.endsWith("/elements")) return response({ value: [{ ELEMENT: cleared ? "other-field" : "original-field" }] });
      if (path.endsWith("/element/original-field/displayed")) return response({ value: true });
      if (path.endsWith("/element/original-field/clear")) { cleared = true; return response({ value: null }); }
      if (path.endsWith("/element/original-field/value")) return response({ value: null });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await adapter.act({ kind: "fill", selector: "accessibility=Email", value: "synthetic@example.test" });
    expect(requests.filter((request) => request.endsWith("/elements"))).toHaveLength(1);
    expect(requests).toContain("POST /session/existing/element/original-field/clear");
    expect(requests).toContain("POST /session/existing/element/original-field/value");
    expect(requests.some((request) => request.includes("other-field"))).toBe(false);
  });

  it("preserves an attached session by default and deletes it only with an explicit opt-in", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      requests.push(init?.method ?? "GET");
      return response({ value: null });
    }) as typeof fetch;
    const attached = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "shared" });
    await attached.connect();
    await attached.close();
    expect(requests).toEqual([]);

    const owned = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "shared", keepSession: false });
    await owned.connect();
    await owned.close();
    expect(requests).toEqual(["DELETE"]);
  });

  it("keeps the session available for cleanup retry after a driver HTTP failure", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (requests.length === 1) return new Response(JSON.stringify({ value: { error: "unknown error", message: "private driver detail" } }), { status: 500 });
      return response({ value: null });
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: false });
    await adapter.connect();
    await expect(adapter.close()).rejects.toMatchObject({
      name: "InconclusiveError", code: "mobile-session-cleanup-unverified",
      message: expect.not.stringContaining("private driver detail"),
    });
    await adapter.close();
    await adapter.close();
    expect(requests).toEqual(["DELETE /session/existing", "DELETE /session/existing"]);
  });

  it("surfaces a timed-out session deletion without forgetting the session", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (requests.length > 1) return response({ value: null });
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(init?.signal?.reason);
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: false, requestTimeoutMs: 10 });
    await adapter.connect();
    await expect(adapter.close()).rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-session-cleanup-unverified" });
    await adapter.close();
    expect(requests).toEqual(["DELETE /session/existing", "DELETE /session/existing"]);
  });

  it("aborts an in-flight locator request without sending a late click", async () => {
    const requests: string[] = [];
    let locatorStarted!: () => void;
    const inLocator = new Promise<void>((resolve) => { locatorStarted = resolve; });
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/url")) return response({ value: "http://device.local/home" });
      if (path.endsWith("/elements") && init?.method === "POST") {
        locatorStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(init.signal?.reason);
          if (init.signal?.aborted) onAbort();
          else init.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: true });
    await adapter.connect();
    const controller = new AbortController();
    const reason = new Error("cancel mobile run");
    const action = adapter.act({ kind: "click", selector: "accessibility=Continue" }, { signal: controller.signal });
    await inLocator;
    controller.abort(reason);
    await expect(action).rejects.toBe(reason);
    expect(requests.some((request) => request.endsWith("/click"))).toBe(false);
    expect(requests.filter((request) => request.endsWith("/elements"))).toHaveLength(1);
  });

  it.each([
    [[], "mobile-selector-missing"],
    [[{ ELEMENT: "one" }, { ELEMENT: "two" }], "mobile-selector-ambiguous"],
    [[{ ELEMENT: "one" }], "mobile-selector-hidden"],
  ] as const)("refuses an unverified mobile action target (%s)", async (matches, code) => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/url")) return response({ value: "http://device.local/home" });
      if (path.endsWith("/elements")) return response({ value: matches });
      if (path.endsWith("/element/one/displayed")) return response({ value: false });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await expect(adapter.act({ kind: "click", selector: "accessibility=Submit" }))
      .rejects.toMatchObject({ name: "InconclusiveError", code });
    expect(requests.some((request) => /\/(click|clear|value)$/.test(request))).toBe(false);
  });

  it("does not treat hidden source text as visible", async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/elements") && init?.method === "POST") {
        return response({ value: [{ "element-6066-11e4-a52e-4f735466cecf": "hidden-element" }] });
      }
      if (path.endsWith("/element/hidden-element/displayed")) return response({ value: false });
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing", keepSession: true });
    await adapter.connect();
    expect((await adapter.assert({ kind: "text-visible", text: "Hidden" })).passed).toBe(false);
    expect((await adapter.assert({ kind: "text-not-visible", text: "Hidden" })).passed).toBe(true);
  });

  it("classifies unsupported mobile visibility commands as inconclusive", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      value: { error: "unsupported operation", message: "XPath unavailable" },
    }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await expect(adapter.assert({ kind: "text-not-visible", text: "Error" }))
      .rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-visibility-unavailable" });
  });

  it("does not report a product assertion failure when the driver cannot return title or URL facts", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/title")) return new Response(JSON.stringify({ value: { error: "unknown error", message: "private title" } }), { status: 500 });
      if (path.endsWith("/url")) return response({ value: null });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await expect(adapter.assert({ kind: "title-contains", text: "Expected" }))
      .rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-title-unavailable", message: expect.not.stringContaining("private title") });
    await expect(adapter.assert({ kind: "url-matches", pattern: "expected" }))
      .rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-url-unavailable" });
  });

  it("bounds WebDriver responses even when the server omits Content-Length", async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (init?.method === "DELETE") return response({ value: null });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9 * 1024 * 1024));
          controller.enqueue(new Uint8Array(8 * 1024 * 1024));
          controller.close();
        },
      }));
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await expect(adapter.capture("screen.png"))
      .rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-driver-response-too-large" });
  });

  it("rejects an oversized declared driver response before reading its body", async () => {
    globalThis.fetch = vi.fn(async () => new Response("small", {
      headers: { "content-length": String(17 * 1024 * 1024) },
    })) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    await expect(adapter.capture("screen.png"))
      .rejects.toMatchObject({ name: "InconclusiveError", code: "mobile-driver-response-too-large" });
  });

  it("quotes text containing both quote characters in the WebDriver XPath", async () => {
    let expression: string | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/elements")) {
        expression = JSON.parse(String(init?.body)).value as string;
        return response({ value: [] });
      }
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    expect((await adapter.assert({ kind: "text-not-visible", text: `He said "don't"` })).passed).toBe(true);
    expect(expression).toContain(`concat("He said ", '"', "don't", '"', "")`);
  });

  it("summarizes mobile labels without persisting editable or secure source values", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/source")) return response({ value: `<hierarchy>
        <node text="Submit" content-desc="Send" displayed="true"/>
        <android.widget.EditText text="typed-secret"/>
        <node text="secure-secret" password="true"/>
        <node text="hidden-secret" displayed="false"/>
        <node label="alice@example.com"/>
        <node text="12345678901"/>
      </hierarchy>` });
      if (path.endsWith("/url")) return response({ value: "https://user:pass@example.com/app?token=secret#private" });
      if (path.endsWith("/title")) return response({ value: "Mobile" });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const adapter = new MobileAdapter({ serverUrl: "http://127.0.0.1:4723", sessionId: "existing" });
    await adapter.connect();
    const snapshot = await adapter.snapshot();
    expect(snapshot.url).toBe("https://example.com/__redacted__");
    expect(snapshot.text).toContain("Submit");
    expect(snapshot.text).toContain("Send");
    expect(snapshot.text).toContain("[REDACTED_EMAIL]");
    expect(snapshot.text).not.toMatch(/typed-secret|secure-secret|hidden-secret|alice@example.com/);
    expect(snapshot.text).not.toContain("token=secret");
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
