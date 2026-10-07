import { describe, expect, it } from "vitest";
import { IntentPlanner } from "./index.js";

describe("IntentPlanner", () => {
  it("creates executable navigation and text assertions", () => {
    const charter = new IntentPlanner().plan("打开招聘页", { url: "https://example.com", expect: ["Example"] });
    expect(charter.actions).toEqual([{ kind: "goto", url: "https://example.com" }, { kind: "observe" }]);
    expect(charter.assertions).toEqual([{ kind: "text-visible", text: "Example" }]);
    expect(charter.metadata.planner).toBe("deterministic-v1");
  });
});
