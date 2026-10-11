import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TestCharterSchema } from "../packages/contracts/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";
import { IntentPlanner } from "../packages/planner/dist/index.js";

// A real HTTP W3C WebDriver protocol fixture; no emulator or device is claimed.
const scratch = await mkdtemp(join(tmpdir(), "proofkit-mobile-smoke-"));
const source = join(scratch, "source");
const workspaceRoot = join(scratch, "workspace");
const sessions = new Map();
const requests = [];
let activeSessionId;
let sequence = 0;
let mode = "success";
let rejectNextDelete = false;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6px8AAAAASUVORK5CYII=";
const driver = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: { error: "fixture error", message: error.message } }));
  });
});
let mcp;
let client;
const priorFixtureUrl = process.env.PROOFKIT_MOBILE_SMOKE_URL;
try {
  await mkdir(source);
  await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
  const sourceBytes = JSON.stringify({ name: "mobile-isolated-source", version: "1.0.0" });
  await writeFile(join(source, "package.json"), sourceBytes);
  await new Promise((resolveListen) => driver.listen(0, "127.0.0.1", resolveListen));
  const address = driver.address();
  if (!address || typeof address === "string") throw new Error("Mobile fixture did not bind");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  process.env.PROOFKIT_MOBILE_SMOKE_URL = serverUrl;
  await writeFile(join(workspaceRoot, ".proofkit", "integration.mjs"), connectorSource());
  const charter = TestCharterSchema.parse({
    intent: "验证移动端提交后后台接受本次操作",
    level: "core", mode: "deterministic", sideEffectPolicy: "allow",
    actions: [
      { kind: "capability", name: "fixture.bindRun", input: {} },
      { kind: "click", selector: "accessibility=Submit" },
      { kind: "waitForText", text: "Submitted", timeoutMs: 2000 },
    ],
    assertions: [{ kind: "text-visible", text: "Submitted" }],
    oracles: ["fixture.business"],
  });
  await writeFile(join(workspaceRoot, ".proofkit", "charters", "mobile-submit.yml"), new IntentPlanner().toYaml(charter));
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify({
    project: { root: source }, surfaces: { mobile: { serverUrl, platformName: "Android",
      automationName: "UiAutomator2", deviceName: "proofkit-fixture",
      readyWhen: { text: "Submit", timeoutMs: 1000 } } },
    policies: { environment: "test", sideEffects: "allow" },
    charters: [{ id: "mobile-submit", path: ".proofkit/charters/mobile-submit.yml",
      aliases: ["测试移动端提交"], level: "core", surfaces: ["mobile"] }],
  }));
  mcp = await createProofkitMcp({ root: source, workspaceRoot, allowCapabilityWrites: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "proofkit-mobile-smoke", version: "1" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  const environment = payload(await client.callTool({ name: "inspect_test_environment", arguments: { surface: "mobile" } }));
  assert.equal(environment.surface, "mobile");
  assert.equal(environment.status, "incomplete", "the fixture declares no backend health endpoint");
  assert.equal(environment.testVerdict, "not-asserted");
  assert.ok(environment.checks.some((check) => check.id === "webdriver-status" && check.status === "passed"));
  assert.ok(environment.notChecked.includes("device-session"));
  assert.equal(sessions.size, 0, "environment inspection must not create a session");
  const cliEnvironment = await environmentThroughCli();
  assert.equal(cliEnvironment.surface, "mobile");
  assert.ok(cliEnvironment.checks.some((check) => check.id === "webdriver-status" && check.status === "passed"));
  assert.equal(sessions.size, 0);
  assert.deepEqual(requests.filter((item) => item.includes("/status")), ["GET /status", "GET /status"]);

  const inspection = payload(await client.callTool({ name: "inspect_surface",
    arguments: { surface: "mobile" } }));
  assert.equal(inspection.surface, "mobile");
  assert.equal(inspection.status, "observed");
  assert.equal(inspection.testVerdict, "not-asserted");
  assert.equal(inspection.readiness.status, "observed");
  assert.match(inspection.snapshot.text, /Submit/);
  assert.ok(inspection.evidence.some((item) => item.kind === "screenshot"));
  assert.equal(requests.filter((item) => item.endsWith("/click")).length, 0);
  const cliInspection = await inspectThroughCli(serverUrl);
  assert.equal(cliInspection.surface, "mobile");
  assert.equal(cliInspection.status, "observed");
  assert.equal(cliInspection.testVerdict, "not-asserted");
  assert.equal(cliInspection.readiness.status, "observed");
  assert.equal(requests.filter((item) => item.endsWith("/click")).length, 0);

  const success = await runMission("passed");
  mode = "duplicate-target";
  const clicksBeforeAmbiguous = requests.filter((item) => item.endsWith("/click")).length;
  const ambiguousStart = payload(await client.callTool({ name: "run_test",
    arguments: { intent: "测试移动端提交", surface: "mobile" } }));
  const ambiguousWait = payload(await client.callTool({ name: "await_test_result",
    arguments: { missionId: ambiguousStart.missionId, timeoutMs: 20000 } }));
  assert.equal(ambiguousWait.state, "terminal");
  const ambiguous = payload(await client.callTool({ name: "get_mission_evidence",
    arguments: { missionId: ambiguousStart.missionId } }));
  assert.equal(ambiguous.testVerdict, "inconclusive");
  assert.ok(ambiguous.findings.some((finding) => finding.message.includes("matched 2 elements")));
  assert.equal(ambiguous.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"), false);
  assert.equal(requests.filter((item) => item.endsWith("/click")).length, clicksBeforeAmbiguous);
  mode = "business-defect";
  const defect = await runMission("failed");
  assert.ok(defect.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"
    && finding.evidence.some((item) => item.kind === "business" && item.path.endsWith("oracle-1-source.json"))));
  mode = "success";
  rejectNextDelete = true;
  const cleanupGap = await runMission("inconclusive");
  assert.ok(cleanupGap.summary.runs.some((run) => run.verdict === "inconclusive"));
  assert.ok(cleanupGap.report);
  const report = JSON.parse(await readFile(join(dirname(cleanupGap.report), "summary.json"), "utf8"));
  assert.equal(report.testVerdict, "inconclusive");
  assert.equal(sessions.size, 1, "the rejected DELETE leaves a session for explicit cleanup");
  const orphanId = [...sessions.keys()][0];
  const cleanup = await fetch(`${serverUrl}/session/${orphanId}`, { method: "DELETE" });
  assert.equal(cleanup.ok, true);
  assert.equal(sessions.size, 0);
  assert.ok(requests.some((item) => item.endsWith("/elements")));
  assert.ok(requests.some((item) => item.endsWith("/displayed")));
  assert.equal(requests.filter((item) => item.endsWith("/click")).length, 3);
  assert.equal(requests.filter((item) => item.startsWith("DELETE /session/")).length, 7);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), sourceBytes);
  console.log(JSON.stringify({ successMission: success.missionId, defectMission: defect.missionId,
    verified: ["native-mcp-mobile-environment", "cli-mobile-environment", "native-mcp-mobile-inspection", "cli-mobile-inspection", "native-mcp-mobile-core", "w3c-http-session", "unique-visible-action-target", "displayed-text", "independent-business-oracle",
      "evidence-linked-defect", "session-cleanup", "cleanup-failure-non-green", "external-workspace", "source-unchanged"] }, null, 2));
} finally {
  await client?.close();
  await mcp?.close();
  if (driver.listening) await new Promise((resolveClose) => driver.close(resolveClose));
  if (priorFixtureUrl === undefined) delete process.env.PROOFKIT_MOBILE_SMOKE_URL;
  else process.env.PROOFKIT_MOBILE_SMOKE_URL = priorFixtureUrl;
  await rm(scratch, { recursive: true, force: true });
}

