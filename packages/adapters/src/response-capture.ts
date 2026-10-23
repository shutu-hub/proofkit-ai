import { createHash } from "node:crypto";
import type { CDPSession, Page, Request, Response } from "playwright-core";
import { CaptureResponseActionSchema, ResponseErrorObservationSchema, ResponseIdentifierSchema, ResponseObservationSchema, type CaptureResponseAction, type ResponseErrorObservation, type ResponseObservation } from "@proofkit/contracts";
import { InconclusiveError, ResponseCaptureError, ResponseStatusError } from "@proofkit/runner";
import { sanitizeSurfaceText } from "./surface-sanitize.js";

const MAX_BODY_BYTES = 65536;
const gap = (code: string, message: string) => new InconclusiveError(code, message);
type AcquiredBody = Promise<{ bytes: Buffer } | { unavailable: true }>;

export type ResponseCaptureTriggerContext = {
  signal: AbortSignal;
  remainingTimeoutMs: () => number;
};

/** Only scalar fields explicitly selected by the Charter may leave this module. */
export function projectResponseFields(body: unknown, fields: CaptureResponseAction["response"]["fields"]): ResponseObservation["fields"] {
  const selected: ResponseObservation["fields"] = {};
  for (const [name, field] of Object.entries(fields)) {
    let value: unknown = body;
    for (const segment of field.pointer.slice(1).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        throw gap("response-field-missing", `Required response field is missing: ${name}`);
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (field.type === "id") {
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) value = String(value);
      if (typeof value !== "string" || !/^[1-9]\d{0,127}$/.test(value)) throw gap("response-field-invalid", `Response ID is invalid: ${name}`);
    } else if (field.type === "identifier") {
      if (!ResponseIdentifierSchema.safeParse(value).success) throw gap("response-field-invalid", `Response identifier is invalid: ${name}`);
    } else if (field.type === "string") {
      if (typeof value !== "string" || value.length > 256 || /[\x00-\x1f]/.test(value)) throw gap("response-field-invalid", `Response string is invalid: ${name}`);
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw gap("response-field-invalid", `Response number is invalid: ${name}`);
    } else if (typeof value !== "boolean") {
      throw gap("response-field-invalid", `Response boolean is invalid: ${name}`);
    }
    selected[name] = value as string | number | boolean;
  }
  return selected;
}

function queryFields(action: CaptureResponseAction, request: Request): Pick<ResponseObservation, "queryFields"> {
  const search = new URL(request.url()).search;
  const selected = action.response.queryFields;
  if (!search) {
    if (selected) throw gap("request-query-missing", "The selected request has no declared query parameters");
    return {};
  }
  if (!selected) throw gap("request-query-unreviewed", "The selected request contains unreviewed query parameters");
  if (Buffer.byteLength(search) > 4096) throw gap("request-query-bound", "The selected request query exceeds its acceptance bound");
  const expected = new Set(Object.values(selected).map((field) => field.pointer.slice(1).replace(/~1/g, "/").replace(/~0/g, "~")));
  const values: Record<string, string> = Object.create(null);
  for (const pair of search.slice(1).split("&")) {
    const separator = pair.indexOf("=");
    let name: string, value: string;
    try {
      name = decodeURIComponent((separator < 0 ? pair : pair.slice(0, separator)).replace(/\+/g, " "));
      value = decodeURIComponent((separator < 0 ? "" : pair.slice(separator + 1)).replace(/\+/g, " "));
    } catch { throw gap("request-query-invalid", "The selected request query is not valid UTF-8 form encoding"); }
    if (!expected.has(name)) throw gap("request-query-unreviewed", "The selected request contains an undeclared query key");
    if (Object.hasOwn(values, name)) throw gap("request-query-ambiguous", "The selected request repeats a query key");
    values[name] = value;
  }
  if (Object.keys(values).length !== expected.size) throw gap("request-query-missing", "A declared query key is absent from the selected request");
  return { queryFields: projectResponseFields(values, selected) as Record<string, string> };
}

