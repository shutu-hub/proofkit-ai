import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalRunnerService } from "@proofkit/local-runner";
import { registerTools } from "./tools.js";

export type McpServerOptions = {
  root?: string;
  evidenceDir?: string;
};

export async function createProofkitMcp(options: McpServerOptions = {}): Promise<McpServer> {
  const runner = await LocalRunnerService.create({
    root: options.root ?? process.env.PROOFKIT_ROOT ?? process.cwd(),
    evidenceDir: options.evidenceDir ?? process.env.PROOFKIT_EVIDENCE_DIR,
    restrictWebOrigins: true,
  });
  const server = new McpServer({ name: "proofkit", version: "0.1.0" });
  registerTools(server, runner);
  return server;
}

export async function main(): Promise<void> {
  const server = await createProofkitMcp();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
