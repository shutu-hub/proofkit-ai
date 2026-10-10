import { describe, expect, it } from "vitest";
import { ActionSchema, CaptureResponseActionSchema, ProofkitConfigSchema } from "./index.js";

const action = { kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1:8080/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } };

describe("action-scoped response contract", () => {
  it("normalizes finite windows and propagates a typed trigger", () => {
    expect(ActionSchema.parse(action)).toMatchObject({ timeoutMs: 10000, requestWindowMs: 500, response: { statuses: [200, 201] } });
    expect(CaptureResponseActionSchema.parse({ ...action, trigger: { kind: "press", selector: "#name", key: "Enter" } }).trigger.kind).toBe("press");
    expect(ActionSchema.parse({ ...action, requestStartTimeoutMs: 120000, requestWindowMs: 1000, timeoutMs: 180000 }))
      .toMatchObject({ requestStartTimeoutMs: 120000, requestWindowMs: 1000, timeoutMs: 180000 });
    expect(ActionSchema.parse({ ...action, followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 500 } }))
      .toMatchObject({ followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 500 } });
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
});
