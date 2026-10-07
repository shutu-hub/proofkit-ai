import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { ProjectRuntime } from "./index.js";

describe("ProjectRuntime", () => {
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
      config: { project: { root: ".", health: [`http://127.0.0.1:${address.port}`], startupTimeoutMs: 1_000 }, surfaces: {}, planning: { provider: "deterministic", timeoutMs: 30_000 }, oracles: [], policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false } },
      onEvent: (event) => events.push(event.type),
    });
    await runtime.start();
    await runtime.stop();
    server.close();
    expect(events).toContain("health.ready");
  });
});
