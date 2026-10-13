import { describe, expect, it } from "vitest";
import { ActionSchema, SurfaceTextReadObservationSchema, SurfaceTextReadRequestSchema } from "./index.js";

describe("targeted rendered text protocol", () => {
  it("requires a pinned source for continuation and bounds requests", () => {
    expect(SurfaceTextReadRequestSchema.parse({ selector: "#results" })).toMatchObject({ offset: 0, limit: 4000 });
    for (const request of [{ selector: "#results", offset: 1 }, { selector: "#results", limit: 8001 },
      { selector: "#results", offset: -1 }, { selector: "#results", script: "arbitrary" }]) {
      expect(SurfaceTextReadRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(ActionSchema.parse({ kind: "observe", readText: { selector: "#results" } }).kind).toBe("observe");
  });

  it("rejects incomplete windows disguised as complete observations", () => {
    const read = { scope: "rendered-main-frame-region", text: "abc", sourceSha256: "a".repeat(64),
      offset: 0, limit: 3, totalChars: 5, returnedChars: 3, nextOffset: 3 };
    expect(SurfaceTextReadObservationSchema.safeParse(read).success).toBe(true);
    for (const patch of [{ nextOffset: null }, { returnedChars: 2 }, { totalChars: 2 }, { limit: 4 }, { offset: 6 }]) {
      expect(SurfaceTextReadObservationSchema.safeParse({ ...read, ...patch }).success).toBe(false);
    }
    expect(SurfaceTextReadObservationSchema.safeParse({ ...read, offset: 5, text: "", returnedChars: 0, nextOffset: null }).success).toBe(true);
  });
});
