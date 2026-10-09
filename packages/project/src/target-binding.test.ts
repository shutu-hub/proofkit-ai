import { describe, expect, it } from "vitest";
import { classifyTargetBinding, inspectTargetBinding } from "./target-binding.js";

const expectedRoot = "D:/code/AIHR";
const origin = "http://localhost:5174";

describe("target binding", () => {
  it("distinguishes a matching listener process path from a different checkout", () => {
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12, projectRoot: expectedRoot }]))
      .toMatchObject({ status: "matching-process-path", processId: 12 });
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12, projectRoot: "D:/tmp/aihr-hotfix" }]))
      .toMatchObject({ status: "different-project", observedProjectRoot: "D:/tmp/aihr-hotfix", processId: 12 });
  });

  it("leaves missing or conflicting process roots unverified", () => {
    expect(classifyTargetBinding(expectedRoot, origin, [{ processId: 12 }]).status).toBe("unverified");
    expect(classifyTargetBinding(expectedRoot, origin, [
      { processId: 12, projectRoot: expectedRoot },
      { processId: 13, projectRoot: "D:/tmp/other" },
    ]).status).toBe("unverified");
  });

  it("does not claim source ownership when no local HTTP target is available", async () => {
    expect((await inspectTargetBinding(expectedRoot)).status).toBe("unverified");
    expect((await inspectTargetBinding(expectedRoot, "https://example.com/app")).status).toBe("unverified");
    expect((await inspectTargetBinding(expectedRoot, "file:///app/index.html")).status).toBe("unverified");
  });

  it("does not turn caller cancellation into an unverified target", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop target inspection"));
    await expect(inspectTargetBinding(expectedRoot, origin, controller.signal)).rejects.toThrow("stop target inspection");
  });
});
