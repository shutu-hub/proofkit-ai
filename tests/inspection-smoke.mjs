import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

const scratch = await mkdtemp(join(tmpdir(), "proofkit-inspection-"));
const source = join(scratch, "source");
const workspaceRoot = join(scratch, "workspace");
let mcp;
let client;
const web = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Inspection fixture</title><h1>Resume intake</h1>
    <p>qa@example.com 13800138000</p>
    <label for="candidate">Candidate</label><input id="candidate" data-testid="candidate-field" value="private candidate value">
    <button id="fetch" onclick="document.querySelector('#result').textContent='Resume ready'">Fetch resume</button>
    <button onclick="document.querySelector('#result').textContent='Details ready'">Show details</button>
    <button>Duplicate</button><button>Duplicate</button>
    <div id="result"></div>`);
});
try {
  await Promise.all([mkdir(source), mkdir(workspaceRoot)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "inspection-source", devDependencies: { vite: "1" } }));
  await new Promise((done) => web.listen(0, "127.0.0.1", done));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Inspection fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}/?token=private`;
  await mkdir(join(workspaceRoot, ".proofkit"));
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
    project: { root: source }, surfaces: { web: { baseUrl,
      ...(process.env.PROOFKIT_BROWSER_PATH || process.platform === "win32"
        ? { executablePath: process.env.PROOFKIT_BROWSER_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" }
        : {}) } },
    policies: { environment: "test", sideEffects: "allow" },
  }));

  mcp = await createProofkitMcp({ root: source, workspaceRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "inspection-smoke", version: "1" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  const response = await client.callTool({ name: "inspect_surface", arguments: { surface: "web" } });
  assert.equal(response.isError, undefined);
  const inspection = JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(inspection.status, "observed", JSON.stringify(inspection));
  assert.equal(inspection.testVerdict, "not-asserted");
  assert.equal(inspection.snapshot.url, `http://127.0.0.1:${address.port}/`);
  assert.equal(inspection.snapshot.text.includes("qa@example.com"), false);
  assert.equal(inspection.snapshot.text.includes("13800138000"), false);
  assert.equal(JSON.stringify(inspection).includes("private candidate value"), false);
  const fetch = inspection.snapshot.controls.find((item) => item.name === "Fetch resume");
  const details = inspection.snapshot.controls.find((item) => item.name === "Show details");
  const candidate = inspection.snapshot.controls.find((item) => item.name === "Candidate");
  const duplicates = inspection.snapshot.controls.filter((item) => item.name === "Duplicate");
  assert.equal(fetch?.selector, "#fetch");
  assert.equal(candidate?.selector, '[data-testid="candidate-field"]');
  assert.equal(details?.selector, 'role=button[name="Show details"]');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((item) => item.selector === undefined));
  assert.ok(inspection.evidence.some((item) => item.kind === "screenshot"));
  const saved = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "runs", inspection.inspectionId, "run.json"), "utf8"));
  assert.equal(saved.steps[0].afterSnapshot.controls.length >= 2, true);

  const runner = await LocalRunnerService.create({ root: source, workspaceRoot, restrictWebOrigins: true });
  const started = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Use the observed semantic selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: details.selector }],
    assertions: [{ kind: "text-visible", text: "Details ready" }], sideEffectPolicy: "allow", metadata: {},
  } });
  assert.equal((await runner.wait(started.runId)).verdict, "passed");
  const ambiguous = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Reject an ambiguous selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: 'role=button[name="Duplicate"]' }],
    assertions: [{ kind: "text-visible", text: "Details ready" }], sideEffectPolicy: "allow", metadata: {},
  } });
  const ambiguousSummary = await runner.wait(ambiguous.runId);
  assert.equal(ambiguousSummary.verdict, "failed");
  assert.ok(ambiguousSummary.findings.some((finding) => finding.includes("matched 2 elements")));
  assert.deepEqual(await readdir(source), ["package.json"]);
  console.log(JSON.stringify({ inspectionId: inspection.inspectionId, controls: inspection.snapshot.controls.length,
    selector: details.selector, verified: ["mcp-inspect-surface", "redacted-snapshot", "unique-role-selector", "ambiguous-controls-without-selector", "ambiguous-action-rejected", "reusable-selector", "source-unchanged"] }, null, 2));
} finally {
  await client?.close();
  await mcp?.close();
  await new Promise((done) => web.close(() => done()));
  const safe = resolve(scratch);
  if (!safe.startsWith(resolve(tmpdir()) + sep) || !safe.split(sep).at(-1)?.startsWith("proofkit-inspection-")) {
    throw new Error("Inspection scratch directory escaped the temporary directory");
  }
  await rm(safe, { recursive: true, force: true });
}