async function runMission(expectedVerdict) {
  const started = payload(await client.callTool({ name: "run_test",
    arguments: { intent: "测试移动端提交", surface: "mobile" } }));
  assert.equal(started.catalogId, "mobile-submit");
  assert.equal(started.level, "core");
  assert.equal(started.readiness.ready, true);
  let terminal;
  for (let attempt = 0; attempt < 3; attempt++) {
    terminal = payload(await client.callTool({ name: "await_test_result",
      arguments: { missionId: started.missionId, timeoutMs: 20000 } }));
    if (terminal.state === "terminal") break;
  }
  assert.equal(terminal?.state, "terminal", JSON.stringify(terminal));
  const evidence = payload(await client.callTool({ name: "get_mission_evidence",
    arguments: { missionId: started.missionId } }));
  assert.equal(evidence.verdict, expectedVerdict, JSON.stringify(evidence.findings));
  assert.equal(evidence.testVerdict, expectedVerdict);
  assert.ok(evidence.evidence.some((item) => item.kind === "screenshot"));
  assert.ok(evidence.evidence.some((item) => item.kind === "business"));
  const status = payload(await client.callTool({ name: "get_mission_status",
    arguments: { missionId: started.missionId } }));
  const runId = status.mission.observations.find((item) => item.kind === "surface.run")?.data.runId;
  assert.ok(runId);
  const run = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "runs", runId, "run.json"), "utf8"));
  assert.equal(run.assertions[0].passed, true);
  assert.equal(run.oracles[0].passed, expectedVerdict !== "failed");
  if (expectedVerdict === "inconclusive") {
    assert.ok(run.findings.includes("Adapter close failed; inspect trusted local diagnostics."));
    assert.equal(run.oracles[0].passed, true, "the business Oracle passed before cleanup failed");
  }
  assert.equal(run.steps[1].action.kind, "click");
  return evidence;
}

