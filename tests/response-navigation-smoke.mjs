import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebAdapter } from "../packages/adapters/dist/index.js";

let writes = 0;
const server = createServer((request, response) => {
  if (request.url === "/login" && request.method === "POST") {
    writes++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "login-" + writes, access_token: "DO_NOT_CAPTURE" })); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url === "/account" ? "<h1>Account loaded</h1>" : '<h1>Sign in</h1><button id="login">Login</button><script>document.querySelector("#login").onclick = async () => { await (await fetch("/login", {method:"POST"})).json(); location.href = "/account"; };</script>');
});
let adapter;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  adapter = new WebAdapter({ baseUrl, headless: true, executablePath: process.env.PROOFKIT_BROWSER_PATH
    ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) });
  await adapter.connect();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await adapter.act({ kind: "goto", url: baseUrl });
    const result = await adapter.act({ kind: "captureResponse", name: "login", trigger: { kind: "click", selector: "#login" },
      response: { url: baseUrl + "/login", method: "POST", statuses: [200], fields: { id: { pointer: "/id", type: "identifier" } } },
      requestStartTimeoutMs: 2000, requestWindowMs: 500, timeoutMs: 5000 });
    assert.equal(result.metadata.response.fields.id, "login-" + attempt);
    assert.ok(!JSON.stringify(result).includes("DO_NOT_CAPTURE"));
    await adapter.act({ kind: "waitForText", text: "Account loaded" });
  }
  assert.equal(writes, 3);
  console.log(JSON.stringify({ status: "passed", fullDocumentNavigations: 3, selectedResponsePreserved: true, unselectedTokenExcluded: true }));
} finally {
  await adapter?.close();
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
