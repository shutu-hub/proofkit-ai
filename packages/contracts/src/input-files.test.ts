import { describe, expect, it } from "vitest";
import { ActionSchema, FixturePathSchema, TestCharterSchema } from "./index.js";

describe("workspace fixture references", () => {
  it.each(["C:/secret.pdf", "/etc/passwd", "../resume.pdf", ".proofkit/config.yaml", ".proofkit/fixtures/../config.yaml", ".proofkit/fixtures\\resume.pdf", ".proofkit/fixtures/a:stream", ".proofkit/fixtures//a", ".proofkit/fixtures/a.", ".proofkit/fixtures/a\0.pdf"])("rejects %s", (path) => {
    expect(FixturePathSchema.safeParse(path).success).toBe(false);
  });
  it("accepts portable fixture paths and propagates the action to negative scenarios", () => {
    const action = { kind: "setInputFiles", selector: 'input[type="file"]', files: [".proofkit/fixtures/简历.pdf"] };
    expect(ActionSchema.parse(action)).toEqual(action);
    const charter = TestCharterSchema.parse({ intent: "upload", actions: [action], negativeCases: [{ caseId: "invalid-file", title: "reject invalid file", actions: [action] }] });
    expect(charter.negativeCases?.[0]?.actions[0]?.kind).toBe("setInputFiles");
    expect(ActionSchema.safeParse({ ...action, buffer: "secret" }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...action, files: [] }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...action, files: Array(11).fill(".proofkit/fixtures/a.pdf") }).success).toBe(false);
  });
});
