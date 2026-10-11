import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeWebDriverStatus } from "./webdriver-status.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  return `http://127.0.0.1:${address.port}`;
}

describe("WebDriver status probe", () => {
  it("reads only a bounded /status response beneath a server prefix and retains no private body or query", async () => {
    const requests: string[] = [];
    const base = await serve((req, res) => { requests.push(`${req.method} ${req.url}`); res.end(JSON.stringify({ value: { ready: true, message: "private token" } })); });
    const result = await probeWebDriverStatus(`${base}/wd/hub?token=private#fragment`, 1000);
    expect(requests).toEqual(["GET /wd/hub/status"]);
    expect(result).toMatchObject({ ready: true, http: { endpoint: `${base}/wd/hub/status`, status: "reachable", observedStatus: 200 } });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("distinguishes not-ready, malformed and oversized responses without accepting a header-only success", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/not-ready/status") res.end(JSON.stringify({ value: { ready: false } }));
      else if (req.url === "/large/status") res.end(JSON.stringify({ value: { ready: true, message: "x".repeat(9_000) } }));
      else res.end("not JSON");
    });
    expect((await probeWebDriverStatus(`${base}/not-ready`, 1000)).ready).toBe(false);
    expect((await probeWebDriverStatus(`${base}/malformed`, 1000)).ready).toBe("unverified");
    expect((await probeWebDriverStatus(`${base}/large`, 1000)).ready).toBe("unverified");
  });

  it("does not follow redirects and bounds a stalled body", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/redirect/status") { res.writeHead(302, { Location: "/secret" }); res.end(); }
      else { res.writeHead(200); res.write('{"value":'); }
    });
    expect(await probeWebDriverStatus(`${base}/redirect`, 1000)).toMatchObject({ ready: "unverified", http: { status: "unexpected-status", observedStatus: 302 } });
    expect(await probeWebDriverStatus(`${base}/stall`, 50)).toMatchObject({ ready: "unverified", http: { status: "unreachable", reason: "timeout" } });
  });

  it("propagates caller cancellation while a driver body is stalled", async () => {
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    const base = await serve((_req, res) => { res.writeHead(200); res.write('{"value":'); requested(); });
    const controller = new AbortController();
    const reason = new Error("cancel mobile inspection");
    const pending = probeWebDriverStatus(base, 1000, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await requestSeen;
    controller.abort(reason);
    await rejected;
  });

  it("rejects credential URLs without sending a request", async () => {
    const result = await probeWebDriverStatus("http://user:secret@127.0.0.1:4723", 1000);
    expect(result).toMatchObject({ ready: "unverified", http: { endpoint: "[invalid endpoint]", status: "invalid" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
