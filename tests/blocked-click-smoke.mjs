import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
const workspace = await mkdtemp(join(tmpdir(), "proofkit-blocked-click-")); let writes = 0;
const server = createServer((request, response) => {
  if (request.url === "/action") { writes++; response.writeHead(200); response.end("ok"); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end('<button id="save" onclick="fetch(\'/action\',{method:\'POST\'}).then(()=>document.querySelector(\'output\').textContent=\'Saved once\')">Save reviewed note</button><output>Not saved</output><div style="position:fixed;inset:0;background:#bbb;z-index:999">Obstructing overlay</div>');
});
let runner, sessionId;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done)); const url = "http://127.0.0.1:" + server.address().port;
  runner = new LocalRunnerService({ root: workspace, workspaceRoot: workspace, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: url, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } }, policies: { sideEffects: "allow" } }) });
  const opened = await runner.interactSurface({ adapter: "web", keepSession: true, action: { kind: "goto", url } }); sessionId = opened.sessionId; assert.ok(sessionId);
  const inspected = await runner.inspectSurface({ adapter: "web", sessionId }); assert.equal(inspected.status, "observed");
  const pin = { runId: inspected.inspectionId, manifestSha256: inspected.manifest.sha256 };
  const start = Date.now(); const blocked = await runner.interactSurface({ adapter: "web", sessionId, inspection: pin, action: { kind: "click", selector: "#save" } });
  const elapsedMs = Date.now() - start; assert.equal(blocked.status, "failed"); assert.ok(elapsedMs < 25000); assert.equal(writes, 0);
  assert.equal(runner.listSurfaceSessions().sessions.length, 1);
  const saved = JSON.parse(await readFile(join(workspace, ".proofkit/runs", blocked.interactionId, "run.json"), "utf8"));
  assert.ok(saved.steps[0].artifacts.some((path) => path.endsWith("failure.png")));
  const keyboard = await runner.interactSurface({ adapter: "web", sessionId, inspection: pin, action: { kind: "press", selector: "#save", key: "Enter" } });
  assert.equal(keyboard.status, "observed"); assert.equal(writes, 1);
  const manifest = await runner.evidenceManifest(blocked.interactionId); assert.equal((await runner.verifyEvidenceManifest(blocked.interactionId, manifest.sha256)).status, "intact");
  const result = { checkedAt: new Date().toISOString(), workspace, blockedStatus: blocked.status, elapsedMs, writesBeforeRecovery: 0, failureScreenshotRetained: true,
    sameSessionReusable: true, keyboardStatus: keyboard.status, writes, report: join(workspace, ".proofkit/runs", blocked.interactionId, "report.html"), manifestSha256: manifest.sha256,
    note: "Keyboard activation is separately explicit; a blocked click remains failed and is never forced or marked successful" };
  await writeFile(new URL("../outputs/blocked-click-validation.json", import.meta.url), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally { if (sessionId) await runner.closeSurfaceSession(sessionId); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
