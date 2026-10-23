import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceTargetExpectation } from "@proofkit/contracts";
import { withWebActionTarget } from "./web-target.js";

const expected: SurfaceTargetExpectation = { observedAt: "2026-10-19T00:00:00.000Z", origin: "https://fixture.local", tag: "button", role: "button", name: "Save", groupName: "" };

function fixture() {
  const raw = { tag: "button", role: "button", name: "Save", groupName: "", inputType: undefined };
  const handle = { evaluate: vi.fn(async () => raw), click: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const locator = { first: () => locator, waitFor: vi.fn(async () => {}), count: vi.fn(async () => 1), elementHandle: vi.fn(async () => handle), click: vi.fn() };
  const page = { locator: () => locator, url: () => "https://fixture.local/editor" } as unknown as Page;
  const recordTargetCheck = vi.fn(async () => {});
  return { raw, handle, locator, page, recordTargetCheck };
}

describe("pre-action Web target identity", () => {
  it("records the match before acting and disposes the exact checked element", async () => {
    const state = fixture();
    await withWebActionTarget(state.page, "#save", expected, state, (target) => target.click());
    expect(state.recordTargetCheck).toHaveBeenCalledWith(expect.objectContaining({ status: "matched", changedFields: [] }));
    expect(state.recordTargetCheck.mock.invocationCallOrder[0]).toBeLessThan(state.handle.click.mock.invocationCallOrder[0]!);
    expect(state.handle.click).toHaveBeenCalledOnce();
    expect(state.locator.click).not.toHaveBeenCalled();
    expect(state.handle.dispose).toHaveBeenCalledOnce();
  });

  it.each(["name", "role", "tag", "groupName", "inputType"])("stops before mutation when %s changes", async (field) => {
    const state = fixture(); Object.assign(state.raw, { [field]: "changed" });
    await expect(withWebActionTarget(state.page, "#save", expected, state, (target) => target.click())).rejects.toMatchObject({ code: "surface-target-changed" });
    expect(state.recordTargetCheck).toHaveBeenCalledWith(expect.objectContaining({ status: "changed", changedFields: [field] }));
    expect(state.handle.click).not.toHaveBeenCalled();
    expect(state.handle.dispose).toHaveBeenCalledOnce();
  });

  it("does not follow a selector replacement after its check evidence is saved", async () => {
    const state = fixture();
    const replacement = { ...state.handle, click: vi.fn() };
    state.recordTargetCheck.mockImplementation(async () => { state.locator.elementHandle.mockResolvedValue(replacement); state.handle.click.mockRejectedValue(new Error("Checked element was detached")); });
    await expect(withWebActionTarget(state.page, "#save", expected, state, (target) => target.click())).rejects.toThrow("detached");
    expect(replacement.click).not.toHaveBeenCalled();
    expect(state.locator.elementHandle).toHaveBeenCalledOnce();
  });

  it("stops before acting if saving the check fails or cancellation arrives during the evidence write", async () => {
    const state = fixture(); state.recordTargetCheck.mockRejectedValue(new Error("Cannot save check"));
    await expect(withWebActionTarget(state.page, "#save", expected, state, (target) => target.click())).rejects.toThrow("Cannot save check");
    expect(state.handle.click).not.toHaveBeenCalled();
    const controller = new AbortController();
    state.recordTargetCheck.mockImplementation(async () => { controller.abort(new Error("Cancelled")); });
    await expect(withWebActionTarget(state.page, "#save", expected, { ...state, signal: controller.signal }, (target) => target.click())).rejects.toThrow("Cancelled");
    expect(state.handle.click).not.toHaveBeenCalled();
  });

  it("records only sanitized identity text and safe origins", async () => {
    const state = fixture(); state.raw.name = "Authorization: Bearer private-token";
    await expect(withWebActionTarget(state.page, "#save", expected, state, (target) => target.click())).rejects.toMatchObject({ code: "surface-target-changed" });
    expect(JSON.stringify(state.recordTargetCheck.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(state.recordTargetCheck.mock.calls)).not.toContain("/editor");
  });
});
