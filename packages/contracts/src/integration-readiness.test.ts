import { describe, expect, it } from "vitest";
import { IntegrationReadinessInputSchema, IntegrationReadinessSchema } from "./index.js";

const candidate = { charterPath: ".proofkit/charters/core.yml", charterSha256: "a".repeat(64) };
const base = { schemaVersion: 1, testVerdict: "not-asserted", projectRoot: "/source", workspaceRoot: "/tests",
  level: "core", surfaces: ["web"], environment: "test", status: "unavailable", next: [], checkedAt: new Date().toISOString() };

describe("readiness selection provenance", () => {
  it.each([{ charterId: "core" }, candidate])("retains exactly one catalog or candidate identity (%j)", (selection) => {
    expect(IntegrationReadinessInputSchema.parse(selection)).toEqual(selection);
    expect(IntegrationReadinessSchema.parse({ ...base, ...selection })).toMatchObject(selection);
  });

  it.each([{}, { charterPath: candidate.charterPath }, { charterSha256: candidate.charterSha256 },
    { charterId: "core", ...candidate }, { charterId: "core", charterPath: candidate.charterPath },
    { charterId: "core", charterSha256: candidate.charterSha256 }, { ...candidate, charterSha256: "bad" }])(
    "rejects missing, ambiguous or incomplete provenance in both input and output (%j)", (selection) => {
      expect(IntegrationReadinessInputSchema.safeParse(selection).success).toBe(false);
      expect(IntegrationReadinessSchema.safeParse({ ...base, ...selection }).success).toBe(false);
    });

  it("refuses a product acceptance claim even when the connector passes", () => {
    expect(IntegrationReadinessSchema.safeParse({ ...base, ...candidate, testVerdict: "passed",
      status: "ready", check: { passed: true, message: "ready" } }).success).toBe(false);
  });
});
