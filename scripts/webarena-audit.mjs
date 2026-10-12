import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditPersistedBenchmarkTask } from "../packages/local-runner/dist/index.js";

/** Trusted controller command after the MCP process exits. Never give the agent this operator file. */
export async function auditWebArenaSession(operatorPath) {
  if (!isAbsolute(operatorPath)) throw new Error("Expected absolute benchmark operator path");
  const config = JSON.parse((await bounded(operatorPath, 1024 * 1024)).toString("utf8"));
  const paths = ["root", "workspaceRoot", "captureDirectory", "publicInputPath"];
  if (!config || typeof config !== "object" || paths.some((name) => typeof config[name] !== "string" || !isAbsolute(config[name]))
    || !Number.isSafeInteger(config.taskId) || config.taskId < 0
    || typeof config.publicInputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.publicInputSha256)
    || !config.browser || typeof config.browser !== "object") throw new Error("Invalid persistent benchmark operator record");
  const publicBytes = await bounded(config.publicInputPath, 1024 * 1024);
  if (createHash("sha256").update(publicBytes).digest("hex") !== config.publicInputSha256) {
    throw new Error("Benchmark public input changed");
  }
  const tasks = JSON.parse(publicBytes.toString("utf8"));
  if (!Array.isArray(tasks) || tasks.filter((task) => task?.taskId === config.taskId).length !== 1) {
    throw new Error("Benchmark task selection changed");
  }
  return auditPersistedBenchmarkTask({ directory: config.captureDirectory, projectRoot: config.root,
    workspaceRoot: config.workspaceRoot, taskId: config.taskId, publicInputSha256: config.publicInputSha256 });
}

async function bounded(path, limit) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid benchmark audit input");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("Benchmark audit input changed while reading");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== "--session") {
    throw new Error("Usage: node scripts/webarena-audit.mjs --session <operator-json>");
  }
  const result = await auditWebArenaSession(resolve(process.argv[3]));
  console.log(JSON.stringify(result));
  if (result.status !== "consistent") process.exitCode = 1;
}
