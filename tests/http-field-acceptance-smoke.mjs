import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { EvidenceStore } from "../packages/evidence/dist/index.js";

const workspace = await mkdtemp(join(tmpdir(), "proofkit-http-field-acceptance-"));
const expected = { roomId: 1, firstName: "Proofkit", lastName: "FieldEvidence", email: "field-evidence@example.invalid", contactNumber: "00000000000",
  depositPaid: false, checkIn: "2026-11-10", checkOut: "2026-11-12" };
const pointers = { roomId: "/roomId", firstName: "/guest/firstName", lastName: "/guest/lastName", email: "/guest/email", contactNumber: "/guest/contactNumber",
  depositPaid: "/depositPaid", checkIn: "/bookingdates/checkin", checkOut: "/bookingdates/checkout" };
const scenarios = [{ name: "matched", verdict: "passed" }, { name: "wrong-checkout", verdict: "failed" },
  { name: "missing-contact", verdict: "inconclusive" }, { name: "wrong-type", verdict: "inconclusive" },
  { name: "pending-then-matched", verdict: "passed" }, { name: "mismatch-and-missing", verdict: "failed" }];
const buildFiles = ["packages/contracts/dist/index.js", "packages/oracles/dist/index.js", "packages/runner/dist/index.js", "packages/evidence/dist/index.js",
  "packages/local-runner/dist/index.js", "packages/adapters/dist/web.js", "tests/http-field-acceptance-smoke.mjs"];
