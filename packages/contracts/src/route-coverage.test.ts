import { describe, expect, it } from "vitest";
import { RouteCoverageTargetSchema } from "./index.js";

describe("RouteCoverageTargetSchema", () => {
  it("requires a method and exact HTTP origin for API evidence", () => {
    const target = { kind: "api", path: "/api/v1/resumes/:id", method: "POST", origin: "http://127.0.0.1:8080" };
    expect(RouteCoverageTargetSchema.safeParse(target).success).toBe(true);
    expect(RouteCoverageTargetSchema.safeParse({ ...target, method: undefined }).success).toBe(false);
    expect(RouteCoverageTargetSchema.safeParse({ ...target, origin: "http://127.0.0.1:8080/other" }).success).toBe(false);
    expect(RouteCoverageTargetSchema.safeParse({ ...target, origin: "file:///tmp/app" }).success).toBe(false);
    expect(RouteCoverageTargetSchema.safeParse({ ...target, source: "../other/router.ts" }).success).toBe(false);
  });

  it("keeps Web route targets independent of an API origin", () => {
    expect(RouteCoverageTargetSchema.safeParse({ kind: "web", path: "/resumes/:id", source: "apps/web/router.ts" }).success).toBe(true);
    expect(RouteCoverageTargetSchema.safeParse({ kind: "web", path: "/resumes?token=x" }).success).toBe(false);
  });
});
