import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { configuredHttpOracle, jsonPointer, pollHttpOracle } from "./index.js";

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
  it("reads a configured JSON Pointer from the business response", async () => {
    const oracle = configuredHttpOracle({ name: "resume", url: await endpoint(["pending", "failed"]), query: {}, statusPointer: "/state", successValues: ["complete"], failureValues: ["failed"], expectedStatus: 200, intervalMs: 10, deadlineMs: 500 });
    const result = await oracle.check({ runId: "test", charter: { intent: "test", mode: "guided", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, steps: [], assertions: [] });
    expect(result.passed).toBe(false);
    expect(result.evidence[0]).toContain('"state":"failed"');
    expect(jsonPointer({ data: { "a/b": "complete" } }, "/data/a~1b")).toBe("complete");
  });

  it("binds a sanitized capability ID into an encoded query parameter", async () => {
    let received = "";
    const server = createServer((request, response) => {
      received = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("fileId") ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { status: "complete" } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server port");
    const oracle = configuredHttpOracle({ name: "resume", url: `http://127.0.0.1:${address.port}/status`, query: { fileId: { source: "step", stepId: "step-001", field: "fileId" } }, statusPointer: "/data/status", successValues: ["complete"], failureValues: ["failed"], expectedStatus: 200, intervalMs: 10, deadlineMs: 500 });
    const result = await oracle.check({ runId: "test", charter: { intent: "test", mode: "guided", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} }, steps: [{ stepId: "step-001", action: { kind: "observe" }, status: "passed", artifacts: [], capabilityOutput: { fileId: "file&42" } }], assertions: [] });
    expect(result.passed).toBe(true);
    expect(received).toBe("file&42");
  });

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
