import { createHash } from "node:crypto";
import type { Page, Request, Response } from "playwright-core";
import { CaptureResponseActionSchema, ResponseObservationSchema, type CaptureResponseAction, type ResponseObservation } from "@proofkit/contracts";
import { InconclusiveError } from "@proofkit/runner";

const MAX_BODY_BYTES = 65536;
const gap = (code: string, message: string) => new InconclusiveError(code, message);

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

/**
 * Observes one main-frame request started in a finite trigger window.
 * This is temporal association, not proof that the click causally created an object.
 * Independent Oracles still own business acceptance.
 */
export async function captureActionResponse(page: Page, input: CaptureResponseAction, trigger: (context: ResponseCaptureTriggerContext) => Promise<void>, signal?: AbortSignal): Promise<ResponseObservation> {
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
  const onResponse = (response: Response) => { if (response.request() === selectedRequest) resolveResponse(response); };
  const onFailure = (request: Request) => {
    if (request === selectedRequest) controller.abort(gap("response-request-failed", "The selected request failed before a complete response was observed"));
  };
  const onClose = () => controller.abort(gap("response-page-closed", "The page closed during response capture"));
  try {
    scopedSignal.throwIfAborted();
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailure);
    page.on("close", onClose);
    await scoped(trigger({ signal: scopedSignal, remainingTimeoutMs }), scopedSignal);
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
    if (!action.response.statuses.includes(status)) throw gap("response-status", `Response status ${status} is outside the declared statuses`);
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
    let bytes: Buffer;
    try { bytes = await scoped(response.body(), scopedSignal); }
    catch (error) {
      if (scopedSignal.aborted) throw scopedSignal.reason;
      throw gap("response-body-unavailable", "The complete selected response body was unavailable");
    }
    if (bytes.length < 1 || bytes.length > MAX_BODY_BYTES) throw gap("response-body-bound", "The decoded response body is outside the 1-65536-byte acceptance bound");
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); }
    catch { throw gap("response-json-invalid", "The selected response is not valid JSON"); }
    return ResponseObservationSchema.parse({
      name: action.name, association: "action-window", url: endpoint.href, method: action.response.method, status, requestCount: 1,
      windowStartedAt, requestStartedAt, windowEndedAt, capturedAt: new Date().toISOString(), bodyBytes: bytes.length,
      bodySha256: createHash("sha256").update(bytes).digest("hex"), fields: projectResponseFields(body, action.response.fields),
    });
  } finally {
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
