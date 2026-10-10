import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { TestScopeSchema } from "@proofkit/contracts";
import type { setupAgent } from "./agent-setup.js";

type Setup = Awaited<ReturnType<typeof setupAgent>>;
type Phase = "connect" | "list-tools" | "inspect-scope" | "verify-binding";

/** Check the emitted local launcher, not host registration or product behavior. */
export async function checkAgentConnection(setup: Setup, timeoutMs = 30_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("Agent connection timeout must be 1000–60000 milliseconds");
  }
  const deadline = Date.now() + timeoutMs;
  const { command, args, env, serverName } = setup.connection;
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command, args, env: {
    ...inherited, ...env, PROOFKIT_ALLOW_CAPABILITY_WRITES: env.PROOFKIT_ALLOW_CAPABILITY_WRITES ?? "0",
  } });
  const client = new Client({ name: "proofkit-agent-connection-check", version: "1" });
  let phase: Phase = "connect";
  try {
    await within(client.connect(transport), deadline);
    phase = "list-tools";
    const listed = await within(client.listTools(), deadline);
    const required = ["inspect_test_scope", "run_test", "await_test_result", "get_mission_status", "get_mission_evidence"];
    if (!required.every((name) => listed.tools.some((tool) => tool.name === name))) {
      return blocked(phase, serverName, "required-high-level-tools-missing");
    }
    phase = "inspect-scope";
    const response = CallToolResultSchema.parse(await within(client.callTool({ name: "inspect_test_scope", arguments: { level: "core", surface: "web", limit: 1 } }), deadline));
    if (response.isError) return blocked(phase, serverName, "scope-inspection-rejected");
    const content = response.content?.find((item) => item.type === "text")?.text;
    if (!content) return blocked(phase, serverName, "scope-response-missing");
    const scope = TestScopeSchema.parse(JSON.parse(content));
    phase = "verify-binding";
    if (scope.projectRoot !== setup.projectRoot) return blocked(phase, serverName, "project-binding-mismatch");
    if (scope.workspaceRoot !== setup.workspaceRoot) return blocked(phase, serverName, "workspace-binding-mismatch");
    return {
      status: "connected" as const, serverName, projectRoot: scope.projectRoot, workspaceRoot: scope.workspaceRoot,
      testVerdict: "not-asserted" as const, hostRegistration: "not-checked" as const,
      modelBehavior: "not-checked" as const, executionChecks: "not-run" as const,
      scope: { level: scope.selection.level, inventoryTruncated: scope.inventory.truncated,
        catalogTotal: scope.catalog.total, catalogEligible: scope.catalog.eligible,
        routeCandidates: scope.routes.total },
    };
  } catch {
    // SDK/connector errors can contain local paths, credentials or response text.
    return blocked(phase, serverName, phase === "connect" ? "local-launcher-unavailable" : `${phase}-failed`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function blocked(phase: Phase, serverName: string, issue: string) {
  return { status: "blocked" as const, serverName, phase, issue,
    testVerdict: "not-asserted" as const, hostRegistration: "not-checked" as const,
    modelBehavior: "not-checked" as const, executionChecks: "not-run" as const };
}

async function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Agent connection deadline exceeded");
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Agent connection deadline exceeded")), remaining);
    })]);
  } finally { clearTimeout(timer!); }
}