async function inspectThroughCli(serverUrl) {
  return await new Promise((resolveInspection, rejectInspection) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bundle", "main.js"), "inspect",
      "--root", source, "--workspace", workspaceRoot, "--adapter", "mobile",
      "--mobile-server", serverUrl, "--ready-text", "Submit"], { windowsHide: true });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", rejectInspection);
    child.on("close", (code) => {
      if (code !== 0) rejectInspection(new Error(`Mobile CLI inspection failed: ${errors}`));
      else try { resolveInspection(JSON.parse(output)); } catch (error) { rejectInspection(error); }
    });
  });
}

async function environmentThroughCli() {
  return await new Promise((resolveInspection, rejectInspection) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bundle", "main.js"), "environment",
      "--root", source, "--workspace", workspaceRoot, "--surface", "mobile"], { windowsHide: true });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", rejectInspection);
    child.on("close", (code) => {
      if (code !== 2) rejectInspection(new Error(`Mobile CLI environment inspection returned ${code}: ${errors}`));
      else try { resolveInspection(JSON.parse(output)); } catch (error) { rejectInspection(error); }
    });
  });
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  requests.push(`${request.method} ${path}`);
  const send = (value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ value }));
  };
  if (path === "/status" && request.method === "GET") return send({ ready: true, message: "fixture driver ready" });
  if (path === "/session" && request.method === "POST") {
    const sessionId = `mobile-${++sequence}`;
    sessions.set(sessionId, { boundRunId: null, clicked: false, accepted: false });
    activeSessionId = sessionId;
    return send({ sessionId, capabilities: { platformName: "Android" } });
  }
  if (path === "/bind" && request.method === "POST") {
    const body = JSON.parse(await bodyText(request));
    const session = sessions.get(activeSessionId);
    if (!session || !body.runId) return send({ error: "invalid argument", message: "No active session or Run" }, 400);
    session.boundRunId = body.runId;
    return send({ boundRunId: body.runId });
  }
  if (path === "/business" && request.method === "GET") {
    const session = sessions.get(activeSessionId);
    return send({ boundRunId: session?.boundRunId ?? null,
      submitted: session?.clicked ?? false, accepted: session?.accepted ?? false });
  }
  const match = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
  const session = match && sessions.get(match[1]);
  if (!session) return send({ error: "invalid session id", message: "Unknown mobile session" }, 404);
  const route = match[2] ?? "";
  if (!route && request.method === "DELETE") {
    if (rejectNextDelete) {
      rejectNextDelete = false;
      return send({ error: "unknown error", message: "Fixture refuses session cleanup" }, 500);
    }
    sessions.delete(match[1]);
    if (activeSessionId === match[1]) activeSessionId = undefined;
    return send(null);
  }
  if (route === "source") return send(session.clicked
    ? '<hierarchy><node text="Submit"/><node text="Submitted" displayed="true"/></hierarchy>'
    : '<hierarchy><node text="Submit"/></hierarchy>');
  if (route === "url") return send("app://proofkit/submit");
  if (route === "title") return send("ProofKit Mobile Fixture");
  if (route === "screenshot") return send(png);
  if (route === "elements" && request.method === "POST") {
    const body = JSON.parse(await bodyText(request));
    if (body.using === "accessibility id" && body.value === "Submit" && mode === "duplicate-target") {
      return send([{ "element-6066-11e4-a52e-4f735466cecf": "submit-button" },
        { "element-6066-11e4-a52e-4f735466cecf": "duplicate-button" }]);
    }
    if ((body.using === "accessibility id" && body.value === "Submit")
      || (body.using === "xpath" && body.value.includes('"Submit"'))) {
      return send([{ "element-6066-11e4-a52e-4f735466cecf": "submit-button" }]);
    }
    const found = body.using === "xpath" && body.value.includes('"Submitted"') && session.clicked;
    return send(found ? [{ "element-6066-11e4-a52e-4f735466cecf": "submitted-label" }] : []);
  }
  if (route === "element/submit-button/displayed") return send(true);
  if (route === "element/submitted-label/displayed") return send(session.clicked);
  if (route === "element/submit-button/click" && request.method === "POST") {
    session.clicked = true;
    session.accepted = mode === "success";
    return send(null);
  }
  return send({ error: "unknown command", message: `${request.method} ${path}` }, 404);
}

