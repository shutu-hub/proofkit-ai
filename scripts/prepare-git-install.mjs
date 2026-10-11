import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const main = resolve(projectRoot, "bundle/main.js");
const server = resolve(projectRoot, "bundle/server.js");

// pnpm source installs already link the workspace packages and use the explicit
// build command. A parent pnpm command can also spawn npm, so user-agent alone
// cannot identify a source install. npm runs Git prepare before packing "files".
const workspaceLinked = existsSync(resolve(projectRoot, "packages/adapters/node_modules/@proofkit/runner/package.json"))
  && existsSync(resolve(projectRoot, "packages/cli/node_modules/@proofkit/local-runner/package.json"));
if ((existsSync(main) && existsSync(server))
  || (process.env.npm_config_user_agent?.startsWith("pnpm/") && workspaceLinked)) {
  process.exit(0);
}

const pnpm = resolve(projectRoot, "node_modules/pnpm/bin/pnpm.cjs");
if (!existsSync(pnpm)) {
  throw new Error("Git installation requires its declared pnpm build dependency");
}
await run(["install", "--frozen-lockfile", "--ignore-scripts"]);
await run(["build"]);
if (!existsSync(main) || !existsSync(server)) {
  throw new Error("Git installation did not produce ProofKit CLI and MCP entrypoints");
}

function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [pnpm, ...args], {
      cwd: projectRoot, stdio: "inherit", windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`pnpm ${args[0]} failed with exit code ${code ?? "unknown"}`)));
  });
}
