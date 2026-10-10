import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const caseRoot = join(repoRoot, ".proofkit", "local-runner-smoke", `electron-file-route-${Date.now()}`);
const sourceRoot = join(caseRoot, "source");
const workspaceRoot = join(caseRoot, "test-workspace");
const profile = join(caseRoot, "electron-profile");
await mkdir(join(sourceRoot, "dist"), { recursive: true });
await mkdir(join(sourceRoot, "src"), { recursive: true });
await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
await mkdir(profile, { recursive: true });
await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "proofkit-electron-file-route-fixture" }));
await writeFile(join(sourceRoot, "src", "router.ts"),
  "export const resume = { path: '/resumes/:id' };\n");
const htmlPath = join(sourceRoot, "dist", "index.html");
await writeFile(htmlPath, `<!doctype html><title>Electron file route fixture</title><h1 id="state"></h1>
<script>function render(){const route=location.hash?location.hash.slice(1):location.pathname;document.querySelector('#state').textContent=
route.startsWith('/resumes/')?'Resume ready':route==='/login'?'Login ready':'Unknown route'}
addEventListener('hashchange',render);render()</script>`);
const fileUrl = pathToFileURL(htmlPath).href;
const expectedFileSha256 = createHash("sha256").update(`${new URL(fileUrl).host}${new URL(fileUrl).pathname}`).digest("hex");

const server = createServer((request, response) => {
  if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
  if (request.url === "/resumes/123") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><link rel="icon" href="data:,"><title>Web route fixture</title><h1>Resume ready</h1>`);
    return;
  }
  if (request.url === "/resume/status" || request.url === "/login/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "SUCCESS", data: { state: "done" } }));
  } else response.writeHead(404).end();
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const oracleOrigin = `http://127.0.0.1:${server.address().port}`;

let electron;
try {
  const appPath = join(profile, "app.cjs");
  await writeFile(appPath, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});
app.commandLine.appendSwitch('remote-debugging-port','0');
app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
window.loadFile(${JSON.stringify(htmlPath)},{hash:'/resumes/123'});});
app.on('window-all-closed',()=>app.quit());`);
  const executable = process.env.PROOFKIT_ELECTRON_PATH
    ?? resolve(repoRoot, "../Python/AIHR-Microservices/node_modules/.pnpm/electron@28.3.3/node_modules/electron/dist/electron.exe");
  electron = spawn(executable, [appPath, "--no-sandbox", "--disable-gpu"], { stdio: "ignore", windowsHide: true });
  let spawnError;
  electron.on("error", (error) => { spawnError = error; });
  const portFile = join(profile, "DevToolsActivePort");
  await waitForDevtools(portFile, () => spawnError ?? (electron.exitCode === null ? undefined : new Error("Electron exited before CDP was ready")));

  const charters = ["resume", "resume-copy"].map((id) => ({
    id, path: `.proofkit/charters/${id}.yml`, aliases: [id], level: "release", surfaces: ["web", "electron"],
    routeTargets: [{ kind: "web", path: "/resumes/:id", source: "src/router.ts" }],
  }));
  const config = ProofkitConfigSchema.parse({
    project: { root: sourceRoot },
    surfaces: {
      web: { baseUrl: `${oracleOrigin}/resumes/123`, executablePath: process.env.PROOFKIT_BROWSER_PATH
        ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) },
      electron: { devtoolsActivePort: portFile, targetUrlPrefix: fileUrl },
    },
    charters,
    suites: [{ id: "file-routes", aliases: ["Electron file route regression"], level: "release",
      charterIds: ["resume", "resume-copy"], surfaces: ["web", "electron"] }],
    oracles: ["resume", "resume-copy"].map((id) => ({ name: `${id}-state`, url: `${oracleOrigin}/resume/status`,
      statusPointer: "/data/state", successValues: ["done"] })),
    run: { timeoutMs: 15_000 },
  });
  await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), JSON.stringify(config));
  for (const id of ["resume", "resume-copy"]) {
    const charter = TestCharterSchema.parse({ intent: `check ${id} file route`, level: "release", mode: "deterministic",
      preconditions: [], actions: [{ kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Resume ready" }],
      oracles: [`${id}-state`], sideEffectPolicy: "deny", metadata: {} });
    await writeFile(join(workspaceRoot, ".proofkit", "charters", `${id}.yml`), JSON.stringify(charter));
  }

  const service = await LocalRunnerService.create({ root: sourceRoot, workspaceRoot });
  const mission = await service.createMission({ intent: "Electron file route regression", surface: "electron", suiteId: "file-routes" });
  await service.startMission(mission.missionId, { approve: true });
  const completed = await service.waitMission(mission.missionId);
  const evidence = await service.missionEvidence(mission.missionId);
  assert.equal(completed.verdict, "passed", JSON.stringify(completed.findings));
  assert.equal(evidence.suiteScope?.routeCoverage?.observedCandidates, 1, JSON.stringify(evidence.suiteScope?.routeCoverage));
  const runs = completed.observations.filter((item) => item.kind === "surface.run" && item.data.runKind !== "negative");
  assert.equal(runs.length, 8);
  for (const item of runs) {
    const expected = "/resumes/:id";
    assert.deepEqual(item.data.matchedRoutePaths, [expected]);
    const summary = await service.wait(item.data.runId);
    assert.equal(summary.verdict, "passed");
    const runText = await readFile(join(workspaceRoot, ".proofkit", "runs", summary.runId, "run.json"), "utf8");
    const eventText = await readFile(join(workspaceRoot, ".proofkit", "runs", summary.runId, "events.jsonl"), "utf8");
    assert.ok(!`${runText}\n${eventText}`.includes(fileUrl));
    assert.ok(!`${runText}\n${eventText}`.includes("/resumes/123"));
    assert.ok(summary.steps.some((step) => step.afterSnapshot?.metadata.matchedRoutePaths?.includes(expected)));
    assert.ok(summary.steps.every((step) => !step.afterSnapshot?.url?.includes("#")));
    const snapshots = summary.steps.flatMap((step) => [step.beforeSnapshot, step.afterSnapshot].filter(Boolean));
    if (item.data.surface === "electron") {
      assert.ok(snapshots.every((snapshot) => snapshot.url === "file:[PATH REDACTED]"));
      assert.ok(snapshots.every((snapshot) => snapshot.metadata.fileDocumentSha256 === expectedFileSha256));
      assert.ok(!JSON.stringify(snapshots).includes(fileUrl));
    } else {
      assert.ok(snapshots.every((snapshot) => snapshot.url === `${oracleOrigin}/resumes/:id`));
      assert.ok(!JSON.stringify(snapshots).includes("/resumes/123"));
    }
  }
  assert.ok(!JSON.stringify(runs.map((item) => item.data.matchedRoutePaths)).includes("/resumes/123"));
  console.log(JSON.stringify({ missionId: mission.missionId, verdict: completed.verdict,
    observedRoutes: evidence.suiteScope.routeCoverage.observedCandidates, runs: runs.length, workspaceRoot }));
} finally {
  electron?.kill();
  server.close();
}

async function waitForDevtools(path, problem) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (problem()) throw problem();
    try {
      const port = Number((await readFile(path, "utf8")).split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      }
    } catch { /* Electron is still starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Timed out waiting for Electron DevToolsActivePort");
}
