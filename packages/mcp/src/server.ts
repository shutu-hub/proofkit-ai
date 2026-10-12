#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LocalRunnerService, type BenchmarkCaptureSession } from "@proofkit/local-runner";
import { registerTools } from "./tools.js";

export type McpServerOptions = {
  root?: string;
  workspaceRoot?: string;
  evidenceDir?: string;
  /** Explicit operator opt-in for trusted, test-environment write capabilities. */
  allowCapabilityWrites?: boolean;
  /** Trusted embedding API; never read from ordinary MCP tool inputs or environment variables. */
  benchmarkCapture?: BenchmarkCaptureSession;
};

export async function createProofkitMcp(options: McpServerOptions = {}): Promise<McpServer> {
  const runner = await LocalRunnerService.create({
    root: options.root ?? process.env.PROOFKIT_ROOT ?? process.cwd(),
    workspaceRoot: options.workspaceRoot ?? process.env.PROOFKIT_WORKSPACE_ROOT,
    evidenceDir: options.evidenceDir ?? process.env.PROOFKIT_EVIDENCE_DIR,
    restrictWebOrigins: true,
    allowCapabilityWrites: options.allowCapabilityWrites ?? (process.env.PROOFKIT_ALLOW_CAPABILITY_WRITES === "1"),
    benchmarkCapture: options.benchmarkCapture,
  });
  const server = new McpServer({ name: "proofkit", version: "0.1.0" });
  registerTools(server, runner);
  return server;
}

export async function main(): Promise<void> {
  const server = await createProofkitMcp();
  await server.connect(new StdioServerTransport());
}

if (invokedAsExecutable()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function invokedAsExecutable(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entry = realpathSync.native(process.argv[1]);
    const current = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? entry.toLowerCase() === current.toLowerCase() : entry === current;
  } catch {
    return false;
  }
}
