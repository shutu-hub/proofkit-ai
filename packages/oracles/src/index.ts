import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { sha256 } from "@proofkit/evidence";
import type { CaptureResponseAction, HttpFieldCheck, HttpFieldExpectation, OracleResult, ProofkitConfig, StepResult } from "@proofkit/contracts";
import { HttpFieldValueSchema, ResponseIdentifierSchema } from "@proofkit/contracts";
import { InconclusiveError, type BusinessOracle } from "@proofkit/runner";

export type HttpOracleFacts = Record<string, string | number | boolean | null | HttpFieldCheck[]>;

export type HttpOracleOptions = {
  name: string;
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  check?: (body: unknown, response: { status: number; headers: Record<string, string> }) => boolean | Promise<boolean>;
  describe?: (body: unknown) => string;
  facts?: (body: unknown, response: { status: number; headers: Record<string, string> }) => HttpOracleFacts;
  signal?: AbortSignal;
};

export type PollHttpOracleOptions = Omit<HttpOracleOptions, "check" | "describe" | "facts"> & {
  intervalMs?: number;
  deadlineMs: number;
  evaluate: (body: unknown, response: { status: number; headers: Record<string, string> }) => "pending" | "passed" | "failed" | Promise<"pending" | "passed" | "failed">;
  facts?: HttpOracleOptions["facts"];
};

export function configuredHttpOracle(config: ProofkitConfig["oracles"][number]): BusinessOracle {
  const success = new Set(config.successValues);
  const failure = new Set(config.failureValues);
  if (config.failureValues.some((value) => success.has(value))) {
    throw new Error(`Oracle ${config.name} has overlapping terminal values`);
  }
  return {
    name: config.name,
    async check(context) {
      const url = new URL(config.url);
      const matches: Array<{ parameter: string; value: string; pointer: string; type: CaptureResponseAction["response"]["fields"][string]["type"] }> = [];
      for (const [parameter, binding] of Object.entries(config.query)) {
        const value = binding.source === "runId"
          ? context.runId
          : binding.source === "step" ? readStepField(context.steps, binding.stepId, binding.field)
          : (() => {
            const selected = readResponseField(context.steps, binding.stepId, binding.field);
            matches.push({ parameter, value: selected.value, pointer: binding.matchPointer, type: selected.type });
            return selected.value;
          })();
        url.searchParams.set(parameter, value);
      }
      const scopeMatches = (body: unknown): boolean | null => {
        const values = matches.map((match) => normalizeResponseScalar(jsonPointer(body, match.pointer), match.type));
        if (values.some((value) => value === undefined)) return null;
        return values.every((value, index) => value === matches[index]?.value);
      };
      const result = await pollHttpOracle({
        name: config.name,
        url: url.toString(),
        expectedStatus: config.expectedStatus,
        intervalMs: config.intervalMs,
        deadlineMs: config.deadlineMs,
        evaluate: (body) => {
          const scoped = scopeMatches(body);
          if (scoped === null) return "pending";
          if (!scoped) return "failed";
          const value = jsonPointer(body, config.statusPointer);
          if (typeof value !== "string") return "pending";
          if (success.has(value)) {
            const fields = checkHttpFields(body, config.expectFields ?? []);
            if (fields.some((field) => field.result === "mismatch")) return "failed";
            if (fields.some((field) => field.result !== "matched")) return "pending";
            return "passed";
          }
          if (failure.has(value)) return "failed";
          return "pending";
        },
        facts: (body, response) => {
          const value = jsonPointer(body, config.statusPointer);
          const facts: HttpOracleFacts = {
            state: typeof value === "string" && (success.has(value) || failure.has(value)) ? value : "pending",
          };
          if (matches.length) facts.scopeMatches = scopeMatches(body);
          for (const match of matches) {
            facts[`expected_${match.parameter}`] = match.value;
            facts[`observed_${match.parameter}`] = normalizeResponseScalar(jsonPointer(body, match.pointer), match.type) ?? null;
          }
          if (config.expectFields) facts.fieldChecks = response.status === config.expectedStatus && (!matches.length || scopeMatches(body) === true)
            ? checkHttpFields(body, config.expectFields)
            : config.expectFields.map((field) => ({ name: field.name, pointer: field.pointer, result: "not-evaluated" }));
          return facts;
        },
        signal: context.signal,
      }).check(context);
      return config.expectFields && result.passed === null ? { ...result,
        message: config.name + ": identity, terminal state or required field observations were not established within " + config.deadlineMs + "ms" } : result;
    },
  };
}

