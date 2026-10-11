import type { HttpEndpointObservation } from "@proofkit/contracts";

export type WebDriverStatusObservation = {
  http: HttpEndpointObservation;
  ready: boolean | "unverified";
};

/** Bounded, read-only W3C /status probe. Never creates a driver session or retains the response body. */
export async function probeWebDriverStatus(serverUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<WebDriverStatusObservation> {
  signal?.throwIfAborted();
  const started = performance.now();
  let target: URL;
  try {
    target = new URL(serverUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid endpoint");
  } catch {
    return { http: { endpoint: "[invalid endpoint]", status: "invalid", reason: "invalid-url", expectedStatus: 200, durationMs: performance.now() - started }, ready: "unverified" };
  }
  target.pathname = `${target.pathname.replace(/\/$/, "")}/status`;
  target.search = "";
  target.hash = "";
  const endpoint = target.href;
  const observation = (status: HttpEndpointObservation["status"], detail: Partial<HttpEndpointObservation> = {}): HttpEndpointObservation =>
    ({ endpoint, status, expectedStatus: 200, durationMs: performance.now() - started, ...detail });
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
  try {
    const response = await fetch(target, { method: "GET", redirect: "manual", signal: controller.signal });
    const observedStatus = response.status;
    if (observedStatus !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { http: observation("unexpected-status", { observedStatus }), ready: "unverified" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { http: observation("reachable", { observedStatus }), ready: "unverified" };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8_192) return { http: observation("reachable", { observedStatus }), ready: "unverified" };
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => undefined); }
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      const ready = typeof value === "object" && value !== null && "value" in value
        && typeof value.value === "object" && value.value !== null && "ready" in value.value ? value.value.ready : undefined;
      return { http: observation("reachable", { observedStatus }), ready: typeof ready === "boolean" ? ready : "unverified" };
    } catch {
      return { http: observation("reachable", { observedStatus }), ready: "unverified" };
    }
  } catch {
    signal?.throwIfAborted();
    return { http: observation("unreachable", { reason: timedOut ? "timeout" : "network-error" }), ready: "unverified" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
