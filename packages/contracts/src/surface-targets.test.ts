import { describe, expect, it } from "vitest";
import { ActionSchema, changedSurfaceTargetFields, PlanningSurfaceObservationSchema, planningObservationSources, SurfaceTargetCheckSchema, SurfaceTargetExpectationSchema } from "./index.js";

const observedAt = "2026-10-19T00:00:00.000Z";
const expected = { observedAt, origin: "https://fixture.local", tag: "button", role: "button", name: "Save", groupName: "" };
const actual = { tag: "button", role: "button", name: "Save", groupName: "" };

describe("planned surface identities", () => {
  it("keeps multi-state source declarations bounded, distinct and consistent", () => {
    const source = (runId: string) => ({ runId, manifestSha256: "a".repeat(64), snapshotPath: `${runId}/artifacts/step-001-after.json`, snapshotSha256: "b".repeat(64) });
    const first = { capturedAt: observedAt, controlsTruncated: false, source: source("first") };
    const second = { capturedAt: "2026-10-19T00:01:00.000Z", controlsTruncated: true, source: source("second") };
    const input = { capturedAt: observedAt, controlsTruncated: true, sources: [first, second] };
    expect(planningObservationSources(PlanningSurfaceObservationSchema.parse(input))).toHaveLength(2);
    expect(PlanningSurfaceObservationSchema.safeParse({ ...input, controlsTruncated: false }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ ...input, source: first.source }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ ...input, sources: [first, first] }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ ...input, sources: [] }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ ...input, sources: Array.from({ length: 11 }, (_, index) => ({ ...first, source: source(`source-${index}`) })) }).success).toBe(false);
  });

  it("bounds the optional saved source and session declaration without requiring it for caller snapshots", () => {
    expect(PlanningSurfaceObservationSchema.parse({ capturedAt: observedAt, controlsTruncated: false })).toEqual({ capturedAt: observedAt, controlsTruncated: false });
    const source = { runId: "inspection-1", manifestSha256: "a".repeat(64), snapshotPath: "inspection-1/artifacts/step-001-after.json", snapshotSha256: "b".repeat(64) };
    expect(PlanningSurfaceObservationSchema.safeParse({ capturedAt: observedAt, controlsTruncated: false, source }).success).toBe(true);
    expect(PlanningSurfaceObservationSchema.safeParse({ capturedAt: observedAt, controlsTruncated: false, source: { ...source, snapshotPath: "../private.json" } }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ capturedAt: observedAt, controlsTruncated: false, source: { ...source, manifestSha256: "invalid" } }).success).toBe(false);
    expect(PlanningSurfaceObservationSchema.safeParse({ capturedAt: observedAt, controlsTruncated: false, sessionId: "arbitrary label" }).success).toBe(false);
  });

  it("keeps legacy actions readable and permits explicit observed expectations on every control action", () => {
    expect(ActionSchema.parse({ kind: "click", selector: "#save" })).toEqual({ kind: "click", selector: "#save" });
    for (const action of [{ kind: "click" }, { kind: "fill", value: "reviewed" }, { kind: "press", key: "Enter" },
      { kind: "setChecked", checked: true }, { kind: "selectOption", option: { label: "Ready" } }, { kind: "selectOptions", options: [] },
      { kind: "waitForValue", value: "expected", timeoutMs: 1000, stableForMs: 250 },
      { kind: "setInputFiles", files: [".proofkit/fixtures/sample.txt"] }]) {
      expect(ActionSchema.parse({ ...action, selector: "#save", expectedTarget: expected })).toHaveProperty("expectedTarget.name", "Save");
    }
  });

  it("computes exact finite differences independently of adapter status", () => {
    expect(changedSurfaceTargetFields(expected, actual, "https://fixture.local")).toEqual([]);
    expect(changedSurfaceTargetFields(expected, { ...actual, name: "Delete", role: "link" }, "https://other.local")).toEqual(["role", "name", "origin"]);
    const check = { selector: "#save", observedAt, expected, actual, actualOrigin: "https://fixture.local", status: "matched", changedFields: [] };
    expect(SurfaceTargetCheckSchema.safeParse(check).success).toBe(true);
    expect(SurfaceTargetCheckSchema.safeParse({ ...check, actual: { ...actual, name: "Delete" } }).success).toBe(false);
    expect(SurfaceTargetCheckSchema.safeParse({ ...check, status: "changed", changedFields: ["name"] }).success).toBe(false);
    expect(SurfaceTargetCheckSchema.safeParse({ ...check, actual: { ...actual, name: "Delete" }, status: "changed", changedFields: ["name", "name"] }).success).toBe(false);
  });

  it.each(["https://user:secret@fixture.local", "https://fixture.local/path", "https://fixture.local?token=private", "file:///private/app"])("refuses a non-origin binding %s", (origin) => {
    expect(SurfaceTargetExpectationSchema.safeParse({ ...expected, origin }).success).toBe(false);
  });

  it("bounds control names and excludes input values from the identity contract", () => {
    expect(SurfaceTargetExpectationSchema.safeParse({ ...expected, name: "x".repeat(121) }).success).toBe(false);
    expect(SurfaceTargetExpectationSchema.safeParse({ ...expected, value: "private input" }).success).toBe(false);
  });
});
