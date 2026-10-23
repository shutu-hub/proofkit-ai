import { describe, expect, it } from "vitest";
import { ActionSchema, CaptureResponseActionSchema, InlineHttpOracleSchema, ProofkitConfigSchema, ResponseErrorObservationSchema, TestCharterSchema } from "./index.js";

const action = { kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1:8080/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } };

describe("unexpected response diagnostic contract", () => {
  const diagnostic = { name: "intake", kind: "unexpected-status", acceptance: "not-established", association: "action-window",
    url: action.response.url, method: "POST", status: 422, expectedStatuses: [201], requestCount: 1,
    windowStartedAt: "2026-10-20T00:00:00.000Z", windowEndedAt: "2026-10-20T00:00:01.000Z", capturedAt: "2026-10-20T00:00:01.000Z",
    bodyBytes: 22, bodySha256: "a".repeat(64), fields: { message: "Invalid address" }, fieldGaps: [] };
  it("accepts explicitly selected diagnostics independently from successful facts", () => {
    expect(ResponseErrorObservationSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, errorFields: { message: { pointer: "/message", type: "string" } } } }).response.errorFields).toBeDefined();
  });
  it("retains incomplete fields only for a declared status and an actual projection gap", () => {
    const incomplete = { ...diagnostic, kind: "incomplete-fields", status: 201, fieldGaps: [{ name: "room", code: "missing" }] };
    expect(ResponseErrorObservationSchema.safeParse(incomplete).success).toBe(true);
    for (const change of [{ status: 422 }, { fieldGaps: [] }, { bodyGap: "body-unavailable", fields: {}, fieldGaps: [] }]) {
      expect(ResponseErrorObservationSchema.safeParse({ ...incomplete, ...change }).success).toBe(false);
    }
    expect(ResponseErrorObservationSchema.safeParse({ ...incomplete, fieldGaps: [], requestGap: "request-json-invalid" }).success).toBe(true);
  });
  it.each([
    { status: 201 }, { status: 302 }, { acceptance: "passed" }, { windowEndedAt: "invalid" }, { bodySha256: undefined },
    { bodyGap: "body-unavailable" }, { fieldGaps: [{ name: "message", code: "missing" }] },
    { fieldGaps: [{ name: "other", code: "missing" }, { name: "other", code: "invalid" }] },
    { requestFields: { quantity: 2 } }, { requestBodyBytes: 3 },
    { requestFields: { quantity: 2 }, requestBodyBytes: 3, requestBodySha256: "b".repeat(64), requestGap: "request-json-invalid" },
  ])("rejects contradictory or structurally unverified diagnostics: %j", (change) => {
    expect(ResponseErrorObservationSchema.safeParse({ ...diagnostic, ...change }).success).toBe(false);
  });
});

