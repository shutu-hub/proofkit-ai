import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHost } from "../scripts/host-runtime.mjs";

test("repeated provider stream failures before any tool call are infrastructure blockage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofkit-host-runtime-"));
  try {
    const script = join(directory, "host.mjs");
    await writeFile(script, `for (let i = 0; i < 3; i++) console.log(JSON.stringify({type:"error",message:"stream disconnected - Reconnecting"}));\nprocess.exit(1);\n`);
    const result = await runHost(process.execPath, [script], directory, 10_000, join(directory, "events.jsonl"));
    assert.equal(result.blocker, "provider-stream-unavailable");
    assert.equal(result.milestones.firstToolCallAtMs, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a recovered stream and completed host turn are not classified as infrastructure blockage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofkit-host-runtime-"));
  try {
    const script = join(directory, "host.mjs");
    await writeFile(script, `console.log(JSON.stringify({type:"error",message:"stream disconnected - Reconnecting"}));\nconsole.log(JSON.stringify({type:"turn.completed"}));\n`);
    const result = await runHost(process.execPath, [script], directory, 10_000, join(directory, "events.jsonl"));
    assert.equal(result.code, 0);
    assert.equal(result.blocker, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