async function requestFields(action: CaptureResponseAction, request: Request): Promise<Pick<ResponseObservation, "requestBodyBytes" | "requestBodySha256" | "requestFields" | "queryFields">> {
  const query = queryFields(action, request);
  const bytes = request.postDataBuffer?.() ?? null;
  if (!bytes || bytes.length === 0) {
    if (action.response.requestFields) throw gap("request-body-missing", "Declared request fields require a non-empty request body");
    return query;
  }
  if (bytes.length > MAX_BODY_BYTES) throw gap("request-body-bound", "The selected request body exceeds the 65536-byte acceptance bound");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!action.response.requestFields) return { ...query, requestBodyBytes: bytes.length, requestBodySha256: digest };
  const contentType = await request.headerValue?.("content-type") ?? "";
  let body: unknown;
  if (/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    try { body = JSON.parse(bytes.toString("utf8")); }
    catch { throw gap("request-json-invalid", "The selected request body is not valid JSON"); }
  } else if (/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) throw gap("request-form-charset", "Selected form fields require UTF-8 encoding");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      decodeURIComponent(text.replace(/\+/g, " "));
    } catch { throw gap("request-form-invalid", "The selected request body is not valid UTF-8 form data"); }
    const values: Record<string, string | string[]> = Object.create(null);
    for (const [name, value] of new URLSearchParams(text)) {
      const previous = values[name];
      if (Array.isArray(previous)) previous.push(value);
      else values[name] = previous === undefined ? value : [previous, value];
    }
    body = values;
  } else {
    throw gap("request-content-type", "Declared request fields require JSON or URL-encoded form content");
  }
  return { ...query, requestBodyBytes: bytes.length, requestBodySha256: digest,
    requestFields: projectResponseFields(body, action.response.requestFields) };
}

/**
 * Observes one main-frame request started in a finite trigger window.
 * This is temporal association, not proof that the click causally created an object.
 * Independent Oracles still own business acceptance.
 */
