import { createServer } from "node:http";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureResponseActionSchema, HttpFieldExpectationSchema, ProofkitConfigSchema, StepResultSchema, type HttpFieldExpectation } from "@proofkit/contracts";
import { checkHttpFields, configuredHttpOracle, pollHttpOracle } from "./index.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
const action = CaptureResponseActionSchema.parse({ kind: "captureResponse", name: "created", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1/create", method: "POST", fields: { id: { pointer: "/id", type: "identifier" } } } });
const step = StepResultSchema.parse({ stepId: "step-001", action, status: "passed", artifacts: [], response: {
  name: "created", association: "action-window", url: action.response.url, method: "POST", status: 201, requestCount: 1,
  windowStartedAt: "start", windowEndedAt: "end", capturedAt: "now", bodyBytes: 32, bodySha256: "a".repeat(64), fields: { id: "record-42" } } });
const context = { runId: "field-check-run", charter: {} as never, steps: [step], assertions: [] };
const fields = HttpFieldExpectationSchema.array().parse([{ name: "total", pointer: "/total", expected: 55.03 },
  { name: "city", pointer: "/billing/city", expected: "PRIVATE_EXPECTED_CITY" },
  { name: "deposit", pointer: "/deposit", expected: false }, { name: "optionalValue", pointer: "/nullable", expected: null }]);
const valid = () => ({ id: "record-42", state: "complete", total: 55.03, billing: { city: "PRIVATE_EXPECTED_CITY" }, deposit: false, nullable: null });
async function fixture(body: (attempt: number) => unknown, expectations = fields, status = 200, deadlineMs = 200) {
  let calls = 0;
  const server = createServer((request, response) => {
    expect(new URL(request.url!, "http://localhost").searchParams.get("id")).toBe("record-42");
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body(++calls)));
  });
  servers.push(server); await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing endpoint");
  const config = ProofkitConfigSchema.parse({ oracles: [{ name: "fields", url: "http://127.0.0.1:" + address.port + "/status",
    query: { id: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" } }, statusPointer: "/state",
    successValues: ["complete"], failureValues: ["failed"], expectFields: expectations, intervalMs: 10, deadlineMs }] }).oracles[0]!;
  return { oracle: configuredHttpOracle(config), calls: () => calls, config };
}
const trace = (result: { evidence: string[] }) => JSON.parse(result.evidence[0]!) as { observations: Array<{ state?: string; status?: number; facts?: { fieldChecks: Array<{ name: string; result: string }> } }>; omittedObservations: number };
function lastFieldChecks(result: { evidence: string[] }) {
  const observed = trace(result).observations.filter((observation) => observation.status !== undefined).at(-1);
  expect(observed).toBeDefined(); expect(observed?.facts?.fieldChecks.length).toBeGreaterThan(0);
  return observed!.facts!.fieldChecks;
}

describe("independent field-aware HTTP acceptance", () => {
  it("releases cancellation listeners after repeated pending field observations", async () => {
    const controller = new AbortController(); const baseline = getEventListeners(controller.signal, "abort").length;
    try {
      const fixtureState = await fixture((attempt) => ({ ...valid(), state: attempt < 20 ? "pending" : "complete" }), fields, 200, 2000);
      const result = await fixtureState.oracle.check({ ...context, signal: controller.signal }); expect(result.passed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
    } finally { controller.abort(); }
  });
  it("requires current identity, terminal success and all declared typed values, saving only match outcomes", async () => {
    const fixtureState = await fixture(valid); const result = await fixtureState.oracle.check(context);
    expect(result.passed).toBe(true); expect(fixtureState.calls()).toBe(1);
    expect(lastFieldChecks(result).every((field) => field.result === "matched")).toBe(true);
    expect(result.evidence[0]).not.toContain("PRIVATE_EXPECTED_CITY");
  });
  it("rejects a wrong persisted value even when identity and completion are correct", async () => {
    const fixtureState = await fixture(() => ({ ...valid(), billing: { city: "PRIVATE_RETURNED_CITY" } }));
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBe(false);
    expect(lastFieldChecks(result)).toContainEqual({ name: "city", pointer: "/billing/city", result: "mismatch" });
    expect(result.evidence[0]).not.toMatch(/PRIVATE_RETURNED_CITY|PRIVATE_EXPECTED_CITY/);
  });
  it.each(["missing", "type-mismatch"])("keeps %s independent fields inconclusive instead of inventing a business failure", async (kind) => {
    const fixtureState = await fixture(() => ({ ...valid(), total: kind === "missing" ? undefined : "55.03" }));
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBeNull();
    expect(lastFieldChecks(result)).toContainEqual({ name: "total", pointer: "/total", result: kind });
    expect(result.message).toContain("required field observations");
  });
  it("does not hide a definite terminal mismatch behind another missing field", async () => {
    const fixtureState = await fixture(() => ({ ...valid(), total: 99, deposit: undefined }));
    expect((await fixtureState.oracle.check(context)).passed).toBe(false);
  });
  it("waits for terminal state before interpreting temporary value differences as a failure", async () => {
    const fixtureState = await fixture((attempt) => attempt === 1 ? { ...valid(), state: "pending", total: 99 } : valid());
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBe(true); expect(fixtureState.calls()).toBe(2);
    expect(trace(result).observations[0]!.state).toBe("pending");
  });
  it("allows missing projections to arrive before the observation deadline", async () => {
    const fixtureState = await fixture((attempt) => attempt === 1 ? { ...valid(), deposit: undefined } : valid());
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBe(true); expect(fixtureState.calls()).toBe(2);
  });
  it.each(["identity", "access"])("does not evaluate business fields from an unavailable %s", async (kind) => {
    const fixtureState = await fixture(() => ({ ...valid(), ...(kind === "identity" ? { id: "historical" } : {}) }), fields, kind === "access" ? 403 : 200);
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBe(kind === "identity" ? false : null);
    const received = trace(result).observations.filter((observation) => observation.status !== undefined);
    expect(received.length).toBeGreaterThan(0);
    for (const observed of received) {
      expect(observed.facts?.fieldChecks).toHaveLength(fields.length);
      expect(observed.facts!.fieldChecks.every((field) => field.result === "not-evaluated")).toBe(true);
    }
  });
  it("uses strict types and distinguishes absent values from explicit null", () => {
    const expectations: HttpFieldExpectation[] = [{ name: "field", pointer: "/field", expected: null }];
    expect(checkHttpFields({ field: null }, expectations)[0]!.result).toBe("matched");
    expect(checkHttpFields({}, expectations)[0]!.result).toBe("missing");
    expect(checkHttpFields({ field: false }, expectations)[0]!.result).toBe("type-mismatch");
    expect(checkHttpFields({ field: "false" }, [{ ...expectations[0]!, expected: false }])[0]!.result).toBe("type-mismatch");
  });
  it("retains only explicitly selected bounded values", () => {
    expect(checkHttpFields({ total: 56 }, [{ name: "total", pointer: "/total", expected: 55.03, retainValue: true }]))
      .toEqual([{ name: "total", pointer: "/total", result: "mismatch", observed: 56 }]);
    expect(checkHttpFields({ total: "x".repeat(257) }, [{ name: "total", pointer: "/total", expected: 55.03, retainValue: true }]))
      .toEqual([{ name: "total", pointer: "/total", result: "type-mismatch" }]);
    expect(checkHttpFields({ total: 56 }, [{ name: "total", pointer: "/total", expected: 55.03 }]))
      .toEqual([{ name: "total", pointer: "/total", result: "mismatch" }]);
  });
  it("retains the final complete field observation within the source-artifact byte budget and declares omitted history", async () => {
    const longFields = Array.from({ length: 16 }, (_, index) => ({ name: "field" + index, pointer: "/data/" + "x".repeat(200) + index, expected: true }));
    const data = Object.fromEntries(longFields.map((field, index) => ["x".repeat(200) + index, true]));
    const fixtureState = await fixture((attempt) => ({ ...valid(), state: attempt < 14 ? "pending" : "complete", data }), longFields, 200, 2000);
    const result = await fixtureState.oracle.check(context); expect(result.passed).toBe(true);
    expect(trace(result).omittedObservations).toBeGreaterThan(0);
    expect(lastFieldChecks(result)).toHaveLength(16);
    expect(Buffer.byteLength(JSON.stringify({ oracle: "fields", facts: [JSON.parse(result.evidence[0]!)] }, null, 2))).toBeLessThanOrEqual(60 * 1024);
  });
  it("does not pass when a single source observation cannot be retained", async () => {
    const fixtureState = await fixture(valid);
    const oracle = pollHttpOracle({ name: "oversized", url: fixtureState.config.url + "?id=record-42", deadlineMs: 100, intervalMs: 10,
      evaluate: () => "passed", facts: () => ({ oversized: "PRIVATE_SOURCE_VALUE".repeat(5000) }) });
    const result = await oracle.check(context); expect(result.passed).toBeNull(); expect(result.evidence[0]).not.toContain("PRIVATE_SOURCE_VALUE");
  });
});
