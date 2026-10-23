import { describe, expect, it } from "vitest";
import { OracleResultSchema } from "./index.js";

describe("Oracle field mismatch contract", () => {
  const failing = { name: "current-record", passed: false, verificationKind: "business", message: "Current title differs" };

  it("accepts only bounded names on failing independent checks", () => {
    expect(OracleResultSchema.parse({ ...failing, fieldMismatches: ["note.title", "note.status"] }).fieldMismatches)
      .toEqual(["note.title", "note.status"]);
    for (const invalid of [[], ["note.title", "note.title"], ["email@example.com"], ["<script>"], ["a".repeat(81)],
      Array.from({ length: 9 }, (_, index) => "field" + index)]) {
      expect(OracleResultSchema.safeParse({ ...failing, fieldMismatches: invalid }).success).toBe(false);
    }
  });

  it("never labels passing, unknown or HTTP-only results as field mismatches", () => {
    for (const change of [{ passed: true }, { passed: null }, { verificationKind: "http-contract" }, { verificationKind: undefined }]) {
      expect(OracleResultSchema.safeParse({ ...failing, ...change, fieldMismatches: ["note.title"] }).success).toBe(false);
    }
  });
});