export async function captureActionResponse(page: Page, input: CaptureResponseAction,
  trigger: (context: ResponseCaptureTriggerContext) => Promise<"clicked" | "skipped" | void>, signal?: AbortSignal): Promise<ResponseObservation> {
  const action = CaptureResponseActionSchema.parse(input);
  const endpoint = new URL(action.response.url);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const deadline = performance.now() + action.timeoutMs;
  const expire = () => controller.abort(gap("response-timeout", "Response capture did not complete within its deadline"));
  const timer = setTimeout(expire, action.timeoutMs);
  const scopedSignal = controller.signal;
  const remainingTimeoutMs = () => {
    scopedSignal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) { expire(); scopedSignal.throwIfAborted(); }
    return Math.max(1, Math.ceil(remaining));
  };
  const windowStartedAt = new Date().toISOString();
  let accepting = true;
  let requestCount = 0;
  let selectedRequest: Request | undefined;
  let requestStartedAt: string | undefined;
  let requestStartedClock: number | undefined;
  let resolveRequestStarted!: () => void;
  const requestStartedPromise = new Promise<void>((resolve) => { resolveRequestStarted = resolve; });
  let requestStartTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResponse!: (response: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  let responseBody: AcquiredBody | undefined;
  const onRequest = (request: Request) => {
    if (!accepting) return;
    try {
      const url = new URL(request.url());
      if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || request.method() !== action.response.method
        || request.frame() !== page.mainFrame()) return;
      if (request.redirectedFrom()) {
        controller.abort(gap("response-redirect", "Redirected requests cannot establish the response identity"));
        return;
      }
      requestCount++;
      if (requestCount > 1) {
        controller.abort(gap("response-ambiguous", "More than one matching request occurred in the action window"));
      } else {
        selectedRequest = request;
        requestStartedAt = new Date().toISOString();
        requestStartedClock = performance.now();
        resolveRequestStarted();
      }
    } catch { /* Worker requests without a frame cannot establish this association. */ }
  };
  const onResponse = (response: Response) => {
    if (response.request() !== selectedRequest || responseBody) return;
    const status = response.status();
    const headers = response.headers();
    const length = headers["content-length"];
    if (!(status >= 300 && status < 400) && (action.response.statuses.includes(status) || Boolean(action.response.errorFields))
      && /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(headers["content-type"] ?? "")
      && (length === undefined || /^\d+$/.test(length) && Number(length) <= MAX_BODY_BYTES)) {
      responseBody = Promise.resolve().then(() => response.body()).then((bytes) => ({ bytes }), () => ({ unavailable: true as const }));
    }
    resolveResponse(response);
  };
  const onFailure = (request: Request) => {
    if (request === selectedRequest) controller.abort(gap("response-request-failed", "The selected request failed before a complete response was observed"));
  };
  const onClose = () => controller.abort(gap("response-page-closed", "The page closed during response capture"));
  let durableSession: CDPSession | undefined;
  try {
    scopedSignal.throwIfAborted();
    if (page.context?.().newCDPSession) {
      try {
        const session = await scoped<CDPSession>(page.context().newCDPSession(page).then(async (session) => {
          if (scopedSignal.aborted) { await session.detach().catch(() => {}); scopedSignal.throwIfAborted(); }
          return session;
        }), scopedSignal);
        durableSession = session;
        await scoped(session.send("Network.enable", { maxTotalBufferSize: 1024 * 1024,
          maxResourceBufferSize: MAX_BODY_BYTES, enableDurableMessages: true }), scopedSignal);
      } catch {
        await durableSession?.detach().catch(() => {}); durableSession = undefined;
        scopedSignal.throwIfAborted();
      }
    }
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailure);
    page.on("close", onClose);
    const followUp = await scoped(trigger({ signal: scopedSignal, remainingTimeoutMs }), scopedSignal);
    if (action.requestStartTimeoutMs !== undefined) {
      if (!selectedRequest) {
        requestStartTimer = setTimeout(() => controller.abort(gap("response-not-observed", "No matching request started within the declared delay")), action.requestStartTimeoutMs);
        await scoped(requestStartedPromise, scopedSignal);
      }
      if (requestStartTimer) { clearTimeout(requestStartTimer); requestStartTimer = undefined; }
      const remainingGuardMs = Math.max(0, action.requestWindowMs - (performance.now() - requestStartedClock!));
      if (remainingGuardMs > 0) await delay(remainingGuardMs, scopedSignal);
    } else {
      await delay(action.requestWindowMs, scopedSignal);
    }
    accepting = false;
    const windowEndedAt = new Date().toISOString();
    if (requestCount !== 1) throw gap("response-not-observed", "No matching request occurred in the action window");
    const response = await scoped(responsePromise, scopedSignal);
    const status = response.status();
    if (status >= 300 && status < 400) throw gap("response-redirect", "Redirected responses cannot establish the response identity");
    if (!action.response.statuses.includes(status)) {
      if (action.response.errorFields || action.response.requestFields || action.response.queryFields) {
        throw new ResponseStatusError(await observeUnexpectedResponse(action, selectedRequest!, response, responseBody,
          { windowStartedAt, requestStartedAt, windowEndedAt, followUp: followUp || undefined }, scopedSignal));
      }
      throw gap("response-status", `Response status ${status} is outside the declared statuses`);
    }
    // Reject an oversized declared body before acquisition; decoded bytes are checked again below.
    // Playwright materializes bodies, so this bounds accepted facts, not its transient allocation.
    const headers = response.headers();
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(headers["content-type"] ?? "")) {
      throw gap("response-content-type", "Response capture requires a JSON content type");
    }
    const length = headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      throw gap("response-body-bound", "The declared response body exceeds the 65536-byte acceptance bound");
    }
    const acquired = responseBody ? await scoped(responseBody, scopedSignal) : undefined;
    if (!acquired || "unavailable" in acquired) throw gap("response-body-unavailable", "The complete selected response body was unavailable");
    const bytes = acquired.bytes;
    if (bytes.length < 1 || bytes.length > MAX_BODY_BYTES) throw gap("response-body-bound", "The decoded response body is outside the 1-65536-byte acceptance bound");
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); }
    catch { throw gap("response-json-invalid", "The selected response is not valid JSON"); }
    const projected = projectDiagnosticFields(body, action.response.fields);
    let requestObservation: Awaited<ReturnType<typeof requestFields>> = {};
    let requestGap: string | undefined;
    try { requestObservation = await scoped(requestFields(action, selectedRequest!), scopedSignal); }
    catch (error) {
      scopedSignal.throwIfAborted();
      if (!(error instanceof InconclusiveError)) throw error;
      requestGap = error.code;
    }
    scopedSignal.throwIfAborted();
    if (projected.fieldGaps.length || requestGap) throw new ResponseCaptureError(ResponseErrorObservationSchema.parse({
      name: action.name, kind: "incomplete-fields", acceptance: "not-established", expectedStatuses: action.response.statuses,
      association: "action-window", url: endpoint.href, method: action.response.method, status, requestCount: 1,
      windowStartedAt, requestStartedAt, followUp: followUp || undefined, windowEndedAt, capturedAt: new Date().toISOString(),
      bodyBytes: bytes.length, bodySha256: createHash("sha256").update(bytes).digest("hex"), ...projected, ...requestObservation, requestGap,
    }));
    return ResponseObservationSchema.parse({
      name: action.name, association: "action-window", url: endpoint.href, method: action.response.method, status, requestCount: 1,
      windowStartedAt, requestStartedAt, followUp, windowEndedAt, capturedAt: new Date().toISOString(), bodyBytes: bytes.length,
      bodySha256: createHash("sha256").update(bytes).digest("hex"), fields: projectResponseFields(body, action.response.fields),
      ...requestObservation,
    });
  } finally {
    await durableSession?.detach().catch(() => {});
    accepting = false;
    clearTimeout(timer);
    if (requestStartTimer) clearTimeout(requestStartTimer);
    signal?.removeEventListener("abort", abort);
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFailure);
    page.off("close", onClose);
  }
}

