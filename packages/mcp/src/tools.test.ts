import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { LocalRunnerService } from "@proofkit/local-runner";
import { registerTools } from "./tools.js";

describe("ProofKit MCP tools", () => {
  it("exposes only the high-level local runner surface", async () => {
    const runner = new LocalRunnerService({ root: process.cwd() });
    const server = new McpServer({ name: "proofkit-test", version: "0.1.0" });
    registerTools(server, runner);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "discover_project",
      "plan_test",
      "start_run",
      "get_run_status",
      "get_evidence",
      "replay_run",
    ]);
    expect(listed.tools.some((tool) => tool.name.includes("shell"))).toBe(false);

    await client.close();
    await server.close();
  });
});
