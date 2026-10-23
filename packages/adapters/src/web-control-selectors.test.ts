import { describe, expect, it } from "vitest";
import { landmarkControlSelectors, nativeClassSelectors, observedRowName, rowControlSelectors, scopedControlSelectors } from "./web-control-selectors.js";

describe("observed record rows", () => {
  it("uses an explicit ID column while the mutable title and timestamp change", () => {
    expect(observedRowName("row-001 Private draft 2026-10-22", ["ID", "Title", "Created"], ["row-001", "Private draft", "2026-10-22"]))
      .toBe("row-001");
    expect(observedRowName("row-001 Approved", ["id", "Title"], ["row-001", "Approved"]))
      .toBe("row-001");
    expect(observedRowName("full row", ["Title"], ["row-001"])).toBe("full row");
    expect(observedRowName("full row", ["ID"], ["person@example.invalid"])).toBe("full row");
  });
  it("preserves column positions and refuses ambiguous identity headers", () => {
    expect(observedRowName("Private draft row-001", ["", "ID"], ["Private draft", "row-001"])).toBe("row-001");
    expect(observedRowName("row-001 row-002", ["ID", "Identifier"], ["row-001", "row-002"])).toBe("row-001 row-002");
    expect(observedRowName("full row", ["ID"], [""])).toBe("full row");
  });
  it("offers content-bound row candidates without fixed positions", () => {
    const selectors = rowControlSelectors("tr", ["", "record-001", "Draft"]);
    expect(selectors).toContain('tr:has(> td:text-is("record-001")):visible');
    expect(selectors).toContain('tr:has(> td :text-is("record-001")):visible');
    expect(selectors.some((selector) => selector.includes("nth"))).toBe(false);
  });
  it("omits sensitive or excessive cell text and unrelated containers", () => {
    expect(rowControlSelectors("div", ["record-001"])).toEqual([]);
    expect(rowControlSelectors("tr", ["person@example.invalid", "token=private", "x".repeat(121)])).toEqual([]);
    expect(rowControlSelectors("tr", ["one", "one", "two", "three", "ignored"])).toHaveLength(7);
  });
});

describe("observed semantic containers", () => {
  it("distinguishes a modal footer action from a same-named field control without positional selectors", () => {
    expect(landmarkControlSelectors(["div", "footer", "div", "body"], ['role=button[name="Create"]']))
      .toEqual(['footer >> role=button[name="Create"]']);
    expect(landmarkControlSelectors(["div", "output", "div", "header"], ['role=button[name="Create"]']))
      .toEqual(['header >> role=button[name="Create"]']);
  });
  it("bounds candidates and refuses non-landmark structural guesses", () => {
    expect(landmarkControlSelectors(["div", "span", "body"], ["button"])).toEqual([]);
    expect(landmarkControlSelectors(["footer", "dialog", "form", "aside", "nav"], ["a", "b", "c", "d", "e"]))
      .toHaveLength(16);
    expect(landmarkControlSelectors(["footer"], ["x".repeat(513)])).toEqual([]);
  });
});

describe("observed native control class fallbacks", () => {
  it("offers bounded class candidates without positional assumptions", () => {
    expect(nativeClassSelectors("input", ["toggle", "todo-control", "toggle"])).toEqual(["input.toggle", "input.todo-control", "input.toggle.todo-control"]);
    expect(nativeClassSelectors("input", ["one", "two", "three", "four"])).toHaveLength(4);
    expect(nativeClassSelectors("input")).toEqual([]);
  });
  it("rejects non-native elements, selector injection, oversized tokens and recognized sensitive values", () => {
    expect(nativeClassSelectors("div", ["toggle"])).toEqual([]);
    expect(nativeClassSelectors("input", ["x:hover", "name@example.com", "x y", "x".repeat(65), "phone-13812345678", "safe"])).toEqual(["input.safe"]);
  });
});

describe("observed heading and label scopes", () => {
  it("uses exact visible context and bounded child paths without ordinal selectors", () => {
    expect(scopedControlSelectors("input", [{ tag: "div", path: ["label"], text: "Check In" }]))
      .toEqual(['div:has(> label:text-is("Check In")) >> input']);
    expect(scopedControlSelectors("a", [{ tag: "article", path: ["div", "h3"], text: "Single" }], ['role=link[name="Book now"]']))
      .toEqual(['article:has(> div > h3:text-is("Single")) >> role=link[name="Book now"]', 'article:has(> div > h3:text-is("Single")) >> a']);
  });
  it("rejects unsafe, sensitive or unbounded context", () => {
    const valid = { tag: "div", path: ["h3"], text: "Room" };
    for (const scope of [{ ...valid, text: "name@example.com" }, { ...valid, text: "token=secret" }, { ...valid, text: "x".repeat(121) },
      { ...valid, path: ["h3:has(a)"] }, { ...valid, path: ["div"] }, { ...valid, path: [] }, { ...valid, path: ["div", "div", "div", "div", "h3"] }, { ...valid, tag: "div,body" }]) {
      expect(scopedControlSelectors("a", [scope])).toEqual([]);
    }
    expect(scopedControlSelectors("a", Array.from({ length: 20 }, () => valid), Array.from({ length: 20 }, (_, index) => "a.choice" + index))).toHaveLength(4);
  });
});
