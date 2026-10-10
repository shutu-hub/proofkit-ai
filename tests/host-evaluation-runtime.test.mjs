import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyHostBlocker, runHost } from "./host-evaluation-runtime.mjs";

test("provider access outranks an MCP cancellation; ordinary model output is not a blocker", () => {
  const events = [
    { type: "item.completed", item: { type: "mcp_tool_call", status: "failed", error: { message: "user cancelled MCP tool call" } } },
    { type: "error", message: "403 Forbidden: insufficient balance" },
  ];
  assert.equal(classifyHostBlocker(events.map((event) => JSON.stringify(event)).join("\n")), "provider-balance");
  assert.equal(classifyHostBlocker(JSON.stringify({ type: "item.completed", item: {
    type: "agent_message", text: "The example says 403 Forbidden: insufficient balance" } })), null);
  assert.equal(classifyHostBlocker(JSON.stringify(events[0])), "mcp-tool-call-cancelled");
});

test("a decisive provider error stops the owned host process before its retry loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-host-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake-host.cjs");
  await writeFile(script, 'process.stdout.write(JSON.stringify({type:"error",message:"403 Forbidden: insufficient balance"})+"\\n"); setInterval(()=>{},1000);');
  const result = await runHost(process.execPath, [script], root, 10_000, join(root, "events.jsonl"));
  assert.equal(result.blocker, "provider-balance");
  assert.equal(result.stopReason, "provider-balance");
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs < 5_000, `Host should stop promptly, took ${result.durationMs}ms`);
});
