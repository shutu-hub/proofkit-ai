import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupAgent, type AgentHarness } from "./agent-setup.js";
import { registerAgentHost } from "./agent-registration.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(harness: AgentHarness, misreport = false) {
  const scratch = await mkdtemp(join(tmpdir(), "proofkit-host-registration-"));
  roots.push(scratch);
  const root = join(scratch, "source space & $(literal)");
  const workspaceRoot = join(scratch, "external workspace");
  const serverPath = join(scratch, "server with spaces.js");
  const state = join(scratch, "host-registration.json");
  const hostCliPath = join(scratch, "host-cli.js");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"untouched"}');
  await writeFile(serverPath, "// MCP fixture\n");
  const setup = await setupAgent({ root, workspaceRoot, harness }, { serverPath });
  const correctOutput = harness === "codex"
    ? JSON.stringify({ name: setup.connection.serverName, transport: { type: "stdio",
      command: setup.connection.command, args: setup.connection.args, env: setup.connection.env } })
    : [ `${setup.connection.serverName}:`, "  Scope: User config (available in all your projects)",
      "  Type: stdio", `  Command: ${setup.connection.command}`,
      `  Args: ${setup.connection.args.join(" ")}`, "  Environment:",
      ...Object.entries(setup.connection.env).map(([key, value]) => `    ${key}=${value}`) ].join("\n");
  await writeFile(hostCliPath, `const fs = require('node:fs');
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'get') {
  if (fs.existsSync(state)) { console.log(${JSON.stringify(misreport ? '{"configured":true}' : correctOutput)}); process.exit(0); }
  console.error('No MCP server named ' + JSON.stringify(args.at(-1)) + ' found.');
  process.exit(1);
}
if (args[1] === 'add') {
  if (fs.existsSync(state)) process.exit(3);
  fs.writeFileSync(state, JSON.stringify(args));
  console.log('added');
  process.exit(0);
}
process.exit(4);
`);
  return { scratch, root, state, hostCliPath, setup };
}

describe("optional host registration", () => {
  it.each(["codex", "claude-code"] as const)("registers %s using exact argument arrays and preserves existing host entries", async (harness) => {
    const f = await fixture(harness);
    const registered = await registerAgentHost(f.setup, { hostCliPath: f.hostCliPath });
    expect(registered).toEqual({ status: "registered", phase: "verify", serverName: f.setup.connection.serverName });
    const saved = JSON.parse(await readFile(f.state, "utf8"));
    expect(saved).toEqual(f.setup.connection.registration!.args);
    expect(saved).toContain(`PROOFKIT_ROOT=${f.setup.projectRoot}`);
    expect(saved).toContain(`PROOFKIT_WORKSPACE_ROOT=${f.setup.workspaceRoot}`);
    const again = await registerAgentHost(f.setup, { hostCliPath: f.hostCliPath });
    expect(again).toMatchObject({ status: "review-required", phase: "inspect", issue: "host-server-name-already-present" });
    expect(JSON.parse(await readFile(f.state, "utf8"))).toEqual(saved);
    expect(await readFile(join(f.root, "package.json"), "utf8")).toBe('{"name":"untouched"}');
  });

  it("refuses to overwrite a foreign registration and rejects shell wrappers", async () => {
    const f = await fixture("codex");
    await writeFile(f.state, '["foreign"]');
    expect(await registerAgentHost(f.setup, { hostCliPath: f.hostCliPath })).toMatchObject({ status: "review-required" });
    expect(await readFile(f.state, "utf8")).toBe('["foreign"]');
    const wrapper = join(f.scratch, "host.cmd");
    await writeFile(wrapper, "@echo off\n");
    await expect(registerAgentHost(f.setup, { hostCliPath: wrapper })).rejects.toThrow("Shell wrapper");
  });

  it.each(["codex", "claude-code"] as const)("marks a mismatched %s host entry unverified", async (harness) => {
    const f = await fixture(harness, true);
    expect(await registerAgentHost(f.setup, { hostCliPath: f.hostCliPath })).toMatchObject({
      status: "unverified", phase: "verify", issue: "host-registration-mismatch",
    });
  });
});