export function checkHttpFields(body: unknown, fields: HttpFieldExpectation[]): HttpFieldCheck[] {
  return fields.map(({ name, pointer, expected, retainValue }) => {
    const observed = jsonPointer(body, pointer);
    let result: HttpFieldCheck["result"];
    if (observed === undefined) result = "missing";
    else if ((expected === null ? observed !== null : observed === null || typeof observed !== typeof expected)
      || typeof observed === "string" && (observed.length > 256 || /[\x00-\x1f]/.test(observed))
      || typeof observed === "number" && !Number.isFinite(observed)) result = "type-mismatch";
    else result = observed === expected ? "matched" : "mismatch";
    const retained = retainValue ? HttpFieldValueSchema.safeParse(observed) : undefined;
    return { name, pointer, result, ...(retained?.success ? { observed: retained.data } : {}) };
  });
}

function readResponseField(steps: StepResult[], stepId: string, field: string): {
  value: string; type: CaptureResponseAction["response"]["fields"][string]["type"];
} {
  const step = steps.find((item) => item.stepId === stepId);
  if (!step || step.status !== "passed" || step.action.kind !== "captureResponse" || !step.response
    || step.response.name !== step.action.name || !Object.hasOwn(step.action.response.fields, field)
    || !Object.hasOwn(step.response.fields, field)) {
    throw new InconclusiveError("response-binding-unavailable", `Oracle binding requires a completed response field: ${stepId}.${field}`);
  }
  const type = step.action.response.fields[field]!.type;
  const value = normalizeResponseScalar(step.response.fields[field], type);
  if (value === undefined) throw new InconclusiveError("response-binding-unavailable", `Oracle response field is invalid: ${stepId}.${field}`);
  return { value, type };
}

function normalizeResponseScalar(value: unknown, type: CaptureResponseAction["response"]["fields"][string]["type"]): string | undefined {
  if (type === "identifier") {
    const parsed = ResponseIdentifierSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  if (type === "id") {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) value = String(value);
    return typeof value === "string" && /^[1-9]\d{0,127}$/.test(value) ? value : undefined;
  }
  if (typeof value !== type) return undefined;
  if (typeof value === "string" && (value.length > 256 || /[\x00-\x1f]/.test(value))) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  return String(value);
}

