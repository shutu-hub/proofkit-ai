import assert from "node:assert/strict";
import test from "node:test";
import { standaloneRunTraceIssues } from "../scripts/webarena-host-audit.mjs";

test("each standalone browser run must be returned by a matching ProofKit surface tool", () => {
  const calls = [
    { tool: "inspect_surface", result: { inspectionId: "inspection-1" } },
    { tool: "interact_surface", result: { interactionId: "interaction-2" } },
    { tool: "submit_benchmark_task", result: { runIds: ["forged-3"] } },
  ];
  assert.deepEqual(standaloneRunTraceIssues(["inspection-1", "interaction-2"], calls), []);
  assert.deepEqual(standaloneRunTraceIssues(["inspection-1", "forged-3"], calls),
    ["forged-3:host-standalone-run-not-observed"]);
  assert.deepEqual(standaloneRunTraceIssues(["inspection-1"], [{ tool: "run_test", result: { inspectionId: "inspection-1" } }]),
    ["inspection-1:host-standalone-run-not-observed"]);
});
