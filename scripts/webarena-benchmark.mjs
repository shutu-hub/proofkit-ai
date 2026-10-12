import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProfileTasks, benchmarkProfile, publicTask, renderScorecard, scorecard, selectTasks, sha256, upstreamCommit } from "./webarena-benchmark-lib.mjs";
import { probePilotEnvironment } from "./webarena-environment.mjs";

const execute = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];
const options = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!["--upstream", "--output", "--python", "--batch", "--submissions", "--config", "--profile", "--docker-wsl"].includes(name)
    || !value || value.startsWith("--") || options.has(name)) throw new Error(`Invalid argument ${name}`);
  options.set(name, value);
}
if (!["prepare", "probe", "replay", "grade"].includes(command)) {
  console.log("Usage: pnpm benchmark:webarena <prepare|probe|replay|grade> --upstream <pinned-checkout> --output <new-external-dir> --python <venv-python>\nProbe requires --config <environment-json>. Grade also requires --batch <prepared-dir> --submissions <dir> --config <environment-json>.");
  process.exit(command ? 1 : 0);
}
const required = (name) => { if (!options.has(name)) throw new Error(`Missing ${name}`); return options.get(name); };
const profile = benchmarkProfile(options.get("--profile") ?? "pilot-12");
const upstream = resolve(required("--upstream"));
const output = resolve(required("--output"));
const python = required("--python");
const git = async (...args) => (await execute("git", ["-C", upstream, ...args], { timeout: 15_000, windowsHide: true })).stdout.trim();
if (await git("rev-parse", "HEAD") !== upstreamCommit) throw new Error("Unexpected upstream commit; review and update the benchmark pin explicitly");
await git("diff", "--exit-code", "HEAD", "--");
const datasetPath = join(upstream, "assets/dataset/webarena-verified.json");
const datasetBytes = await boundedRead(datasetPath, 20 * 1024 * 1024);
const dataset = JSON.parse(datasetBytes.toString("utf8"));
const provenance = { upstreamRepository: "https://github.com/ServiceNow/webarena-verified", upstreamCommit,
  createdAt: new Date().toISOString(),
  controllerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  librarySha256: sha256(await readFile(join(scriptRoot, "webarena-benchmark-lib.mjs"))),
  environmentProbeSha256: sha256(await readFile(join(scriptRoot, "webarena-environment.mjs"))),
  sidecarSha256: sha256(await readFile(join(scriptRoot, "webarena-evaluator.py"))),
  datasetSha256: sha256(datasetBytes), proofkitCommit: (await execute("git", ["rev-parse", "HEAD"], { cwd: join(scriptRoot, "..") })).stdout.trim(),
  proofkitDirty: Boolean((await execute("git", ["status", "--porcelain"], { cwd: join(scriptRoot, "..") })).stdout.trim()) };
// No overwrite or report directory inside the reference checkout/product tree.
for (const forbidden of [upstream, resolve(scriptRoot, "..")]) {
  if (output.toLowerCase() === forbidden.toLowerCase() || output.toLowerCase().startsWith(forbidden.toLowerCase() + "/")
    || output.toLowerCase().startsWith(forbidden.toLowerCase() + "\\")) throw new Error("Use an external benchmark output directory");
}
await mkdir(output); // Existing runs are immutable inputs, never overwritten.

