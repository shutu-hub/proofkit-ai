import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { WebAdapter } from "../packages/adapters/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

class ObservedWebAdapter extends WebAdapter {
  currentPage() { return this.page(); }
  currentBrowser() { return this.browser; }
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Browser presentation fixture</title>
    <h1>Live browser evidence</h1><div id="finite">Animation running</div><div id="loop">Continuous motion</div>
    <input id="input" aria-label="Live input"><div style="height:1600px"></div>
    <script>
      window.finishes = 0; window.cancels = 0;
      window.finite = document.querySelector('#finite').animate([{opacity:1},{opacity:.2}], {duration:60000,fill:'forwards'});
      window.finite.onfinish = () => { window.finishes++; document.querySelector('#finite').textContent = 'Animation finished'; };
      window.loop = document.querySelector('#loop').animate([{transform:'translateX(0)'},{transform:'translateX(60px)'}], {duration:60000,iterations:Infinity});
      window.loop.oncancel = () => window.cancels++;
    </script>`);
});

let adapter;
let cdpAdapter;
let cdpContext;
let workspace;
const originalLaunch = chromium.launch;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const headless = process.env.PROOFKIT_TEST_HEADFUL !== "1";
  adapter = new ObservedWebAdapter({
    baseUrl: `http://127.0.0.1:${address.port}/`, headless,
    executablePath: process.env.PROOFKIT_BROWSER_PATH
      ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined),
  });
  await adapter.connect();
  const page = adapter.currentPage();
  const firstBrowser = adapter.currentBrowser();
  if (!headless) assert.equal(page.viewportSize(), null, "Visible runs should use the actual browser window size");
  await page.locator("#input").focus();
  await page.waitForFunction(() => window.loop.startTime !== null);
  const before = await page.evaluate(() => ({ startTime: window.loop.startTime, width: innerWidth, height: innerHeight, scroll: scrollY }));
  for (let index = 0; index < 3; index++) {
    const bytes = await adapter.capture(`capture-${index}.png`);
    assert.ok(bytes && Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  }
  const after = await page.evaluate(() => ({
    startTime: window.loop.startTime, width: innerWidth, height: innerHeight, scroll: scrollY,
    finishes: window.finishes, cancels: window.cancels, state: window.finite.playState,
    focused: document.activeElement.id, visibility: document.visibilityState,
  }));
  assert.equal(after.finishes, 0, "Evidence screenshots must not finish the application's animations");
  assert.equal(after.cancels, 0, "Evidence screenshots must not restart continuous animations");
  assert.equal(after.state, "running");
  assert.deepEqual({ startTime: after.startTime, width: after.width, height: after.height, scroll: after.scroll }, before);
  assert.equal(after.focused, "input");
  assert.equal(after.visibility, "visible");

  await page.close();
  await assert.rejects(adapter.snapshot(), /page is closed/i);
  await adapter.connect();
  assert.notEqual(adapter.currentPage(), page, "Reconnecting must create a new page after the prior page closed");
  assert.equal(firstBrowser.isConnected(), false, "Reconnecting must release the previous browser instead of leaving a hidden process");
  assert.equal(await adapter.currentPage().title(), "Browser presentation fixture");
  const secondPage = adapter.currentPage();
  await adapter.connect();
  assert.notEqual(adapter.currentPage(), secondPage);
  assert.equal(secondPage.isClosed(), true);
  await adapter.close();

  // Exercise the same workspace setting through the public Local Runner used by MCP.
  workspace = await mkdtemp(join(tmpdir(), "proofkit-browser-presentation-"));
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const config = ProofkitConfigSchema.parse({
    project: { root }, policies: { environment: "test", targetBinding: "record" },
    surfaces: { web: { baseUrl: `http://127.0.0.1:${address.port}/`, headless,
      executablePath: process.env.PROOFKIT_BROWSER_PATH
        ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) } },
  });
  const launched = [];
  chromium.launch = async function (options) {
    const browser = await originalLaunch.call(this, options);
    launched.push({ headless: options.headless, browser });
    return browser;
  };
  const runner = new LocalRunnerService({ root, workspaceRoot: workspace, config });
  const inspection = await runner.inspectSurface();
  assert.equal(inspection.status, "observed", JSON.stringify(inspection));
  assert.equal(launched[0].headless, headless, "Public inspection must honor the workspace visibility setting");
  assert.equal(launched[0].browser.isConnected(), false, "Inspection must release its owned browser");
  const override = await runner.inspectSurface({ headful: headless });
  assert.equal(override.status, "observed", JSON.stringify(override));
  assert.equal(launched[1].headless, !headless, "An explicit per-call visibility option must override workspace configuration");
  assert.equal(launched[1].browser.isConnected(), false);
  chromium.launch = originalLaunch;

  const cdpProfile = join(workspace, "cdp-profile");
  cdpContext = await chromium.launchPersistentContext(cdpProfile, { headless: true,
    executablePath: config.surfaces.web.executablePath, args: ["--remote-debugging-port=0"] });
  const existingPage = cdpContext.pages()[0];
  await existingPage.goto(config.surfaces.web.baseUrl, { waitUntil: "domcontentloaded" });
  const port = (await readFile(join(cdpProfile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  cdpAdapter = new ObservedWebAdapter({ cdpUrl: `http://127.0.0.1:${port}`, baseUrl: config.surfaces.web.baseUrl });
  await cdpAdapter.connect();
  assert.equal(cdpAdapter.currentPage().url(), existingPage.url());
  await cdpAdapter.connect();
  assert.equal(existingPage.isClosed(), false, "Reconnecting a CDP client must preserve the application's existing page");
  assert.equal(cdpContext.pages().length, 1, "CDP attachment must not create a replacement application page");
  await cdpAdapter.close();
  assert.equal(await existingPage.title(), "Browser presentation fixture");

  const duplicate = await cdpContext.newPage();
  await duplicate.goto(config.surfaces.web.baseUrl, { waitUntil: "domcontentloaded" });
  await assert.rejects(cdpAdapter.connect(), /matched 2 application pages/);
  assert.equal(existingPage.isClosed(), false, "Failed target selection must not close application pages");
  assert.equal(duplicate.isClosed(), false);
  console.log(JSON.stringify({ status: "passed", headless, checks: ["animation continuity", "focus and window size", "closed-page rejection", "fresh-page reconnect", "previous browser cleanup", "workspace visibility through public inspection", "per-call visibility override", "CDP page preservation", "ambiguous CDP target cleanup"] }));
} finally {
  chromium.launch = originalLaunch;
  await adapter?.close();
  await cdpAdapter?.close();
  await cdpContext?.close();
  await new Promise((resolve) => server.close(resolve));
  if (workspace) {
    if (dirname(resolve(workspace)) !== resolve(tmpdir())) throw new Error("Temporary browser workspace escaped the intended directory");
    await rm(workspace, { recursive: true, force: true });
  }
}