describe("action-scoped response contract", () => {
  it("enforces explicit encryption key configuration for persisted sessions", () => {
    expect(ProofkitConfigSchema.safeParse({ sessions: { persistence: "encrypted" } }).success).toBe(false);
    expect(ProofkitConfigSchema.safeParse({ sessions: { persistence: "disabled", keyEnv: "PROOFKIT_SESSION_KEY" } }).success).toBe(false);
    expect(ProofkitConfigSchema.safeParse({ sessions: { persistence: "encrypted", keyEnv: "PROOFKIT_SESSION_KEY" } }).success).toBe(true);
    expect(ProofkitConfigSchema.safeParse({}).success).toBe(true);
    expect(ProofkitConfigSchema.safeParse({ sessions: { recordNetwork: false } }).success).toBe(true);
    expect(ProofkitConfigSchema.safeParse({ sessions: { recordNetwork: "false" } }).success).toBe(false);
    expect(ProofkitConfigSchema.safeParse({ sessions: { recordVideo: true, recordNetwork: false } }).success).toBe(true);
    expect(ProofkitConfigSchema.safeParse({ sessions: { recordVideo: "true" } }).success).toBe(false);
  });

  it("normalizes finite windows and propagates a typed trigger", () => {
    expect(ActionSchema.parse(action)).toMatchObject({ timeoutMs: 10000, requestWindowMs: 500, response: { statuses: [200, 201] } });
    expect(CaptureResponseActionSchema.parse({ ...action, trigger: { kind: "press", selector: "#name", key: "Enter" } }).trigger.kind).toBe("press");
    expect(ActionSchema.parse({ ...action, requestStartTimeoutMs: 120000, requestWindowMs: 1000, timeoutMs: 180000 }))
      .toMatchObject({ requestStartTimeoutMs: 120000, requestWindowMs: 1000, timeoutMs: 180000 });
    expect(ActionSchema.parse({ ...action, followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 500 } }))
      .toMatchObject({ followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 500 } });
  });
  it("allows only distinct one-segment string-like selected query parameters", () => {
    const selected = { tenant: { pointer: "/tenant", type: "identifier" as const } };
    expect(CaptureResponseActionSchema.parse({ ...action, response: { ...action.response, queryFields: selected } }).response.queryFields).toEqual(selected);
    for (const queryFields of [
      { tenant: { pointer: "/tenant/id", type: "identifier" } },
      { tenant: { pointer: "/tenant", type: "number" } },
      { tenant: { pointer: "/tenant", type: "identifier" }, alias: { pointer: "/tenant", type: "identifier" } },
    ]) expect(CaptureResponseActionSchema.safeParse({ ...action, response: { ...action.response, queryFields } }).success).toBe(false);
  });
  it.each(["invalid", "file:///private", "https://user:password@example.com/api", "https://example.com/api?token=private", "https://example.com/api#private"])("rejects unsafe endpoint %s", (url) => {
    expect(ActionSchema.safeParse({ ...action, response: { ...action.response, url } }).success).toBe(false);
  });
  it.each(["data/file_id", "/data/~2bad", "/data/__proto__/x", "/data/constructor", "/a/b/c/d/e/f/g/h/i"])("rejects unsafe pointer %s", (pointer) => {
    expect(ActionSchema.safeParse({ ...action, response: { ...action.response, fields: { fileId: { pointer, type: "id" } } } }).success).toBe(false);
  });
  it("rejects arbitrary triggers, body dumps, empty or excessive projections and unbounded timing", () => {
    for (const change of [{ trigger: { kind: "goto", url: "http://127.0.0.1" } }, { script: "readSecrets()" },
      { timeoutMs: 600001 }, { requestWindowMs: 0 }, { requestStartTimeoutMs: 0 }, { requestStartTimeoutMs: 300001 },
      { followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 0 } },
      { followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 5001 } },
      { followUp: { kind: "clickIfVisible", selector: "x".repeat(1025), waitMs: 500 } },
      { followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 500, script: "danger()" } }]) {
      expect(ActionSchema.safeParse({ ...action, ...change }).success).toBe(false);
    }
    for (const fields of [{}, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, { pointer: "/data/id", type: "id" }])), { body: { pointer: "/data", type: "object" } }]) {
      expect(ActionSchema.safeParse({ ...action, response: { ...action.response, fields } }).success).toBe(false);
    }
  });
  it("requires an independent identity pointer for response-bound HTTP checks", () => {
    const oracle = { name: "terminal", url: "http://127.0.0.1/status", statusPointer: "/data/status", successValues: ["complete"] };
    const binding = { source: "response", stepId: "step-003", field: "fileId", matchPointer: "/data/file_id" };
    expect(ProofkitConfigSchema.parse({ oracles: [{ ...oracle, query: { fileId: binding } }] }).oracles[0]?.query.fileId).toEqual(binding);
    for (const change of [{ matchPointer: undefined }, { matchPointer: "/data/~2bad" }, { field: "constructor" }]) {
      expect(ProofkitConfigSchema.safeParse({ oracles: [{ ...oracle, query: { fileId: { ...binding, ...change } } }] }).success).toBe(false);
    }
  });
  it("accepts only bounded, response-bound inline business readers", () => {
    const oracle = { name: "current-intake", url: "http://127.0.0.1:8080/api/v1/intakes/status",
      query: { fileId: { source: "response", stepId: "step-001", field: "fileId", matchPointer: "/data/file_id" } },
      statusPointer: "/data/state", successValues: ["complete"], failureValues: ["failed"] };
    expect(TestCharterSchema.parse({ intent: "Verify current intake", actions: [action],
      oracles: ["current-intake"], httpOracles: [oracle] }).httpOracles?.[0]).toMatchObject({
      ...oracle, expectedStatus: 200, intervalMs: 500, deadlineMs: 30000,
    });
    for (const change of [
      { query: {} }, { query: { runId: { source: "runId" } } },
      { url: "http://127.0.0.1/status?token=private" },
      { url: "http://user:password@127.0.0.1/status" },
      { statusPointer: "/data/__proto__/state" },
      { successValues: ["complete"], failureValues: ["complete"] },
      { deadlineMs: 300001 }, { script: "return true" },
    ]) expect(InlineHttpOracleSchema.safeParse({ ...oracle, ...change }).success).toBe(false);
  });
});