function readStepField(steps: Array<{ stepId: string; status: string; capabilityOutput?: unknown }>, stepId: string, field: string): string {
  const step = steps.find((item) => item.stepId === stepId);
  if (!step || step.status !== "passed" || !step.capabilityOutput || typeof step.capabilityOutput !== "object") {
    throw new Error(`Oracle binding requires a completed capability step: ${stepId}`);
  }
  const value = (step.capabilityOutput as Record<string, unknown>)[field];
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Oracle binding field is not a string or number: ${stepId}.${field}`);
  return String(value);
}

export function jsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must start with /");
  let current: unknown = value;
  for (const token of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(token)) throw new Error("Invalid JSON Pointer escape");
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

export function httpOracle(options: HttpOracleOptions): BusinessOracle {
  const verificationKind = options.check ? "business" as const : "http-contract" as const;
  return {
    name: options.name,
    async check(context): Promise<OracleResult> {
      let response: { status: number; headers: Record<string, string>; body: unknown };
      try {
        response = await fetchJson({ ...options, signal: context.signal });
      } catch (error) {
        if (context.signal?.aborted) {
          const reason = context.signal.reason;
          throw reason instanceof Error ? reason : new Error("HTTP oracle cancelled");
        }
        return {
          name: options.name,
          verificationKind,
          passed: null,
          message: `HTTP oracle could not observe ${options.name} (${httpObservationFailure(error)}).`,
          evidence: [],
          observedAt: new Date().toISOString(),
        };
      }
      const expectedStatus = options.expectedStatus ?? 200;
      const statusPassed = response.status === expectedStatus;
      const accessUnavailable = !statusPassed && [401, 403, 429].includes(response.status);
      const hasBusinessPredicate = options.check !== undefined;
      const isExplicitNegativeStatusCheck = options.expectedStatus !== undefined && options.expectedStatus >= 400;
      const contentPassed = statusPassed && options.check ? await options.check(response.body, response) : false;
      const passed = accessUnavailable ? null
        : hasBusinessPredicate ? statusPassed && contentPassed
        : isExplicitNegativeStatusCheck ? statusPassed
        : null;
      return {
        name: options.name,
        verificationKind,
        passed,
        message: accessUnavailable
          ? `HTTP oracle ${options.name} could not read the business result (status ${response.status}); verify test access and rate limits.`
          : !hasBusinessPredicate && !isExplicitNegativeStatusCheck
          ? `HTTP oracle ${options.name} observed status ${response.status}, but no business predicate was declared; endpoint reachability cannot establish a business result.`
          : passed
          ? options.describe?.(response.body) ?? `HTTP oracle passed: ${options.name}`
          : isExplicitNegativeStatusCheck && !hasBusinessPredicate
          ? `HTTP oracle ${options.name} expected status ${expectedStatus}, observed ${response.status}.`
          : `HTTP oracle failed: ${options.name} (status ${response.status}, predicate ${contentPassed ? "passed" : "failed"})`,
        evidence: [JSON.stringify({ status: response.status, bodySha256: sha256(JSON.stringify(response.body)), ...(!accessUnavailable && options.facts ? { facts: options.facts(response.body, response) } : {}) })],
        observedAt: new Date().toISOString(),
      };
    },
  };
}

function httpObservationFailure(error: unknown): string {
  if (error instanceof Error && error.message === "HTTP oracle timed out") return "timeout";
  if (error instanceof Error && error.message === "HTTP oracle response exceeds 1 MB") return "response-too-large";
  return "transport-error";
}

export function pollHttpOracle(options: PollHttpOracleOptions): BusinessOracle {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new Error("deadlineMs must be positive");
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be positive");
  return {
    name: options.name,
    async check(context): Promise<OracleResult> {
      const deadline = Date.now() + options.deadlineMs;
      let attempts = 0;
      let omittedObservations = 0;
      const observations: Array<Record<string, unknown>> = [];
      const traceBytes = (items: Array<Record<string, unknown>>) => Buffer.byteLength(JSON.stringify({ oracle: options.name,
        facts: [{ attempts, omittedObservations, observations: items }] }, null, 2));
      const record = (observation: Record<string, unknown>) => {
        const next = { at: new Date().toISOString(), ...observation };
        if (traceBytes([next]) > 60 * 1024) throw new Error("HTTP oracle source observation exceeds its evidence bound");
        observations.push(next);
        while (observations.length > 1 && (observations.length > 100 || traceBytes(observations) > 60 * 1024)) {
          observations.shift(); omittedObservations++;
        }
      };
      while (Date.now() < deadline) {
        throwIfAborted(context.signal);
        attempts++;
        try {
          const remaining = Math.max(1, deadline - Date.now());
          const response = await fetchJson({ ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, remaining), signal: context.signal });
          const state = response.status === (options.expectedStatus ?? 200)
            ? await options.evaluate(response.body, response)
            : "pending";
          const facts = options.facts?.(response.body, response);
          record({ status: response.status, state, bodySha256: sha256(JSON.stringify(response.body)), ...(facts ? { facts } : {}) });
          if (state === "passed" || state === "failed") {
            return { name: options.name, passed: state === "passed", message: `${options.name}: ${state} after ${attempts} observation(s)`, evidence: [JSON.stringify({ attempts, omittedObservations, observations })], observedAt: new Date().toISOString() };
          }
        } catch (error) {
          record({ observationError: error instanceof Error ? error.name : "Error" });
        }
        await waitOrAbort(Math.min(intervalMs, Math.max(0, deadline - Date.now())), context.signal);
      }
      return { name: options.name, passed: null, message: `${options.name}: terminal state not observed within ${options.deadlineMs}ms`, evidence: [JSON.stringify({ attempts, omittedObservations, observations })], observedAt: new Date().toISOString() };
    },
  };
}

async function fetchJson(options: HttpOracleOptions): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const parsed = new URL(options.url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("HTTP oracle requires an http or https URL");
  const requestImpl = parsed.protocol === "https:" ? httpsRequest : request;
  return await new Promise((resolve, reject) => {
    const req = requestImpl(parsed, { method: "GET", headers: options.headers, timeout: options.timeoutMs ?? 5_000 }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) {
          req.destroy(new Error("HTTP oracle response exceeds 1 MB"));
          return;
        }
        chunks.push(chunk);
      });
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
    const onAbort = () => req.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("HTTP oracle cancelled"));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    req.on("close", cleanup);
    req.end();
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal || !signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("HTTP oracle cancelled");
}

async function waitOrAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, delayMs);
      onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("HTTP oracle cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