function projectDiagnosticFields(body: unknown, projection: CaptureResponseAction["response"]["fields"]): Pick<ResponseErrorObservation, "fields" | "fieldGaps"> {
  const observed: Pick<ResponseErrorObservation, "fields" | "fieldGaps"> = { fields: {}, fieldGaps: [] };
  for (const [name, field] of Object.entries(projection)) {
    try {
      const value = projectResponseFields(body, { [name]: field })[name]!;
      observed.fields[name] = typeof value === "string" && field.type === "string" ? sanitizeSurfaceText(value, 256).slice(0, 256) : value;
    } catch (error) {
      observed.fieldGaps.push({ name, code: error instanceof InconclusiveError && error.code === "response-field-missing" ? "missing" : "invalid" });
    }
  }
  return observed;
}

async function observeUnexpectedResponse(action: CaptureResponseAction, request: Request, response: Response, responseBody: AcquiredBody | undefined,
  window: Pick<ResponseObservation, "windowStartedAt" | "requestStartedAt" | "windowEndedAt" | "followUp">, signal: AbortSignal): Promise<ResponseErrorObservation> {
  const observed: Pick<ResponseErrorObservation, "fields" | "fieldGaps" | "bodyGap" | "bodyBytes" | "bodySha256"> = { fields: {}, fieldGaps: [] };
  if (!action.response.errorFields) observed.bodyGap = "not-requested";
  else {
    const headers = response.headers();
    const length = headers["content-length"];
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(headers["content-type"] ?? "")) observed.bodyGap = "content-type";
    else if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) observed.bodyGap = "body-bound";
    else {
      const acquired = responseBody ? await scoped(responseBody, signal) : undefined;
      if (!acquired || "unavailable" in acquired) observed.bodyGap = "body-unavailable";
      else if (acquired.bytes.length < 1 || acquired.bytes.length > MAX_BODY_BYTES) observed.bodyGap = "body-bound";
      else {
        observed.bodyBytes = acquired.bytes.length;
        observed.bodySha256 = createHash("sha256").update(acquired.bytes).digest("hex");
        let body: unknown;
        try { body = JSON.parse(acquired.bytes.toString("utf8")); }
        catch { observed.bodyGap = "json-invalid"; }
        if (!observed.bodyGap) Object.assign(observed, projectDiagnosticFields(body, action.response.errorFields));
      }
    }
  }
  let requestObservation: Awaited<ReturnType<typeof requestFields>> = {};
  let requestGap: string | undefined;
  try { requestObservation = await scoped(requestFields(action, request), signal); }
  catch (error) {
    signal.throwIfAborted();
    requestGap = error instanceof InconclusiveError ? error.code : "request-observation-unavailable";
  }
  signal.throwIfAborted();
  return ResponseErrorObservationSchema.parse({ name: action.name, kind: "unexpected-status", acceptance: "not-established", association: "action-window",
    url: action.response.url, method: action.response.method, status: response.status(), expectedStatuses: action.response.statuses, requestCount: 1,
    ...window, capturedAt: new Date().toISOString(), ...observed, ...requestObservation, ...(requestGap ? { requestGap } : {}) });
}

async function scoped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw signal.reason; }
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let timer!: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
