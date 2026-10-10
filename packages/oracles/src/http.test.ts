import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { httpOracle } from "./index.js";

describe("httpOracle", () => {
  it("treats a successful HTTP response without a business predicate as reachability only", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "pending", token: "must-not-leak" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const url = `http://127.0.0.1:${address.port}`;
      for (const expectedStatus of [undefined, 200]) {
        const result = await httpOracle({ name: "resume-workflow", url, expectedStatus }).check({
          runId: "test", charter: {} as never, steps: [], assertions: [],
        });
        expect(result.passed).toBeNull();
        expect(result.verificationKind).toBe("http-contract");
        expect(result.message).toContain("no business predicate");
        expect(result.evidence[0]).toContain('"status":200');
        expect(result.evidence[0]).not.toContain("must-not-leak");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("turns a read-only endpoint into evidence-backed business truth", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "completed", token: "must-not-leak" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const result = await httpOracle({
      name: "resume-workflow",
      url: `http://127.0.0.1:${address.port}`,
      check: (body) => (body as { status?: string }).status === "completed",
    }).check({ runId: "test", charter: {} as never, steps: [], assertions: [] });
    server.close();
    expect(result.passed).toBe(true);
    expect(result.verificationKind).toBe("business");
    expect(result.evidence[0]).not.toContain("must-not-leak");
  });

  it("keeps a transport failure inconclusive without treating it as a business defect", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const url = `http://127.0.0.1:${address.port}/private?token=must-not-leak`;
    const result = await httpOracle({ name: "resume-workflow", url }).check({
      runId: "test", charter: {} as never, steps: [], assertions: [],
    });
    expect(result.passed).toBeNull();
    expect(result.evidence).toEqual([]);
    expect(result.message).toContain("transport-error");
    expect(result.message).not.toContain("must-not-leak");
  });

  it("reports denied business-reader access as inconclusive without projecting its body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "PRIVATE_ACCESS_DETAIL" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    let factsCalled = false;
    try {
      const result = await httpOracle({ name: "resume-workflow", url: `http://127.0.0.1:${address.port}`,
        facts: () => { factsCalled = true; return { leaked: true }; } }).check({
        runId: "test", charter: {} as never, steps: [], assertions: [],
      });
      expect(result.passed).toBeNull();
      expect(result.message).toContain("status 403");
      expect(result.evidence[0]).toContain('"status":403');
      expect(result.evidence[0]).not.toContain("PRIVATE_ACCESS_DETAIL");
      expect(factsCalled).toBe(false);
      const negativeCase = await httpOracle({ name: "access-negative", url: `http://127.0.0.1:${address.port}`,
        expectedStatus: 403 }).check({ runId: "test", charter: {} as never, steps: [], assertions: [] });
      expect(negativeCase.passed).toBe(true);
      expect(negativeCase.verificationKind).toBe("http-contract");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("propagates cancellation while the reader is waiting for a response", async () => {
    const server = createServer(() => { /* Keep the response pending until cancellation. */ });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const controller = new AbortController();
    const cancelled = new Error("cancelled by the test run");
    try {
      const pending = httpOracle({ name: "resume-workflow", url: `http://127.0.0.1:${address.port}`, timeoutMs: 5_000 }).check({
        runId: "test", charter: {} as never, steps: [], assertions: [], signal: controller.signal,
      });
      setTimeout(() => controller.abort(cancelled), 20);
      await expect(pending).rejects.toBe(cancelled);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
