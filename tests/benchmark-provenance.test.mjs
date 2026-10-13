import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeFingerprint, sealBenchmarkProvenance, summarizeReportedModel, validBenchmarkModel } from "../scripts/benchmark-provenance.mjs";

test("reported model only accepts host fields and never promotes tool data or aliases to verified identity", () => {
  const events = [
    { type: "system", subtype: "init", model: "claude-alias" },
    { type: "assistant", message: { model: "claude-version", content: "private-message" } },
    { type: "user", model: "tool-forgery", message: { model: "tool-forgery" } },
    { type: "system", subtype: "other", model: "wrong-field" },
    { type: "assistant", message: { model: "secret with spaces" } },
  ].map(JSON.stringify).join("\n");
  const result = summarizeReportedModel(events, "claude-code", "claude-alias");
  assert.deepEqual(result.reported, ["claude-alias", "claude-version"]);
  assert.equal(result.identifiers, "multiple-reported-identifiers");
  assert.equal(result.providerIdentityVerified, false);
  assert.ok(!JSON.stringify(result).includes("private-message"));
  assert.equal(summarizeReportedModel(events, "codex", "gpt-6-sol").status, "requested-only");
  assert.equal(summarizeReportedModel("", "codex").status, "unknown");
  assert.equal(summarizeReportedModel(JSON.stringify(events), "claude-code").status, "unknown");
  assert.equal(summarizeReportedModel('{"type":"system","subtype":"init","model":"version"}', "claude-code", "alias").identifiers, "different-identifiers");
  for (const invalid of ["--model", "x\nsecret", "x;command", "", null, "x".repeat(129)]) assert.equal(validBenchmarkModel(invalid), false);
});

test("fingerprint covers actual nested dist files; missing or changed artifacts keep sealing incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-provenance-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "packages", "core", "dist", "nested"), { recursive: true });
    for (const name of ["webarena-mcp.mjs", "webarena-run-host.mjs", "host-runtime.mjs", "benchmark-provenance.mjs"]) await writeFile(join(root, "scripts", name), "fixture");
    await writeFile(join(root, "pnpm-lock.yaml"), "fixture");
    const dist = join(root, "packages", "core", "dist", "nested", "runtime.js");
    await writeFile(dist, "v1");
    const cli = join(root, "cli.mjs"), eventsPath = join(root, "events.jsonl"), operatorPath = join(root, "operator.json");
    await writeFile(cli, "fixture-cli"); await writeFile(eventsPath, "private-events"); await writeFile(operatorPath, "private-operator");
    const launcher = { executable: process.execPath, prefix: [cli] };
    const first = await runtimeFingerprint(root, launcher);
    assert.ok(first.files["packages/core/dist/nested/runtime.js"]);
    await writeFile(dist, "v2");
    assert.notEqual((await runtimeFingerprint(root, launcher)).digest, first.digest);
    const input = { runtime: first, operatorSha256: "wrong-hash", hostConfigSha256: null };
    const changed = await sealBenchmarkProvenance(input, { root, launcher, host: "codex", transcript: "private-message", eventsPath, operatorPath });
    assert.equal(changed.sealStatus, "incomplete");
    assert.deepEqual(changed.issues, ["runtime-changed", "operator-changed"]);
    assert.equal(changed.hostConfigStable, null);
    assert.ok(!JSON.stringify(changed).includes("private-"));
    await rm(cli);
    const missing = await sealBenchmarkProvenance(input, { root, launcher, host: "codex", transcript: "", eventsPath: join(root, "missing"), operatorPath });
    assert.equal(missing.runtimeStable, null); assert.equal(missing.eventsSha256, null);
    assert.ok(missing.issues.includes("runtime-unavailable"));
    assert.ok(missing.issues.includes("events-unavailable"));
    assert.equal(input.eventsSha256, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
