import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureResponseActionSchema, ProofkitConfigSchema, StepResultSchema, type StepResult } from "@proofkit/contracts";
import { InconclusiveError } from "@proofkit/runner";
import { configuredHttpOracle } from "./index.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const action = CaptureResponseActionSchema.parse({ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } });
function step(id = "9007199254740993"): StepResult {
  return StepResultSchema.parse({ stepId: "step-003", action, status: "passed", capabilityOutput: { fileId: "1" },
    response: { name: "intake", association: "action-window", url: action.response.url, method: "POST", status: 201, requestCount: 1,
      windowStartedAt: "start", windowEndedAt: "end", capturedAt: "now", bodyBytes: 32, bodySha256: "a".repeat(64), fields: { fileId: id } } });
}
const context = (steps: StepResult[]) => ({ runId: "run", charter: {} as never, steps, assertions: [] });

async function fixture(body: (calls: number, id: string | null) => unknown) {
  const reads: Array<string | null> = [];
  const server = createServer((request, response) => {
    const id = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("fileId"); reads.push(id);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body(reads.length, id)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  const config = ProofkitConfigSchema.parse({ oracles: [{ name: "terminal", url: `http://127.0.0.1:${address.port}/status`,
    query: { fileId: { source: "response", stepId: "step-003", field: "fileId", matchPointer: "/data/file_id" } },
    statusPointer: "/data/state", successValues: ["complete"], failureValues: ["failed"], intervalMs: 10, deadlineMs: 1_000 }] });
  return { oracle: configuredHttpOracle(config.oracles[0]!), reads };
}

describe("configured response-bound business observation", () => {
  it.each(["request-1", "550e8400-e29b-41d4-a716-446655440000", "CaseSensitive_ID:42"])("binds a declared string identifier %s without changing it", async (id) => {
    const f = await fixture((_calls, supplied) => ({ data: { file_id: supplied, state: "complete" } }));
    const saved = step(id);
    if (saved.action.kind !== "captureResponse") throw new Error("Expected capture fixture");
    saved.action.response.fields.fileId!.type = "identifier";
    const result = await f.oracle.check(context([saved]));
    expect(result.passed).toBe(true); expect(f.reads).toEqual([id]);
    expect(result.evidence[0]).toContain('"scopeMatches":true');
  });

  it("does not coerce a number into a declared string identity", async () => {
    const f = await fixture(() => ({ data: { file_id: "1", state: "complete" } }));
    const saved = step();
    if (saved.action.kind !== "captureResponse") throw new Error("Expected capture fixture");
    saved.action.response.fields.fileId!.type = "identifier"; saved.response!.fields.fileId = 42;
    await expect(Promise.resolve().then(() => f.oracle.check(context([saved])))).rejects.toBeInstanceOf(InconclusiveError);
    expect(f.reads).toEqual([]);
  });

  it.each(["9007199254740993", "42"])("queries only the captured ID %s and persists selected independent facts", async (id) => {
    const f = await fixture((_calls, requested) => ({ data: { file_id: id === "42" ? 42 : requested, state: "complete" }, private: "PRIVATE_RESPONSE_BODY" }));
    const result = await f.oracle.check(context([step(id)]));
    expect(result.passed).toBe(true); expect(f.reads).toEqual([id]);
    expect(result.evidence[0]).toContain(`"expected_fileId":"${id}"`);
    expect(result.evidence[0]).toContain(`"observed_fileId":"${id}"`);
    expect(result.evidence[0]).toContain('"scopeMatches":true');
    expect(result.evidence[0]).not.toContain("PRIVATE_RESPONSE_BODY");
  });
  it("rejects an independently observed historical ID despite a successful state", async () => {
    const f = await fixture(() => ({ data: { file_id: "1", state: "complete" } }));
    const result = await f.oracle.check(context([step()]));
    expect(result.passed).toBe(false); expect(result.evidence[0]).toContain('"scopeMatches":false');
    expect(result.evidence[0]).toContain('"observed_fileId":"1"');
  });
  it.each([undefined, null, 9007199254740992, "01", { id: "42" }])("keeps an unavailable identity %j inconclusive", async (id) => {
    const f = await fixture(() => ({ data: { file_id: id, state: "complete" } }));
    const result = await f.oracle.check(context([step()]));
    expect(result.passed).toBeNull(); expect(result.evidence[0]).toContain('"scopeMatches":null');
  });
  it("waits for the current object's terminal state", async () => {
    const f = await fixture((calls, id) => ({ data: { file_id: id, state: calls === 1 ? "pending" : "complete" } }));
    const result = await f.oracle.check(context([step()]));
    expect(result.passed).toBe(true); expect(f.reads).toEqual(["9007199254740993", "9007199254740993"]);
    expect(result.evidence[0]).toContain('"state":"pending"');
  });
  it.each(["missing-step", "failed-step", "wrong-kind", "missing-facts", "missing-field", "invalid-id"])("rejects %s before making a business request", async (kind) => {
    const f = await fixture(() => ({ data: { file_id: "1", state: "complete" } }));
    const saved = step();
    if (kind === "failed-step") saved.status = "failed";
    if (kind === "wrong-kind") saved.action = { kind: "observe" };
    if (kind === "missing-facts") delete saved.response;
    if (kind === "missing-field") saved.response!.fields = {};
    if (kind === "invalid-id") saved.response!.fields.fileId = "01";
    await expect(Promise.resolve().then(() => f.oracle.check(context(kind === "missing-step" ? [] : [saved])))).rejects.toBeInstanceOf(InconclusiveError);
    expect(f.reads).toEqual([]);
  });
});
