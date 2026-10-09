import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
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
  it("runs a curated write workflow only with the operator's process-level opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-write-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-write-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
      vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
      vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }));
      await writeFile(join(root, "package.json"), '{"name":"write-source"}');
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
        project: { root }, policies: { environment: "test", sideEffects: "allow" },
        charters: [{ id: "write-core", path: ".proofkit/charters/write.yml", aliases: ["写入测试"], level: "core", surfaces: ["web"] }],
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "write.yml"), JSON.stringify({
        intent: "验证隔离写入", level: "core", actions: [{ kind: "capability", name: "fixture.write", input: {} }],
        assertions: [{ kind: "text-visible", text: "ready" }], oracles: ["fixture.written"], sideEffectPolicy: "allow",
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export function createIntegration({ workspaceRoot, z }) {
          return { name: 'write-fixture', preflight: async () => ({ passed: true, message: 'isolated test scope' }),
            capabilities: [{ name: 'fixture.write', description: 'write test marker', sideEffect: 'write', environments: ['test'], timeoutMs: 1000,
              inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
              execute: async () => { await writeFile(join(workspaceRoot, 'executed.txt'), 'yes'); return { ok: true }; },
              evidence: (output) => ({ ok: output.ok }) }],
            oracles: [{ name: 'fixture.written', check: async ({ steps }) => ({ name: 'fixture.written',
              passed: steps.some((step) => step.capabilityOutput?.ok === true), message: 'marker written', evidence: [] }) }] };
        }
      `);

      server = await createProofkitMcp({ root, workspaceRoot, allowCapabilityWrites: false });
      client = await connect(server);
      const denied = payload(await client.callTool({ name: "run_test", arguments: { intent: "写入测试", level: "core" } }));
      const deniedStatus = await waitForMission(client, denied.missionId);
      expect(deniedStatus.mission.verdict).toBe("blocked");
      await expect(readFile(join(workspaceRoot, "executed.txt"), "utf8")).rejects.toThrow();
      await client.close();
      await server.close();

      server = await createProofkitMcp({ root, workspaceRoot, allowCapabilityWrites: true });
      client = await connect(server);
      const allowed = payload(await client.callTool({ name: "run_test", arguments: { intent: "写入测试", level: "core" } }));
      const allowedStatus = await waitForMission(client, allowed.missionId);
      expect(allowedStatus.mission.verdict).toBe("passed");
      expect(await readFile(join(workspaceRoot, "executed.txt"), "utf8")).toBe("yes");
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      vi.restoreAllMocks();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it("resolves a one-sentence core request to a curated workspace Charter", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-mcp-catalog-source-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-mcp-catalog-workspace-"));
    let client: Client | undefined;
    let server: McpServer | undefined;
    try {
      await writeFile(join(root, "package.json"), '{"name":"catalog-source"}');
      await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
      await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
        project: { root },
        charters: [{ id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["简历获取"], level: "core", surfaces: ["web", "electron"] }],
        oracles: [{ name: "resume-status", url: "http://127.0.0.1:8080/status", statusPointer: "/data/status", successValues: ["complete"] }],
      }));
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "resume.yml"), JSON.stringify({
        intent: "验证简历获取完成", level: "core", actions: [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "完成" }], oracles: ["resume-status"], sideEffectPolicy: "deny",
      }));
      server = await createProofkitMcp({ root, workspaceRoot });
      client = await connect(server);
      const catalog = payload(await client.callTool({ name: "list_test_charters", arguments: {} }));
      expect(catalog.charters).toEqual([expect.objectContaining({ id: "resume-core" })]);
      const started = payload(await client.callTool({ name: "run_test", arguments: { intent: "测试简历获取核心链路", surface: "electron", autoApprove: false } }));
      expect(started).toMatchObject({ status: "awaiting-approval", level: "core", catalogId: "resume-core", oracleRequirement: { required: true, declared: 1 } });
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await client?.close();
      await server?.close();
      await Promise.all([root, workspaceRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
  });

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

async function waitForMission(client: Client, missionId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = payload(await client.callTool({ name: "get_mission_status", arguments: { missionId } }));
    if (["completed", "failed", "blocked", "cancelled"].includes(status.mission.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Mission ${missionId} did not finish`);
}
