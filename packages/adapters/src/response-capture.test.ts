import { EventEmitter } from "node:events";
import { getEventListeners } from "node:events";
import type { Page, Request, Response } from "playwright-core";
import { describe, expect, it } from "vitest";
import { CaptureResponseActionSchema } from "@proofkit/contracts";
import { InconclusiveError } from "@proofkit/runner";
import { captureActionResponse, projectResponseFields } from "./response-capture.js";
import { WebAdapter } from "./web.js";

const action = CaptureResponseActionSchema.parse({ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } }, requestWindowMs: 5, timeoutMs: 200 });

function fixture() {
  const events = new EventEmitter();
  const frame = {};
  const page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
  const request = (options: { url?: string; frame?: unknown; redirected?: boolean; method?: string } = {}) => ({
    url: () => options.url ?? action.response.url, method: () => options.method ?? "POST",
    frame: () => options.frame ?? frame, redirectedFrom: () => options.redirected ? {} : null,
  }) as unknown as Request;
  const response = (request: Request, options: { data?: unknown; status?: number; headers?: Record<string, string | undefined>; body?: () => Promise<Buffer> } = {}) => {
    const bytes = Buffer.from(JSON.stringify(options.data ?? { data: { file_id: "41" }, private: "DO_NOT_SAVE" }));
    return { request: () => request, status: () => options.status ?? 201,
      headers: () => ({ "content-type": "application/json", "content-length": String(bytes.length), ...options.headers }),
      body: options.body ?? (async () => bytes),
    } as unknown as Response;
  };
  const send = (req = request(), res = response(req)) => { events.emit("request", req); events.emit("response", res); };
  const clean = () => expect(events.eventNames().map((name) => events.listenerCount(name))).toEqual([]);
  return { page, events, request, response, send, clean };
}

