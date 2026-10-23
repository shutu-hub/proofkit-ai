import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { createProofkitMcp } from "../packages/mcp/dist/server.js";

const scratch = await mkdtemp(join(process.env.PROOFKIT_INSPECTION_RUNS ?? tmpdir(), "proofkit-inspection-"));
const source = join(scratch, "source");
const workspaceRoot = join(scratch, "workspace");
const fillEnvName = "PROOFKIT_INSPECTION_FILL_VALUE";
const previousFillValue = process.env[fillEnvName];
let mcp;
let client;
let electron;
let textRevision = 0;
let tableEmailRevision = 0;
const regionText = `${"Row content ".repeat(341)} qa@example.com password=synthetic-secret ${" More content".repeat(700)} LONG_REGION_END`;
// Match rendered HTML whitespace independently of ProofKit's sanitizer.
const expectedRegionText = regionText.replace(/\s+/g, " ").trim()
  .replace("qa@example.com", "[REDACTED_EMAIL]").replace("password=synthetic-secret", "password=[REDACTED]");
const web = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/session-auth" && request.method === "POST") {
    response.writeHead(204, { "set-cookie": "proofkit-session=fixture; HttpOnly; SameSite=Lax; Path=/" });
    response.end(); return;
  }
  if (path === "/session-private") {
    const signedIn = request.headers.cookie?.includes("proofkit-session=fixture");
    response.writeHead(signedIn ? 200 : 401, { "content-type": "text/html; charset=utf-8" });
    response.end(`<h1>${signedIn ? "Private session ready" : "Unauthorized"}</h1>`); return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (path === "/session-login") {
    response.end('<h1>Session login</h1><button id="session-login" onclick="fetch(\'/session-auth\',{method:\'POST\'}).then(()=>document.querySelector(\'#state\').textContent=\'Signed in\')">Sign in</button><p id="state"></p>');
    return;
  }
  if (path === "/long-read" || path === "/long-read-other") {
    response.end(`<!doctype html><title>Long text fixture</title><h1>Long reading ready</h1>
      <p>${"Overview prefix ".repeat(180)}</p><div id="region">${regionText}${textRevision ? " Revised" : ""}</div>
      <div id="other-region">${regionText}</div><div class="duplicate-region">First</div><div class="duplicate-region">Second</div>
      <svg id="non-html-region" width="100" height="30"><text x="0" y="20">SVG fixture</text></svg>
      <div id="hidden-region" hidden>Hidden fixture content</div><div id="oversized-region">${"Z".repeat(200001)}</div>
      <button id="revise-region" onclick="document.querySelector('#region').textContent+=' Revised'">Revise reading</button>
      <a id="table-read-link" href="/table-read">Table reading fixture</a>`);
    return;
  }
  if (path === "/table-read") {
    response.end(`<!doctype html><title>Table fixture</title><h1>Current results page</h1>
      <p>Page 1 of 2</p><table class="read-grid" hidden><thead><tr><th>Hidden</th></tr></thead><tbody><tr><td>clone</td></tr></tbody></table>
      <table id="data-table" class="read-grid"><thead><tr><th>ID</th><th>Contact</th><th>Status</th></tr></thead>
      <tbody>${Array.from({ length: 45 }, (_, index) => `<tr><td>${index + 1}</td><td>${tableEmailRevision && index === 0 ? "other" : `qa${index}`}@example.com</td><td>Complete</td></tr>`).join("")}</tbody></table>
      <div id="not-a-table">Other region</div><button id="revise-table" onclick="document.querySelector('#data-table tbody tr:first-child td:last-child').textContent='Revised'">Revise table</button>`);
    return;
  }
  if (["/delayed", "/diagnostics", "/auth-blocked", "/never"].includes(path)) {
    response.end(`<!doctype html><title>Delayed inspection fixture</title><p style="display:none">Delayed controls ready</p><div id="app"></div><script>
      ${path === "/diagnostics" ? "setTimeout(()=>{for(let i=0;i<15;i++)console.error('runtime diagnostic '+i+' qa@example.com');},450);" : ""}
      ${path === "/auth-blocked" ? "setTimeout(()=>console.error('AuthRequiredError: test session expired'),450);" : ""}
      ${path === "/never" ? "" : "setTimeout(()=>{document.querySelector('#app').innerHTML='<h1>Delayed controls ready</h1><button id=ready>Continue</button><a id=forms href=/>Native form fixture</a>';},1200);"}
    </script>`);
    return;
  }
  response.end(`<!doctype html><title>Inspection fixture</title><h1>Resume intake</h1>
    <p>qa@example.com 13800138000</p>
    <label for="candidate">Candidate</label><input id="candidate" data-testid="candidate-field" value="private candidate value" oninput="document.querySelector('#result').textContent='Candidate updated'">
    <button id="fetch" onclick="document.querySelector('#result').textContent='Resume ready'">Fetch resume</button>
    <button onclick="document.querySelector('#result').textContent='Details ready'">Show details</button>
    <button>Duplicate</button><button>Duplicate</button>
    <a href="#" role="menuitem" style="text-transform:uppercase" onclick="document.querySelector('#result').textContent='Catalog opened';return false"><span>Catalog</span></a>
    <button role="menuitem" onclick="document.querySelector('#result').textContent='Filters opened'">Filters</button><button style="display:none">Filters</button>
    <div id="result"></div>
    <fieldset><legend>Quantity</legend><label>from <input id="quantity-from"></label><label>to <input id="quantity-to"></label></fieldset>
    <fieldset><legend>Price</legend><label>from <input id="price-from"></label></fieldset>
    <fieldset><legend>Private qa@example.com</legend><label>value <input id="private-group"></label></fieldset>
    <select id="status" onchange="document.querySelector('#selection').textContent='Selection '+this.value">
      <option value="">Choose</option><option value="complete">Complete</option><option value="pending">Pending</option>
      <option value="off" disabled>Disabled</option><optgroup label="Unavailable" disabled><option value="group-off">Group disabled</option></optgroup>
    </select><div id="selection"></div>
    <input type="checkbox" id="enabled" onchange="document.querySelector('#changes').textContent='Changes '+(++window.changes)+' checked '+this.checked"><div id="changes">Changes 0 checked false</div>
    <style>.native-toggle{position:relative;display:inline-block;width:48px;height:24px;margin:8px}.native-toggle input{position:absolute;inset:0;width:48px;height:24px;margin:0}.native-toggle label,.native-toggle .unrelated-cover{position:absolute;inset:0;background:#ddd;border:1px solid #888;z-index:2}.native-toggle label span{display:block;width:100%;height:100%}</style>
    <label for="styled">Styled caption</label><div class="native-toggle"><input id="styled" type="checkbox" onchange="document.querySelector('#styled-changes').textContent='Styled '+(++window.styledChanges)+' checked '+this.checked"><label for="styled"><span></span></label></div><div id="styled-changes">Styled 0 checked false</div>
    <div class="native-toggle"><input id="styled-radio" type="radio" name="styled-group"><label for="styled-radio"><span></span></label></div>
    <div class="native-toggle"><input id="styled-disabled" type="checkbox" disabled><label for="styled-disabled"><span></span></label></div>
    <div class="native-toggle"><input id="styled-reset" type="checkbox" onchange="this.checked=false"><label for="styled-reset"><span></span></label></div>
    <div class="native-toggle"><input id="unrelated-overlay" type="checkbox"><div class="unrelated-cover"></div></div>
    <div class="native-toggle"><input id="ambiguous-label" type="checkbox"><label for="ambiguous-label"><label for="ambiguous-label"><span></span></label></label></div>
    <script>window.changes=0;window.styledChanges=0</script>
    <select id="ambiguous-option"><option>Choose</option><option value="a">Same</option><option value="b">Same</option></select>
    <select id="disabled-select" disabled><option>Choose</option></select>
    <select id="multi" multiple onchange="document.querySelector('#multi-selection').textContent='Multi '+(Array.from(this.selectedOptions).map(o=>o.value).join(',')||'none')">
      <option value="complete">Complete</option><option value="pending" selected>Pending</option><option value="other">Other</option>
      <option value="off" disabled>Disabled</option><optgroup disabled label="Unavailable"><option value="group-off">Group disabled</option></optgroup>
    </select><div id="multi-selection">Multi pending</div>
    <select id="ambiguous-multi" multiple><option value="a">Same</option><option value="b">Same</option></select>
    <select id="duplicate-value-multi" multiple><option value="a">First</option><option value="a">Second</option></select>
    <select id="reset-multi" multiple onchange="this.options[1].selected=true"><option value="a">First</option><option value="b">Second</option></select>
    <fieldset disabled><select id="fieldset-multi" multiple><option value="a">First</option></select></fieldset>
    <select id="reset-select" onchange="this.selectedIndex=0"><option value="">Choose</option><option value="complete">Complete</option></select>
    <input id="radio" type="radio" name="group"><div id="custom" role="checkbox" aria-checked="false">Custom checkbox</div>
    <a id="long-read" href="/long-read">Long reading fixture</a>`);
});

