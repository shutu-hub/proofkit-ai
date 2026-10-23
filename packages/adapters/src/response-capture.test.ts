import { EventEmitter } from "node:events";
import { getEventListeners } from "node:events";
import type { Page, Request, Response } from "playwright-core";
import { describe, expect, it } from "vitest";
import { CaptureResponseActionSchema } from "@proofkit/contracts";
import { InconclusiveError, ResponseCaptureError, ResponseStatusError } from "@proofkit/runner";
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

describe("incomplete response projection diagnostics", () => {
  it("does not accept an unreviewed query as the declared query-free endpoint", async () => {
    const surface = fixture(); const request = surface.request({ url: action.response.url + "?tenant=other" }); let writes = 0;
    await expect(captureActionResponse(surface.page, action, async () => { writes++; surface.send(request); }))
      .rejects.toMatchObject({ code: "request-query-unreviewed" });
    expect(writes).toBe(1); surface.clean();
  });
  it("captures only explicitly reviewed query values without retaining the raw query string", async () => {
    const surface = fixture(); const request = surface.request({ url: action.response.url + "?tenant=team42" });
    const selected = CaptureResponseActionSchema.parse({ ...action, response: { ...action.response,
      queryFields: { tenant: { pointer: "/tenant", type: "identifier" } } } });
    const result = await captureActionResponse(surface.page, selected, async () => surface.send(request));
    expect(result.queryFields).toEqual({ tenant: "team42" });
    expect(result.url).toBe(action.response.url);
    expect(JSON.stringify(result)).not.toContain("?tenant="); surface.clean();
  });
  it.each([
    { search: "", code: "request-query-missing" },
    { search: "?tenant=team42&token=secret", code: "request-query-unreviewed" },
    { search: "?tenant=team42&tenant=other", code: "request-query-ambiguous" },
    { search: "?tenant=%ZZ", code: "request-query-invalid" },
    { search: "?other=team42", code: "request-query-unreviewed" },
  ])("refuses unreviewed or malformed selected queries: $code", async ({ search, code }) => {
    const surface = fixture(); const request = surface.request({ url: action.response.url + search });
    const selected = { ...action, response: { ...action.response, queryFields: { tenant: { pointer: "/tenant", type: "identifier" as const } } } };
    await expect(captureActionResponse(surface.page, selected, async () => surface.send(request))).rejects.toMatchObject({ code }); surface.clean();
  });
  it("retains reviewed query facts on unexpected status without claiming acceptance", async () => {
    const surface = fixture(); const request = surface.request({ url: action.response.url + "?tenant=team42" });
    const selected = CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, statuses: [201],
      queryFields: { tenant: { pointer: "/tenant", type: "identifier" } } } });
    await expect(captureActionResponse(surface.page, selected, async () => surface.send(request, surface.response(request, { status: 422 }))))
      .rejects.toMatchObject({ observation: { kind: "unexpected-status", acceptance: "not-established", queryFields: { tenant: "team42" } } });
    surface.clean();
  });
  it("keeps the selected identity and independent missing/invalid gaps without replay", async () => {
    const surface = fixture(); const request = surface.request(); let writes = 0;
    const current = CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, fields: { ...action.response.fields,
      room: { pointer: "/room", type: "number" }, invalid: { pointer: "/invalid", type: "boolean" }, note: { pointer: "/note", type: "string" } } } });
    let caught: unknown;
    try {
      await captureActionResponse(surface.page, current, async () => {
        writes++; surface.send(request, surface.response(request, { data: { data: { file_id: "41" }, invalid: "false", note: "token=private user@example.com", private: "PRIVATE_UNSELECTED" } }));
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ResponseCaptureError); expect(caught).not.toBeInstanceOf(ResponseStatusError);
    expect(caught).toMatchObject({ code: "response-field-missing", observation: { kind: "incomplete-fields", status: 201, acceptance: "not-established",
      fields: { fileId: "41" }, fieldGaps: [{ name: "room", code: "missing" }, { name: "invalid", code: "invalid" }] } });
    expect(JSON.stringify((caught as ResponseCaptureError).observation)).not.toMatch(/private|user@example.com|PRIVATE_UNSELECTED/);
    expect(writes).toBe(1); surface.clean();
  });
  it("keeps selected response fields when declared request fields cannot be projected", async () => {
    const surface = fixture(); const request = Object.assign(surface.request(), { postDataBuffer: () => Buffer.from("not-json"), headerValue: async () => "application/json" });
    const current = CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, requestFields: { quantity: { pointer: "/quantity", type: "number" } } } });
    await expect(captureActionResponse(surface.page, current, async () => surface.send(request))).rejects.toMatchObject({ code: "request-json-invalid",
      observation: { kind: "incomplete-fields", fields: { fileId: "41" }, fieldGaps: [], requestGap: "request-json-invalid" } }); surface.clean();
  });
});

