import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { OracleResult } from "@proofkit/contracts";
import type { BusinessOracle } from "@proofkit/runner";

export type HttpOracleOptions = {
  name: string;
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  check?: (body: unknown, response: { status: number; headers: Record<string, string> }) => boolean | Promise<boolean>;
  describe?: (body: unknown) => string;
};

export function httpOracle(options: HttpOracleOptions): BusinessOracle {
  return {
    name: options.name,
    async check(): Promise<OracleResult> {
      let response: { status: number; headers: Record<string, string>; body: unknown };
      try {
        response = await fetchJson(options);
      } catch (error) {
        return {
          name: options.name,
          passed: false,
          message: `HTTP oracle could not observe ${options.name}: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
          observedAt: new Date().toISOString(),
        };
      }
      const statusPassed = response.status === (options.expectedStatus ?? 200);
      const contentPassed = statusPassed && options.check ? await options.check(response.body, response) : statusPassed;
      const passed = statusPassed && contentPassed;
      return {
        name: options.name,
        passed,
        message: passed
          ? options.describe?.(response.body) ?? `HTTP oracle passed: ${options.name}`
          : `HTTP oracle failed: ${options.name} (status ${response.status})`,
        evidence: [JSON.stringify({ status: response.status, body: sanitizeBody(response.body) })],
        observedAt: new Date().toISOString(),
      };
    },
  };
}

async function fetchJson(options: HttpOracleOptions): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const parsed = new URL(options.url);
  const requestImpl = parsed.protocol === "https:" ? httpsRequest : request;
  return await new Promise((resolve, reject) => {
    const req = requestImpl(parsed, { method: "GET", headers: options.headers, timeout: options.timeoutMs ?? 5_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* plain text is a valid observation */ }
        resolve({
          status: response.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value ?? "")])),
          body,
        });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("HTTP oracle timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function sanitizeBody(body: unknown): unknown {
  if (typeof body === "string") return body.slice(0, 2_000);
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => /token|secret|password|cookie|authorization/i.test(key) ? [key, "[REDACTED]"] : [key, value]));
}