const builds = async () => Object.fromEntries(await Promise.all(buildFiles.map(async (path) => [path,
  createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex")])));
const frameworkBuild = await builds();
await writeFile(join(workspace, "frozen-contract.json"), JSON.stringify({ frozenAt: new Date().toISOString(), expected, pointers, scenarios,
  note: "Synthetic controlled browser fixtures. Persisted facts are server memory; fixture faults are deliberate. This is not hosted application or production acceptance." }, null, 2));
let mode = scenarios[0].name, writes = 0;
const records = new Map();
const server = createServer(async (request, response) => {
  if (request.url === "/api/bookings" && request.method === "POST") {
    let text = ""; for await (const chunk of request) text += chunk;
    const submitted = JSON.parse(text); const id = "record-" + (++writes);
    const persisted = structuredClone(submitted);
    if (["wrong-checkout", "mismatch-and-missing"].includes(mode)) persisted.bookingdates.checkout = "2026-11-13";
    if (["missing-contact", "mismatch-and-missing"].includes(mode)) delete persisted.guest.email;
    if (mode === "wrong-type") persisted.roomId = "1";
    records.set(id, { id, mode, submitted, persisted, reads: 0 });
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ id, private: "PRIVATE_UNSELECTED_ACTION" })); return;
  }
  if (request.url?.startsWith("/api/status?")) {
    const id = new URL(request.url, "http://localhost").searchParams.get("id"); const record = records.get(id);
    response.writeHead(record ? 200 : 404, { "content-type": "application/json" });
    if (!record) { response.end("{}"); return; }
    record.reads++;
    const pending = record.mode === "pending-then-matched" && record.reads === 1;
    response.end(JSON.stringify({ ...record.persisted, id, state: pending ? "pending" : "complete",
      ...(pending ? { bookingdates: { checkin: expected.checkIn, checkout: "2026-11-20" } } : {}), private: "PRIVATE_UNSELECTED_READER" })); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<h1>Reviewed booking</h1><label for="room">Room</label><select id="room"><option value="2">Double</option><option value="1">Single</option></select>'
    + '<label for="first">First name</label><input id="first"><label for="last">Last name</label><input id="last">'
    + '<label for="email">Email</label><input id="email" type="email"><label for="phone">Phone</label><input id="phone" type="tel">'
    + '<label for="checkin">Check in</label><input id="checkin" type="date"><label for="checkout">Check out</label><input id="checkout" type="date">'
    + '<label for="deposit">Deposit paid</label><input id="deposit" type="checkbox" checked><button id="submit">Create reviewed booking</button><output>Not submitted</output>'
    + '<script>document.querySelector("#submit").onclick=async()=>{document.querySelector("#submit").disabled=true;const value=(selector)=>document.querySelector(selector).value;'
    + 'await fetch("/api/bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({roomId:Number(value("#room")),guest:{firstName:value("#first"),lastName:value("#last"),email:value("#email"),contactNumber:value("#phone")},'
    + 'depositPaid:document.querySelector("#deposit").checked,bookingdates:{checkin:value("#checkin"),checkout:value("#checkout")},private:"PRIVATE_UNSELECTED_REQUEST"})});document.querySelector("output").textContent="Booking Confirmed"};</script>');
});
let service;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = "http://127.0.0.1:" + server.address().port;
  service = new LocalRunnerService({ root: workspace, workspaceRoot: workspace, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin, executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined) } }, run: { recordVideo: true }, policies: { sideEffects: "allow" } }) });
  const inspection = await service.inspectSurface({ adapter: "web" });
  const charter = await service.plan("Verify every reviewed booking field using current-record observations, not UI confirmation alone", { adapter: "web",
    inspections: [{ runId: inspection.inspectionId, manifestSha256: inspection.manifest.sha256 }], expect: ["Booking Confirmed"], sideEffectPolicy: "allow", charter: {
      intent: "Verify every reviewed booking field using current-record observations, not UI confirmation alone", level: "core", mode: "deterministic", sideEffectPolicy: "allow",
      actions: [{ kind: "selectOption", selector: "#room", option: { value: "1" } }, { kind: "fill", selector: "#first", value: expected.firstName },
        { kind: "fill", selector: "#last", value: expected.lastName }, { kind: "fill", selector: "#email", value: expected.email },
        { kind: "fill", selector: "#phone", value: expected.contactNumber }, { kind: "fill", selector: "#checkin", value: expected.checkIn },
        { kind: "fill", selector: "#checkout", value: expected.checkOut }, { kind: "setChecked", selector: "#deposit", checked: false },
        { kind: "waitForValue", selector: "#checkin", value: expected.checkIn, stableForMs: 150 }, { kind: "waitForValue", selector: "#checkout", value: expected.checkOut, stableForMs: 150 },
        { kind: "captureResponse", name: "booking-created", trigger: { kind: "click", selector: "#submit" }, response: { url: origin + "/api/bookings", method: "POST", statuses: [201],
          fields: { id: { pointer: "/id", type: "identifier" } }, requestFields: Object.fromEntries(Object.entries(pointers).map(([name, pointer]) => [name, { pointer, type: typeof expected[name] }])) },
          requestWindowMs: 200, timeoutMs: 5000 }, { kind: "waitForText", text: "Booking Confirmed" }],
      assertions: [{ kind: "text-visible", text: "Booking Confirmed" }], oracles: ["current-booking-fields"], httpOracles: [{ name: "current-booking-fields", url: origin + "/api/status",
        query: { id: { source: "response", stepId: "step-011", field: "id", matchPointer: "/id" } }, statusPointer: "/state", successValues: ["complete"], failureValues: ["failed"],
        expectFields: Object.entries(pointers).map(([name, pointer]) => ({ name, pointer, expected: expected[name], retainValue: ["roomId", "depositPaid", "checkIn", "checkOut"].includes(name) })),
        intervalMs: 100, deadlineMs: 1000 }], metadata: {} } });
  await writeFile(join(workspace, "frozen-charter.json"), JSON.stringify(charter, null, 2));
  const cases = [];
  for (const scenario of scenarios) {
    mode = scenario.name; const before = writes;
    const summary = await service.wait((await service.start({ adapter: "web", charter, start: false })).runId);
    assert.equal(summary.verdict, scenario.verdict, JSON.stringify({ scenario, steps: summary.steps, oracles: summary.oracles, findings: summary.findings }));
    assert.equal(writes - before, 1); assert.equal(summary.steps.length, 12); assert.ok(summary.steps.every((step) => step.status === "passed"));
    const captured = summary.steps[10].response; assert.ok(captured); const record = records.get(captured.fields.id); assert.ok(record);
    assert.equal(record.submitted.bookingdates.checkout, expected.checkOut); assert.equal(record.submitted.guest.email, expected.email);
    assert.equal(summary.oracles.length, 1);
    const source = summary.oracles[0].sourceEvidenceArtifacts[0];
    const sourceBytes = await readFile(join(workspace, ".proofkit/runs", source)); const facts = JSON.parse(sourceBytes.toString("utf8"));
    const latest = facts.facts[0].observations.at(-1); assert.equal(latest.facts.scopeMatches, true); assert.equal(latest.facts.fieldChecks.length, 8);
    assert.ok(!sourceBytes.toString("utf8").includes(expected.email)); assert.ok(!sourceBytes.toString("utf8").includes("PRIVATE_UNSELECTED"));
    assert.equal(summary.recording?.status, "recorded");
    const report = join(workspace, ".proofkit/runs", summary.runId, "report.html"); const html = await readFile(report, "utf8");
    assert.ok(html.includes("Required field checks")); assert.ok(!html.includes("PRIVATE_UNSELECTED"));
    const manifest = await service.evidenceManifest(summary.runId); assert.equal((await service.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
    let tamperWithdrawn;
    if (scenario.name === "matched") {
      await writeFile(join(workspace, ".proofkit/runs", source), "tampered field evidence");
      const store = new EvidenceStore(join(workspace, ".proofkit/runs"));
      const changed = await readFile(await store.writeReport(summary), "utf8");
      assert.ok(!changed.includes("Required field checks (8/8 matched)")); assert.ok(changed.includes("Independent reader facts unavailable or changed"));
      await writeFile(join(workspace, ".proofkit/runs", source), sourceBytes); await store.writeReport(summary);
      assert.equal((await service.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact"); tamperWithdrawn = true;
    }
    cases.push({ scenario: scenario.name, expectedVerdict: scenario.verdict, verdict: summary.verdict, runId: summary.runId, report,
      manifestSha256: manifest.sha256, source, fieldChecks: latest.facts.fieldChecks, writes: writes - before, reads: record.reads, tamperWithdrawn,
      submittedCheckout: record.submitted.bookingdates.checkout, persistedCheckout: record.persisted.bookingdates.checkout,
      recording: summary.recording, screenshot: summary.steps[11].artifacts.find((path) => path.endsWith(".png")) });
    console.log(JSON.stringify({ scenario: scenario.name, verdict: summary.verdict, writes: writes - before, runId: summary.runId }));
  }
  assert.deepEqual(await builds(), frameworkBuild);
  const result = { checkedAt: new Date().toISOString(), status: "passed", workspaceRoot: workspace, expected, pointers, cases, frameworkBuild,
    completeGoal: false, scope: "Controlled browser and independent server-memory regressions with deliberately seeded faults; not hosted website success rate or durable database acceptance" };
  await writeFile(join(workspace, "validation-result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(new URL("../outputs/http-field-acceptance-validation.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ status: result.status, workspaceRoot: workspace, cases: cases.length }));
} finally {
  await service?.closeAllSurfaceSessions(); server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
