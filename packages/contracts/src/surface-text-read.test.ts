import { describe, expect, it } from "vitest";
import { ActionSchema, SurfaceTableReadObservationSchema, SurfaceTableReadRequestSchema, SurfaceTextReadObservationSchema, SurfaceTextReadRequestSchema } from "./index.js";

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

describe("rendered current-page table protocol", () => {
  it("requires a pinned source for row continuation and distinct projected columns", () => {
    expect(SurfaceTableReadRequestSchema.parse({ selector: "#orders" })).toMatchObject({ offset: 0, limit: 20 });
    expect(ActionSchema.parse({ kind: "observe", readTable: { selector: "#orders" } }).kind).toBe("observe");
    for (const request of [{ selector: "#orders", offset: 1 }, { selector: "#orders", columns: [1, 1] },
      { selector: "#orders", limit: 51 }, { selector: "#orders", columns: [32] }]) {
      expect(SurfaceTableReadRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("cannot represent current-page completion as all-page verification", () => {
    const read = { scope: "rendered-current-page-table", sourceSha256: "a".repeat(64),
      columns: [{ index: 0, header: "ID" }], rows: [["1"], ["2"]], offset: 0, limit: 2,
      totalRows: 2, returnedRows: 2, nextOffset: null, allPagesVerified: false };
    expect(SurfaceTableReadObservationSchema.safeParse(read).success).toBe(true);
    for (const patch of [{ allPagesVerified: true }, { nextOffset: 1 }, { returnedRows: 1 },
      { rows: [["1", "extra"], ["2"]] }]) {
      expect(SurfaceTableReadObservationSchema.safeParse({ ...read, ...patch }).success).toBe(false);
    }
  });
});
