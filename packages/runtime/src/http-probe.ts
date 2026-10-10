import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HttpEndpointObservation } from "@proofkit/contracts";

/** Header-only GET: no redirects, response bodies, cookies or raw errors in observations. */
export async function probeHttpEndpoint(url: string, expectedStatus = 200, timeoutMs = 2_000, signal?: AbortSignal): Promise<HttpEndpointObservation> {
  signal?.throwIfAborted();
  const started = performance.now();
  let target: URL;
  try {
    target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid endpoint");
  } catch {
    return { endpoint: "[invalid endpoint]", status: "invalid", reason: "invalid-url", expectedStatus, durationMs: performance.now() - started };
  }
  const endpoint = `${target.origin}${target.pathname}`;
  return new Promise<HttpEndpointObservation>((resolve, reject) => {
    let req: ClientRequest | undefined;
    let settled = false;
    const finish = (status: HttpEndpointObservation["status"], detail: Partial<HttpEndpointObservation> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      req?.destroy();
      resolve({ endpoint, status, expectedStatus, durationMs: performance.now() - started, ...detail });
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      req?.destroy();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => finish("unreachable", { reason: "timeout" }), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const request = target.protocol === "https:" ? httpsRequest : httpRequest;
      req = request(target, { method: "GET", agent: false }, (response) => {
        const observedStatus = response.statusCode;
        response.destroy();
        finish(observedStatus === expectedStatus ? "reachable" : "unexpected-status", { observedStatus });
      });
      req.on("error", () => finish("unreachable", { reason: "network-error" }));
      req.end();
    } catch {
      finish("unreachable", { reason: "network-error" });
    }
  });
}