describe("unexpected response diagnostics", () => {
  const selected = CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, statuses: [201],
    errorFields: { message: { pointer: "/message", type: "string" } }, requestFields: { quantity: { pointer: "/quantity", type: "number" } } } });
  const withRequest = (request: Request, bytes = '{"quantity":2,"password":"PRIVATE_REQUEST"}', contentType = "application/json") =>
    Object.assign(request, { postDataBuffer: () => Buffer.from(bytes), headerValue: async () => contentType });
  it("keeps selected error and request facts from the first request without returning success", async () => {
    const surface = fixture(); let triggers = 0;
    try {
      await captureActionResponse(surface.page, selected, async () => {
        triggers++; const request = withRequest(surface.request());
        surface.send(request, surface.response(request, { status: 422, data: { message: "Invalid address; token=secretvalue user@example.com", private: "PRIVATE_RESPONSE" } }));
      });
      throw new Error("Expected unexpected status");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseStatusError);
      const observation = (error as ResponseStatusError).observation;
      expect(observation).toMatchObject({ status: 422, expectedStatuses: [201], acceptance: "not-established", requestFields: { quantity: 2 }, fieldGaps: [] });
      expect(observation.fields.message).toContain("Invalid address");
      expect(JSON.stringify(observation)).not.toMatch(/secretvalue|user@example.com|PRIVATE_REQUEST|PRIVATE_RESPONSE/);
    }
    expect(triggers).toBe(1); surface.clean();
  });
  it("does not acquire an undeclared error body, including request-only diagnostics", async () => {
    for (const requestOnly of [false, true]) {
      const surface = fixture(); const request = withRequest(surface.request()); let reads = 0;
      const current = CaptureResponseActionSchema.parse({ ...selected, response: { ...selected.response, errorFields: undefined,
        requestFields: requestOnly ? selected.response.requestFields : undefined } });
      await expect(captureActionResponse(surface.page, current, async () => {
        surface.send(request, surface.response(request, { status: 401, body: async () => { reads++; throw new Error("Unselected body"); } }));
      })).rejects.toMatchObject(requestOnly ? { observation: { bodyGap: "not-requested", requestFields: { quantity: 2 }, fields: {} } } : { code: "response-status" });
      expect(reads).toBe(0); surface.clean();
    }
  });
  it("retains valid error fields alongside explicit missing and invalid gaps", async () => {
    const surface = fixture(); const request = withRequest(surface.request(), "quantity=2&password=PRIVATE_REQUEST", "application/x-www-form-urlencoded");
    const current = CaptureResponseActionSchema.parse({ ...selected, response: { ...selected.response,
      requestFields: { quantity: { pointer: "/quantity", type: "string" } }, errorFields: { ...selected.response.errorFields,
        missing: { pointer: "/missing", type: "string" }, invalid: { pointer: "/invalid", type: "number" } } } });
    await expect(captureActionResponse(surface.page, current, async () => {
      surface.send(request, surface.response(request, { status: 422, data: { message: "Invalid", invalid: "wrong type" } }));
    })).rejects.toMatchObject({ observation: { requestFields: { quantity: "2" }, fields: { message: "Invalid" },
      fieldGaps: [{ name: "missing", code: "missing" }, { name: "invalid", code: "invalid" }] } }); surface.clean();
  });
  it.each([
    { headers: { "content-type": "text/plain" }, bodyGap: "content-type" },
    { headers: { "content-length": "65537" }, bodyGap: "body-bound" },
    { body: async () => Buffer.alloc(65537), bodyGap: "body-bound" },
    { body: async () => { throw new Error("Unavailable"); }, bodyGap: "body-unavailable" },
    { body: async () => Buffer.from("invalid-json"), bodyGap: "json-invalid" },
  ])("retains bounded gaps instead of inventing error facts: $bodyGap", async ({ bodyGap, ...options }) => {
    const surface = fixture(); const request = withRequest(surface.request());
    await expect(captureActionResponse(surface.page, selected, async () => {
      surface.send(request, surface.response(request, { status: 422, ...options }));
    })).rejects.toMatchObject({ observation: { bodyGap, fields: {}, fieldGaps: [], requestFields: { quantity: 2 } } }); surface.clean();
  });
  it("retains a request gap without discarding the selected error", async () => {
    const surface = fixture(); const request = withRequest(surface.request(), "not-json");
    await expect(captureActionResponse(surface.page, selected, async () => {
      surface.send(request, surface.response(request, { status: 422, data: { message: "Rejected" } }));
    })).rejects.toMatchObject({ observation: { requestGap: "request-json-invalid", fields: { message: "Rejected" } } }); surface.clean();
  });
  it.each(["redirect", "duplicate", "cancel"])("does not turn %s into trusted diagnostics", async (kind) => {
    const surface = fixture(); const request = withRequest(surface.request()); const controller = new AbortController();
    let caught: unknown;
    try {
      await captureActionResponse(surface.page, selected, async () => {
        surface.send(request, surface.response(request, { status: kind === "redirect" ? 302 : 422 }));
        if (kind === "duplicate") { const other = withRequest(surface.request()); surface.send(other, surface.response(other, { status: 422 })); }
        if (kind === "cancel") controller.abort(new Error("Cancelled fixture"));
      }, controller.signal);
    } catch (error) { caught = error; }
    expect(caught).toBeDefined(); expect(caught).not.toBeInstanceOf(ResponseStatusError); surface.clean();
  });
});

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
  it("reads the bounded response before trigger navigation invalidates the response handle", async () => {
    const f = fixture(); const req = f.request(); let navigationFinished = false; let reads = 0;
    const result = await captureActionResponse(f.page, action, async () => {
      f.send(req, f.response(req, { body: async () => {
        reads++;
        if (navigationFinished) throw new Error("Response handle lost after navigation");
        return Buffer.from('{"data":{"file_id":"41"}}');
      } }));
      await new Promise((resolve) => setTimeout(resolve, 0)); navigationFinished = true;
    });
    expect(result.fields.fileId).toBe("41"); expect(reads).toBe(1); f.clean();
  });
  it("retains early body acquisition failure as an inconclusive gap without an unhandled rejection", async () => {
    const f = fixture(); const req = f.request();
    await expect(captureActionResponse(f.page, action, async () => {
      f.send(req, f.response(req, { body: async () => { throw new Error("Body unavailable"); } }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    })).rejects.toMatchObject({ code: "response-body-unavailable" }); f.clean();
  });
  it.each([true, false])("releases the bounded CDP capture session when durable messages are supported=%s", async (supported) => {
    const f = fixture(); let detached = 0; let configured: unknown;
    Object.assign(f.page, { context: () => ({ newCDPSession: async () => ({
      send: async (method: string, options: unknown) => { expect(method).toBe("Network.enable"); configured = options; if (!supported) throw new Error("Unsupported protocol option"); },
      detach: async () => { detached++; },
    }) }) });
    const result = await captureActionResponse(f.page, action, async () => f.send());
    expect(result.fields.fileId).toBe("41"); expect(detached).toBe(1);
    expect(configured).toEqual({ maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 65536, enableDurableMessages: true }); f.clean();
  });
  it("releases a CDP session that arrives after cancellation without triggering a write", async () => {
    const f = fixture(); const controller = new AbortController(); let complete!: (value: unknown) => void; let detached = 0; let writes = 0;
    Object.assign(f.page, { context: () => ({ newCDPSession: () => new Promise((resolve) => { complete = resolve; }) }) });
    const reason = new Error("Cancelled while connecting");
    const running = captureActionResponse(f.page, action, async () => { writes++; }, controller.signal);
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    complete({ detach: async () => { detached++; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detached).toBe(1); expect(writes).toBe(0); f.clean();
  });
  it("captures only explicitly declared JSON request fields plus bounded request facts", async () => {
    const f = fixture(); const req = f.request();
    const requestBody = Buffer.from(JSON.stringify({ candidate_id: 42, email: "private@example.invalid" }));
    Object.assign(req, {
      postDataBuffer: () => requestBody,
      headerValue: async (name: string) => name === "content-type" ? "application/json" : null,
    });
    const configured = { ...action, response: { ...action.response,
      requestFields: { candidateId: { pointer: "/candidate_id", type: "id" as const } } } };
    const result = await captureActionResponse(f.page, configured, async () => f.send(req, f.response(req)));
    expect(result.requestFields).toEqual({ candidateId: "42" });
    expect(result.requestBodyBytes).toBe(requestBody.length);
    expect(result.requestBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
    f.clean();
  });
  it("projects UTF-8 form fields without coercion, loss of duplicates or private fields", async () => {
    const f = fixture(); const req = f.request();
    const bytes = Buffer.from("name=ProofKit+%2B+%E4%B8%AD%E6%96%87&topping=bacon&topping=cheese&empty=&__proto__=safe&private=DO_NOT_SAVE");
    Object.assign(req, { postDataBuffer: () => bytes, headerValue: async () => "application/x-www-form-urlencoded; charset=UTF-8" });
    const configured = { ...action, response: { ...action.response, requestFields: {
      customer: { pointer: "/name", type: "string" as const }, first: { pointer: "/topping/0", type: "string" as const },
      second: { pointer: "/topping/1", type: "string" as const }, empty: { pointer: "/empty", type: "string" as const },
    } } };
    const result = await captureActionResponse(f.page, configured, async () => f.send(req, f.response(req)));
    expect(result.requestFields).toEqual({ customer: "ProofKit + 中文", first: "bacon", second: "cheese", empty: "" });
    expect(result.requestBodyBytes).toBe(bytes.length); expect(result.requestBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_SAVE"); f.clean();
  });
  it.each([
    { data: "field=%ZZ", contentType: "application/x-www-form-urlencoded", code: "request-form-invalid" },
    { data: "field=%C3%28", contentType: "application/x-www-form-urlencoded", code: "request-form-invalid" },
    { data: Buffer.from([0xff]), contentType: "application/x-www-form-urlencoded", code: "request-form-invalid" },
    { data: "field=value", contentType: "application/x-www-form-urlencoded; charset=iso-8859-1", code: "request-form-charset" },
    { data: "field=value", contentType: "multipart/form-data; boundary=example", code: "request-content-type" },
    { data: "field=a&field=b", contentType: "application/x-www-form-urlencoded", code: "response-field-invalid" },
    { data: "other=value", contentType: "application/x-www-form-urlencoded", code: "response-field-missing" },
  ])("rejects unsupported or ambiguous form projection: $code", async ({ data, contentType, code }) => {
    const f = fixture(); const req = f.request();
    Object.assign(req, { postDataBuffer: () => Buffer.isBuffer(data) ? data : Buffer.from(data), headerValue: async () => contentType });
    const configured = { ...action, response: { ...action.response, requestFields: { field: { pointer: "/field", type: "string" as const } } } };
    await expect(captureActionResponse(f.page, configured, async () => f.send(req, f.response(req)))).rejects.toMatchObject({ code }); f.clean();
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
  it.each(["clicked", "skipped"])("records an optional follow-up that was %s", async (branch) => {
    const f = fixture(); const req = f.request(); let mainClicks = 0; let followClicks = 0;
    const main = { first: () => main, waitFor: async () => {}, count: async () => 1, elementHandle: async () => main, dispose: async () => {},
      click: async () => { mainClicks++; if (branch === "skipped") f.send(req, f.response(req)); } };
    const follow = { filter: () => follow, first: () => follow, elementHandle: async () => follow, dispose: async () => {}, waitFor: async () => {
      if (branch === "skipped") throw Object.assign(new Error("not visible"), { name: "TimeoutError" });
    }, count: async () => 1, click: async () => { followClicks++; f.send(req, f.response(req)); } };
    Object.assign(f.page, { url: () => action.response.url, title: async () => "test",
      locator: (selector: string) => selector === "#submit" ? main : follow });
    class AttachedAdapter extends WebAdapter { constructor() { super(); this.activePage = f.page; } }
    const receipt = await new AttachedAdapter().act({ ...action, requestStartTimeoutMs: 100, timeoutMs: 250,
      followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 20 } });
    expect((receipt.metadata.response as { followUp: string }).followUp).toBe(branch);
    expect(mainClicks).toBe(1); expect(followClicks).toBe(branch === "clicked" ? 1 : 0); f.clean();
  });
  it("rejects an ambiguous follow-up and never clicks it after cancellation", async () => {
    const ambiguous = fixture(); let clicks = 0;
    const main = { first: () => main, waitFor: async () => {}, count: async () => 1, click: async () => {}, elementHandle: async () => main, dispose: async () => {} };
    const follow = { filter: () => follow, first: () => follow, waitFor: async () => {}, count: async () => 2, click: async () => { clicks++; } };
    Object.assign(ambiguous.page, { url: () => action.response.url, locator: (selector: string) => selector === "#submit" ? main : follow });
    class AmbiguousAdapter extends WebAdapter { constructor() { super(); this.activePage = ambiguous.page; } }
    const guarded = { ...action, followUp: { kind: "clickIfVisible" as const, selector: "#confirm", waitMs: 20 } };
    await expect(new AmbiguousAdapter().act(guarded)).rejects.toMatchObject({ code: "follow-up-ambiguous" });
    expect(clicks).toBe(0); ambiguous.clean();

    const cancelled = fixture(); const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const delayed = { filter: () => delayed, first: () => delayed, waitFor: () => waiting, count: async () => 1, click: async () => { clicks++; } };
    Object.assign(cancelled.page, { url: () => action.response.url, locator: (selector: string) => selector === "#submit" ? main : delayed });
    class CancelledAdapter extends WebAdapter { constructor() { super(); this.activePage = cancelled.page; } }
    const running = new CancelledAdapter().act(guarded, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5)); controller.abort(new Error("stop confirmation"));
    await expect(running).rejects.toThrow("stop confirmation");
    release(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clicks).toBe(0); cancelled.clean();
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
  it.each(["request-1", "01", "550e8400-e29b-41d4-a716-446655440000", "CaseSensitive_ID:42", "a".repeat(128)])("preserves explicit bounded string identifier %s", (identifier) => {
    expect(projectResponseFields({ identifier }, { id: { pointer: "/identifier", type: "identifier" } })).toEqual({ id: identifier });
  });
  it.each(["", " has space", "a/b", "a?token=b", "a\n", "a".repeat(129), 42, {}, null])("rejects malformed string identifier %j", (identifier) => {
    expect(() => projectResponseFields({ identifier }, { id: { pointer: "/identifier", type: "identifier" } })).toThrow(InconclusiveError);
  });
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
