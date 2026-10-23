import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-scoped-controls-"));
let reversed = false;
const writes = [];
const server = createServer(async (request, response) => {
  if (request.url === "/book" && request.method === "POST") {
    let body = ""; for await (const chunk of request) body += chunk;
    writes.push(JSON.parse(body)); response.writeHead(201, { "content-type": "application/json" }); response.end('{"id":"selected-room"}'); return;
  }
  const dates = ["Check In", "Check Out"].map((label) => '<div><label>' + label + '</label><div><input type="text"></div></div>');
  const rooms = ["Single", "Double", "Repeated", "Repeated", "name@example.com", "other@example.com"].map((name) => '<article><div><h3>' + name
    + '</h3><a href="#" onclick="selectRoom(event,this)">Book now</a></div></article>');
  if (reversed) { dates.reverse(); rooms.reverse(); }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<h1>Scoped booking controls</h1>' + dates.join("") + rooms.join("") + '<output>Not booked</output><script>'
    + 'async function selectRoom(event,link){event.preventDefault();const fields=[...document.querySelectorAll("label")];const value=(name)=>fields.find(label=>label.textContent===name).parentElement.querySelector("input").value;'
    + 'const room=link.parentElement.querySelector("h3").textContent;await fetch("/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({room,checkIn:value("Check In"),checkOut:value("Check Out")})});document.querySelector("output").textContent="Selected "+room}</script>');
});
let runner;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  runner = new LocalRunnerService({ root: workspaceRoot, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl, executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) } }, policies: { sideEffects: "allow" } }),
    integration: { name: "independent-booking-fixture", oracles: [{ name: "selected-booking", async check() {
      const passed = writes.length === 1 && writes[0].room === "Single" && writes[0].checkIn === "2026-11-10" && writes[0].checkOut === "2026-11-12";
      return { name: "selected-booking", verificationKind: "business", passed, observedAt: new Date().toISOString(),
        message: "Independent fixture state, not durable persistence", evidence: [JSON.stringify({ writes })] };
    } }] } });
  const inspection = await runner.inspectSurface({ adapter: "web" });
  const controls = inspection.snapshot.controls;
  const checkIn = controls.find((control) => control.selector?.includes('text-is("Check In")'));
  const checkOut = controls.find((control) => control.selector?.includes('text-is("Check Out")'));
  const single = controls.find((control) => control.selector?.includes('text-is("Single")'));
  assert.ok(checkIn && checkOut && single);
  assert.equal(controls.filter((control) => control.role === "link" && !control.selector).length, 4);
  assert.ok(!JSON.stringify(controls).includes("example.com"));
  assert.ok(controls.every((control) => !/nth|first|last/.test(control.selector ?? "")));
  const charter = await runner.plan("Book the Single room for the reviewed dates", { adapter: "web", sideEffectPolicy: "allow",
    inspections: [{ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }], expect: ["Selected Single"], charter: {
      intent: "Book the Single room for the reviewed dates", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
      actions: [{ kind: "fill", selector: checkIn.selector, value: "2026-11-10" }, { kind: "fill", selector: checkOut.selector, value: "2026-11-12" },
        { kind: "captureResponse", name: "booking", trigger: { kind: "click", selector: single.selector }, response: {
          url: baseUrl + "/book", method: "POST", statuses: [201], fields: { id: { pointer: "/id", type: "identifier" } }, requestFields: {
            room: { pointer: "/room", type: "string" }, checkIn: { pointer: "/checkIn", type: "string" }, checkOut: { pointer: "/checkOut", type: "string" } } }, requestWindowMs: 150 },
        { kind: "waitForText", text: "Selected Single" }], assertions: [{ kind: "text-visible", text: "Selected Single" }], oracles: ["selected-booking"], metadata: {} } });
  reversed = true;
  const summary = await runner.wait((await runner.start({ adapter: "web", charter, start: false })).runId);
  assert.equal(summary.verdict, "passed"); assert.equal(writes.length, 1); assert.equal(writes[0].room, "Single");
  const manifest = await runner.evidenceManifest(summary.runId);
  assert.equal((await runner.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
  const result = { status: "passed", workspaceRoot, runId: summary.runId, report: join(workspaceRoot, ".proofkit/runs", summary.runId, "report.html"),
    uniqueAnonymousDates: 2, duplicateContextControlsUnbound: 2, sensitiveContextControlsUnbound: 2, reversedDomOrderKeptIntendedTarget: true,
    writes: writes.length, independentlyVerifiedFields: ["room", "checkIn", "checkOut"], manifestSha256: manifest.sha256 };
  await readFile(result.report, "utf8");
  await writeFile(new URL("../outputs/scoped-controls-validation.json", import.meta.url), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  await runner?.closeAllSurfaceSessions(); server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
