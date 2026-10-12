import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BenchmarkCaptureSession } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

// Controller-owned configuration, never an agent tool argument. This entrypoint
// loads public input only; it does not load upstream data, gold or evaluator code.
export async function createWebArenaMcp(configPath) {
  const config = JSON.parse((await readBounded(configPath)).toString("utf8"));
  const fields = ["root", "workspaceRoot", "captureDirectory", "taskId", "publicInputPath", "publicInputSha256"];
  if (!config || typeof config !== "object" || Object.keys(config).some((field) => ![...fields, "browser"].includes(field))
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
  const browser = config.browser === undefined ? undefined : z.object({
    startUrl: z.string().url(), executablePath: z.string().min(1).optional(), headless: z.boolean().optional(),
    extraHTTPHeaders: z.record(z.string().max(4096)).optional(),
  }).strict().parse(config.browser);
  if (browser) {
    const start = new URL(browser.startUrl);
    if (!["http:", "https:"].includes(start.protocol) || start.username || start.password
      || !["localhost", "127.0.0.1", "[::1]"].includes(start.hostname)) {
      throw new Error("Benchmark MCP start URL requires a loopback test-site mapping");
    }
    if (browser.extraHTTPHeaders && Object.entries(browser.extraHTTPHeaders).some(([name, value]) =>
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))) {
      throw new Error("Invalid benchmark browser headers");
    }
  }
  const session = new BenchmarkCaptureSession({ directory: config.captureDirectory,
    taskId: config.taskId, publicInputSha256: digest, browser });
  const server = await createProofkitMcp({ root: config.root, workspaceRoot: config.workspaceRoot,
    benchmarkCapture: session, allowCapabilityWrites: false });
  if (browser) {
    const answer = z.object({
      task_type: z.enum(["RETRIEVE", "NAVIGATE", "MUTATE"]),
      status: z.enum(["SUCCESS", "ACTION_NOT_ALLOWED_ERROR", "PERMISSION_DENIED_ERROR", "NOT_FOUND_ERROR", "DATA_VALIDATION_ERROR", "UNKNOWN_ERROR"]),
      retrieved_data: z.array(z.unknown()).nullable(), error_details: z.string().nullable(),
    }).strict();
    server.tool("submit_benchmark_task",
      "Submit the final public-task answer once. Requires all browser Runs to have finished; seals the complete shared-context HAR and includes every attempt. Captured means local evidence consistency, not official task success, AI certification or product acceptance. No further browser actions are allowed.",
      answer.shape,
      async (input) => ({ content: [{ type: "text", text: JSON.stringify(await session.finalizeTask(answer.parse(input))) }] }));
    const previousClose = server.server.onclose;
    server.server.onclose = () => {
      previousClose?.();
      void session.abandonTask().catch(() => { process.stderr.write("Benchmark task browser cleanup failed\n"); });
    };
  }
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
  const { server, session } = await createWebArenaMcp(resolve(process.argv[3]));
  let stopping;
  const stop = () => stopping ??= (async () => {
    await session.abandonTask();
    await server.close();
  })();
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  // StdioServerTransport does not close itself when stdin reaches EOF. Without
  // an explicit owner cleanup, Node may exit before Playwright flushes HAR.
  process.stdin.once("end", () => { void stop().catch(() => { process.stderr.write("Benchmark task browser cleanup failed\n"); }); });
  await server.connect(new StdioServerTransport());
}