async function sidecar(operation, cases = [], environments = {}) {
  const request = { operation, datasetSha256: provenance.datasetSha256, cases, environments };
  const path = join(output, `request-${operation}.json`);
  await save(path, request);
  try {
    const result = await execute(python, [join(scriptRoot, "webarena-evaluator.py"), "--upstream", upstream, "--request", path], {
      timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    await writeFile(join(output, `evaluator-${operation}.stderr.log`), result.stderr);
    return JSON.parse(result.stdout);
  } catch (error) {
    await writeFile(join(output, `evaluator-${operation}.stderr.log`), String(error.stderr ?? error.message));
    throw error;
  }
}

try {
  const probe = await sidecar("probe");
  if (command === "probe") {
    const configBytes = await boundedRead(resolve(required("--config")), 1024 * 1024);
    const environment = await probePilotEnvironment(JSON.parse(configBytes.toString("utf8")), { sites: profile.sites });
    const report = { schemaVersion: 1, benchmark: profile.benchmark, mode: "environment-probe",
      provenance, configSha256: sha256(configBytes), taskIds: profile.taskIds, environment };
    await save(join(output, "environment-report.json"), report);
    console.log(JSON.stringify({ report: join(output, "environment-report.json"), status: environment.status,
      applicationSitesReachable: environment.applicationSitesReachable, controlsHealthy: environment.controlsHealthy,
      reset: environment.reset, taskExecution: environment.taskExecution }));
    if (environment.status !== "reachable") process.exitCode = 1;
  } else if (command === "prepare") {
    const tasks = selectTasks(dataset, profile.taskIds);
    const taskDesignAudit = auditProfileTasks(dataset, options.get("--profile") ?? "pilot-12");
    const actor = join(output, "agent-input");
    await mkdir(actor);
    await save(join(actor, "tasks.json"), tasks.map(publicTask));
    await save(join(actor, "answer-schema.json"), { type: "object", additionalProperties: false,
      required: ["task_type", "status", "retrieved_data", "error_details"], properties: {
        task_type: { type: "string", enum: ["RETRIEVE", "NAVIGATE", "MUTATE"] },
        status: { type: "string", enum: ["SUCCESS", "ACTION_NOT_ALLOWED_ERROR", "PERMISSION_DENIED_ERROR", "NOT_FOUND_ERROR", "DATA_VALIDATION_ERROR", "UNKNOWN_ERROR"] },
        retrieved_data: { type: ["array", "null"], items: {} }, error_details: { type: ["string", "null"] },
      } });
    let docker;
    const distro = options.get("--docker-wsl");
    if (distro && !/^[A-Za-z0-9_.-]{1,64}$/.test(distro)) throw new Error("Invalid Docker WSL distribution");
    try {
      const r = distro
        ? await execute("wsl.exe", ["-d", distro, "-e", "docker", "info", "--format", "{{.ServerVersion}}"], { timeout: 15_000, windowsHide: true })
        : await execute("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000, windowsHide: true });
      docker = { status: "available", version: r.stdout.trim(), ...(distro ? { wslDistribution: distro } : {}) };
    }
    catch (error) { docker = { status: "blocked", reason: error.code === "ENOENT" ? "docker-not-installed" : "docker-daemon-unavailable" }; }
    const report = { schemaVersion: 1, benchmark: profile.benchmark, provenance, runtime: probe.runtime,
      taskDesignAudit,
      taskIds: profile.taskIds, publicInputSha256: sha256(await readFile(join(actor, "tasks.json"))),
      environment: { docker, liveExecution: "not-started", reset: "not-verified" },
      summary: scorecard("prepared-batch", tasks.length, tasks.map((task) => ({ taskId: task.task_id, status: "not-run" }))),
      cases: tasks.map((task) => ({ taskId: task.task_id, status: "not-run", score: null })) };
    await publish(report);
  } else if (command === "replay") {
    const controls = [];
    const demo = join(upstream, "examples/agent_logs/demo/108");
    const response = join(demo, "agent_response.json");
    const trace = join(demo, "network.har");
    controls.push(await input("demo-retrieve-108", 108, response, trace, "success", "upstream-recording"));
    const wrongPath = join(output, "wrong-108.json");
    const wrong = JSON.parse((await boundedRead(response, 1024 * 1024)).toString("utf8"));
    wrong.retrieved_data[0].count += 1;
    await save(wrongPath, wrong);
    controls.push(await input("wrong-answer-108", 108, wrongPath, trace, "failure", "mutated-upstream-recording"));
    // Upstream demo 107 says NAVIGATE; the pinned dataset now requires RETRIEVE.
    controls.push(await input("stale-demo-107", 107, join(upstream, "examples/agent_logs/demo/107/agent_response.json"),
      join(upstream, "examples/agent_logs/demo/107/network.har"), "failure", "stale-upstream-recording"));
    const empty = join(output, "empty.har");
    await save(empty, { log: { version: "1.2", creator: { name: "negative-control", version: "1" }, entries: [] } });
    controls.push(await input("missing-network-108", 108, response, empty, "error", "synthetic-empty-trace"));
    const navigationResponse = join(output, "navigation-response.json");
    await save(navigationResponse, { task_type: "NAVIGATE", status: "SUCCESS", retrieved_data: null, error_details: null });
    for (const [name, path, status, expectedStatus] of [
      ["navigation-correct-44", "/dashboard/todos", 200, "success"],
      ["navigation-wrong-44", "/dashboard/projects", 200, "failure"],
      ["navigation-http-error-44", "/dashboard/todos", 500, "failure"],
    ]) {
      const harPath = join(output, `${name}.har`);
      // Evaluator calibration only: this is generated HAR, never a live run.
      await save(harPath, { log: { version: "1.2", creator: { name: "synthetic-evaluator-control", version: "1" },
        entries: [{ startedDateTime: "2026-10-12T00:00:00Z", time: 1,
          request: { url: `http://gitlab.benchmark.invalid${path}`, method: "GET", headers: [{ name: "Accept", value: "text/html" }], queryString: [], cookies: [] },
          response: { status, headers: [], cookies: [], redirectURL: "", content: { mimeType: "text/html", text: "测试", size: 6 } },
          cache: {}, timings: { send: 0, wait: 1, receive: 0 } }] } });
      controls.push(await input(name, 44, navigationResponse, harPath, expectedStatus, "synthetic-navigation-trace"));
    }
    const evaluation = await sidecar("evaluate", controls, {
      __SHOPPING_ADMIN__: { urls: ["http://192.168.1.35:7780"] },
      __GITLAB__: { urls: ["http://gitlab.benchmark.invalid"] },
    });
    await save(join(output, "official-results.json"), evaluation);
    const cases = evaluation.results.map(({ caseId, result }) => {
      const control = controls.find((item) => item.caseId === caseId);
      return { caseId, taskId: result.task_id, status: result.status, score: result.score,
        expectedStatus: control.expectedStatus, origin: control.origin,
        controlMatched: result.status === control.expectedStatus && (result.status !== "success" || result.score === 1) };
    });
    const report = { schemaVersion: 1, provenance, runtime: evaluation.runtime,
      summary: scorecard("upstream-replay-controls", controls.length, cases), cases };
    await publish(report);
    if (cases.some((item) => !item.controlMatched)) process.exitCode = 1;
  } else {
    const batch = resolve(required("--batch"));
    const manifest = JSON.parse((await boundedRead(join(batch, "report.json"), 1024 * 1024)).toString("utf8"));
    if (manifest.benchmark !== profile.benchmark || manifest.provenance?.upstreamCommit !== upstreamCommit
      || manifest.provenance?.datasetSha256 !== provenance.datasetSha256
      || JSON.stringify(manifest.taskIds) !== JSON.stringify(profile.taskIds)) throw new Error("Batch provenance or fixed task selection changed");
    const publicBytes = await boundedRead(join(batch, "agent-input/tasks.json"), 1024 * 1024);
    if (sha256(publicBytes) !== manifest.publicInputSha256
      || JSON.stringify(JSON.parse(publicBytes.toString("utf8"))) !== JSON.stringify(selectTasks(dataset, profile.taskIds).map(publicTask))) throw new Error("Public tasks changed");
    const submissions = resolve(required("--submissions"));
    const config = JSON.parse((await boundedRead(resolve(required("--config")), 1024 * 1024)).toString("utf8"));
    const cases = [], inputs = [];
    const snapshots = join(output, "submissions");
    await mkdir(snapshots);
    for (const taskId of profile.taskIds) {
      const root = join(submissions, String(taskId));
      try { inputs.push(await input(String(taskId), taskId, join(root, "agent_response.json"), join(root, "network.har"),
        undefined, undefined, join(snapshots, String(taskId)))); }
      catch (error) { cases.push({ taskId, caseId: String(taskId), status: error.code === "ENOENT" ? "not-run" : "error", score: null, reason: error.code === "ENOENT" ? "missing-response-or-trace" : "invalid-input" }); }
    }
    const evaluation = await sidecar("evaluate", inputs, config.environments ?? {});
    await save(join(output, "official-results.json"), evaluation);
    for (const { caseId, result } of evaluation.results) cases.push({ taskId: result.task_id, caseId, status: result.status, score: result.score });
    cases.sort((a, b) => profile.taskIds.indexOf(a.taskId) - profile.taskIds.indexOf(b.taskId));
    await publish({ schemaVersion: 1, provenance, runtime: evaluation.runtime,
      summary: scorecard("imported-submissions", profile.taskIds.length, cases), cases });
    if (cases.some((item) => item.status !== "success" || item.score !== 1)) process.exitCode = 1;
  }
} catch (error) {
  await save(join(output, "blocked.json"), { status: "blocked", productVerdict: "not-asserted", proofkitEffectiveness: "not-measured", reason: String(error.message).slice(0, 1000), provenance });
  throw error;
}

async function input(caseId, taskId, response, trace, expectedStatus, origin, snapshot) {
  const responseBytes = await boundedRead(response, 1024 * 1024);
  const traceBytes = await boundedRead(trace, 32 * 1024 * 1024);
  if (snapshot) {
    // Judge captured bytes, not a submission path that can change after import.
    // Preserve malformed complete pairs as evidence of the input error too.
    await mkdir(snapshot);
    response = join(snapshot, "agent_response.json");
    trace = join(snapshot, "network.har");
    await writeFile(response, responseBytes, { flag: "wx" });
    await writeFile(trace, traceBytes, { flag: "wx" });
    await save(join(snapshot, "checksums.json"), { responseSha256: sha256(responseBytes), traceSha256: sha256(traceBytes) });
  }
  JSON.parse(responseBytes.toString("utf8"));
  const har = JSON.parse(traceBytes.toString("utf8"));
  if (!Array.isArray(har.log?.entries)) throw new Error("Expected HAR log.entries");
  return { caseId, taskId, response, trace, responseSha256: sha256(responseBytes), traceSha256: sha256(traceBytes), expectedStatus, origin };
}
async function boundedRead(path, limit) {
  const { open } = await import("node:fs/promises");
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const { bytesRead } = await file.read(bytes, size, bytes.length - size, null); if (!bytesRead) break; size += bytesRead; }
    if (size > limit) throw new Error("Benchmark input exceeds byte limit");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
async function publish(report) {
  await save(join(output, "report.json"), report);
  await writeFile(join(output, "report.html"), renderScorecard(report), { flag: "wx" });
  console.log(JSON.stringify({ report: join(output, "report.html"), ...report.summary, environment: report.environment }));
}