async function bodyText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function payload(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP tool returned no text");
  return JSON.parse(text);
}

function connectorSource() {
  return `
export function createIntegration({ z }) {
  const base = process.env.PROOFKIT_MOBILE_SMOKE_URL;
  return {
    name: "mobile-smoke-connector", version: "1",
    capabilities: [{
      name: "fixture.bindRun", description: "Bind the current fixture session to this ProofKit Run",
      sideEffect: "write", environments: ["test"], timeoutMs: 5000,
      inputSchema: z.object({}), outputSchema: z.object({ boundRunId: z.string() }),
      async execute(_input, { runId, signal }) {
        const response = await fetch(base + "/bind", { method: "POST", signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }) });
        if (!response.ok) throw new Error("Fixture Run binding failed");
        return { boundRunId: (await response.json()).value.boundRunId };
      },
      evidence: (output) => ({ boundRunId: output.boundRunId }),
    }],
    oracles: [{
      name: "fixture.business",
      async check({ runId, signal }) {
        const response = await fetch(base + "/business", { signal });
        if (!response.ok) throw new Error("Fixture business reader failed");
        const value = (await response.json()).value;
        const matched = value.boundRunId === runId;
        const passed = matched && value.submitted ? value.accepted === true : null;
        return { name: "fixture.business", passed,
          message: passed === true ? "Current mobile submission was accepted" : passed === false
            ? "Current mobile submission was rejected by the backend" : "Current submission identity is unverified",
          evidence: [JSON.stringify({ boundRunId: value.boundRunId, submitted: value.submitted,
            accepted: value.accepted, expectedRunId: runId })], observedAt: new Date().toISOString() };
      },
    }],
  };
}
`;
}
