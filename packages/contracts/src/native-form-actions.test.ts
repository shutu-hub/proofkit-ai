import { describe, expect, it } from "vitest";
import { ActionSchema } from "./index.js";

describe("native form action contracts", () => {
  it("accepts exact labels, values including an empty placeholder, and explicit checked state", () => {
    for (const option of [{ label: "Complete" }, { value: "complete" }, { value: "" }]) {
      expect(ActionSchema.parse({ kind: "selectOption", selector: "#status", option })).toMatchObject({ option });
    }
    expect(ActionSchema.parse({ kind: "setChecked", selector: "#enabled", checked: false })).toMatchObject({ checked: false });
  });
  it.each([{}, { index: 1 }, { label: "Complete", value: "complete" }, { label: "" }, { value: "complete", force: true }])("rejects guessed or ambiguous option %j", (option) => {
    expect(ActionSchema.safeParse({ kind: "selectOption", selector: "#status", option }).success).toBe(false);
  });
  it("rejects implicit toggles and extra fields", () => {
    expect(ActionSchema.safeParse({ kind: "setChecked", selector: "#enabled" }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: "setChecked", selector: "#enabled", checked: true, force: true }).success).toBe(false);
  });
  it("requires a bounded, explicit multiple-select set and allows an empty set", () => {
    for (const options of [[], [{ label: "Complete" }, { value: "pending" }]]) {
      expect(ActionSchema.parse({ kind: "selectOptions", selector: "#statuses", options })).toMatchObject({ options });
    }
    for (const options of [undefined, [{ label: "Same" }, { label: "Same" }], [{ value: "a" }, { value: "a" }],
      [{ index: 1 }], Array.from({ length: 33 }, (_, index) => ({ value: String(index) }))]) {
      expect(ActionSchema.safeParse({ kind: "selectOptions", selector: "#statuses", options }).success).toBe(false);
    }
    expect(ActionSchema.safeParse({ kind: "selectOptions", selector: "#statuses", options: [], force: true }).success).toBe(false);
  });
});
