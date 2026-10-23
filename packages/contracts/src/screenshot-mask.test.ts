import { describe, expect, it } from "vitest";
import { ProofkitConfigSchema } from "./index.js";

describe("workspace screenshot mask selectors", () => {
  it("keeps the policy optional and bounds editable selectors", () => {
    expect(ProofkitConfigSchema.parse({}).surfaces.web).toBeUndefined();
    expect(ProofkitConfigSchema.parse({ surfaces: { web: { screenshotMaskSelectors: ["  #private  "] } } }).surfaces.web?.screenshotMaskSelectors).toEqual(["#private"]);
    for (const selectors of [[" "], ["x".repeat(257)], Array.from({ length: 17 }, (_, index) => `#private-${index}`)]) {
      expect(ProofkitConfigSchema.safeParse({ surfaces: { web: { screenshotMaskSelectors: selectors } } }).success).toBe(false);
    }
  });
});
