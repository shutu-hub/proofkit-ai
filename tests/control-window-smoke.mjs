import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema, SurfaceSnapshotSchema } from "../packages/contracts/dist/index.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-control-window-acceptance-"));
await mkdir(join(root, "source")); await mkdir(join(root, "workspace"));
let writes = 0;
const page = '<!doctype html><html><head><title>Dense control fixture</title></head><body><h1>Dense control fixture</h1>'
  + Array.from({ length: 65 }, (_, index) => '<button id="noise-' + index + '">Noise ' + index + '</button>').join("")
  + '<header><button>Create</button></header><footer><button>Create</button></footer><output id="status">Not saved</output>'
  + '<script>document.querySelector("footer button").onclick=async()=>{await fetch("/save",{method:"POST"});document.querySelector("#status").textContent="Saved";}</script></body></html>';
const server = createServer((request, response) => {
  if (request.method === "POST") { writes++; response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html" }); response.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const config = ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } },
  sessions: { recordNetwork: true, recordVideo: true }, policies: { sideEffects: "allow" } });
const runner = await LocalRunnerService.create({ root: join(root, "source"), workspaceRoot: join(root, "workspace"), config });
let closed;
try {
  const first = await runner.inspectSurface({ keepSession: true, headful: true });
  assert.equal(first.status, "observed"); assert.equal(first.snapshot.controls.length, 60); assert.equal(first.snapshot.controlsTruncated, true);
  assert.ok(!first.snapshot.controls.some((control) => control.selector === 'footer >> role=button[name="Create"]')); assert.equal(writes, 0);
  const second = await runner.inspectSurface({ sessionId: first.sessionId, controlOffset: 60 });
  assert.equal(second.status, "observed"); SurfaceSnapshotSchema.parse(second.snapshot);
  assert.deepEqual(second.snapshot.controlWindow, { scope: "rendered-main-frame-controls", offset: 60, limit: 60, total: 67, returned: 7, nextOffset: null, allControlsObserved: false });
  const selectors = second.snapshot.controls.map((control) => control.selector).filter(Boolean);
  assert.equal(new Set(selectors).size, selectors.length);
  assert.ok(second.snapshot.controls.some((control) => control.selector === 'footer >> role=button[name="Create"]'));
  const originalPin = { runId: second.inspectionId, manifestSha256: second.manifest.sha256 };
  assert.equal((await runner.verifyEvidenceManifest(originalPin.runId, originalPin.manifestSha256)).status, "intact");
  const result = await runner.interactSurface({ sessionId: first.sessionId, inspection: originalPin, action: { kind: "click", selector: 'footer >> role=button[name="Create"]' } });
  assert.equal(result.status, "observed"); assert.equal(writes, 1);
  const done = await runner.inspectSurface({ sessionId: first.sessionId, readyWhen: { text: "Saved", timeoutMs: 5000 } });
  assert.equal(done.status, "observed");
  const invalid = await runner.inspectSurface({ sessionId: first.sessionId, controlOffset: 120 });
  assert.equal(invalid.status, "failed"); assert.ok(invalid.findings.some((finding) => finding.includes("outside"))); assert.equal(writes, 1);
  closed = await runner.closeSurfaceSession(first.sessionId);
  assert.equal(closed.networkCapture.recording.status, "recorded");
  assert.equal((await runner.verifyEvidenceManifest(closed.networkCapture.runId, closed.networkCapture.manifest.sha256)).status, "intact");
  const receipt = { checkedAt: new Date().toISOString(), root, initialControls: first.snapshot.controls.length, laterWindow: second.snapshot.controlWindow,
    targetedAction: result.interactionId, writes, manifests: "intact", rejectedOutOfRange: invalid.inspectionId, recording: closed.networkCapture.recording,
    limitation: "Controlled dense page regression, not whole-page coverage or external application acceptance" };
  await writeFile(join(repository, "outputs/control-window-browser-validation.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt, null, 2));
} finally { await runner.closeAllSurfaceSessions(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
