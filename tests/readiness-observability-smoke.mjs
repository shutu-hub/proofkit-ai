import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { createBookerReadinessIntegration } from "./booker-readiness-integration.mjs";

const buildFiles = ["packages/contracts/dist/index.js", "packages/local-runner/dist/index.js", "packages/runner/dist/index.js",
  "packages/adapters/dist/web.js", "tests/booker-readiness-integration.mjs", "tests/booker-live-oracles.mjs", "tests/readiness-observability-smoke.mjs"];
const buildHashes = async () => Object.fromEntries(await Promise.all(buildFiles.map(async (path) => [path,
  createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex")])));
const frameworkBuild = await buildHashes();

const expected = { roomId: 1, firstName: "Proofkit", lastName: "PrewriteReadiness", email: "readiness@example.invalid", contactNumber: "00000000000",
  depositPaid: false, checkIn: "2026-11-10", checkOut: "2026-11-12" };
const workspace = await mkdtemp(join(tmpdir(), "proofkit-observability-readiness-"));
let fullSample = false, sampleUnavailable = false, productWrites = 0, oracleCalls = 0, browserConnections = 0;
const trace = [];
const server = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/auth/login" && request.method === "POST") { response.end('{"token":"fixture-only-token"}'); return; }
  if (request.url === "/api/booking/1" && request.method === "GET") {
    if (sampleUnavailable) { response.statusCode = 404; response.end('{"error":"Fixture unavailable"}'); return; }
    response.end(JSON.stringify({ bookingid: 1, roomid: 1, firstname: "Another", lastname: "SyntheticFixture", depositpaid: false,
      bookingdates: { checkin: "2026-11-01", checkout: "2026-11-03" }, ...(fullSample ? { email: "fixture@example.invalid", phone: "00000000000" } : {}) })); return;
  }
  if (request.url === "/api/booking" && request.method === "POST") { productWrites++; response.statusCode = 201; response.end('{"bookingid":2}'); return; }
  response.statusCode = 404; response.end("{}");
});
const originalConnect = WebAdapter.prototype.connect;
WebAdapter.prototype.connect = async function () { browserConnections++; throw new Error("A blocked readiness test must never connect a browser"); };
let liveService;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = "http://127.0.0.1:" + server.address().port;
  const integration = createBookerReadinessIntegration({ origin, observeRequest: (request) => trace.push(request) });
  integration.oracles = [{ name: "booker-current-booking", async check() { oracleCalls++; throw new Error("No Oracle should execute"); } }];
  const service = new LocalRunnerService({ root: workspace, workspaceRoot: workspace, integration,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: origin } }, policies: { sideEffects: "allow" } }) });
  const charter = TestCharterSchema.parse({ intent: "Verify the full booking including independent contact fields", level: "core", surfaces: ["web"], mode: "deterministic", sideEffectPolicy: "allow",
    actions: [{ kind: "captureResponse", name: "booking-created", trigger: { kind: "click", selector: "#submit" },
      response: { url: origin + "/api/booking", method: "POST", statuses: [201], fields: { bookingId: { pointer: "/bookingid", type: "id" } } } }],
    assertions: [{ kind: "text-visible", text: "Booking Confirmed" }], oracles: ["booker-current-booking"],
    metadata: { expectedBooking: JSON.stringify(expected), readinessBookingId: "1" },
    planning: { source: "submitted", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [] } });
  const readiness = await service.inspectIntegrationReadiness({ charter });
  assert.equal(readiness.status, "blocked"); assert.equal(readiness.testVerdict, "not-asserted");
  assert.equal(readiness.check.evidence.missingFields, "email,contactNumber");
  assert.ok(!(await readdir(workspace)).includes(".proofkit"));
  const blocked = await service.wait((await service.start({ adapter: "web", charter, start: false })).runId);
  assert.equal(blocked.verdict, "blocked"); assert.equal(blocked.steps.length, 0); assert.equal(blocked.oracles.length, 0);
  const preflightArtifact = blocked.artifacts.find((path) => path.endsWith("/preflight.json")); assert.ok(preflightArtifact);
  const preflight = JSON.parse(await readFile(join(workspace, ".proofkit/runs", preflightArtifact), "utf8")); assert.equal(preflight.passed, false);
  fullSample = true;
  const ready = await service.inspectIntegrationReadiness({ charter }); assert.equal(ready.status, "ready"); assert.equal(ready.testVerdict, "not-asserted");
  assert.equal(ready.check.evidence.responseSchemaVerified, false); assert.equal(ready.draftSha256, readiness.draftSha256);
  sampleUnavailable = true;
  const unavailable = await service.inspectIntegrationReadiness({ charter }); assert.equal(unavailable.status, "unavailable");
  assert.equal(productWrites, 0); assert.equal(oracleCalls, 0); assert.equal(browserConnections, 0);
  assert.ok(trace.every((request) => request.path === "/api/auth/login" || request.path === "/api/booking/1"));
  const manifest = await service.evidenceManifest(blocked.runId);
  assert.equal((await service.verifyEvidenceManifest(blocked.runId, manifest.sha256)).status, "intact");
  const result = { checkedAt: new Date().toISOString(), status: "passed", workspaceRoot: workspace, readiness, readySample: ready, unavailableSample: unavailable,
    blockedRun: { runId: blocked.runId, verdict: blocked.verdict, report: join(workspace, ".proofkit/runs", blocked.runId, "report.html"), manifestSha256: manifest.sha256 },
    productWrites, oracleCalls, browserConnections, requestTrace: trace, frameworkBuild,
    buildUnchanged: JSON.stringify(await buildHashes()) === JSON.stringify(frameworkBuild), scope: "Controlled before-write regression; ready is not current-record acceptance" };
  assert.equal(result.buildUnchanged, true);
  await writeFile(new URL("../outputs/readiness-observability-validation.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ mode: "controlled", status: result.status, productWrites, oracleCalls, browserConnections, blockedVerdict: blocked.verdict, workspaceRoot: workspace }));

  if (process.argv.includes("--live-booker")) {
    const root = (await readFile(new URL("../outputs/booker-sample-root.txt", import.meta.url), "utf8")).trim();
    const original = JSON.parse(await readFile(join(root, "partial-response-acceptance/frozen-charter.json"), "utf8"));
    const liveCharter = TestCharterSchema.parse({ ...original, surfaces: ["web"], metadata: { ...original.metadata, readinessBookingId: "1" } });
    const liveWorkspace = await mkdtemp(join(tmpdir(), "proofkit-booker-readiness-"));
    const liveTrace = [];
    liveService = new LocalRunnerService({ root: join(root, "reviewed-target"), workspaceRoot: liveWorkspace,
      integration: createBookerReadinessIntegration({ observeRequest: (request) => liveTrace.push(request) }),
      config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "https://automationintesting.online" } }, policies: { sideEffects: "allow" } }) });
    await writeFile(join(liveWorkspace, "frozen-charter.json"), JSON.stringify(liveCharter, null, 2) + "\n");
    const observed = await liveService.inspectIntegrationReadiness({ charter: liveCharter });
    let runtime;
    if (observed.status === "blocked") {
      const summary = await liveService.wait((await liveService.start({ adapter: "web", charter: liveCharter, start: false })).runId);
      assert.equal(summary.verdict, "blocked"); assert.equal(summary.steps.length, 0); assert.equal(summary.oracles.length, 0);
      const manifest = await liveService.evidenceManifest(summary.runId);
      assert.equal((await liveService.verifyEvidenceManifest(summary.runId, manifest.sha256)).status, "intact");
      runtime = { runId: summary.runId, verdict: summary.verdict, steps: summary.steps.length,
        report: join(liveWorkspace, ".proofkit/runs", summary.runId, "report.html"), manifestSha256: manifest.sha256 };
    }
    assert.equal(browserConnections, 0);
    assert.ok(liveTrace.every((request) => request.path === "/api/auth/login" && request.method === "POST" || request.path === "/api/booking/1" && request.method === "GET"));
    const live = { checkedAt: new Date().toISOString(), target: "https://automationintesting.online", workspaceRoot: liveWorkspace,
      readiness: observed, runtime, browserConnections, productBookingRequests: 0, requestTrace: liveTrace, frameworkBuild,
      buildUnchanged: JSON.stringify(await buildHashes()) === JSON.stringify(frameworkBuild),
      scope: "Explicit existing demo sample; authentication and GET only. No browser connected, booking submitted or business acceptance asserted." };
    assert.equal(live.buildUnchanged, true);
    await writeFile(join(liveWorkspace, "readiness-result.json"), JSON.stringify(live, null, 2) + "\n");
    await writeFile(new URL("../outputs/readiness-observability-live-validation.json", import.meta.url), JSON.stringify(live, null, 2) + "\n");
    console.log(JSON.stringify({ mode: "live", status: observed.status, runtime, requestTrace: liveTrace, workspaceRoot: liveWorkspace }));
  }
} finally {
  WebAdapter.prototype.connect = originalConnect;
  await liveService?.closeAllSurfaceSessions();
  server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done));
}
