import { describe, expect, it } from "vitest";
import { SuiteCatalogEntrySchema, TestCharterSchema, TestSuiteSchema } from "./index.js";
const charter = TestCharterSchema.parse({ intent: "Verify a declared release workflow", level: "release", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["record"] });

describe("declared release platform matrix", () => {
  it.each([ ["web"], ["electron"], ["web", "electron"] ] as const)("accepts the explicit matrix %j", (...surfaces) => {
    expect(SuiteCatalogEntrySchema.parse({ id: "release", aliases: ["release"], level: "release", charterIds: ["notes", "jobs"], surfaces }).surfaces).toEqual(surfaces);
    expect(TestSuiteSchema.parse({ suiteId: "release", level: "release", surfaces, charters: [{ charterId: "notes", charter }, { charterId: "jobs", charter }] }).surfaces).toEqual(surfaces);
  });

  it("still requires a non-empty unique matrix and at least two distinct catalog workflows", () => {
    const suite = { id: "release", aliases: ["release"], level: "release", charterIds: ["notes", "jobs"], surfaces: ["web"] };
    for (const changed of [{ surfaces: [] }, { surfaces: ["web", "web"] }, { charterIds: ["notes"] }, { charterIds: ["notes", "notes"] }]) {
      expect(SuiteCatalogEntrySchema.safeParse({ ...suite, ...changed }).success).toBe(false);
    }
  });

  it("retains matching level and per-workflow surface restrictions", () => {
    const suite = { suiteId: "release", level: "release", surfaces: ["web"], charters: [{ charterId: "notes", charter }, { charterId: "jobs", charter }] };
    expect(TestSuiteSchema.safeParse({ ...suite, charters: [{ charterId: "notes", charter: { ...charter, level: "quick" } }, suite.charters[1]] }).success).toBe(false);
    expect(TestSuiteSchema.safeParse({ ...suite, charters: [{ ...suite.charters[0], surfaces: ["electron"] }, suite.charters[1]] }).success).toBe(false);
  });
});
