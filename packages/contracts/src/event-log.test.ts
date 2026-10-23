import { describe, expect, it } from "vitest";
import { RunSummarySchema, TestCharterSchema } from "./index.js";

describe("Run event-log pins", () => {
  const summary = { runId: "event-log", startedAt: "2026-10-20T00:00:00.000Z", status: "completed", charter: TestCharterSchema.parse({ intent: "inspect" }) };
  it("retains historical compatibility without inventing a seal", () => {
    expect(RunSummarySchema.parse(summary).eventLog).toBeUndefined();
    expect(RunSummarySchema.parse({ ...summary, eventLog: { status: "unavailable" } }).eventLog).toEqual({ status: "unavailable" });
  });
  it("requires bounded byte counts and original digests for a sealed log", () => {
    expect(RunSummarySchema.safeParse({ ...summary, eventLog: { status: "sealed", bytes: 12, sha256: "a".repeat(64) } }).success).toBe(true);
    for (const eventLog of [{ status: "sealed" }, { status: "sealed", bytes: 1 }, { status: "sealed", bytes: -1, sha256: "a".repeat(64) },
      { status: "sealed", bytes: 64 * 1024 * 1024 + 1, sha256: "a".repeat(64) }, { status: "unavailable", bytes: 0, sha256: "a".repeat(64) }]) {
      expect(RunSummarySchema.safeParse({ ...summary, eventLog }).success).toBe(false);
    }
  });
});
