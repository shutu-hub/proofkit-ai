import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { pollHttpOracle } from "./index.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function endpoint(states: string[]): Promise<string> {
  let calls = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: states[Math.min(calls++, states.length - 1)] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return `http://127.0.0.1:${address.port}/status`;
}

describe("pollHttpOracle", () => {
  it("waits for a terminal success and records scoped facts", async () => {
    const oracle = pollHttpOracle({ name: "resume", url: await endpoint(["pending", "complete"]), deadlineMs: 500, intervalMs: 10, evaluate: (body) => (body as { state: string }).state === "complete" ? "passed" : "pending", facts: (body) => ({ state: (body as { state: string }).state }) });
    const result = await oracle.check({ runId: "test", charter: { intent: "test", mode: "guided", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, steps: [], assertions: [] });
    expect(result.passed).toBe(true);
    expect(result.evidence[0]).toContain('"state":"complete"');
    expect(result.evidence[0]).toContain('"state":"pending"');
  });

  it("marks a pending workflow inconclusive at the deadline", async () => {
    const oracle = pollHttpOracle({ name: "resume", url: await endpoint(["pending"]), deadlineMs: 40, intervalMs: 10, evaluate: () => "pending" });
    const result = await oracle.check({ runId: "test", charter: { intent: "test", mode: "guided", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, steps: [], assertions: [] });
    expect(result.passed).toBeNull();
    expect(result.message).toContain("terminal state not observed");
  });
});
