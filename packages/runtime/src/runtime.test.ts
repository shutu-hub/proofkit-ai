import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { ProjectRuntime } from "./index.js";
import { ProofkitConfigSchema } from "@proofkit/contracts";

describe("ProjectRuntime", () => {
  it("accepts the declared HTTP status without waiting for a streaming body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(202);
      response.write("still streaming");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const events: string[] = [];
    const runtime = new ProjectRuntime({
      root: process.cwd(),
      config: ProofkitConfigSchema.parse({ project: { health: [{ url: `http://127.0.0.1:${address.port}`, expectedStatus: 202 }], startupTimeoutMs: 1_000 } }),
      onEvent: (event) => events.push(event.type),
    });
    try {
      await runtime.start();
      expect(events).toEqual(["health.ready"]);
      expect(runtime.running).toBe(false);
    } finally {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds stalled health headers by the remaining startup deadline", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const events: string[] = [];
    const runtime = new ProjectRuntime({
      root: process.cwd(),
      config: ProofkitConfigSchema.parse({ project: { health: [`http://127.0.0.1:${address.port}`], startupTimeoutMs: 100 } }),
      onEvent: (event) => events.push(event.type),
    });
    const started = performance.now();
    try {
      await expect(runtime.start()).rejects.toThrow("within 100ms");
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(events).toEqual(["health.timeout"]);
    } finally {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts an in-flight health request and stops polling", async () => {
    let requested!: () => void;
    const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
    let requests = 0;
    const server = createServer(() => { requests++; requested(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const events: string[] = [];
    const runtime = new ProjectRuntime({
      root: process.cwd(),
      config: ProofkitConfigSchema.parse({ project: { root: ".", health: [`http://127.0.0.1:${address.port}`], startupTimeoutMs: 30_000 } }),
      onEvent: (event) => events.push(event.type),
    });
    const controller = new AbortController();
    const reason = new Error("Mission cancelled during startup");
    const start = runtime.start(controller.signal);
    const rejected = expect(start).rejects.toBe(reason);
    try {
      await firstRequest;
      controller.abort(reason);
      await rejected;
      expect(requests).toBe(1);
      expect(events).not.toContain("health.ready");
      expect(events).not.toContain("health.timeout");
    } finally {
      controller.abort(reason);
      await runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not spawn a configured process for a pre-aborted start", async () => {
    const events: string[] = [];
    const runtime = new ProjectRuntime({ root: process.cwd(), config: ProofkitConfigSchema.parse({ project: { start: "must-not-execute" } }), onEvent: (event) => events.push(event.type) });
    const controller = new AbortController();
    const reason = new Error("Cancelled before startup");
    controller.abort(reason);
    await expect(runtime.start(controller.signal)).rejects.toBe(reason);
    expect(runtime.running).toBe(false);
    expect(events).toEqual([]);
  });

  it("waits for a configured health endpoint", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const events: string[] = [];
    const runtime = new ProjectRuntime({
      root: process.cwd(),
      config: {
        project: { root: ".", health: [`http://127.0.0.1:${address.port}`], startupTimeoutMs: 1_000 },
        surfaces: {},
        planning: { provider: "deterministic", timeoutMs: 30_000 },
        integration: {},
        charters: [],
        suites: [],
        run: { timeoutMs: 300_000 },
        oracles: [],
        policies: {
          environment: "test",
          sideEffects: "confirm",
          saveSensitivePayloads: false,
          targetBinding: "block-different",
          runtime: {
            mode: "record",
            pageErrors: true,
            requestFailures: false,
            consoleLevels: ["error"],
            failedResponses: { enabled: true, include4xx: false },
            allowUrlPatterns: [],
            ignoreUrlPatterns: [],
            blockConsolePatterns: [],
          },
        },
      },
      onEvent: (event) => events.push(event.type),
    });
    await runtime.start();
    await runtime.stop();
    server.close();
    expect(events).toContain("health.ready");
  });
});
