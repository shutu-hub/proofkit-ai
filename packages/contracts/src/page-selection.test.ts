import { describe, expect, it } from "vitest";
import { ActionSchema, PlanningObservationRequestSchema, SurfaceSnapshotSchema } from "./index.js";

describe("explicit Web page selection", () => {
  it("accepts a bounded exact title with finite selection time", () => {
    expect(ActionSchema.parse({ kind: "switchPage", title: "Review" })).toEqual({ kind: "switchPage", title: "Review", timeoutMs: 5000 });
    expect(PlanningObservationRequestSchema.safeParse({ status: "needs-observation", reason: "Inspect review window", expectedObservation: "Review controls", action: { kind: "switchPage", title: "Review" } }).success).toBe(true);
    for (const changed of [{ title: "" }, { title: "x".repeat(201) }, { timeoutMs: 0 }, { timeoutMs: 15001 }, { index: 1 }]) {
      expect(ActionSchema.safeParse({ kind: "switchPage", title: "Review", ...changed }).success).toBe(false);
    }
  });

  it("bounds observed page inventory independently of frame and control counts", () => {
    const page = { title: "Review", url: "http://fixture.local/__redacted__", active: false, eligibleForSwitch: true };
    const snapshot = { capturedAt: "now", pages: [page], pagesTruncated: false, metadata: {} };
    expect(SurfaceSnapshotSchema.parse(snapshot).pages).toEqual([page]);
    expect(SurfaceSnapshotSchema.safeParse({ ...snapshot, pages: Array.from({ length: 17 }, () => page) }).success).toBe(false);
  });
});
