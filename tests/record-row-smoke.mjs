import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-record-row-")); await mkdir(join(root, "source")); await mkdir(join(root, "workspace"));
let writes = 0;
const server = createServer((request, response) => {
  if (request.method === "POST") { writes++; response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html" });
  const page = ('<!doctype html><html><head><title>Row fixture</title></head><body><table><tbody><tr tabindex="0"><td>row-001</td><td id="label">Private draft</td></tr><tr tabindex="-1"><td>Ignored static</td></tr><tr><td>Noninteractive static</td></tr></tbody></table><button id="change">Change row</button><button id="duplicate">Duplicate row</button><output id="status">Ready</output><script>const row=document.querySelector("tbody tr");row.onclick=async()=>{await fetch("/save",{method:"POST"});document.querySelector("#status").textContent="Opened record";};document.querySelector("#change").onclick=()=>document.querySelector("#label").textContent="Different record";document.querySelector("#duplicate").onclick=()=>{const duplicate=row.cloneNode(true);duplicate.removeAttribute("id");row.after(duplicate);};</script></body></html>');
  let content = page;
  if (request.url.includes("misaligned-id")) content = content.replace('<td>row-001</td><td id="label">Private draft</td>', '<td id="label">Private draft</td><td id="record-id">row-001</td>')
    .replace("<table><tbody>", '<table><thead><tr><th hidden>Title</th><th>ID</th></tr></thead><tbody>');
  else if (request.url.includes("ambiguous-id")) content = content.replace("<table><tbody>", "<table><thead><tr><th>ID</th><th>Identifier</th></tr></thead><tbody>");
  else if (request.url.includes("spanning-id")) content = content.replace("<table><tbody>", '<table><thead><tr><th colspan="2">ID</th></tr></thead><tbody>');
  else if (request.url.includes("stable-id")) content = content.replace("<table><tbody>", "<table><thead><tr><th>ID</th><th>Title</th></tr></thead><tbody>");
  if (request.url.includes("replaced")) content = content.replace('document.querySelector("#label").textContent="Different record"', '(document.querySelector("#record-id")??document.querySelector("tbody tr td")).textContent="row-002"');
  response.end(content.replace('<tr tabindex="0">', request.url !== "/" ? '<tr tabindex="0" id="stable-target">' : '<tr tabindex="0">'));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const runner = await LocalRunnerService.create({ root: join(root, "source"), workspaceRoot: join(root, "workspace"),
  config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } }, policies: { sideEffects: "allow" } }) });
const receipts = [];
const pin = (inspection) => ({ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 });
try {
  for (const kind of ["valid", "changed", "stable-changed", "stable-id", "stable-id-replaced", "misaligned-id-replaced", "misaligned-id-title", "ambiguous-id", "spanning-id", "duplicate"]) {
    const first = await runner.inspectSurface({ keepSession: true, headful: true, url: origin + (["valid", "changed", "duplicate"].includes(kind) ? "/" : "/" + kind) });
    assert.equal(first.status, "observed"); const sessionId = first.sessionId;
    const rows = first.snapshot.controls.filter((control) => control.tag === "tr"); assert.equal(rows.length, 1); assert.equal(rows[0].role, "row");
    if (kind === "stable-id") assert.equal(rows[0].name, "row-001");
    if (kind !== "valid") {
      const mutation = await runner.interactSurface({ sessionId, inspection: pin(first), action: { kind: "click", selector: kind === "duplicate" ? "#duplicate" : "#change" } });
      assert.equal(mutation.status, "observed");
    }
    const observed = rows[0]; const before = writes;
    const result = await runner.interactSurface({ sessionId, inspection: pin(first), action: { kind: "click", selector: observed.selector } });
    if (["valid", "stable-id", "misaligned-id-title"].includes(kind)) { assert.equal(result.status, "observed"); assert.equal(writes, before + 1); }
    else { assert.equal(result.status, "failed"); assert.equal(writes, before); assert.equal(result.action.failureCode, kind === "changed" ? "surface-selector-drift" : kind === "duplicate" ? "surface-target-ambiguous" : "surface-target-changed"); }
    const manifest = await runner.evidenceManifest(result.interactionId); assert.equal((await runner.verifyEvidenceManifest(result.interactionId, manifest.sha256)).status, "intact");
    receipts.push({ kind, runId: result.interactionId, status: result.status, failureCode: result.action.failureCode, writes: writes - before });
    await runner.closeSurfaceSession(sessionId);
  }
  await writeFile(join(repo, "outputs/record-row-browser-validation.json"), JSON.stringify({ checkedAt: new Date().toISOString(), root, receipts, totalWrites: writes, limitation: "Controlled focusable native-table rows; not arbitrary custom widgets or independent business acceptance" }, null, 2));
  console.log(JSON.stringify({ root, receipts, writes }, null, 2));
} finally { await runner.closeAllSurfaceSessions(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
