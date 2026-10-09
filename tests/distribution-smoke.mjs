import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempParent = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempParent, "proofkit-distribution-"));
try {
  const packDir = join(scratch, "pack");
  const installDir = join(scratch, "install");
  const source = join(scratch, "source");
  const workspace = join(scratch, "workspace");
  await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(source)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "external-web-fixture", dependencies: { vite: "*" } }));
  await writeFile(join(source, "index.html"), "<!doctype html><title>External fixture</title>");

  const packed = parsePackOutput((await npm(["pack", "--pack-destination", packDir, "--json", "--silent"], projectRoot)).stdout);
  assert.equal(packed.name, "proofkit-ai");
  const files = packed.files.map((file) => file.path).sort();
  assert.deepEqual(files, ["LICENSE", "README.md", "bundle/main.js", "bundle/server.js", "package.json"]);
  await npm([
    "install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", resolve(packDir, packed.filename),
  ], scratch);

  const installed = join(installDir, "node_modules", "proofkit-ai");
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.private, undefined);
  assert.equal(Object.keys(installedManifest.dependencies ?? {}).some((name) => name.startsWith("@proofkit/")), false);
  const cli = join(installed, "bundle", "main.js");
  const mcp = join(installed, "bundle", "server.js");
  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node/);
  assert.equal((await command(process.execPath, [cli, "--version"], scratch)).stdout.trim(), packed.version);
  assert.equal((await npm(["exec", "--prefix", installDir, "--", "proofkit", "--version"], scratch)).stdout.trim(), packed.version);
  assert.match((await npm(["exec", "--prefix", installDir, "--", "proofkit", "mission", "create", "--help"], scratch)).stdout, /--charter <path>/);
  await command(process.execPath, [cli, "init", "--root", source, "--workspace", workspace], scratch);
  const doctor = await command(process.execPath, [cli, "doctor", "--root", source, "--workspace", workspace], scratch);
  assert.match(doctor.stdout, /web surface\s+detected/);

  assert.match(await readFile(mcp, "utf8"), /^#!\/usr\/bin\/env node/);
  const npmBin = await npmExecutable();
  const mcpEnv = { ...process.env, PROOFKIT_ROOT: source, PROOFKIT_WORKSPACE_ROOT: workspace };
  for (const key of Object.keys(mcpEnv)) if (/^npm_config_/i.test(key)) delete mcpEnv[key];
  const transport = new StdioClientTransport({
    command: npmBin.executable,
    args: [...npmBin.prefix, "exec", "--prefix", installDir, "--", "proofkit-mcp"],
    env: mcpEnv,
  });
  const client = new Client({ name: "proofkit-distribution-smoke", version: "1" });
  try {
    await withDeadline(client.connect(transport), 10_000, "MCP connection");
    const listed = await withDeadline(client.listTools(), 10_000, "MCP tool listing");
    const runTest = listed.tools.find((tool) => tool.name === "run_test");
    assert.ok(runTest);
    assert.ok(runTest.inputSchema.properties?.charter);
    const discovered = await withDeadline(client.callTool({ name: "discover_project", arguments: {} }), 10_000, "MCP project discovery");
    const item = discovered.content.find((content) => content.type === "text");
    assert.ok(item);
    assert.equal(JSON.parse(item.text).detected.web, true);
  } finally {
    await client.close();
  }
  console.log(JSON.stringify({ package: packed.name, version: packed.version, files, verified: ["isolated-npm-install", "installed-cli-bin", "cli-mission-charter-option", "cli-init-doctor", "installed-mcp-bin-stdio-discovery", "mcp-inline-charter-schema"] }, null, 2));
} finally {
  const safeRoot = resolve(scratch);
  if (!safeRoot.startsWith(resolve(tempParent) + sep) || !basename(safeRoot).startsWith("proofkit-distribution-")) {
    throw new Error("Distribution scratch directory escaped the temporary parent");
  }
  await rm(safeRoot, { recursive: true, force: true });
}

function command(executable, args, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectCommand);
    child.once("close", (code) => code === 0
      ? resolveCommand({ stdout, stderr })
      : rejectCommand(new Error(`${executable} ${args[0]} exited ${code}: ${stderr || stdout}`)));
  });
}

async function npm(args, cwd) {
  const resolved = await npmExecutable();
  return command(resolved.executable, [...resolved.prefix, ...args], cwd);
}

async function npmExecutable() {
  if (process.platform !== "win32") return { executable: "npm", prefix: [] };
  const cli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(cli);
  return { executable: process.execPath, prefix: [cli] };
}

function withDeadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function parsePackOutput(output) {
  for (let start = output.lastIndexOf("["); start >= 0; start = output.lastIndexOf("[", start - 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed) && parsed[0]?.name === "proofkit-ai") return parsed[0];
    } catch { /* prepack writes build output before npm's final JSON array */ }
  }
  throw new Error("npm pack did not return a proofkit-ai package description");
}
