import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeHttpEndpoint } from "./http-probe.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("header-only HTTP observations", () => {
  it("finishes at headers despite an unfinished body, retaining no body, headers or query", async () => {
    const base = await serve((_req, res) => { res.writeHead(200, { "Set-Cookie": "session=private" }); res.write("secret body"); });
    const observation = await probeHttpEndpoint(`${base}/health?access_token=private#secret`, 200, 1000);
    expect(observation).toMatchObject({ endpoint: `${base}/health`, status: "reachable", observedStatus: 200 });
    expect(JSON.stringify(observation)).not.toMatch(/private|secret|Cookie|token/);
  });
  it("records an unexpected status without following a redirect", async () => {
    const paths: string[] = [];
    const base = await serve((req, res) => { paths.push(req.url!); res.writeHead(302, { Location: "/private" }); res.end(); });
    expect(await probeHttpEndpoint(base)).toMatchObject({ status: "unexpected-status", observedStatus: 302 });
    expect(paths).toEqual(["/"]);
  });
  it("rejects cancellation with its original reason and destroys the request", async () => {
    let seen!: () => void;
    let closed!: () => void;
    const requested = new Promise<void>((resolve) => { seen = resolve; });
    const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
    const base = await serve((req) => { req.on("close", closed); seen(); });
    const controller = new AbortController();
    const reason = new Error("cancel inspection");
    const request = probeHttpEndpoint(base, 200, 2000, controller.signal);
    const rejected = expect(request).rejects.toBe(reason);
    await requested;
    controller.abort(reason);
    await rejected;
    await connectionClosed;
  });
  it("bounds an endpoint that never sends headers", async () => {
    const base = await serve(() => {});
    expect(await probeHttpEndpoint(base, 200, 60)).toMatchObject({ status: "unreachable", reason: "timeout" });
  });
  it("rejects unsupported or credential-bearing URLs without echoing them", async () => {
    for (const url of ["file:///private", "http://user:secret@localhost/health", "not-a-url-secret"]) {
      const result = await probeHttpEndpoint(url);
      expect(result).toMatchObject({ status: "invalid", endpoint: "[invalid endpoint]" });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
});
