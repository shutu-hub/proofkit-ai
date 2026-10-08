import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProofkitMcp } from "./server.js";

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-client", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payload(result: unknown) {
  const content = typeof result === "object" && result !== null && "content" in result
    ? (result as { content?: unknown }).content
    : undefined;
  if (!Array.isArray(content)) throw new Error("MCP response did not contain text content");
  const item = content.find((candidate): candidate is { type: "text"; text: string } => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const value = candidate as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string";
  });
  if (!item) throw new Error("MCP response did not contain a text item");
  return JSON.parse(item.text);
}

describe("MCP external workspace", () => {
  it("selects the workspace from environment and reopens a Mission on a new connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      await writeFile(join(root, "package.json"), '{"name":"mcp-source","devDependencies":{"vite":"1"}}');
      vi.stubEnv("PROOFKIT_ROOT", root);
      vi.stubEnv("PROOFKIT_WORKSPACE_ROOT", workspaceRoot);
      server = await createProofkitMcp();
      client = await connect(server);
      const map = payload(await client.callTool({ name: "discover_project", arguments: {} }));
      expect(map.root).toBe(root);
      expect(map.packageName).toBe("mcp-source");
      const mission = payload(await client.callTool({ name: "run_test", arguments: { intent: "verify ready", expect: ["ready"], level: "quick", autoApprove: false } }));
      expect(mission).toMatchObject({ projectRoot: root, workspaceRoot, status: "awaiting-approval", level: "quick" });
      await client.close();
      await server.close();
      server = await createProofkitMcp();
      client = await connect(server);
      const status = payload(await client.callTool({ name: "get_mission_status", arguments: { missionId: mission.missionId } }));
      expect(status.mission.projectRoot).toBe(root);
      expect(status.mission.workspaceRoot).toBe(workspaceRoot);
      expect(status.mission.status).toBe("awaiting-approval");
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      vi.unstubAllEnvs();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
});
