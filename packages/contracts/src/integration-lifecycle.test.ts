import { describe, expect, it } from "vitest";
import { hasIncompleteIntegrationCleanup, IntegrationCleanupSchema } from "./index.js";

describe("cleanup acceptance invariants", () => {
  const verified = { status: "verified", declaredResources: 1, verifiedResources: 1,
    artifact: "run-1/artifacts/integration-cleanup.json", sha256: "a".repeat(64) };

  it.each([
    { ...verified, artifact: undefined },
    { ...verified, sha256: undefined },
    { ...verified, verifiedResources: 0 },
    { ...verified, verifiedResources: 2 },
    { ...verified, declaredResources: 0, verifiedResources: 0 },
    { ...verified, status: "completed", verifiedResources: 0 },
    { ...verified, status: "not-required" },
  ])("rejects a green declaration without consistent cleanup proof (%j)", (cleanup) => {
    expect(IntegrationCleanupSchema.safeParse(cleanup).success).toBe(false);
    expect(hasIncompleteIntegrationCleanup(cleanup)).toBe(true);
  });

  it("keeps old Runs and completed legacy hooks readable without calling them verified", () => {
    expect(hasIncompleteIntegrationCleanup(undefined)).toBe(false);
    expect(IntegrationCleanupSchema.parse({ status: "completed", declaredResources: 0, verifiedResources: 0 }).status).toBe("completed");
    expect(IntegrationCleanupSchema.parse(verified).status).toBe("verified");
  });
});
