import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
  assert.equal(classifyHostBlocker(JSON.stringify({ type: "system", subtype: "api_retry",
    error_status: 401, error: "authentication_failed" })), "provider-access");
});

test("a Claude API authentication retry stops before its backoff loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-claude-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake-claude.cjs");
  await writeFile(script, 'process.stdout.write(JSON.stringify({type:"system",subtype:"api_retry",error_status:401,error:"authentication_failed"})+"\\n"); setInterval(()=>{},1000);');
  const result = await runHost(process.execPath, [script], root, 10_000, join(root, "events.jsonl"));
  assert.equal(result.blocker, "provider-access");
  assert.equal(result.stopReason, "provider-access");
  assert.ok(result.durationMs < 5_000);
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

test("a host exit finishes even when a descendant inherits its output pipe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-host-pipe-"));
  const pidFile = join(root, "descendant.pid");
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, "utf8"))); } catch { /* already exited */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); return; }
      catch (error) { if (error.code !== "EBUSY" || attempt === 19) throw error; }
      await delay(100);
    }
  });
  const script = join(root, "fake-host.cjs");
  await writeFile(script, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
  { detached: true, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
fs.writeFileSync(process.argv[2], String(descendant.pid));
descendant.unref();
process.stdout.write(JSON.stringify({ type: "thread.started" }) + "\\n");
`);
  const result = await runHost(process.execPath, [script, pidFile], root, 10_000, join(root, "events.jsonl"));
  assert.equal(result.code, 0);
  assert.equal(result.stopReason, null);
  assert.equal(result.timedOut, false);
  assert.match(result.transcript, /thread\.started/);
  assert.ok(result.durationMs < 5_000, `Inherited pipe should not stall the evaluator, took ${result.durationMs}ms`);
});

test("records tool, answer and completion milestones without treating a message as host completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-host-milestones-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake-host.cjs");
  await writeFile(script, `
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({ type: "item.completed", item: { type: "mcp_tool_call", tool: "inspect_test_scope" } });
emit({ type: "item.completed", item: { type: "mcp_tool_call", tool: "run_test" } });
emit({ type: "item.completed", item: { type: "agent_message", text: "{}" } });
emit({ type: "turn.completed" });
`);
  const result = await runHost(process.execPath, [script], root, 10_000, join(root, "events.jsonl"));
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.ok(result.milestones.firstToolCallAtMs >= 0);
  assert.ok(result.milestones.lastToolCallAtMs >= result.milestones.firstToolCallAtMs);
  assert.ok(result.milestones.lastAgentMessageAtMs >= result.milestones.lastToolCallAtMs);
  assert.ok(result.milestones.turnCompletedAtMs >= result.milestones.lastAgentMessageAtMs);
});

test("an event file failure rejects without waiting for the host deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-host-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(runHost(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 10_000,
    join(root, "missing", "events.jsonl")), { code: "ENOENT" });
  assert.ok(Date.now() - started < 5_000);
});
