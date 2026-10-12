import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runWebArenaHost } from "../scripts/webarena-run-host.mjs";
import { pilotTaskIds, upstreamCommit } from "../scripts/webarena-benchmark-lib.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const datasetSha256 = "315af52919d4afb5f5f168be58c796d35ff10d65cb49c9b762bf2b8b1c10b6cc";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-webarena-host-run-"));
  const batch = join(root, "batch"), project = join(root, "project"), workspace = join(root, "workspace");
  const capture = join(root, "capture"), operatorPath = join(root, "operator.json");
  const output = join(root, "host-output"), cli = join(root, "host.mjs");
  await mkdir(join(batch, "agent-input"), { recursive: true });
  await mkdir(project); await mkdir(workspace);
  const task = { taskId: 157, revision: 2, sites: ["shopping_admin"],
    intent: "View the details of all customers", startUrls: ["__SHOPPING_ADMIN__"] };
  const tasks = Buffer.from(JSON.stringify([task]));
  await writeFile(join(batch, "agent-input", "tasks.json"), tasks);
  await writeFile(join(batch, "report.json"), JSON.stringify({ benchmark: "webarena-verified-pilot-v1",
    provenance: { upstreamCommit, datasetSha256 }, taskIds: pilotTaskIds, publicInputSha256: hash(tasks) }));
  await writeFile(operatorPath, JSON.stringify({ root: project, workspaceRoot: workspace,
    captureDirectory: capture, taskId: 157, publicInputPath: join(batch, "agent-input", "tasks.json"),
    publicInputSha256: hash(tasks), browser: { startUrl: "http://127.0.0.1:7780/admin" } }));
  await writeFile(cli, 'if (process.argv.includes("--no-daemon")) process.exit(2); else if (process.argv.includes("mcp")) process.stdout.write("[]"); else process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");\n');
  return { root, batch, project, workspace, capture, operatorPath, output, cli };
}

test("a completed host process without a captured task cannot become a benchmark submission", async () => {
  const f = await fixture();
  try {
    const result = await runWebArenaHost({ sessionPath: f.operatorPath, batchPath: f.batch,
      output: f.output, host: "codex", cliPath: f.cli, timeoutMs: 10_000 });
    assert.equal(result.status, "incomplete");
    assert.equal(result.execution.code, 0);
    assert.equal(result.officialScore, "not-run");
    assert.equal(result.audit?.status, "incomplete");
    assert.deepEqual(await readdir(f.project), []);
    await assert.rejects(readdir(f.capture), { code: "ENOENT" });
    await assert.rejects(readdir(join(f.output, "submissions")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(f.output, "host-run.json"), "utf8")).status, "incomplete");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a CLI that exits before emitting events is an infrastructure blocker", async () => {
  const f = await fixture();
  try {
    await writeFile(f.cli, 'if (process.argv.includes("mcp")) process.stdout.write("[]"); else process.exit(2);\n');
    const result = await runWebArenaHost({ sessionPath: f.operatorPath, batchPath: f.batch,
      output: f.output, host: "codex", cliPath: f.cli, timeoutMs: 10_000 });
    assert.equal(result.status, "infrastructure-blocked");
    assert.equal(result.execution.blocker, "host-cli-startup");
    assert.equal(result.execution.milestones.firstToolCallAtMs, null);
    assert.equal(result.officialScore, "not-run");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects an ambient browser MCP before launching a benchmark host", async () => {
  const f = await fixture();
  try {
    await writeFile(f.cli, 'process.stdout.write(JSON.stringify([{name:"cua_repl",enabled:true}]));\n');
    await assert.rejects(runWebArenaHost({ sessionPath: f.operatorPath, batchPath: f.batch,
      output: f.output, host: "codex", cliPath: f.cli, timeoutMs: 10_000 }),
    /enabled ambient MCP servers.*cua_repl/);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects the Magento storefront root as a shopping admin task start", async () => {
  const f = await fixture();
  try {
    const operator = JSON.parse(await readFile(f.operatorPath, "utf8"));
    operator.browser.startUrl = "http://127.0.0.1:7780/";
    await writeFile(f.operatorPath, JSON.stringify(operator));
    await assert.rejects(runWebArenaHost({ sessionPath: f.operatorPath, batchPath: f.batch,
      output: f.output, cliPath: f.cli }), /start URL does not match/);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("refuses stale capture and unprojected task data before starting a host", async () => {
  const f = await fixture();
  try {
    await mkdir(f.capture);
    await assert.rejects(runWebArenaHost({ sessionPath: f.operatorPath, batchPath: f.batch,
      output: f.output, cliPath: f.cli }), /capture directory must be new/);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const changed = await fixture();
  try {
    const taskPath = join(changed.batch, "agent-input", "tasks.json");
    const operator = JSON.parse(await readFile(changed.operatorPath, "utf8"));
    const manifestPath = join(changed.batch, "report.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const altered = Buffer.from(JSON.stringify([{ taskId: 157, sites: ["shopping_admin"],
      intent: "View customers", startUrls: ["__SHOPPING_ADMIN__"], eval: [{ answer: "private" }] }]));
    await writeFile(taskPath, altered);
    operator.publicInputSha256 = hash(altered); manifest.publicInputSha256 = hash(altered);
    await writeFile(changed.operatorPath, JSON.stringify(operator));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(runWebArenaHost({ sessionPath: changed.operatorPath, batchPath: changed.batch,
      output: changed.output, cliPath: changed.cli }), /Unprojected benchmark task input/);
    await assert.rejects(readdir(changed.output), { code: "ENOENT" });
  } finally { await rm(changed.root, { recursive: true, force: true }); }
});
