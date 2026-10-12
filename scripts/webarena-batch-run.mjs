import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { benchmarkProfile, upstreamCommit } from "./webarena-benchmark-lib.mjs";
import { probePilotEnvironment } from "./webarena-environment.mjs";
import { runWebArenaHost } from "./webarena-run-host.mjs";

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMAGE = "sha256:d0531dd27ed98d0c459ff9e88118bf2ed8b660b0ed99c38837db46c065a5be13";
const CONTAINER = "webarena_verified_shopping_admin";
const LOGIN_HEADER = "admin:admin1234"; // Fixed credentials of the isolated upstream image.
const PORTS = { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "7780" }],
  "8877/tcp": [{ HostIp: "127.0.0.1", HostPort: "7781" }] };
const RESET_PROBE = `$config = include '/var/www/magento2/app/etc/env.php'; $db = $config['db']['connection']['default']; $pdo = new PDO('mysql:host=' . $db['host'] . ';dbname=' . $db['dbname'], $db['username'], $db['password']); echo $pdo->query("SELECT COUNT(*) FROM core_config_data WHERE path='proofkit/reset_probe_20261012'")->fetchColumn();`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function within(path, root) {
  const local = relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

export function assertPinnedContainer(info) {
  const ports = info?.HostConfig?.PortBindings;
  const portsMatch = ports && Object.keys(ports).length === Object.keys(PORTS).length &&
    Object.entries(PORTS).every(([port, binding]) => JSON.stringify(ports[port]) === JSON.stringify(binding));
  if (info?.Name !== `/${CONTAINER}` || info?.Image !== IMAGE ||
    !Array.isArray(info.Mounts) || info.Mounts.length !== 0 ||
    info.HostConfig?.Binds !== null ||
    !portsMatch) {
    throw new Error("Refusing to replace an unrecognized benchmark container");
  }
  return info.Id;
}

export async function planBatch(options) {
  if (!["shopping-admin-4", "shopping-admin-12"].includes(options.profile) ||
    !["codex", "claude-code"].includes(options.host) ||
    ![options.batch, options.config, options.upstream, options.python, options.chrome,
      options.root, options.workspaceRoot].every((value) => typeof value === "string" && isAbsolute(value)) ||
    (options.dockerWsl && !/^[A-Za-z0-9_.-]{1,64}$/.test(options.dockerWsl)) ||
    (options.cli && !isAbsolute(options.cli)) ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 900_000) {
    throw new Error("Invalid pinned single-site batch options");
  }
  const profile = benchmarkProfile(options.profile);
  const manifest = JSON.parse(await readFile(join(options.batch, "report.json"), "utf8"));
  const publicBytes = await readFile(join(options.batch, "agent-input", "tasks.json"));
  const tasks = JSON.parse(publicBytes.toString("utf8"));
  if (manifest.benchmark !== profile.benchmark ||
    manifest.provenance?.upstreamCommit !== upstreamCommit ||
    manifest.publicInputSha256 !== sha256(publicBytes) ||
    JSON.stringify(manifest.taskIds) !== JSON.stringify(profile.taskIds) ||
    !Array.isArray(tasks) || JSON.stringify(tasks.map((task) => task.taskId)) !== JSON.stringify(profile.taskIds) ||
    tasks.some((task) => JSON.stringify(task.sites) !== '["shopping_admin"]' ||
      JSON.stringify(task.startUrls) !== '["__SHOPPING_ADMIN__"]')) {
    throw new Error("Prepared batch or projected task identity changed");
  }
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const application = config.environments?.__SHOPPING_ADMIN__?.urls;
  if (JSON.stringify(application) !== '["http://localhost:7780/admin"]' ||
    config.controlUrls?.__SHOPPING_ADMIN__ !== "http://localhost:7781" ||
    Object.keys(config.environments).length !== 1 || Object.keys(config.controlUrls).length !== 1) {
    throw new Error("Batch requires the pinned loopback shopping-admin mapping");
  }
  await access(options.chrome);
  await access(options.python);
  await access(options.root);
  await access(options.workspaceRoot);
  if (options.cli) await access(options.cli);
  const { stdout: head } = await execute("git", ["-C", options.upstream, "rev-parse", "HEAD"],
    { timeout: 15_000, windowsHide: true });
  if (head.trim() !== upstreamCommit) throw new Error("Pinned upstream commit changed");
  await execute("git", ["-C", options.upstream, "diff", "--exit-code", "HEAD", "--"],
    { timeout: 15_000, windowsHide: true });
  const dataset = await readFile(join(options.upstream, "assets", "dataset", "webarena-verified.json"));
  if (sha256(dataset) !== manifest.provenance?.datasetSha256) throw new Error("Pinned upstream dataset changed");
  return { profile, tasks, config, publicInputSha256: manifest.publicInputSha256,
    image: IMAGE, container: CONTAINER };
}

async function docker(options, args, timeout = 30_000) {
  const command = options.dockerWsl ? "wsl.exe" : "docker";
  const prefix = options.dockerWsl ? ["-d", options.dockerWsl, "-e", "docker"] : [];
  return execute(command, [...prefix, ...args], { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function inspectContainer(options) {
  try {
    const result = await docker(options, ["inspect", CONTAINER]);
    const items = JSON.parse(result.stdout);
    if (!Array.isArray(items) || items.length !== 1) throw new Error("Ambiguous benchmark container");
    return items[0];
  } catch (error) {
    if (/No such (object|container)/i.test(String(error.stderr ?? ""))) return undefined;
    throw error;
  }
}

async function verifyBrowser(chrome) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { "X-M2-Admin-Auto-Login": LOGIN_HEADER } });
    const page = await context.newPage();
    await page.goto("http://localhost:7780/admin", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL((url) => url.pathname.startsWith("/admin/admin/dashboard"), { timeout: 15_000 });
    return { status: "dashboard-observed", url: page.url() };
  } finally { await browser.close(); }
}

async function resetSite(options, config) {
  const old = await inspectContainer(options);
  if (old) assertPinnedContainer(old);
  await docker(options, ["image", "inspect", IMAGE, "--format", "{{.Id}}"]).then(({ stdout }) => {
    if (stdout.trim() !== IMAGE) throw new Error("Pinned benchmark image is unavailable");
  });
  if (old) await docker(options, ["rm", "-f", old.Id]);
  await docker(options, ["run", "-d", "--name", CONTAINER,
    "-p", "127.0.0.1:7780:80", "-p", "127.0.0.1:7781:8877", IMAGE]);
  const fresh = await inspectContainer(options);
  const newContainer = assertPinnedContainer(fresh);
  if (old && old.Id === newContainer) throw new Error("Benchmark reset reused the old container");
  const deadline = Date.now() + 120_000;
  let probe;
  do {
    probe = await probePilotEnvironment(config, { sites: ["shopping_admin"], timeoutMs: 5_000 });
    if (probe.status === "reachable") break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  if (probe.status !== "reachable") throw new Error("Rebuilt benchmark site did not become reachable");
  const { stdout: marker } = await docker(options, ["exec", newContainer, "php", "-r", RESET_PROBE]);
  if (marker.trim() !== "0") throw new Error("Benchmark database did not return to the fixed initial marker");
  const browser = await verifyBrowser(options.chrome);
  return { oldContainer: old?.Id ?? null, newContainer, image: IMAGE, mounts: 0,
    markerCount: 0, probe: probe.status, browser, resetAt: new Date().toISOString() };
}

async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }

export async function withSiteLock(dockerInstance, output, action) {
  if (typeof dockerInstance !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(dockerInstance)) {
    throw new Error("Invalid Docker instance lock name");
  }
  const path = join(tmpdir(), `proofkit-shopping-admin-${dockerInstance}-batch.lock`);
  let lock;
  try { lock = await open(path, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another shopping-admin batch owns ${path}; review the owner before removing a stale lock`);
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, output, startedAt: new Date().toISOString() }) + "\n");
    return await action();
  } finally {
    await lock.close();
    await unlink(path);
  }
}

async function gradeBatch(options, output, hostPaths) {
  const grade = join(output, "grade");
  const args = [join(ROOT, "scripts", "webarena-benchmark.mjs"), "grade", "--profile", options.profile,
    "--upstream", options.upstream, "--python", options.python, "--batch", options.batch,
    "--submissions", join(output, "submissions"), "--config", options.config, "--output", grade];
  let gradeExit = 0;
  try { await execute(process.execPath, args, { timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024 }); }
  catch (error) { gradeExit = error.code ?? 1; }
  const gradeReport = join(grade, "report.json");
  try { await access(gradeReport); } catch { return { gradeExit, gradeReport: null, diagnosis: null }; }
  const diagnosis = join(output, "diagnosis");
  const diagnoseArgs = [join(ROOT, "scripts", "webarena-diagnose.mjs"), "--grade", gradeReport,
    ...hostPaths.flatMap((path) => ["--host", path]), "--output", diagnosis];
  try {
    await execute(process.execPath, diagnoseArgs, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { gradeExit, gradeReport, diagnosis: join(diagnosis, "report.json") };
  } catch (error) {
    return { gradeExit, gradeReport, diagnosis: null, diagnosisError: String(error.message).slice(0, 300) };
  }
}

export async function runBatch(options) {
  const plan = await planBatch(options);
  if (!options.output || !isAbsolute(options.output)) throw new Error("Batch output must be a new absolute directory");
  const output = resolve(options.output);
  const parent = await realpath(dirname(output));
  for (const forbiddenPath of [ROOT, options.batch, options.upstream, options.root, options.workspaceRoot]) {
    const forbidden = await realpath(forbiddenPath);
    if (within(output, forbidden) || within(forbidden, output)) throw new Error("Batch output overlaps source or inputs");
  }
  return withSiteLock(options.dockerWsl ?? "local", output, () => executeBatch(options, plan, output, parent));
}

async function executeBatch(options, plan, output, parent) {
  await mkdir(join(parent, basename(output)));
  for (const child of ["operators", "captures", "hosts", "submissions", "resets"]) await mkdir(join(output, child));
  const attempts = [], hostPaths = [];
  let abortedReason = null;
  for (const task of plan.tasks) {
    try {
      const reset = await resetSite(options, plan.config);
      await save(join(output, "resets", `${task.taskId}.json`), reset);
      const operatorPath = join(output, "operators", `${task.taskId}.json`);
      await save(operatorPath, { root: options.root, workspaceRoot: options.workspaceRoot,
        captureDirectory: join(output, "captures", String(task.taskId)), taskId: task.taskId,
        publicInputPath: join(options.batch, "agent-input", "tasks.json"),
        publicInputSha256: plan.publicInputSha256,
        browser: { startUrl: "http://localhost:7780/admin", executablePath: options.chrome,
          headless: true, extraHTTPHeaders: { "X-M2-Admin-Auto-Login": LOGIN_HEADER } } });
      const hostOutput = join(output, "hosts", String(task.taskId));
      const report = await runWebArenaHost({ sessionPath: operatorPath, batchPath: options.batch,
        output: hostOutput, host: options.host, cliPath: options.cli, timeoutMs: options.timeoutMs });
      hostPaths.push(join(hostOutput, "host-run.json"));
      if (report.status === "associated") {
        const source = join(hostOutput, "submissions", String(task.taskId));
        const destination = join(output, "submissions", String(task.taskId));
        await mkdir(destination);
        for (const file of ["agent_response.json", "network.har"]) await copyFile(join(source, file), join(destination, file));
        if (sha256(await readFile(join(destination, "agent_response.json"))) !== report.submission?.responseSha256 ||
          sha256(await readFile(join(destination, "network.har"))) !== report.submission?.traceSha256) {
          throw new Error("Staged benchmark submission changed after host audit");
        }
      }
      attempts.push({ taskId: task.taskId, status: report.status, blocker: report.execution?.blocker ?? null });
      if (report.status === "infrastructure-blocked") {
        abortedReason = `host-infrastructure-blocked:${report.execution?.blocker ?? "unknown"}`;
        break;
      }
    } catch (error) {
      attempts.push({ taskId: task.taskId, status: "batch-blocked", reason: String(error.message).slice(0, 300) });
      abortedReason = "batch-environment-or-admission-blocked";
      break;
    }
  }
  const scoring = await gradeBatch(options, output, hostPaths);
  const official = scoring.gradeReport ? JSON.parse(await readFile(scoring.gradeReport, "utf8")) : undefined;
  const report = { schemaVersion: 1, benchmark: plan.profile.benchmark,
    profile: options.profile, host: options.host, planned: plan.tasks.length, attempted: attempts.length,
    associated: attempts.filter((item) => item.status === "associated").length,
    officialEvaluated: official?.summary?.evaluated ?? null,
    officialSuccess: official?.summary?.evaluated ? official.summary.successful : null,
    abortedReason, attempts, scoring,
    provenance: { upstreamCommit, publicInputSha256: plan.publicInputSha256, image: IMAGE } };
  await save(join(output, "batch-run.json"), report);
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  const names = new Set(["--profile", "--batch", "--config", "--upstream", "--python", "--chrome",
    "--root", "--workspace", "--output", "--host", "--cli", "--docker-wsl", "--timeout-ms"]);
  const values = new Map();
  for (let i = 3; i < process.argv.length; i += 2) {
    if (!names.has(process.argv[i]) || !process.argv[i + 1] || values.has(process.argv[i])) throw new Error("Invalid batch argument");
    values.set(process.argv[i], process.argv[i + 1]);
  }
  if (!["plan", "run"].includes(mode)) throw new Error("Usage: node scripts/webarena-batch-run.mjs <plan|run> --profile shopping-admin-12 --batch <prepared> --config <environment> --upstream <pinned> --python <venv-python> --chrome <chrome.exe> --root <target> --workspace <external-workspace> --output <new-dir> [--host codex|claude-code] [--cli <native-executable>] [--docker-wsl proofkit-docker] [--timeout-ms 600000]");
  const options = { profile: values.get("--profile") ?? "shopping-admin-12", batch: values.get("--batch"),
    config: values.get("--config"), upstream: values.get("--upstream"), python: values.get("--python"),
    chrome: values.get("--chrome"), root: values.get("--root"), workspaceRoot: values.get("--workspace"),
    output: values.get("--output"), host: values.get("--host") ?? "codex", cli: values.get("--cli"),
    dockerWsl: values.get("--docker-wsl"), timeoutMs: Number(values.get("--timeout-ms") ?? 600_000) };
  const result = mode === "plan" ? await planBatch(options) : await runBatch(options);
  process.stdout.write(JSON.stringify(mode === "plan" ? { profile: options.profile,
    planned: result.tasks.length, taskIds: result.profile.taskIds, image: result.image,
    testVerdict: "not-asserted" } : result) + "\n");
  if (mode === "run" && (result.abortedReason || result.officialSuccess !== result.planned)) process.exitCode = 1;
}
