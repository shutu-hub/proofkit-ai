import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { httpOracle } from "./index.js";

describe("httpOracle", () => {
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
    expect(result.evidence[0]).not.toContain("must-not-leak");
  });
});
