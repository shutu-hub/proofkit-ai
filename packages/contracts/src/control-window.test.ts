import { describe, expect, it } from "vitest";
import { ActionSchema, SurfaceSnapshotSchema } from "./index.js";

describe("bounded control windows", () => {
  it("accepts a later control window without implying complete page coverage", () => {
    const action = ActionSchema.parse({ kind: "observe", controlOffset: 60 });
    expect(action).toMatchObject({ kind: "observe", controlOffset: 60 });
    const snapshot = SurfaceSnapshotSchema.parse({ capturedAt: "2026-10-22T00:00:00.000Z", controls: [{ tag: "button", role: "button", name: "Plain text", selector: "role=button[name=\"Plain text\"]", disabled: false }], controlsTruncated: true,
      controlWindow: { scope: "rendered-main-frame-controls", offset: 60, limit: 60, total: 61, returned: 1, nextOffset: null, allControlsObserved: false } });
    expect(snapshot.controlWindow?.nextOffset).toBeNull();
    expect(SurfaceSnapshotSchema.safeParse({ ...snapshot, controlsTruncated: false }).success).toBe(false);
  });

  it("rejects unsupported offsets and inconsistent counts", () => {
    for (const offset of [-1, 501, 1.5]) expect(ActionSchema.safeParse({ kind: "observe", controlOffset: offset }).success).toBe(false);
    expect(SurfaceSnapshotSchema.safeParse({ capturedAt: "2026-10-22T00:00:00.000Z", controls: [], controlsTruncated: true,
      controlWindow: { scope: "rendered-main-frame-controls", offset: 60, limit: 60, total: 61, returned: 1, nextOffset: null, allControlsObserved: false } }).success).toBe(false);
  });

  it("ends bounded continuation without claiming the remaining controls were observed", () => {
    const controls = Array.from({ length: 60 }, (_, index) => ({ tag: "button", role: "button", name: "Control " + index, disabled: false }));
    const snapshot = SurfaceSnapshotSchema.parse({ capturedAt: "2026-10-22T00:00:00.000Z", controls, controlsTruncated: true,
      controlWindow: { scope: "rendered-main-frame-controls", offset: 480, limit: 60, total: 550, returned: 60, nextOffset: null, allControlsObserved: false } });
    expect(snapshot.controlWindow?.total).toBe(550);
    expect(snapshot.controlWindow?.allControlsObserved).toBe(false);
  });
});
