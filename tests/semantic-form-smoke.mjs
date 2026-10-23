import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "proofkit-semantic-form-")); await mkdir(join(root, "source")); await mkdir(join(root, "workspace"));
let saved = null, writes = 0; const expected = { title: "Reviewed record", status: "approved" };
const html = `<!doctype html><html><head><title>Changing form IDs</title></head><body><h1>Changing form IDs</h1><button id="open">Open form</button><dialog id="form"></dialog><output id="result">Not saved</output><script>const dialog=document.querySelector("#form");document.querySelector("#open").onclick=()=>{const id=crypto.randomUUID().slice(0,8);dialog.innerHTML='<label for="title-'+id+'">Title</label><textarea id="title-'+id+'"></textarea><label for="status-'+id+'">Status</label><input id="status-'+id+'"><button id="close">Close</button><button id="save">Save</button>';dialog.showModal();dialog.querySelector("#close").onclick=()=>dialog.close();dialog.querySelector("#save").onclick=async()=>{const response=await fetch("/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:dialog.querySelector("textarea").value,status:dialog.querySelector("input").value})});if(response.ok){dialog.close();document.querySelector("#result").textContent="Reviewed record saved";}};};</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/save") {
    let body = ""; for await (const part of request) body += part;
    saved = JSON.parse(body); writes++; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "record-one", ...saved })); return;
  }
  response.writeHead(200, { "content-type": "text/html" }); response.end(html);
}); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const oracle = { name: "current-form", async check() { return { name: "current-form", passed: saved?.title === expected.title && saved?.status === expected.status && writes === 1,
  verificationKind: "business", message: "Independent server memory with exact title and status", evidence: [JSON.stringify({ saved, writes })], observedAt: new Date().toISOString() }; } };
const runner = await LocalRunnerService.create({ root: join(root, "source"), workspaceRoot: join(root, "workspace"), integration: { name: "semantic-form", oracles: [oracle] },
  config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" } }, policies: { sideEffects: "allow" } }) });
try {
  const first = await runner.inspectSurface({ keepSession: true, headful: true }); assert.equal(first.status, "observed"); const sessionId = first.sessionId;
  const open = async (inspection) => { const selector = inspection.snapshot.controls.find((control) => control.name === "Open form")?.selector; assert.ok(selector); const result = await runner.interactSurface({ sessionId, inspection: { runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }, action: { kind: "click", selector } }); assert.equal(result.status, "observed"); return runner.inspectSurface({ sessionId }); };
  const one = await open(first); assert.equal(one.status, "observed");
  const title = one.snapshot.controls.find((control) => control.name === "Title" && control.tag === "textarea");
  const status = one.snapshot.controls.find((control) => control.name === "Status" && control.tag === "input");
  assert.ok(title.selector.startsWith("#title-")); assert.ok(status.selector.startsWith("#status-"));
  assert.ok(title.alternateSelectors.includes('role=textbox[name="Title"]')); assert.ok(status.alternateSelectors.includes('role=textbox[name="Status"]'));
  const closeSelector = one.snapshot.controls.find((control) => control.name === "Close")?.selector; assert.ok(closeSelector);
  const closed = await runner.interactSurface({ sessionId, inspection: { runId: one.inspectionId, manifestSha256: one.manifest.sha256 }, action: { kind: "click", selector: closeSelector } }); assert.equal(closed.status, "observed");
  const afterClose = await runner.inspectSurface({ sessionId }); const two = await open(afterClose); assert.equal(two.status, "observed");
  const nextTitle = two.snapshot.controls.find((control) => control.name === "Title" && control.tag === "textarea");
  assert.notEqual(nextTitle.selector, title.selector); assert.ok(nextTitle.alternateSelectors.includes('role=textbox[name="Title"]'));
  const titleRole = title.alternateSelectors.find((selector) => selector === 'role=textbox[name="Title"]');
  const statusRole = status.alternateSelectors.find((selector) => selector === 'role=textbox[name="Status"]');
  const trial = await runner.interactSurface({ sessionId, inspection: { runId: one.inspectionId, manifestSha256: one.manifest.sha256 }, action: { kind: "fill", selector: titleRole, value: "observed-only" } });
  assert.equal(trial.status, "observed"); assert.equal(writes, 0);
  const charter = TestCharterSchema.parse({ intent: "Open a regenerated form, save the exact reviewed record and check the independent state", level: "core", mode: "deterministic", sideEffectPolicy: "allow", surfaces: ["web"],
    actions: [{ kind: "goto", url: origin }, { kind: "click", selector: first.snapshot.controls.find((control) => control.name === "Open form")?.selector }, { kind: "fill", selector: titleRole, value: expected.title },
      { kind: "fill", selector: statusRole, value: expected.status }, { kind: "click", selector: one.snapshot.controls.find((control) => control.name === "Save")?.selector }, { kind: "waitForText", text: "Reviewed record saved", timeoutMs: 5000 }],
    assertions: [{ kind: "text-visible", text: "Reviewed record saved" }], oracles: [oracle.name] });
  const mission = await runner.createMission({ intent: charter.intent, charter, surface: "web", sessionId, headful: true });
  await runner.startMission(mission.missionId, { approve: true }); await runner.waitMission(mission.missionId);
  const evidence = await runner.missionEvidence(mission.missionId); assert.equal(evidence.testVerdict, "passed", JSON.stringify(evidence.findings));
  assert.deepEqual(saved, expected); assert.equal(writes, 1);
  const formal = await runner.wait(evidence.summary.runs[0].runId); assert.equal(formal.steps.length, 6); assert.equal(formal.verdict, "passed");
  const sealed = await runner.closeSurfaceSession(sessionId); assert.equal(sealed.status, "closed");
  assert.equal((await runner.verifyEvidenceManifest(sealed.networkCapture.runId, sealed.networkCapture.manifest.sha256)).status, "intact");
  await writeFile(join(repository, "outputs/semantic-form-validation.json"), JSON.stringify({ checkedAt: new Date().toISOString(), root, missionId: mission.missionId, verdict: evidence.testVerdict,
    observed: { titleSelector: titleRole, statusSelector: statusRole, originalIdSelectors: [title.selector, status.selector], sourcePin: one.manifest.sha256 }, saved, writes, steps: formal.steps.length,
    sessionCapture: sealed.networkCapture.status, limitation: "Controlled fixture with host-authored plan; not model autonomous planning or a real external application" }, null, 2));
  console.log(JSON.stringify({ missionId: mission.missionId, verdict: evidence.testVerdict, saved, writes }, null, 2));
} finally { await runner.closeAllSurfaceSessions(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
