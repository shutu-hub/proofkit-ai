import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempParent = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempParent, "proofkit-git-install-"));
try {
  const head = (await command("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  const install = join(scratch, "install");
  const source = join(scratch, "source with spaces");
  const workspace = join(scratch, "external workspace");
  await mkdir(source);
  const sourceBytes = '{"name":"git-install-fixture","version":"1.0.0"}';
  await writeFile(join(source, "package.json"), sourceBytes);
  const npm = await npmExecutable();
  await command(npm.executable, [...npm.prefix, "install", "--prefix", install,
    `git+${pathToFileURL(root).href}#${head}`, "--no-audit", "--no-fund"], scratch, 600_000);
  const installed = join(install, "node_modules", "proofkit-ai");
  const cli = join(installed, "bundle", "main.js");
  await access(cli);
  await access(join(installed, "bundle", "server.js"));
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal((await command(process.execPath, [cli, "--version"], scratch)).stdout.trim(), manifest.version);
  const setup = JSON.parse((await command(process.execPath, [cli, "agent", "setup", "--harness", "generic",
    "--root", source, "--workspace", workspace, "--check-connection"], scratch)).stdout);
  assert.equal(setup.localConnection.status, "connected");
  assert.equal(setup.localConnection.testVerdict, "not-asserted");
  assert.equal(setup.localConnection.projectRoot, await realpath(source));
  assert.equal(await readFile(join(source, "package.json"), "utf8"), sourceBytes);
  console.log(JSON.stringify({ commit: head, version: manifest.version,
    verified: ["git-package-build", "installed-cli", "installed-mcp-connection", "source-unchanged"] }, null, 2));
} finally {
  const safeRoot = resolve(scratch);
  if (!safeRoot.startsWith(resolve(tempParent) + sep) || !basename(safeRoot).startsWith("proofkit-git-install-")) {
    throw new Error("Git install scratch directory escaped the temporary parent");
  }
  await rm(safeRoot, { recursive: true, force: true });
}

function command(executable, args, cwd, timeoutMs = 30_000) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-4096); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => { clearTimeout(timeout); rejectCommand(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) rejectCommand(new Error(`${executable} ${args[0]} timed out`));
      else if (code !== 0) rejectCommand(new Error(`${executable} ${args[0]} exited ${code}: ${stderr || stdout}`));
      else resolveCommand({ stdout, stderr });
    });
  });
}

async function npmExecutable() {
  if (process.platform !== "win32") return { executable: "npm", prefix: [] };
  const cli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(cli);
  return { executable: process.execPath, prefix: [cli] };
}
