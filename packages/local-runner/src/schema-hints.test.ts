import { describe, expect, it, vi } from "vitest";
import { z } from "@proofkit/runner";
import { describeInputShape } from "./schema-hints.js";

describe("bounded capability input hints", () => {
  it("describes optional, nullable and union input without invoking user callbacks", () => {
    const defaultValue = vi.fn(() => "private-default");
    const preprocess = vi.fn((value) => value);
    const refine = vi.fn(() => true);
    const lazy = vi.fn(() => z.string());
    const result = describeInputShape(z.object({
      mode: z.enum(["read", "observe"]),
      id: z.union([z.string(), z.number()]).nullable().optional(),
      fallback: z.string().default(defaultValue),
      checked: z.preprocess(preprocess, z.string().refine(refine)),
      opaque: z.lazy(lazy),
    }));
    expect(result.hint).toMatchObject({ kind: "object", properties: {
      mode: { kind: "enum", values: ["read", "observe"] },
      id: { kind: "union", optional: true, nullable: true },
      fallback: { kind: "string", optional: true, defaultOmitted: true },
      checked: { kind: "string", runtimeEffect: true },
      opaque: { kind: "unavailable" },
    } });
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-default");
    for (const callback of [defaultValue, preprocess, refine, lazy]) expect(callback).not.toHaveBeenCalled();
  });

  it("never changes a long enum or literal into an incorrect suggested input", () => {
    const exact = "x".repeat(200);
    const result = describeInputShape(z.object({ mode: z.enum([exact, "read"]), marker: z.literal(exact), largeInteger: z.literal(1n) }));
    expect(result.hint).toMatchObject({ properties: { mode: { kind: "unavailable" }, marker: { kind: "unavailable" }, largeInteger: { kind: "unavailable" } } });
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain(exact.slice(0, 128));
  });

  it("bounds deep, wide and large output while keeping truncation explicit", () => {
    const wide = describeInputShape(z.object(Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`field${index}`, z.string()]))));
    expect(wide.partial).toBe(true);
    expect(Object.keys(wide.hint?.properties as object).length).toBeLessThan(150);
    let deep: z.ZodTypeAny = z.string();
    for (let index = 0; index < 10; index++) deep = z.array(deep);
    expect(describeInputShape(deep).partial).toBe(true);
    const huge = describeInputShape(z.object({ ["field".repeat(1500)]: z.string() }));
    expect(huge.hint).toBeUndefined();
    expect(huge.partial).toBe(true);
    expect(JSON.stringify(huge).length).toBeLessThan(6000);
  });
});