async function verifyTextReading(inspect, readRun) {
  const overview = await inspect();
  assert.equal(overview.status, "observed");
  assert.ok(overview.snapshot.text.length <= 2000);
  assert.equal(overview.snapshot.text.includes("LONG_REGION_END"), false);
  let offset = 0;
  let sourceSha256;
  let combined = "";
  let windows = 0;
  do {
    const result = await inspect({ readText: { selector: "#region", offset, limit: 4096,
      ...(sourceSha256 ? { expectedSourceSha256: sourceSha256 } : {}) } });
    assert.equal(result.status, "observed");
    assert.equal(result.testVerdict, "not-asserted");
    const read = result.snapshot.textRead;
    assert.equal(read.scope, "rendered-main-frame-region");
    assert.equal(read.offset, offset);
    assert.equal(read.totalChars, expectedRegionText.length);
    assert.equal(read.returnedChars, read.text.length);
    assert.equal(read.text, result.snapshot.text);
    if (sourceSha256) assert.equal(read.sourceSha256, sourceSha256);
    sourceSha256 = read.sourceSha256;
    combined += read.text;
    const run = await readRun(result.inspectionId);
    assert.equal(run.verdict, "inconclusive");
    assert.deepEqual(run.steps.at(-1).afterSnapshot.textRead, read);
    assert.equal(run.steps.at(-1).afterSnapshot.text, read.text, "Saved and returned windows must retain the full requested text");
    offset = read.nextOffset;
    windows++;
  } while (offset !== null);
  assert.ok(windows >= 3);
  assert.equal(combined, expectedRegionText, "All sanitized rendered text must be reconstructed without omissions or overlaps");
  const eof = await inspect({ readText: { selector: "#region", offset: combined.length, expectedSourceSha256: sourceSha256 } });
  assert.equal(eof.status, "observed");
  assert.equal(eof.snapshot.textRead.text, "");
  assert.equal(eof.snapshot.textRead.nextOffset, null);
  for (const [request, code] of [
    [{ selector: "#region", offset: combined.length + 1, expectedSourceSha256: sourceSha256 }, "surface-text-read-range"],
    [{ selector: "#other-region", expectedSourceSha256: sourceSha256 }, "surface-text-read-changed"],
    [{ selector: "#oversized-region" }, "surface-text-read-too-large"],
    [{ selector: "#non-html-region" }, "surface-text-read-control"],
    [{ selector: ".duplicate-region" }, "surface-text-read-ambiguous"],
    [{ selector: "#hidden-region" }, "runner-operation-timeout"],
    [{ selector: "#missing-region" }, "runner-operation-timeout"],
  ]) {
    const result = await inspect({ readText: request });
    assert.equal(result.status, "failed");
    assert.equal(result.testVerdict, "not-asserted");
    assert.equal(result.snapshot, undefined, "An unsuccessful scoped read must not fall back to the overview");
    const run = await readRun(result.inspectionId);
    assert.equal(run.verdict, "inconclusive");
    const step = run.steps.at(-1);
    const gap = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", step.artifacts.find((path) => path.endsWith("-response-gap.json"))), "utf8"));
    assert.equal(gap.code, code);
  }
  return sourceSha256;
}

