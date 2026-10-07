import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { sha256 } from "@proofkit/evidence";
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
  facts?: (body: unknown) => Record<string, string | number | boolean | null>;
};

export type PollHttpOracleOptions = Omit<HttpOracleOptions, "check" | "describe" | "facts"> & {
  intervalMs?: number;
  deadlineMs: number;
  evaluate: (body: unknown, response: { status: number; headers: Record<string, string> }) => "pending" | "passed" | "failed" | Promise<"pending" | "passed" | "failed">;
  facts?: (body: unknown) => Record<string, string | number | boolean | null>;
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
          : `HTTP oracle failed: ${options.name} (status ${response.status}, predicate ${contentPassed ? "passed" : "failed"})`,
        evidence: [JSON.stringify({ status: response.status, bodySha256: sha256(JSON.stringify(response.body)), ...(options.facts ? { facts: options.facts(response.body) } : {}) })],
        observedAt: new Date().toISOString(),
      };
    },
  };
}

export function pollHttpOracle(options: PollHttpOracleOptions): BusinessOracle {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new Error("deadlineMs must be positive");
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be positive");
  return {
    name: options.name,
    async check(): Promise<OracleResult> {
      const deadline = Date.now() + options.deadlineMs;
      let attempts = 0;
      const observations: Array<Record<string, unknown>> = [];
      const record = (observation: Record<string, unknown>) => {
        observations.push({ at: new Date().toISOString(), ...observation });
        if (observations.length > 100) observations.shift();
      };
      while (Date.now() < deadline) {
        attempts++;
        try {
          const remaining = Math.max(1, deadline - Date.now());
          const response = await fetchJson({ ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, remaining) });
          const state = response.status === (options.expectedStatus ?? 200)
            ? await options.evaluate(response.body, response)
            : "pending";
          const facts = options.facts?.(response.body);
          record({ status: response.status, state, bodySha256: sha256(JSON.stringify(response.body)), ...(facts ? { facts } : {}) });
          if (state === "passed" || state === "failed") {
            return { name: options.name, passed: state === "passed", message: `${options.name}: ${state} after ${attempts} observation(s)`, evidence: [JSON.stringify({ attempts, observations })], observedAt: new Date().toISOString() };
          }
        } catch (error) {
          record({ observationError: error instanceof Error ? error.name : "Error" });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
      }
      return { name: options.name, passed: null, message: `${options.name}: terminal state not observed within ${options.deadlineMs}ms`, evidence: [JSON.stringify({ attempts, observations })], observedAt: new Date().toISOString() };
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