describe("bounded action response observation", () => {
  it("ignores history, other frames and endpoints and keeps only declared fields", async () => {
    const f = fixture(); const historical = f.request();
    f.send(historical, f.response(historical, { data: { data: { file_id: "1" } } }));
    const result = await captureActionResponse(f.page, action, async () => {
      f.events.emit("response", f.response(historical, { data: { data: { file_id: "1" } } }));
      f.send(f.request({ frame: {} })); f.send(f.request({ url: "http://127.0.0.1/other" })); f.send(f.request({ method: "GET" })); f.send();
    });
    expect(result.fields).toEqual({ fileId: "41" });
    expect(result.association).toBe("action-window"); expect(JSON.stringify(result)).not.toContain("DO_NOT_SAVE");
    expect(result.bodySha256).toMatch(/^[a-f0-9]{64}$/); f.clean();
  });
  it("waits for a delayed response to the selected request", async () => {
    const f = fixture(); const req = f.request();
    const result = await captureActionResponse(f.page, action, async () => {
      f.events.emit("request", req); setTimeout(() => f.events.emit("response", f.response(req)), 20);
    });
    expect(result.fields.fileId).toBe("41"); f.clean();
  });
  it("captures a request that starts after the legacy action window", async () => {
    const f = fixture(); const req = f.request();
    const result = await captureActionResponse(f.page,
      { ...action, requestStartTimeoutMs: 100, requestWindowMs: 10, timeoutMs: 250 }, async () => {
        setTimeout(() => f.send(req, f.response(req)), 35);
      });
    expect(result.fields.fileId).toBe("41");
    expect(result.requestStartedAt).toBeDefined();
    expect(Date.parse(result.requestStartedAt!) - Date.parse(result.windowStartedAt)).toBeGreaterThanOrEqual(20);
    f.clean();
  });
  it("rejects a missing delayed request and a duplicate during its guard window", async () => {
    const missing = fixture();
    await expect(captureActionResponse(missing.page,
      { ...action, requestStartTimeoutMs: 25, requestWindowMs: 10, timeoutMs: 200 }, async () => {}))
      .rejects.toMatchObject({ code: "response-not-observed" });
    missing.clean();

    const duplicate = fixture(); const first = duplicate.request();
    await expect(captureActionResponse(duplicate.page,
      { ...action, requestStartTimeoutMs: 100, requestWindowMs: 25, timeoutMs: 200 }, async () => {
        setTimeout(() => { duplicate.send(first, duplicate.response(first)); duplicate.send(); }, 20);
      })).rejects.toMatchObject({ code: "response-ambiguous" });
    duplicate.clean();
  });
  it("preserves cancellation while awaiting a delayed request", async () => {
    const f = fixture(); const controller = new AbortController(); const reason = { stop: "await-request" };
    const running = captureActionResponse(f.page,
      { ...action, requestStartTimeoutMs: 100, requestWindowMs: 10, timeoutMs: 200 }, async () => {}, controller.signal);
    setTimeout(() => controller.abort(reason), 15);
    await expect(running).rejects.toBe(reason);
    f.clean(); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it.each(["duplicate", "none", "redirect-request", "redirect-response", "request-failed", "page-close"])("cleans an ambiguous or missing observation: %s", async (kind) => {
    const f = fixture();
    await expect(captureActionResponse(f.page, action, async () => {
      const req = f.request({ redirected: kind === "redirect-request" });
      if (kind === "none") return;
      if (kind === "page-close") { f.events.emit("close"); return; }
      f.events.emit("request", req);
      if (kind === "request-failed") { f.events.emit("requestfailed", req); return; }
      f.events.emit("response", f.response(req, { status: kind === "redirect-response" ? 302 : 201 }));
      if (kind === "duplicate") f.send();
    })).rejects.toBeInstanceOf(InconclusiveError); f.clean();
  });
  it.each([
    { headers: { "content-length": "" } }, { headers: { "content-length": "65537" } },
    { headers: { "content-type": "text/html" } },
    { status: 503 }, { data: { data: { file_id: 9007199254740992 } } }, { data: { data: {} } },
  ])("refuses unsupported response metadata before identity acceptance", async (options) => {
    const f = fixture(); const req = f.request();
    await expect(captureActionResponse(f.page, action, async () => f.send(req, f.response(req, options)))).rejects.toBeInstanceOf(InconclusiveError); f.clean();
  });
  it("accepts small chunked or decoded compressed JSON and rejects oversized decoded bytes", async () => {
    for (const headers of [{ "content-encoding": "gzip", "content-length": "20" }, { "content-length": undefined }]) {
      const f = fixture(); const req = f.request();
      const result = await captureActionResponse(f.page, action, async () => f.send(req, f.response(req, { headers })));
      expect(result.fields.fileId).toBe("41"); f.clean();
    }
    const f = fixture(); const req = f.request();
    await expect(captureActionResponse(f.page, action, async () => f.send(req, f.response(req, { body: async () => Buffer.alloc(65537) })))).rejects.toMatchObject({ code: "response-body-bound" }); f.clean();
  });
  it("never records a malformed body or its private parser diagnostic", async () => {
    const f = fixture(); const req = f.request(); const bytes = Buffer.from("PRIVATE_NOT_JSON");
    await expect(captureActionResponse(f.page, action, async () => f.send(req, f.response(req, {
      headers: { "content-length": String(bytes.length) }, body: async () => bytes,
    })))).rejects.toMatchObject({ code: "response-json-invalid", message: "The selected response is not valid JSON" }); f.clean();
  });
  it.each(["trigger", "response", "body"])("bounds a hanging %s and removes listeners", async (phase) => {
    const f = fixture(); const req = f.request();
    await expect(captureActionResponse(f.page, { ...action, timeoutMs: 25 }, async () => {
      if (phase === "trigger") await new Promise<void>(() => {});
      f.events.emit("request", req);
      if (phase === "body") f.events.emit("response", f.response(req, { body: () => new Promise(() => {}) }));
    })).rejects.toMatchObject({ code: "response-timeout" }); f.clean();
  });
  it.each(["trigger", "window", "body"])("preserves cancellation during %s", async (phase) => {
    const f = fixture(); const req = f.request(); const controller = new AbortController(); const reason = { stop: phase };
    const running = captureActionResponse(f.page, { ...action, requestWindowMs: phase === "window" ? 100 : 1 }, async () => {
      if (phase === "trigger") await new Promise<void>(() => {});
      f.send(req, f.response(req, { body: () => new Promise(() => {}) }));
    }, controller.signal);
    setTimeout(() => controller.abort(reason), 15);
    await expect(running).rejects.toBe(reason); f.clean(); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("does not trigger a pre-cancelled action", async () => {
    const f = fixture(); const controller = new AbortController(); const reason = new Error("stop"); controller.abort(reason); let triggers = 0;
    await expect(captureActionResponse(f.page, action, async () => { triggers++; }, controller.signal)).rejects.toBe(reason);
    expect(triggers).toBe(0); f.clean();
  });
  it.each(["deadline", "cancellation"])("does not click when a locator resolves after %s", async (kind) => {
    const f = fixture();
    let resolveLocator!: () => void;
    let clicked = 0;
    const waiting = new Promise<void>((resolve) => { resolveLocator = resolve; });
    const locator = { first: () => locator, waitFor: () => waiting, count: async () => 1, click: async () => { clicked++; } };
    Object.assign(f.page, { url: () => action.response.url, locator: () => locator });
    class AttachedAdapter extends WebAdapter { constructor() { super(); this.activePage = f.page; } }
    const controller = new AbortController();
    const running = new AttachedAdapter().act({ ...action, timeoutMs: 25 }, { signal: controller.signal });
    if (kind === "cancellation") controller.abort(new Error("stop before locator"));
    await expect(running).rejects.toThrow(kind === "deadline" ? "deadline" : "stop before locator");
    resolveLocator();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clicked).toBe(0); f.clean();
  });
  it("keeps successive captures independent without accumulating listeners", async () => {
    const f = fixture(); const controller = new AbortController();
    for (let index = 1; index <= 8; index++) {
      const req = f.request(); const result = await captureActionResponse(f.page, action, async () => f.send(req, f.response(req, { data: { data: { file_id: index } } })), controller.signal);
      expect(result.fields.fileId).toBe(String(index)); f.clean(); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });
});

describe("explicit JSON pointer projection", () => {
  it("accepts escaped names and preserves decimal identities without rounding", () => {
    expect(projectResponseFields({ "a/b": { "~id": "9007199254740993" }, flag: true, value: 1.5 }, {
      id: { pointer: "/a~1b/~0id", type: "id" }, flag: { pointer: "/flag", type: "boolean" }, value: { pointer: "/value", type: "number" },
    })).toEqual({ id: "9007199254740993", flag: true, value: 1.5 });
  });
  it.each([0, -1, 1.5, "01", " 1 ", {}, null, undefined])("rejects invalid IDs without a partial result", (id) => {
    expect(() => projectResponseFields({ id }, { fileId: { pointer: "/id", type: "id" } })).toThrow(InconclusiveError);
  });
  it("rejects inherited properties and large strings", () => {
    expect(() => projectResponseFields(Object.create({ id: "1" }), { id: { pointer: "/id", type: "id" } })).toThrow();
    expect(() => projectResponseFields({ value: "a".repeat(257) }, { value: { pointer: "/value", type: "string" } })).toThrow();
  });
});
