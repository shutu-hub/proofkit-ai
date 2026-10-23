import { describe, expect, it } from "vitest";
import { HttpFieldCheckSchema, HttpFieldExpectationSchema, InlineHttpOracleSchema, ProofkitConfigSchema } from "./index.js";

const oracle = { name: "record", url: "http://127.0.0.1/status", query: { id: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" } },
  statusPointer: "/state", successValues: ["complete"], expectFields: [{ name: "total", pointer: "/total", expected: 55.03 }] };
describe("declared independent HTTP field expectations", () => {
  it("preserves bounded literal checks in both configured and inline readers", () => {
    expect(InlineHttpOracleSchema.parse(oracle).expectFields).toEqual(oracle.expectFields);
    expect(ProofkitConfigSchema.parse({ oracles: [oracle] }).oracles[0]!.expectFields).toEqual(oracle.expectFields);
    for (const expected of [false, true, null, 0, 55.03, "", "Reviewed city"]) {
      expect(HttpFieldExpectationSchema.parse({ name: "field", pointer: "/data/value", expected }).expected).toBe(expected);
    }
  });
  it.each([
    { expected: {} }, { expected: [] }, { expected: Infinity }, { expected: "x".repeat(257) }, { expected: "line\nbreak" },
    { name: "constructor" }, { pointer: "/__proto__/value" }, { pointer: "/data/~2invalid" }, { tolerance: 1 },
  ])("rejects unsafe or unbounded declarations: %j", (change) => {
    expect(HttpFieldExpectationSchema.safeParse({ name: "field", pointer: "/value", expected: "value", ...change }).success).toBe(false);
  });
  it("rejects empty, repeated and oversized expectation sets", () => {
    for (const expectFields of [[], [oracle.expectFields[0], oracle.expectFields[0]],
      [oracle.expectFields[0], { name: "other", pointer: "/total", expected: 55.03 }],
      Array.from({ length: 17 }, (_, index) => ({ name: "field" + index, pointer: "/field" + index, expected: true }))]) {
      expect(InlineHttpOracleSchema.safeParse({ ...oracle, expectFields }).success).toBe(false);
    }
  });
  it("accepts only bounded structured field-check outcomes", () => {
    for (const result of ["matched", "missing", "type-mismatch", "mismatch", "not-evaluated"]) {
      expect(HttpFieldCheckSchema.parse({ name: "total", pointer: "/total", result }).result).toBe(result);
    }
    expect(HttpFieldCheckSchema.safeParse({ name: "total", pointer: "/total", result: "matched", observed: 55.03 }).success).toBe(true);
    expect(HttpFieldCheckSchema.safeParse({ name: "total", pointer: "/total", result: "matched", body: { total: 55.03 } }).success).toBe(false);
    expect(HttpFieldCheckSchema.safeParse({ name: "total", pointer: "/total", result: "passed" }).success).toBe(false);
  });
});
