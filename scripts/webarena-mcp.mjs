import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BenchmarkCaptureSession } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Controller-owned configuration, never an agent tool argument. This entrypoint
// loads public input only; it does not load upstream data, gold or evaluator code.
export async function createWebArenaMcp(configPath) {
  const config = JSON.parse((await readBounded(configPath)).toString("utf8"));
  const fields = ["root", "workspaceRoot", "captureDirectory", "taskId", "publicInputPath", "publicInputSha256"];
  if (!config || typeof config !== "object" || Object.keys(config).some((field) => !fields.includes(field))
    || fields.some((field) => config[field] === undefined)) throw new Error("Invalid benchmark operator configuration");
  for (const name of ["root", "workspaceRoot", "captureDirectory", "publicInputPath"]) {
    if (typeof config[name] !== "string" || !isAbsolute(config[name])) throw new Error("Benchmark operator paths must be absolute");
  }
  const bytes = await readBounded(config.publicInputPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== config.publicInputSha256) throw new Error("Benchmark public input changed");
  const tasks = JSON.parse(bytes.toString("utf8"));
  const allowed = ["taskId", "revision", "sites", "intent", "startUrls", "startUrlContext", "formatSpecification"];
  if (!Array.isArray(tasks) || tasks.some((task) => !task || typeof task !== "object"
    || Object.keys(task).some((key) => !allowed.includes(key)) || !Number.isSafeInteger(task.taskId)
    || typeof task.intent !== "string" || !Array.isArray(task.startUrls) || !Array.isArray(task.sites))
    || tasks.filter((task) => task.taskId === config.taskId).length !== 1) {
    throw new Error("Expected projected public benchmark tasks");
  }
  const session = new BenchmarkCaptureSession({ directory: config.captureDirectory,
    taskId: config.taskId, publicInputSha256: digest });
  const server = await createProofkitMcp({ root: config.root, workspaceRoot: config.workspaceRoot,
    benchmarkCapture: session, allowCapabilityWrites: false });
  return { server, session };
}

async function readBounded(path) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === bytes.length) throw new Error("Benchmark input exceeds byte limit");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== "--session") {
    throw new Error("Usage: node scripts/webarena-mcp.mjs --session <operator-json>");
  }
  const { server } = await createWebArenaMcp(resolve(process.argv[3]));
  await server.connect(new StdioServerTransport());
}
