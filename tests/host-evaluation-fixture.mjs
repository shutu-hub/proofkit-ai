import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { setupAgent } from "../packages/cli/dist/agent-setup.js";
import { hash } from "./host-evaluation-verifier.mjs";

export const hostCases = [
  { id: "core-pass", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete" },
  { id: "core-defect", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true },
  { id: "core-pending", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "inconclusive", state: "pending" },
  { id: "project-gap", prompt: "测试整个项目的所有功能", surface: "web", level: "core", coverage: "project", verdict: "not-asserted", state: "complete" },
  { id: "quick-pass", prompt: "快速测试简历获取页面", surface: "web", level: "quick", coverage: "declared", verdict: "passed", state: "complete" },
  { id: "author-core", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete", noCatalog: true },
  { id: "electron-core-pass", prompt: "测试 Electron 桌面端的简历获取功能", surface: "electron", level: "core", coverage: "declared", verdict: "passed", state: "complete", optional: true },
  { id: "electron-core-defect", prompt: "测试 Electron 桌面端的简历获取功能", surface: "electron", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true, optional: true },
];

/** Synthetic business facts exercise host behavior without real accounts, data or billable work. */
export async function createHostFixture(root, expected) {
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const harness = join(root, "harness");
  await Promise.all([mkdir(source, { recursive: true }), mkdir(harness, { recursive: true }), mkdir(join(workspace, ".proofkit", "charters"), { recursive: true })]);
  const sourceFiles = {
    "package.json": JSON.stringify({ name: "proofkit-host-evaluation-fixture", devDependencies: { vite: "1" } }),
    "resume-page.js": "// Synthetic contract: current resume file 101 belongs to job 7; worker must reach complete.\nexport const route = { path: '/resumes', title: 'Resume ready' };\n",
  };
  await Promise.all(Object.entries(sourceFiles).map(([path, content]) => writeFile(join(source, path), content)));
  const http = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/v1/resumes/101") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SUCCESS", data: { fileId: "101", jobId: expected.wrongRelation ? "9" : "7", state: expected.state } }));
    } else if (url.pathname === "/" || url.pathname === "/resumes") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Resume intake</title><h1>Resume ready</h1><p>Submission accepted</p>");
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  let electron;
  try {
    const surface = expected.surface ?? "web";
    let devtoolsActivePort;
    if (surface === "electron") {
      const executable = process.env.PROOFKIT_ELECTRON_PATH;
      if (!executable) throw new Error("Set PROOFKIT_ELECTRON_PATH for Electron host cases");
      const profile = join(harness, "electron-profile");
      await mkdir(profile, { recursive: true });
      const appPath = join(harness, "electron-app.cjs");
      await writeFile(appPath, `const {app,BrowserWindow}=require('electron');
        app.setPath('userData',${JSON.stringify(profile)});
        app.commandLine.appendSwitch('remote-debugging-port','0');
        let window;app.whenReady().then(()=>{window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(`${origin}/resumes`)});});
        app.on('window-all-closed',()=>app.quit());`);
      electron = spawn(executable, [appPath], { windowsHide: true, stdio: "ignore" });
      let spawnError;
      electron.on("error", (error) => { spawnError = error; });
      devtoolsActivePort = join(profile, "DevToolsActivePort");
      await waitForDevtools(devtoolsActivePort, () => spawnError ??
        (electron.exitCode === null ? undefined : new Error("Electron exited before CDP was ready")));
    }
    const plan = (level) => TestCharterSchema.parse({ intent: "测试简历获取功能", level, sideEffectPolicy: "deny",
      actions: [{ kind: "goto", url: `${origin}/resumes` }, { kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Resume ready" }], ...(level === "core" ? { oracles: ["resume.terminal"] } : {}) });
    const charters = expected.noCatalog ? [] : ["core", "quick"].map((level) => ({ id: `resume-${level}`, path: `.proofkit/charters/resume-${level}.yml`,
      aliases: ["简历获取", "简历"], level, surfaces: [surface], routeTargets: [{ kind: "web", path: "/resumes", source: "resume-page.js" }] }));
    const config = ProofkitConfigSchema.parse({ project: { root: source }, surfaces: { web: { baseUrl: origin,
      ...(process.env.PROOFKIT_BROWSER_PATH ? { executablePath: process.env.PROOFKIT_BROWSER_PATH }
        : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) },
      ...(devtoolsActivePort ? { electron: { devtoolsActivePort } } : {}) },
      integration: { path: ".proofkit/integration.mjs" }, policies: { environment: "test", sideEffects: "deny" }, charters, run: { timeoutMs: 15_000 } });
    await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
    for (const level of ["core", "quick"]) await writeFile(join(workspace, ".proofkit", "charters", `resume-${level}.yml`), JSON.stringify(plan(level)));
    await writeFile(join(workspace, ".proofkit", "integration.mjs"), `export default { name: 'host-evaluation-fixture', version: '1.0.0', oracles: [{
      name: 'resume.terminal', async check(context) {
        const response = await fetch(${JSON.stringify(origin + "/api/v1/resumes/101")}, {signal: context.signal});
        const data = (await response.json()).data;
        const identity = data.fileId === '101' && data.jobId === '7';
        const passed = !identity ? false : data.state === 'complete' ? true : null;
        return { name: 'resume.terminal', passed,
          message: !identity ? 'Current resume belongs to the wrong job' : passed ? 'Current resume reached terminal success' : 'Worker terminal state has not been observed',
          evidence: [JSON.stringify({ expected: {fileId:'101',jobId:'7',state:'complete'}, observed:data })], observedAt: new Date().toISOString() };
      }
    }] };`);
    const setup = await setupAgent({ root: source, workspaceRoot: workspace, harness: "codex", installSkill: true, skillsDir: join(harness, ".agents", "skills") });
    return { root, source, workspace, harness, setup,
      async sourceUnchanged() {
        const paths = await readdir(source);
        return paths.length === Object.keys(sourceFiles).length && (await Promise.all(Object.entries(sourceFiles).map(async ([path, content]) => hash(await readFile(join(source, path))) === hash(content)))).every(Boolean);
      },
      async close() { await stopElectron(electron); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); },
    };
  } catch (error) { await stopElectron(electron); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); throw error; }
}

async function waitForDevtools(path, error) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (error()) throw error();
    try {
      const port = (await readFile(path, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* Electron is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated Electron CDP did not become ready");
}

async function stopElectron(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  if (await waitForExit(child, 5_000)) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { /* report the owned Electron process if it survives */ });
    if (await waitForExit(child, 5_000)) return;
  }
  throw new Error(`Isolated Electron process ${child.pid} did not stop`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}
