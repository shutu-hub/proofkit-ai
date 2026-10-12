import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probePilotEnvironment } from "../scripts/webarena-environment.mjs";

const http = createServer((request, response) => {
  if (request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, details: { environment: "unverified-fixture" } })); return;
  }
  if (request.url === "/bad/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false })); return;
  }
  if (request.url === "/cross") {
    response.writeHead(302, { location: "https://example.invalid/login" }); response.end(); return;
  }
  if (request.url === "/loop") {
    response.writeHead(302, { location: "/loop" }); response.end(); return;
  }
  if (request.url === "/hold") return;
  if (request.url === "/admin") {
    response.writeHead(302, { location: "/admin/login" }); response.end(); return;
  }
  response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>fixture</h1>");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
const base = `http://127.0.0.1:${http.address().port}`;
const tokens = ["__SHOPPING_ADMIN__", "__SHOPPING__", "__REDDIT__", "__GITLAB__"];
const config = () => ({
  environments: Object.fromEntries(tokens.map((token, index) => [token, { urls: [`${base}/${["admin", "shopping", "reddit", "gitlab"][index]}`] }])),
  controlUrls: Object.fromEntries(tokens.map((token) => [token, base])),
});

test("four loopback sites and controls can be reached without claiming reset or image identity", async () => {
  const result = await probePilotEnvironment(config());
  assert.equal(result.status, "reachable");
  assert.equal(result.applicationSitesReachable, 4);
  assert.equal(result.controlsHealthy, 4);
  assert.equal(result.sites[0].application.redirect, "same-origin");
  assert.equal(result.reset, "not-verified");
  assert.equal(result.imageIdentity, "not-verified");
  assert.equal(result.taskExecution, "not-started");
  assert.equal(result.proofkitEffectiveness, "not-measured");
});

test("the single-site profile probes only the pinned shopping admin endpoints", async () => {
  const one = { environments: { __SHOPPING_ADMIN__: config().environments.__SHOPPING_ADMIN__ },
    controlUrls: { __SHOPPING_ADMIN__: base } };
  const result = await probePilotEnvironment(one, { sites: ["shopping_admin"] });
  assert.equal(result.status, "reachable");
  assert.equal(result.sites.length, 1);
  assert.equal(result.reset, "not-verified");
  const extra = config();
  await assert.rejects(probePilotEnvironment(extra, { sites: ["shopping_admin"] }), /selected pinned sites/);
  const storefront = { environments: { __SHOPPING_ADMIN__: { urls: [base] } },
    controlUrls: { __SHOPPING_ADMIN__: base } };
  await assert.rejects(probePilotEnvironment(storefront, { sites: ["shopping_admin"] }), /\/admin base path/);
});

test("missing or unsuccessful control and cross-origin redirects remain incomplete", async () => {
  const missing = config(); delete missing.controlUrls.__GITLAB__;
  assert.equal((await probePilotEnvironment(missing)).status, "incomplete");
  const unhealthy = config(); unhealthy.controlUrls.__GITLAB__ = `${base}/bad`;
  const result = await probePilotEnvironment(unhealthy);
  assert.equal(result.controlsHealthy, 3);
  assert.equal(result.sites[3].control.reason, "status-not-successful");
  const cross = config(); cross.environments.__GITLAB__.urls = [`${base}/cross`];
  const redirected = await probePilotEnvironment(cross);
  assert.equal(redirected.status, "incomplete");
  assert.equal(redirected.sites[3].application.reason, "cross-origin-redirect");
  const loop = config(); loop.environments.__GITLAB__.urls = [`${base}/loop`];
  assert.equal((await probePilotEnvironment(loop)).sites[3].application.reason, "redirect-loop");
});

test("rejects unsafe or ambiguous mappings before any network request", async () => {
  for (const url of ["https://example.com", "http://user:pass@127.0.0.1:8023", "file:///tmp/site", `${base}/?secret=1`]) {
    const candidate = config(); candidate.environments.__GITLAB__.urls = [url];
    await assert.rejects(probePilotEnvironment(candidate), /loopback/);
  }
  const multiple = config(); multiple.environments.__GITLAB__.urls.push(`${base}/other`);
  await assert.rejects(probePilotEnvironment(multiple), /mapping/);
  const missing = config(); delete missing.environments.__REDDIT__;
  await assert.rejects(probePilotEnvironment(missing), /four pinned/);
});

test("a hung site probe has a deadline and cannot be reported reachable", async () => {
  const candidate = config(); candidate.environments.__GITLAB__.urls = [`${base}/hold`];
  const result = await probePilotEnvironment(candidate, { timeoutMs: 150 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.sites[3].application.reason, "request-failed-or-timed-out");
});

test("pinned benchmark CLI records a read-only probe without calling it a task result",
  { skip: !process.env.PROOFKIT_WEBARENA_UPSTREAM || !process.env.PROOFKIT_WEBARENA_PYTHON }, async () => {
    const root = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-env-probe-"));
    const configPath = join(root, "environment.json"), output = join(root, "probe");
    await writeFile(configPath, JSON.stringify(config()));
    const repo = dirname(dirname(fileURLToPath(import.meta.url)));
    const { stdout } = await promisify(execFile)(process.execPath, [join(repo, "scripts/webarena-benchmark.mjs"), "probe",
      "--upstream", process.env.PROOFKIT_WEBARENA_UPSTREAM, "--python", process.env.PROOFKIT_WEBARENA_PYTHON,
      "--config", configPath, "--output", output], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    const report = JSON.parse(await readFile(result.report, "utf8"));
    assert.equal(result.status, "reachable");
    assert.equal(report.mode, "environment-probe");
    assert.equal(report.taskIds.length, 12);
    assert.equal(report.environment.reset, "not-verified");
    assert.equal(report.environment.taskExecution, "not-started");
    assert.equal(report.environment.proofkitEffectiveness, "not-measured");
  });
