/** Independent scripted evaluator calibration. Never counted as an Agent benchmark. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { planBatch, resetSite, withSiteLock } from "./webarena-batch-run.mjs";
import { sha256, upstreamCommit } from "./webarena-benchmark-lib.mjs";
import { summarizeOfficialChecks } from "./webarena-diagnose.mjs";

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTROLS = [
  { taskId: 679, polarity: "positive", type: "NAVIGATE" },
  { taskId: 679, polarity: "negative", type: "NAVIGATE" },
  { taskId: 453, polarity: "positive", type: "MUTATE" },
  { taskId: 453, polarity: "negative", type: "MUTATE" },
];
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function assertExternalOutput(output, forbidden) {
  if (!isAbsolute(output)) throw new Error("Use an absolute new calibration directory");
  const normalized = resolve(output).toLowerCase();
  for (const root of forbidden) {
    const local = relative(resolve(root).toLowerCase(), normalized);
    if (!local || (!local.startsWith("..") && !isAbsolute(local))) {
      throw new Error("Calibration output must be outside product, target and upstream trees");
    }
  }
}

async function menu(page, name, href) {
  await page.waitForLoadState("networkidle");
  await page.locator("#nav").getByRole("link", { name: new RegExp(`${name}$`) }).click();
  await page.locator(`#nav a[href*="${href}"]`).click();
  await page.waitForLoadState("networkidle");
}

async function orders(page, positive) {
  await menu(page, "Sales", "/sales/order/");
  await page.locator('button[data-action="grid-filter-expand"]:visible').click();
  const status = page.locator('select[name="status"]:visible');
  const statusHandle = await status.elementHandle();
  const initialBlank = await status.inputValue() === "";
  assert.ok(initialBlank, "Fresh orders filter must be blank");
  if (positive) {
    await status.selectOption({ label: "Complete" });
    await page.getByRole("button", { name: "Apply Filters", exact: true }).click();
    // Wait for the application to finish its actual render request, then check visible rows.
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => {
      const header = [...document.querySelectorAll("th")].find(e => e.textContent.trim() === "Status" && e.getBoundingClientRect().width > 0);
      const table = header?.closest("table");
      const rows = table ? [...table.querySelectorAll("tbody tr")].filter(r => r.cells.length > header.cellIndex) : [];
      return rows.length > 0 && rows.every(r => r.cells[header.cellIndex].textContent.trim() === "Complete");
    });
  }
  const facts = await page.evaluate(() => {
    const header = [...document.querySelectorAll("th")].find(e => e.textContent.trim() === "Status" && e.getBoundingClientRect().width > 0);
    const table = header?.closest("table");
    const rows = table ? [...table.querySelectorAll("tbody tr")].filter(r => r.cells.length > header.cellIndex) : [];
    return { statusColumnPresent: !!header, visibleRows: rows.length,
      allVisibleRowsComplete: rows.length > 0 && rows.every(r => r.cells[header.cellIndex].textContent.trim() === "Complete") };
  });
  // Applying the filter closes its panel; keep the original live control identity when reading it back.
  facts.selectedComplete = await statusHandle.evaluate(e => e.isConnected && e.value === "complete");
  assert.ok(facts.statusColumnPresent && facts.visibleRows > 0, "Orders must expose actual rows");
  assert.equal(facts.selectedComplete, positive);
  if (positive) assert.ok(facts.allVisibleRowsComplete);
  else assert.equal(facts.allVisibleRowsComplete, false, "Negative control must differ in business state");
  return { initialBlank, ...facts, mutationPerformed: false };
}

async function databaseProductStatus(options, container, productId) {
  assert.match(productId, /^\d+$/);
  const php = `$config = include '/var/www/magento2/app/etc/env.php'; $db = $config['db']['connection']['default']; $pdo = new PDO('mysql:host=' . $db['host'] . ';dbname=' . $db['dbname'], $db['username'], $db['password']); $rows = $pdo->query("SELECT v.value FROM catalog_product_entity_int v JOIN eav_attribute a ON a.attribute_id=v.attribute_id WHERE a.attribute_code='status' AND v.entity_id=${productId} AND v.store_id=0")->fetchAll(PDO::FETCH_COLUMN); echo json_encode($rows);`;
  const command = options.dockerWsl ? "wsl.exe" : "docker";
  const prefix = options.dockerWsl ? ["-d", options.dockerWsl, "-e", "docker"] : [];
  const { stdout } = await execute(command, [...prefix, "exec", container, "php", "-r", php],
    { timeout: 30_000, maxBuffer: 1024, windowsHide: true });
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 1, "Independent database read must identify exactly one store status");
  assert.ok([1, 2].includes(Number(rows[0])));
  return { independentlyEnabled: Number(rows[0]) === 1 };
}

async function product(page, positive, options, reset) {
  await menu(page, "Catalog", "/catalog/product/");
  const name = "Teton Pullover Hoodie"; // Public task and visible UI, never evaluator expected data.
  const search = page.getByRole("textbox", { name: "Search by keyword", exact: true });
  await search.fill(name);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.locator("tr").filter({ has: page.getByText(name, { exact: true }) });
  await row.waitFor();
  assert.equal(await row.count(), 1, "Select exact parent product, excluding variants");
  const edit = row.locator('a[href*="/catalog/product/edit/"]');
  const href = await edit.getAttribute("href");
  const productId = new URL(href, page.url()).pathname.match(/\/id\/(\d+)\//)?.[1];
  assert.ok(productId, "Product identity must come from the live UI");
  await edit.click();
  await page.waitForLoadState("networkidle");
  const status = page.locator('input[name="product[status]"]');
  assert.equal(await status.isChecked(), true, "Fresh product must be enabled");
  assert.equal((await databaseProductStatus(options, reset.newContainer, productId)).independentlyEnabled, true);
  if (positive) {
    // Magento renders a label over the checkbox. Activate its explicit native association through the UI.
    // The field caption and toggle are both associated labels. Select only the actual covering label.
    await status.scrollIntoViewIfNeeded();
    const covering = await status.evaluateHandle(e => {
      const rect = e.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const matches = [...e.labels].filter(l => l.control === e && (l === hit || l.contains(hit)));
      return matches.length === 1 ? matches[0] : null;
    });
    try {
      const toggle = covering.asElement();
      assert.ok(toggle, "Exactly one native associated label must cover the input click point");
      await toggle.click();
    } finally { await covering.dispose(); }
    assert.equal(await status.isChecked(), false);
    await page.locator("#save-button").click();
    await page.waitForLoadState("networkidle");
  }
  // A fresh document and database read distinguish a local checkbox from persisted state.
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await status.isChecked(), !positive);
  const independent = await databaseProductStatus(options, reset.newContainer, productId);
  assert.equal(independent.independentlyEnabled, !positive);
  return { exactParentMatched: true, initialEnabled: true, reloadedEnabled: await status.isChecked(),
    ...independent, mutationPerformed: positive };
}

export async function runLiveControls(options) {
  assertExternalOutput(options.output, [ROOT, options.root, options.workspaceRoot, options.upstream, options.batch]);
  const plan = await planBatch(options);
  assert.ok(CONTROLS.every(c => plan.tasks.some(t => t.taskId === c.taskId)), "Prepared development tasks are required");
  await mkdir(options.output); // No overwrite: all runs are immutable.
  const sourceHashes = Object.fromEntries(await Promise.all([
    "scripts/webarena-live-controls.mjs", "scripts/webarena-batch-run.mjs", "scripts/webarena-evaluator.py",
  ].map(async path => [path, sha256(await readFile(join(ROOT, path)))])));
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true })).stdout.trim();
  const dirty = Boolean((await execute("git", ["status", "--porcelain"], { cwd: ROOT, windowsHide: true })).stdout.trim());
  const manifest = JSON.parse(await readFile(join(options.batch, "report.json"), "utf8"));
  const results = [];
  await withSiteLock(options.dockerWsl ?? "local", options.output, async () => {
    for (const control of CONTROLS) {
      const caseId = `${control.taskId}-${control.polarity}`;
      const path = join(options.output, caseId);
      await mkdir(path);
      const reset = await resetSite(options, plan.config);
      await save(join(path, "reset.json"), reset);
      const trace = join(path, "network.har");
      const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
      let facts, context, page, executionFailed = false;
      try {
        context = await browser.newContext({ extraHTTPHeaders: { "X-M2-Admin-Auto-Login": "admin:admin1234" },
          recordHar: { path: trace, mode: "full", content: "embed" } });
        page = await context.newPage();
        await page.goto("http://localhost:7780/admin", { waitUntil: "networkidle" });
        facts = control.taskId === 679 ? await orders(page, control.polarity === "positive")
          : await product(page, control.polarity === "positive", options, reset);
        await page.screenshot({ path: join(path, "final.png"), fullPage: false });
      } catch (error) {
        await save(join(path, "execution-error.json"), { stage: "live-ui-control", name: error.name, message: error.message });
        if (page && !page.isClosed()) await page.screenshot({ path: join(path, "failure.png") }).catch(() => {});
        executionFailed = true;
      } finally {
        try { await context?.close(); } // Flush even a failed control's real HAR.
        finally { await browser.close(); }
      }
      if (executionFailed) {
        const result = { ...control, caseId, status: "execution-failed", score: null, controlMatched: false,
          evidence: { traceSha256: sha256(await readFile(trace)),
            errorSha256: sha256(await readFile(join(path, "execution-error.json"))) } };
        results.push(result);
        await save(join(path, "summary.json"), result);
        process.stdout.write(JSON.stringify({ caseId, status: result.status, controlMatched: false }) + "\n");
        continue;
      }
      await save(join(path, "facts.json"), facts);
      const response = join(path, "agent_response.json");
      // Negative control intentionally claims success without performing the required business change.
      await save(response, { task_type: control.type, status: "SUCCESS", retrieved_data: null, error_details: null });
      const pair = { caseId: String(control.taskId), taskId: control.taskId, response, trace,
        responseSha256: sha256(await readFile(response)), traceSha256: sha256(await readFile(trace)) };
      const request = join(path, "request.json");
      await save(request, { operation: "evaluate", datasetSha256: manifest.provenance.datasetSha256,
        environments: plan.config.environments, cases: [pair] });
      let evaluated;
      try {
        evaluated = await execute(options.python, [join(ROOT, "scripts/webarena-evaluator.py"),
          "--upstream", options.upstream, "--request", request], { windowsHide: true, timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
      } catch (error) {
        await writeFile(join(path, "evaluator-error.stdout.log"), String(error.stdout ?? ""), { flag: "wx" });
        await writeFile(join(path, "evaluator-error.stderr.log"), String(error.stderr ?? ""), { flag: "wx" });
        throw new Error(`Official evaluator ${caseId} failed; diagnostics retained in the trusted directory`);
      }
      // Full expected/actual evaluator details stay in the trusted directory, never stdout or HTML.
      await writeFile(join(path, "official-results.json"), evaluated.stdout, { flag: "wx" });
      await writeFile(join(path, "evaluator.stderr.log"), evaluated.stderr, { flag: "wx" });
      const official = JSON.parse(evaluated.stdout);
      const result = official.results[0].result;
      const grade = { cases: [{ taskId: control.taskId, status: result.status, score: result.score }] };
      const checks = summarizeOfficialChecks(official, grade).get(control.taskId);
      const passed = result.status === "success" && result.score === 1;
      const controlMatched = control.polarity === "positive" ? passed : result.status === "failure" && result.score === 0;
      assert.equal(pair.responseSha256, sha256(await readFile(response)));
      assert.equal(pair.traceSha256, sha256(await readFile(trace)));
      results.push({ ...control, caseId, status: result.status, score: result.score, controlMatched, checks,
        evidence: { responseSha256: pair.responseSha256, traceSha256: pair.traceSha256,
          factsSha256: sha256(await readFile(join(path, "facts.json"))),
          screenshotSha256: sha256(await readFile(join(path, "final.png"))) } });
      await save(join(path, "summary.json"), results.at(-1));
      process.stdout.write(JSON.stringify({ caseId, status: result.status, controlMatched, checks }) + "\n");
    }
  });
  const report = { schemaVersion: 1, mode: "independent-live-ui-evaluator-calibration", agentAttempted: 0,
    agentTaskSuccessRate: null, controls: results.length, matched: results.filter(r => r.controlMatched).length,
    provenance: { upstreamCommit, datasetSha256: manifest.provenance.datasetSha256, image: plan.image,
      proofkitCommit: head, proofkitDirty: dirty, sourceHashes, createdAt: new Date().toISOString() }, cases: results };
  await save(join(options.output, "report.json"), report);
  await writeFile(join(options.output, "report.html"), `<!doctype html><meta charset="utf-8"><title>真实 UI 评判校准</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto}td,th{padding:12px;border-bottom:1px solid #ddd}</style><h1>真实 UI 评判校准：${report.matched}/${report.controls}</h1><p>独立脚本控制组；AI 执行次数 0，未产生 Agent 成绩。每项重建初态，保存真实 HAR、截图和独立状态。</p><table><tr><th>题号</th><th>控制</th><th>官方结果</th><th>符合预期</th></tr>${results.map(r => `<tr><td>${r.taskId}</td><td>${r.polarity}</td><td>${r.status}</td><td>${r.controlMatched}</td></tr>`).join("")}</table>`, { flag: "wx" });
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[2];
  if (!path || !isAbsolute(path) || process.argv.length !== 3) throw new Error("Usage: node scripts/webarena-live-controls.mjs <absolute-options.json>");
  try {
    const report = await runLiveControls(JSON.parse(await readFile(path, "utf8")));
    if (report.matched !== report.controls) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
