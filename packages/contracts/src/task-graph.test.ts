import { describe, expect, it } from "vitest";
import { TaskGraphSchema } from "./index.js";

const task = (taskId: string, dependsOn: string[] = []) => ({
  taskId, title: taskId, objective: taskId, tool: "fixture.tool", dependsOn,
});

describe("TaskGraphSchema", () => {
  it("accepts a connected acyclic graph with an explicit terminal", () => {
    expect(TaskGraphSchema.parse({
      tasks: [task("discover"), task("run", ["discover"]), task("verify", ["run"])],
      terminalTaskIds: ["verify"],
    }).tasks).toHaveLength(3);
  });

  it("validates a long dependency chain without recursive traversal", () => {
    const tasks = Array.from({ length: 1_500 }, (_, index) => task(`task-${index}`, index === 0 ? [] : [`task-${index - 1}`]));
    expect(TaskGraphSchema.parse({ tasks, terminalTaskIds: ["task-1499"] }).tasks).toHaveLength(1_500);
  });

  it.each([
    ["duplicate task", [task("run"), task("run")], ["run"]],
    ["missing dependency", [task("run", ["missing"])], ["run"]],
    ["self dependency", [task("run", ["run"])], ["run"]],
    ["duplicate dependency", [task("root"), task("run", ["root", "root"])], ["run"]],
    ["cycle", [task("a", ["b"]), task("b", ["a"])], ["a"]],
    ["missing terminal", [task("run")], []],
    ["unknown terminal", [task("run")], ["missing"]],
    ["duplicate terminal", [task("run")], ["run", "run"]],
    ["terminal with dependents", [task("root"), task("run", ["root"])], ["root", "run"]],
    ["unreported branch", [task("root"), task("run", ["root"]), task("orphan", ["root"])], ["run"]],
  ] as const)("rejects %s", (_reason, tasks, terminalTaskIds) => {
    expect(() => TaskGraphSchema.parse({ tasks, terminalTaskIds })).toThrow();
  });
});