async function verifyNativeForms(interact, readRun, persistent = false) {
  for (const [option, output] of [[{ value: "complete" }, "Selection complete"], [{ label: "Pending" }, "Selection pending"], [{ value: "" }, "Selection"]]) {
    const result = await interact({ kind: "selectOption", selector: "#status", option });
    assert.equal(result.status, "observed");
    assert.equal(result.testVerdict, "not-asserted");
    assert.ok(result.snapshot.text.includes(output));
    const run = await readRun(result.interactionId);
    assert.deepEqual(run.steps[0].receipt.metadata.nativeForm, { kind: "selectOption", verified: true, selectedCount: 1 });
  }
  for (const [checked, output] of [[true, "Changes 1 checked true"], [true, "Changes 1 checked true"], [false, persistent ? "Changes 2 checked false" : "Changes 0 checked false"]]) {
    const result = await interact({ kind: "setChecked", selector: "#enabled", checked });
    assert.equal(result.status, "observed");
    assert.ok(result.snapshot.text.includes(output), "Checked state and fixture change count must match the actual context lifetime");
    const run = await readRun(result.interactionId);
    assert.deepEqual(run.steps[0].receipt.metadata.nativeForm, { kind: "setChecked", verified: true, checked });
  }
  const radio = await interact({ kind: "setChecked", selector: "#radio", checked: true });
  assert.equal(radio.status, "observed");
  for (const [checked, output] of [[true, "Styled 1 checked true"], [true, "Styled 1 checked true"], [false, persistent ? "Styled 2 checked false" : "Styled 0 checked false"]]) {
    const result = await interact({ kind: "setChecked", selector: "#styled", checked });
    assert.equal(result.status, "observed");
    assert.ok(result.snapshot.text.includes(output), "Associated covering label must activate exactly once and retain idempotency");
    const run = await readRun(result.interactionId);
    assert.deepEqual(run.steps[0].receipt.metadata.nativeForm, { kind: "setChecked", verified: true, checked });
  }
  assert.equal((await interact({ kind: "setChecked", selector: "#styled-radio", checked: true })).status, "observed");
  for (const [options, output] of [
    [[{ value: "complete" }, { label: "Pending" }], "Multi complete,pending"],
    [[{ label: "Pending" }, { value: "complete" }], "Multi complete,pending"],
    [[{ value: "complete" }], "Multi complete"], [[], "Multi none"],
  ]) {
    const result = await interact({ kind: "selectOptions", selector: "#multi", options });
    assert.equal(result.status, "observed");
    assert.equal(result.testVerdict, "not-asserted");
    assert.ok(result.snapshot.text.includes(output), "The real page must reflect exactly the requested set");
    const run = await readRun(result.interactionId);
    assert.deepEqual(run.steps[0].receipt.metadata.nativeForm, { kind: "selectOptions", verified: true, selectedCount: options.length });
    const multiAfterAction = result.snapshot.controls.find((control) => control.selector === "#multi");
    assert.ok(multiAfterAction, `Missing #multi after native action: ${JSON.stringify({
      controls: result.snapshot.controls.length, truncated: result.snapshot.controlsTruncated,
      selectors: result.snapshot.controls.map((control) => control.selector),
    })}`);
    assert.equal(result.snapshot.controls.length, 20);
    assert.equal(result.snapshot.controlsTruncated, true);
    assert.deepEqual(multiAfterAction.nativeForm,
      { kind: "select", multiple: true, optionCount: 5, selectedCount: options.length });
  }
  const negatives = [
    [{ kind: "selectOption", selector: "#status", option: { value: "missing" } }, "native-option-match"],
    [{ kind: "selectOption", selector: "#ambiguous-option", option: { label: "Same" } }, "native-option-match"],
    [{ kind: "selectOption", selector: "#status", option: { value: "off" } }, "native-option-disabled"],
    [{ kind: "selectOption", selector: "#status", option: { value: "group-off" } }, "native-option-disabled"],
    [{ kind: "selectOption", selector: "#disabled-select", option: { label: "Choose" } }, "native-control-disabled"],
    [{ kind: "selectOption", selector: "#multi", option: { label: "Choose" } }, "native-control-type"],
    [{ kind: "selectOptions", selector: "#status", options: [] }, "native-control-type"],
    [{ kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }, { value: "missing" }] }, "native-option-match"],
    [{ kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }, { label: "Complete" }] }, "native-option-match"],
    [{ kind: "selectOptions", selector: "#ambiguous-multi", options: [{ label: "Same" }] }, "native-option-match"],
    [{ kind: "selectOptions", selector: "#duplicate-value-multi", options: [{ value: "a" }] }, "native-option-match"],
    [{ kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }, { value: "off" }] }, "native-option-disabled"],
    [{ kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }, { value: "group-off" }] }, "native-option-disabled"],
    [{ kind: "selectOptions", selector: "#fieldset-multi", options: [] }, "native-control-disabled"],
    [{ kind: "selectOptions", selector: "#reset-multi", options: [{ value: "a" }] }, "native-state-unverified"],
    [{ kind: "selectOption", selector: "#fetch", option: { label: "Complete" } }, "native-control-type"],
    [{ kind: "selectOption", selector: "#reset-select", option: { value: "complete" } }, "native-state-unverified"],
    [{ kind: "setChecked", selector: "#custom", checked: true }, "native-control-type"],
    [{ kind: "setChecked", selector: "#radio", checked: false }, "native-radio-uncheck"],
    [{ kind: "setChecked", selector: "#styled-disabled", checked: true }, "native-control-disabled"],
    [{ kind: "setChecked", selector: "#styled-reset", checked: true }, "native-state-unverified"],
    [{ kind: "setChecked", selector: "#ambiguous-label", checked: true }, "native-label-match"],
    [{ kind: "setChecked", selector: "#unrelated-overlay", checked: true }, "runner-action-timeout"],
  ];
  for (const [action, code] of negatives) {
    const result = await interact(action);
    assert.equal(result.status, "failed");
    assert.equal(result.testVerdict, "not-asserted");
    const run = await readRun(result.interactionId);
    assert.equal(run.verdict, "inconclusive", "Invalid or unverified interactions are not confirmed product defects");
    assert.equal(run.steps[0].receipt, undefined);
    const gap = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", run.steps[0].artifacts.find((path) => path.endsWith("-response-gap.json"))), "utf8"));
    assert.equal(gap.code, code);
    if (persistent && action.kind === "setChecked" && ["#styled-disabled", "#ambiguous-label", "#unrelated-overlay"].includes(action.selector)) {
      const unchanged = await interact({ kind: "waitForText", text: "Resume intake", timeoutMs: 1000 });
      assert.equal(unchanged.status, "observed", "Rejected activation must preserve the original unchecked state");
      assert.equal(unchanged.snapshot.controls.find((control) => control.selector === action.selector).nativeForm.checked, false);
    }
    if (persistent && action.kind === "selectOptions" && action.selector === "#multi") {
      const unchanged = await interact({ kind: "waitForText", text: "Multi none", timeoutMs: 1000 });
      assert.equal(unchanged.status, "observed", "A rejected set must not partially mutate the persistent page");
      assert.equal(unchanged.snapshot.controls.find((control) => control.selector === "#multi").nativeForm.selectedCount, 0);
    }
  }
}

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
    policies: { environment: "test", sideEffects: "allow", runtime: { mode: "record" } },
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
  assert.equal(inspection.readiness.status, "not-requested");
  assert.equal(inspection.snapshot.url, `http://127.0.0.1:${address.port}/`);
  assert.equal(inspection.snapshot.text.includes("qa@example.com"), false);
  assert.equal(inspection.snapshot.text.includes("13800138000"), false);
  assert.equal(JSON.stringify(inspection).includes("private candidate value"), false);
  const exploratoryResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", action: { kind: "click", selector: "#fetch" } } });
  assert.equal(exploratoryResponse.isError, undefined);
  const exploratory = JSON.parse(exploratoryResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(exploratory.status, "observed");
  assert.equal(exploratory.testVerdict, "not-asserted");
  assert.ok(exploratory.snapshot.text.includes("Resume ready"));
  assert.ok(!JSON.stringify(exploratory).includes("qa@example.com"));
  const retainedResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", keepSession: true, action: { kind: "click", selector: "#fetch" } } });
  assert.equal(retainedResponse.isError, undefined);
  const retained = JSON.parse(retainedResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(retained.status, "observed");
  assert.ok(typeof retained.sessionId === "string");
  const continuedResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", sessionId: retained.sessionId, action: { kind: "waitForText", text: "Resume ready", timeoutMs: 1000 } } });
  assert.equal(continuedResponse.isError, undefined);
  const continued = JSON.parse(continuedResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(continued.status, "observed");
  assert.equal(continued.sessionId, retained.sessionId);
  assert.equal((await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", sessionId: retained.sessionId, url: new URL("/long-read", baseUrl).href,
    action: { kind: "waitForText", text: "Resume ready", timeoutMs: 1000 } } })).isError, true);
  const freshResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", action: { kind: "waitForText", text: "Resume ready", timeoutMs: 1000 } } });
  assert.equal(JSON.parse(freshResponse.content.find((item) => item.type === "text")?.text ?? "null").status, "failed");
  const closeResponse = await client.callTool({ name: "close_surface_session", arguments: { sessionId: retained.sessionId } });
  assert.equal(JSON.parse(closeResponse.content.find((item) => item.type === "text")?.text ?? "null").status, "closed");
  assert.equal((await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", sessionId: retained.sessionId, action: { kind: "waitForText", text: "Resume ready", timeoutMs: 1000 } } })).isError, true);
  const loginUrl = new URL("/session-login", baseUrl).href;
  const privateUrl = new URL("/session-private", baseUrl).href;
  const loginResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", url: loginUrl, keepSession: true, action: { kind: "click", selector: "#session-login" } } });
  assert.equal(loginResponse.isError, undefined);
  const login = JSON.parse(loginResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(login.status, "observed");
  const signedInResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", sessionId: login.sessionId, action: { kind: "waitForText", text: "Signed in", timeoutMs: 3000 } } });
  assert.equal(JSON.parse(signedInResponse.content.find((item) => item.type === "text")?.text ?? "null").status, "observed");
  const privateResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", sessionId: login.sessionId, action: { kind: "goto", url: privateUrl } } });
  const privateResult = JSON.parse(privateResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(privateResult.status, "observed");
  assert.ok(privateResult.snapshot.text.includes("Private session ready"));
  const isolatedResponse = await client.callTool({ name: "interact_surface", arguments: {
    surface: "web", action: { kind: "goto", url: privateUrl } } });
  const isolated = JSON.parse(isolatedResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(isolated.status, "observed");
  assert.ok(isolated.snapshot.text.includes("Unauthorized"));
  assert.equal((await client.callTool({ name: "close_surface_session", arguments: { sessionId: login.sessionId } })).isError, undefined);
  const fetchControl = inspection.snapshot.controls.find((item) => item.name === "Fetch resume");
  const details = inspection.snapshot.controls.find((item) => item.name === "Show details");
  const candidate = inspection.snapshot.controls.find((item) => item.name === "Candidate");
  const duplicates = inspection.snapshot.controls.filter((item) => item.name === "Duplicate");
  assert.equal(fetchControl?.selector, "#fetch");
  assert.equal(candidate?.selector, '[data-testid="candidate-field"]');
  assert.equal(details?.selector, 'role=button[name="Show details"]');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((item) => item.selector === undefined));
  const catalog = inspection.snapshot.controls.find((item) => item.name === "CATALOG");
  assert.equal(catalog?.selector, 'a:has(:text-is("Catalog")):visible');
  const catalogResponse = await client.callTool({ name: "interact_surface", arguments: {
    action: { kind: "click", selector: catalog.selector } } });
  const catalogResult = JSON.parse(catalogResponse.content.find((item) => item.type === "text").text);
  assert.equal(catalogResult.status, "observed");
  assert.ok(catalogResult.snapshot.text.includes("Catalog opened"));
  const filters = inspection.snapshot.controls.find((item) => item.name === "Filters");
  assert.equal(filters?.selector, 'button:text-is("Filters"):visible');
  const filtersResponse = await client.callTool({ name: "interact_surface", arguments: {
    action: { kind: "click", selector: filters.selector } } });
  const filtersResult = JSON.parse(filtersResponse.content.find((item) => item.type === "text").text);
  assert.equal(filtersResult.status, "observed");
  assert.ok(filtersResult.snapshot.text.includes("Filters opened"));
  assert.deepEqual(filtersResult.next, ["inspect_surface"]);
  assert.equal(inspection.snapshot.controls.find((item) => item.selector === "#quantity-from")?.groupName, "Quantity");
  assert.equal(inspection.snapshot.controls.find((item) => item.selector === "#quantity-to")?.groupName, "Quantity");
  assert.equal(inspection.snapshot.controls.find((item) => item.selector === "#price-from")?.groupName, "Price");
  assert.equal(inspection.snapshot.controls.find((item) => item.selector === "#private-group")?.groupName,
    "Private [REDACTED_EMAIL]");
  assert.equal(JSON.stringify(inspection).includes("qa@example.com"), false);
  assert.deepEqual(inspection.snapshot.controls.find((item) => item.selector === "#status").nativeActions, ["selectOption"]);
  const multipleControl = inspection.snapshot.controls.find((item) => item.selector === "#multi");
  assert.equal(multipleControl.role, "listbox");
  assert.deepEqual(multipleControl.nativeActions, ["selectOptions"]);
  assert.deepEqual(multipleControl.nativeForm, { kind: "select", multiple: true, optionCount: 5, selectedCount: 1 });
  assert.deepEqual(inspection.snapshot.controls.find((item) => item.selector === "#enabled").nativeForm, { kind: "checkable", checked: false });
  assert.deepEqual(inspection.snapshot.controls.find((item) => item.selector === "#enabled").nativeActions, ["setChecked"]);
  const disabledMultiple = inspection.snapshot.controls.find((item) => item.selector === "#fieldset-multi");
  assert.equal(disabledMultiple.disabled, true);
  assert.deepEqual(disabledMultiple.nativeActions, []);
  assert.ok(inspection.evidence.some((item) => item.kind === "screenshot"));
  const saved = JSON.parse(await readFile(join(workspaceRoot, ".proofkit", "runs", inspection.inspectionId, "run.json"), "utf8"));
  assert.equal(saved.steps[0].afterSnapshot.controls.length >= 2, true);

  const runner = await LocalRunnerService.create({ root: source, workspaceRoot, restrictWebOrigins: true });
  const readRun = async (id) => JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", id, "run.json"), "utf8"));
  const invokeWeb = async (action) => {
    const response = await client.callTool({ name: "interact_surface", arguments: { action } });
    assert.equal(response.isError, undefined);
    return JSON.parse(response.content.find((item) => item.type === "text").text);
  };
  await verifyNativeForms(invokeWeb, readRun);
  const idempotent = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Native form state and idempotency", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "selectOption", selector: "#status", option: { label: "Complete" } },
      { kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }, { label: "Pending" }] },
      { kind: "selectOptions", selector: "#multi", options: [{ label: "Pending" }, { value: "complete" }] },
      { kind: "selectOptions", selector: "#multi", options: [{ value: "complete" }] },
      { kind: "setChecked", selector: "#enabled", checked: true }, { kind: "setChecked", selector: "#enabled", checked: true },
      { kind: "setChecked", selector: "#enabled", checked: false }],
    assertions: [{ kind: "text-visible", text: "Selection complete" }, { kind: "text-visible", text: "Multi complete" }, { kind: "text-visible", text: "Changes 2 checked false" }], sideEffectPolicy: "allow", metadata: {},
  } });
  assert.equal((await runner.wait(idempotent.runId)).verdict, "passed");
  const deniedRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
    policies: { ...runner.config.policies, sideEffects: "deny" } } });
  const beforeDenied = await readdir(join(workspaceRoot, ".proofkit/runs"));
  await assert.rejects(deniedRunner.interactSurface({ action: { kind: "selectOption", selector: "#status", option: { value: "complete" } } }), /sideEffects=allow/);
  await assert.rejects(deniedRunner.interactSurface({ action: { kind: "selectOptions", selector: "#multi", options: [] } }), /sideEffects=allow/);
  await assert.rejects(deniedRunner.interactSurface({ action: { kind: "setChecked", selector: "#enabled", checked: true } }), /sideEffects=allow/);
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit/runs")), beforeDenied);
  const origin = new URL(baseUrl).origin;
  const inspectWebText = async (input = {}) => {
    const response = await client.callTool({ name: "inspect_surface", arguments: { surface: "web", url: `${origin}/long-read`, ...input } });
    assert.equal(response.isError, undefined);
    return JSON.parse(response.content.find((item) => item.type === "text").text);
  };
  const webTextSha256 = await verifyTextReading(inspectWebText, readRun);
  const inspectWebTable = async (input = {}) => {
    const response = await client.callTool({ name: "inspect_surface", arguments: { surface: "web", url: `${origin}/table-read`, ...input } });
    assert.equal(response.isError, undefined);
    return JSON.parse(response.content.find((item) => item.type === "text").text);
  };
  let tableOffset = 0;
  let tableSha256;
  const tableRows = [];
  do {
    const result = await inspectWebTable({ readTable: { selector: ".read-grid", offset: tableOffset, limit: 20,
      columns: [0, 1], ...(tableSha256 ? { expectedSourceSha256: tableSha256 } : {}) } });
    assert.equal(result.status, "observed");
    assert.equal(result.testVerdict, "not-asserted");
    const read = result.snapshot.tableRead;
    assert.equal(read.scope, "rendered-current-page-table");
    assert.equal(read.totalRows, 45);
    assert.equal(read.allPagesVerified, false, "Finishing a table page must not claim all pages");
    assert.deepEqual(read.columns.map((column) => column.header), ["ID", "Contact"]);
    if (tableSha256) assert.equal(read.sourceSha256, tableSha256);
    tableSha256 = read.sourceSha256;
    tableRows.push(...read.rows);
    assert.deepEqual((await readRun(result.inspectionId)).steps.at(-1).afterSnapshot.tableRead, read);
    tableOffset = read.nextOffset;
  } while (tableOffset !== null);
  assert.equal(tableRows.length, 45);
  assert.deepEqual(tableRows[0], ["1", "[REDACTED_EMAIL]"]);
  const beforeInvalidTable = await readdir(join(workspaceRoot, ".proofkit/runs"));
  for (const readTable of [{ selector: "#data-table", offset: 1 }, { selector: "#data-table", columns: [0, 0] }]) {
    const rejected = await client.callTool({ name: "inspect_surface", arguments: { readTable } });
    assert.equal(rejected.isError, true);
  }
  const conflicting = await client.callTool({ name: "inspect_surface", arguments: {
    readText: { selector: "#data-table" }, readTable: { selector: "#data-table" } } });
  assert.equal(conflicting.isError, true);
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit/runs")), beforeInvalidTable);
  for (const [readTable, code] of [
    [{ selector: "#not-a-table" }, "surface-table-read-control"],
    [{ selector: "#data-table", columns: [7] }, "surface-table-read-columns"],
    [{ selector: ".read-grid", offset: 46, expectedSourceSha256: tableSha256 }, "surface-table-read-range"],
  ]) {
    const failed = await inspectWebTable({ readTable });
    assert.equal(failed.status, "failed");
    assert.equal(failed.snapshot, undefined);
    const run = await readRun(failed.inspectionId);
    const gap = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", run.steps.at(-1).artifacts.find((path) => path.endsWith("-response-gap.json"))), "utf8"));
    assert.equal(gap.code, code);
  }
  tableEmailRevision = 1;
  const changedTable = await inspectWebTable({ readTable: { selector: ".read-grid", offset: 20, columns: [0, 1], expectedSourceSha256: tableSha256 } });
  assert.equal(changedTable.status, "failed");
  tableEmailRevision = 0;
  const beforeInvalidText = await readdir(join(workspaceRoot, ".proofkit/runs"));
  const invalidText = await client.callTool({ name: "inspect_surface", arguments: { readText: { selector: "#region", offset: 1 } } });
  assert.equal(invalidText.isError, true);
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit/runs")), beforeInvalidText);
  const changedPage = await runner.inspectSurface({ url: `${origin}/long-read-other`, readText: { selector: "#region", offset: 4096, expectedSourceSha256: webTextSha256 } });
  assert.equal(changedPage.status, "failed", "An unchanged text region on another page must reject the old fingerprint");
  textRevision = 1;
  const changedText = await inspectWebText({ readText: { selector: "#region", offset: 4096, expectedSourceSha256: webTextSha256 } });
  assert.equal(changedText.status, "failed");
  const changedRun = await readRun(changedText.inspectionId);
  const changedGap = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", changedRun.steps.at(-1).artifacts.find((path) => path.endsWith("-response-gap.json"))), "utf8"));
  assert.equal(changedGap.code, "surface-text-read-changed");
  textRevision = 0;
  const readyWhen = { text: "Delayed controls ready", timeoutMs: 5000 };
  const delayedResponse = await client.callTool({ name: "inspect_surface", arguments: { surface: "web", url: `${origin}/delayed`, readyWhen } });
  assert.equal(delayedResponse.isError, undefined);
  const delayed = JSON.parse(delayedResponse.content.find((item) => item.type === "text").text);
  assert.equal(delayed.status, "observed");
  assert.equal(delayed.readiness.status, "observed");
  assert.ok(delayed.snapshot.text.includes("Delayed controls ready"), "A later visible match must satisfy readiness despite an earlier hidden match");
  assert.equal(delayed.snapshot.controls.find((item) => item.name === "Continue")?.selector, "#ready");
  const delayedRun = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", delayed.inspectionId, "run.json"), "utf8"));
  assert.deepEqual(delayedRun.charter.actions.map((action) => action.kind), ["waitForText", "observe"]);
  assert.equal(delayedRun.steps[0].beforeSnapshot.text.includes("Delayed controls ready"), false, "The fixture must begin before its delayed UI exists");

  const configuredRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
    surfaces: { ...runner.config.surfaces, web: { ...runner.config.surfaces.web, baseUrl: `${origin}/delayed`, readyWhen } } } });
  const configured = await configuredRunner.inspectSurface();
  assert.deepEqual(configured.readiness, { status: "observed", condition: readyWhen });
  const absent = await configuredRunner.inspectSurface({ readyWhen: { text: "Missing condition", timeoutMs: 100 } });
  assert.equal(absent.status, "failed");
  assert.equal(absent.readiness.status, "unverified");
  assert.equal(absent.snapshot, undefined);
  assert.equal(absent.testVerdict, "not-asserted");
  assert.ok(absent.findings.length > 0);
  const diagnostics = await runner.inspectSurface({ url: `${origin}/diagnostics`, readyWhen });
  assert.equal(diagnostics.status, "observed");
  assert.equal(diagnostics.runtimeHealth, "failed");
  assert.equal(diagnostics.runtimeFindings.length, 10);
  assert.equal(diagnostics.runtimeFindingsOmitted, 5);
  assert.ok(diagnostics.runtimeFindings.every((finding) => finding.evidence.length > 0));
  assert.equal(JSON.stringify(diagnostics.runtimeFindings).includes("qa@example.com"), false);
  const blockedRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
    policies: { ...runner.config.policies, runtime: { ...runner.config.policies.runtime,
      blockConsolePatterns: ["AuthRequiredError"] } } } });
  const blocked = await blockedRunner.inspectSurface({ url: `${origin}/auth-blocked`, readyWhen });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.readiness.status, "observed", "a later environment blocker cannot erase an observed readiness condition");
  assert.equal(blocked.testVerdict, "not-asserted");
  assert.ok(blocked.snapshot.text.includes("Delayed controls ready"));
  const blockedRun = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", blocked.inspectionId, "run.json"), "utf8"));
  assert.deepEqual(blockedRun.steps.map((step) => step.status), ["passed", "passed"]);
  const beforeInvalid = await readdir(join(workspaceRoot, ".proofkit/runs"));
  await assert.rejects(runner.inspectSurface({ readyWhen: { text: " ", timeoutMs: 100 } }));
  await assert.rejects(runner.inspectSurface({ readyWhen: { text: "ready", timeoutMs: 15001 } }));
  assert.deepEqual(await readdir(join(workspaceRoot, ".proofkit/runs")), beforeInvalid);

  const cancel = new AbortController();
  const pending = runner.inspectSurface({ url: `${origin}/never`, readyWhen, signal: cancel.signal });
  const cancelTimer = setTimeout(() => cancel.abort(new Error("Readiness cancelled by smoke")), 1500);
  let cancelled;
  try { cancelled = await pending; } finally { clearTimeout(cancelTimer); }
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.readiness.status, "unverified");
  assert.ok(cancelled.findings.some((finding) => finding.includes("Readiness cancelled by smoke")));

  if (process.env.PROOFKIT_ELECTRON_PATH) {
    const profile = join(scratch, "electron-profile");
    await mkdir(profile);
    const app = join(profile, "app.cjs");
    await writeFile(app, `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('remote-debugging-port','0');
      let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(`${origin}/delayed`)});});
      app.on('window-all-closed',()=>app.quit());`);
    electron = spawn(process.env.PROOFKIT_ELECTRON_PATH, [app], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let startupDiagnostics = "";
    electron.stderr.on("data", (chunk) => { startupDiagnostics = (startupDiagnostics + chunk).slice(-2000); });
    let spawnError;
    electron.on("error", (error) => { spawnError = error; });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15000;
    let cdpReady = false;
    let probeDiagnostic = "not-probed";
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (electron.exitCode !== null) throw new Error("Electron exited before readiness inspection");
      try {
        const port = (await readFile(portFile, "utf8")).split(/\r?\n/)[0];
        probeDiagnostic = `port=${JSON.stringify(port)}`;
        if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) { cdpReady = true; break; }
      } catch (error) { probeDiagnostic = error.message; }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(cdpReady, `Electron CDP endpoint did not appear: ${probeDiagnostic}; ${startupDiagnostics}`);
    const desktopRunner = new LocalRunnerService({ root: source, workspaceRoot, config: { ...runner.config,
      surfaces: { ...runner.config.surfaces, electron: { devtoolsActivePort: portFile, readyWhen } } } });
    const desktop = await desktopRunner.inspectSurface({ adapter: "electron" });
    assert.equal(desktop.status, "observed");
    assert.equal(desktop.readiness.status, "observed");
    assert.equal(desktop.snapshot.controls.find((item) => item.name === "Continue")?.selector, "#ready");
    const desktopInteraction = await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#ready" } });
    assert.equal(desktopInteraction.status, "observed");
    assert.equal(desktopInteraction.testVerdict, "not-asserted");
    assert.ok(desktopInteraction.snapshot.text.includes("Delayed controls ready"));
    const openForms = await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#forms" } });
    assert.equal(openForms.status, "observed");
    await verifyNativeForms((action) => desktopRunner.interactSurface({ adapter: "electron", action }), readRun, true);
    assert.equal((await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#long-read" } })).status, "observed");
    const textReady = { text: "Long reading ready", timeoutMs: 1000 };
    const inspectDesktopText = (input = {}) => desktopRunner.inspectSurface({ adapter: "electron", readyWhen: textReady, ...input });
    const desktopTextSha256 = await verifyTextReading(inspectDesktopText, readRun);
    assert.equal((await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#revise-region" } })).status, "observed");
    const desktopChanged = await inspectDesktopText({ readText: { selector: "#region", offset: 4096, expectedSourceSha256: desktopTextSha256 } });
    assert.equal(desktopChanged.status, "failed");
    const desktopChangedRun = await readRun(desktopChanged.inspectionId);
    const desktopGap = JSON.parse(await readFile(join(workspaceRoot, ".proofkit/runs", desktopChangedRun.steps.at(-1).artifacts.find((path) => path.endsWith("-response-gap.json"))), "utf8"));
    assert.equal(desktopGap.code, "surface-text-read-changed");
    const desktopAbsent = await desktopRunner.inspectSurface({ adapter: "electron", readyWhen: { text: "Missing condition", timeoutMs: 100 } });
    assert.equal(desktopAbsent.status, "failed");
    assert.equal(desktopAbsent.readiness.status, "unverified");
    assert.equal((await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#table-read-link" } })).status, "observed");
    const desktopTable = await desktopRunner.inspectSurface({ adapter: "electron",
      readyWhen: { text: "Current results page", timeoutMs: 1000 },
      readTable: { selector: "#data-table", limit: 10, columns: [0, 1] } });
    assert.equal(desktopTable.status, "observed");
    assert.equal(desktopTable.snapshot.tableRead.totalRows, 45);
    assert.equal(desktopTable.snapshot.tableRead.nextOffset, 10);
    assert.equal(desktopTable.snapshot.tableRead.allPagesVerified, false);
    const desktopTableNext = await desktopRunner.inspectSurface({ adapter: "electron",
      readyWhen: { text: "Current results page", timeoutMs: 1000 },
      readTable: { selector: "#data-table", offset: 10, limit: 10, columns: [0, 1],
        expectedSourceSha256: desktopTable.snapshot.tableRead.sourceSha256 } });
    assert.equal(desktopTableNext.status, "observed");
    assert.equal(desktopTableNext.snapshot.tableRead.nextOffset, 20);
    const desktopRevision = await desktopRunner.interactSurface({ adapter: "electron", action: { kind: "click", selector: "#revise-table" } });
    assert.equal(desktopRevision.status, "observed", JSON.stringify({ findings: desktopRevision.findings, action: desktopRevision.action }));
    const desktopTableChanged = await desktopRunner.inspectSurface({ adapter: "electron",
      readyWhen: { text: "Current results page", timeoutMs: 1000 },
      readTable: { selector: "#data-table", offset: 20, columns: [0, 1],
        expectedSourceSha256: desktopTable.snapshot.tableRead.sourceSha256 } });
    assert.equal(desktopTableChanged.status, "failed");
  }
  const started = await runner.start({ adapter: "web", start: false, charter: {
    intent: "Use the observed semantic selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: details.selector }],
    assertions: [{ kind: "text-visible", text: "Details ready" }], sideEffectPolicy: "allow", metadata: {},
  } });
  assert.equal((await runner.wait(started.runId)).verdict, "passed");
  process.env[fillEnvName] = "inspection-fixture-value";
  const fillResponse = await client.callTool({ name: "run_test", arguments: {
    intent: "Fill using a runtime test variable", level: "quick", surface: "web", charter: {
      intent: "Fill using a runtime test variable", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "fill", selector: candidate.selector, value: { env: fillEnvName } }],
      assertions: [{ kind: "text-visible", text: "Candidate updated" }], sideEffectPolicy: "allow", metadata: {},
    },
  } });
  assert.equal(fillResponse.isError, undefined);
  const fillMission = JSON.parse(fillResponse.content.find((item) => item.type === "text")?.text ?? "null");
  assert.equal(fillMission.readiness.ready, true, JSON.stringify(fillMission.readiness));
  let fillStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const statusResponse = await client.callTool({ name: "get_mission_status", arguments: { missionId: fillMission.missionId } });
    fillStatus = JSON.parse(statusResponse.content.find((item) => item.type === "text")?.text ?? "null");
    if (["completed", "failed", "blocked", "cancelled"].includes(fillStatus.mission.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(fillStatus.mission.verdict, "passed", JSON.stringify(fillStatus.mission.findings));
  const savedMission = await readFile(join(workspaceRoot, ".proofkit", "missions", `${fillMission.missionId}.json`), "utf8");
  assert.equal(savedMission.includes("inspection-fixture-value"), false);
  const fillRunId = JSON.parse(savedMission).observations.find((item) => item.kind === "surface.run")?.data.runId;
  assert.ok(fillRunId);
  const fillEvidence = await readFile(join(workspaceRoot, ".proofkit", "runs", fillRunId, "run.json"), "utf8");
  assert.equal(fillEvidence.includes("inspection-fixture-value"), false);
  assert.deepEqual(JSON.parse(fillEvidence).charter.actions[0].value, { env: fillEnvName });
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
    ...(process.env.PROOFKIT_INSPECTION_RUNS ? { artifacts: scratch } : {}),
    selector: details.selector, electronReadiness: process.env.PROOFKIT_ELECTRON_PATH ? "verified" : "not-run",
    verified: ["scoped-text-reconstruction-and-eof", "scoped-text-window-redaction", "scoped-text-persisted-full-window", "scoped-text-negative-evidence", "scoped-text-page-and-region-binding", "scoped-text-changed-source-rejected", "scoped-text-invalid-input-before-run", "current-page-table-row-reconstruction", "current-page-table-pii-redaction", "current-page-table-negative-evidence", "current-page-table-never-claims-all-pages", "native-select-exact-value-and-label", "native-multiple-select-exact-set-replacement-and-clear", "native-multiple-select-prevalidation-and-readback", "native-form-state-and-action-hints", "native-checkbox-idempotency", "native-form-readback", "native-form-negative-evidence", "native-form-write-policy", "acted-control-in-compact-observation", "fieldset-group-name-redaction", "mcp-inspect-surface", "single-step-web-interaction", ...(process.env.PROOFKIT_ELECTRON_PATH ? ["single-step-electron-interaction", "electron-scoped-text-positive-negative-and-continuation", "electron-current-page-table-read-and-change-rejection"] : []), "delayed-ui-readiness", "configured-readiness", "unverified-missing-condition", "bounded-runtime-diagnostics", "readiness-with-environment-blocker", "readiness-cancellation", "invalid-input-before-run", "redacted-snapshot", "unique-role-selector", "ambiguous-controls-without-selector", "ambiguous-action-rejected", "reusable-selector", "runtime-fill-reference", "source-unchanged"] }, null, 2));
} finally {
  if (electron && electron.exitCode === null) {
    const exited = new Promise((done) => electron.once("exit", done));
    electron.kill();
    await exited;
  }
  if (previousFillValue === undefined) delete process.env[fillEnvName];
  else process.env[fillEnvName] = previousFillValue;
  await client?.close();
  await mcp?.close();
  await new Promise((done) => web.close(() => done()));
  if (!process.env.PROOFKIT_INSPECTION_RUNS) {
    const safe = resolve(scratch);
    if (!safe.startsWith(resolve(tmpdir()) + sep) || !safe.split(sep).at(-1)?.startsWith("proofkit-inspection-")) {
      throw new Error("Inspection scratch directory escaped the temporary directory");
    }
    await rm(safe, { recursive: true, force: true });
  }
}
