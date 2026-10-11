import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { setupAgent } from "../packages/cli/dist/agent-setup.js";
import { hash } from "./host-evaluation-verifier.mjs";

export const hostCases = [
  { id: "core-pass", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete", omitSurfaceInScriptedBaseline: true },
  { id: "core-defect", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true },
  { id: "core-pending", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "inconclusive", state: "pending" },
  { id: "project-gap", prompt: "测试整个项目的所有功能", surface: "web", level: "core", coverage: "project", verdict: "not-asserted", state: "complete" },
  { id: "quick-pass", prompt: "快速测试简历获取页面", surface: "web", level: "quick", coverage: "declared", verdict: "passed", state: "complete" },
  { id: "author-core", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete", noCatalog: true },
  { id: "candidate-core", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete",
    noCatalog: true, candidatePath: ".proofkit/charters/resume-core.yml", optional: true },
  { id: "candidate-core-defect", prompt: "测试简历获取功能", surface: "web", level: "core", coverage: "declared", verdict: "failed", state: "complete",
    noCatalog: true, candidatePath: ".proofkit/charters/resume-core.yml", wrongRelation: true, optional: true },
  { id: "candidate-electron-defect", prompt: "测试 Electron 桌面端的简历获取功能", surface: "electron", level: "core", coverage: "declared", verdict: "failed", state: "complete",
    noCatalog: true, candidatePath: ".proofkit/charters/resume-core.yml", wrongRelation: true, optional: true },
  { id: "inline-core-pass", prompt: "测试简历获取功能，并用项目的只读状态接口核对本次文件 ID 和处理终态", surface: "web", level: "core", coverage: "declared", verdict: "passed", state: "complete", noCatalog: true, noReader: true, optional: true },
  { id: "inline-core-defect", prompt: "测试简历获取功能，并用项目的只读状态接口核对本次文件 ID 和处理终态", surface: "web", level: "core", coverage: "declared", verdict: "failed", state: "complete", noCatalog: true, noReader: true, wrongIdentity: true, optional: true },
  { id: "electron-core-pass", prompt: "测试 Electron 桌面端的简历获取功能", surface: "electron", level: "core", coverage: "declared", verdict: "passed", state: "complete", optional: true, omitSurfaceInScriptedBaseline: true },
  { id: "electron-core-defect", prompt: "测试 Electron 桌面端的简历获取功能", surface: "electron", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true, optional: true },
  { id: "inline-electron-pass", prompt: "测试 Electron 桌面端简历获取功能，并用项目的只读状态接口核对本次文件 ID 和处理终态", surface: "electron", level: "core", coverage: "declared", verdict: "passed", state: "complete", noCatalog: true, noReader: true, optional: true, omitSurfaceInScriptedBaseline: true },
  { id: "inline-electron-defect", prompt: "测试 Electron 桌面端简历获取功能，并用项目的只读状态接口核对本次文件 ID 和处理终态", surface: "electron", level: "core", coverage: "declared", verdict: "failed", state: "complete", noCatalog: true, noReader: true, wrongIdentity: true, optional: true },
  { id: "mobile-quick-pass", prompt: "快速测试移动端简历获取页面", surface: "mobile", level: "quick", coverage: "declared", verdict: "passed", state: "complete", optional: true },
  { id: "mobile-core-pass", prompt: "测试移动端简历获取功能", surface: "mobile", level: "core", coverage: "declared", verdict: "passed", state: "complete", optional: true },
  { id: "mobile-core-defect", prompt: "测试移动端简历获取功能", surface: "mobile", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true, optional: true },
];

/** Synthetic business facts exercise host behavior without real accounts, data or billable work. */
export async function createHostFixture(root, expected, agentHarness = "codex") {
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const harness = join(root, "harness");
  await Promise.all([mkdir(source, { recursive: true }), mkdir(harness, { recursive: true }), mkdir(join(workspace, ".proofkit", "charters"), { recursive: true })]);
  const sourceFiles = {
    "package.json": JSON.stringify({ name: "proofkit-host-evaluation-fixture", devDependencies: { vite: "1" } }),
    "resume-page.js": `// A new submission returns its file ID; an older successful file must not satisfy this action.
export const route = { path: '/resumes', title: 'Resume ready' };
export async function acquireResume() {
  const response = await fetch('/api/v1/resumes', { method: 'POST' });
  if (!response.ok) throw new Error('Resume acquisition request failed');
  return (await response.json()).data;
}
`,
    "resume-api.js": `// Independent reader contracts for the resume workflow.
// POST /api/v1/resumes returns { code: 'SUCCESS', data: { fileId: string, jobId: string } }.
// GET /api/v1/resumes/:fileId returns { code: 'SUCCESS', data: { fileId: string, jobId: string, state: 'pending'|'complete'|'failed' } }.
// The returned fileId and jobId must equal the current POST response; jobId '7' is the requested job.
// GET /api/v1/resume-status?fileId=<the fileId returned by POST /api/v1/resumes>
// Response: { code: 'SUCCESS', data: { fileId: string, state: 'pending'|'complete'|'failed' } }
// The response's data.fileId must equal the current POST response fileId.
export const resumeStatusRoute = '/api/v1/resume-status';
`,
  };
  await Promise.all(Object.entries(sourceFiles).map(([path, content]) => writeFile(join(source, path), content)));
  const records = new Map([["101", { fileId: "101", jobId: "7", state: "complete" }]]);
  let nextId = 101;
  const mobileSessions = new Map();
  let nextMobileSession = 0;
  const http = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (expected.surface === "mobile" && url.pathname.startsWith("/wd/")) {
      const send = (value, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ value }));
      };
      if (url.pathname === "/wd/status" && request.method === "GET") return send({ ready: true });
      if (url.pathname === "/wd/session" && request.method === "POST") {
        request.resume();
        const sessionId = `host-mobile-${++nextMobileSession}`;
        mobileSessions.set(sessionId, { fileId: null });
        return send({ sessionId, capabilities: { platformName: "Android" } });
      }
      const match = url.pathname.match(/^\/wd\/session\/([^/]+)(?:\/(.*))?$/);
      if (!match || !mobileSessions.has(match[1])) return send({ error: "invalid session id" }, 404);
      const session = mobileSessions.get(match[1]);
      if (!match[2] && request.method === "DELETE") { mobileSessions.delete(match[1]); return send(null); }
      if (match[2] === "source") return send(`<hierarchy><node text="Resume ready" displayed="true"/>`
        + `<node text="Acquire resume" displayed="true"/>`
        + (session.fileId ? `<node text="Submission accepted #${session.fileId}" displayed="true"/>` : "") + "</hierarchy>");
      if (match[2] === "url") return send("app://proofkit/resumes");
      if (match[2] === "title") return send("Resume intake");
      if (match[2] === "screenshot") return send("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6px8AAAAASUVORK5CYII=");
      if (match[2] === "elements" && request.method === "POST") {
        void (async () => {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 4096) throw new Error("Mobile locator exceeded fixture limit");
          }
          const locator = JSON.parse(body);
          const element = locator.using === "accessibility id" && locator.value === "Acquire resume" ? "acquire-button"
            : locator.using === "xpath" && locator.value.includes('"Resume ready"') ? "ready-label"
              : locator.using === "xpath" && locator.value.includes('"Submission accepted"') && session.fileId
                ? "submitted-label" : null;
          return send(element ? [{ "element-6066-11e4-a52e-4f735466cecf": element }] : []);
        })().catch(() => send({ error: "invalid argument" }, 400));
        return;
      }
      if (["element/ready-label/displayed", "element/acquire-button/displayed"].includes(match[2])) return send(true);
      if (match[2] === "element/submitted-label/displayed") return send(Boolean(session.fileId));
      if (match[2] === "element/acquire-button/click" && request.method === "POST") {
        request.resume();
        const fileId = String(++nextId);
        records.set(fileId, { fileId, jobId: expected.wrongRelation ? "9" : "7", state: "complete" });
        session.fileId = fileId;
        return send(null);
      }
      return send({ error: "unknown command" }, 404);
    }
    if (request.method === "GET" && url.pathname === "/resume-page.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(sourceFiles["resume-page.js"]);
    } else if (request.method === "POST" && url.pathname === "/api/v1/resumes") {
      const fileId = String(++nextId);
      records.set(fileId, { fileId, jobId: expected.wrongRelation ? "9" : "7", state: expected.state });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SUCCESS", data: { fileId, jobId: "7" } }));
    } else if (request.method === "GET" && url.pathname === "/api/v1/resume-status") {
      const fileId = url.searchParams.get("fileId");
      const record = records.get(expected.wrongIdentity ? "101" : fileId);
      if (!record) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SUCCESS", data: { fileId: record.fileId, state: record.state } }));
    } else if (request.method === "GET" && /^\/api\/v1\/resumes\/[1-9]\d*$/.test(url.pathname)) {
      const record = records.get(url.pathname.split("/").at(-1));
      if (!record) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SUCCESS", data: record }));
    } else if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/resumes")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Resume intake</title><h1>Resume ready</h1>
        <button id="acquire">Acquire resume</button><p id="status"></p>
        <script type="module">import { acquireResume } from '/resume-page.js';
          document.querySelector('#acquire').addEventListener('click', async () => {
            try { await acquireResume(); document.querySelector('#status').textContent = 'Submission accepted'; }
            catch { document.querySelector('#status').textContent = 'Submission failed'; }
          });</script>`);
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
    const plan = (level) => TestCharterSchema.parse(surface === "mobile" && level === "quick"
      ? { intent: "快速检查移动端简历获取页面", level, sideEffectPolicy: "deny",
        actions: [{ kind: "waitForText", text: "Resume ready", timeoutMs: 1000 }, { kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Resume ready" }] }
      : surface === "mobile"
        ? { intent: "测试本次移动端简历获取功能", level, sideEffectPolicy: "allow",
          actions: [{ kind: "waitForText", text: "Resume ready", timeoutMs: 1000 },
            { kind: "click", selector: "accessibility=Acquire resume" },
            { kind: "waitForText", text: "Submission accepted", timeoutMs: 1000 }],
          assertions: [{ kind: "text-visible", text: "Submission accepted" }],
          oracles: ["resume.mobileTerminal"] }
      : level === "quick"
      ? { intent: "快速检查简历获取页面", level, sideEffectPolicy: "deny",
        actions: [{ kind: "goto", url: `${origin}/resumes` }, { kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Resume ready" }] }
      : { intent: "测试本次简历获取功能", level, sideEffectPolicy: "allow",
        actions: [{ kind: "goto", url: `${origin}/resumes` },
          { kind: "captureResponse", name: "acquisition", trigger: { kind: "click", selector: "#acquire" },
            response: { url: `${origin}/api/v1/resumes`, method: "POST", statuses: [201], fields: {
              fileId: { pointer: "/data/fileId", type: "id" }, jobId: { pointer: "/data/jobId", type: "id" },
            } }, requestWindowMs: 200, timeoutMs: 5000 },
          { kind: "waitForText", text: "Submission accepted", timeoutMs: 5000 }],
        assertions: [{ kind: "text-visible", text: "Submission accepted" }],
        oracles: [expected.noReader ? "current-resume-status" : "resume.terminal"],
        ...(expected.noReader ? { httpOracles: [{ name: "current-resume-status", url: `${origin}/api/v1/resume-status`,
          query: { fileId: { source: "response", stepId: "step-002", field: "fileId", matchPointer: "/data/fileId" } },
          statusPointer: "/data/state", successValues: ["complete"], failureValues: ["failed"], intervalMs: 100, deadlineMs: 1000 }] } : {}) });
    const catalogLevels = surface === "mobile" && expected.level === "quick" ? ["quick"] : ["core", "quick"];
    const charters = expected.noCatalog ? [] : catalogLevels.map((level) => ({ id: `resume-${level}`, path: `.proofkit/charters/resume-${level}.yml`,
      aliases: ["简历获取", "简历"], level, surfaces: [surface],
      ...(surface === "mobile" ? {} : { routeTargets: [{ kind: "web", path: "/resumes", source: "resume-page.js" }] }) }));
    const config = ProofkitConfigSchema.parse({ project: { root: source }, surfaces: { web: { baseUrl: origin,
      ...(process.env.PROOFKIT_BROWSER_PATH ? { executablePath: process.env.PROOFKIT_BROWSER_PATH }
        : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) },
      ...(surface === "mobile" ? { mobile: { serverUrl: `${origin}/wd`, platformName: "Android",
        automationName: "UiAutomator2", deviceName: "proofkit-host-fixture",
        readyWhen: { text: "Resume ready", timeoutMs: 1000 } } } : {}),
      ...(devtoolsActivePort ? { electron: { devtoolsActivePort } } : {}) },
      integration: { path: ".proofkit/integration.mjs" }, policies: { environment: "test", sideEffects: "allow" }, charters, run: { timeoutMs: 15_000 } });
    await writeFile(join(workspace, ".proofkit", "config.yaml"), JSON.stringify(config));
    if (!expected.noCatalog) {
      for (const level of catalogLevels) await writeFile(join(workspace, ".proofkit", "charters", `resume-${level}.yml`), JSON.stringify(plan(level)));
    } else if (expected.candidatePath) {
      await writeFile(join(workspace, expected.candidatePath), JSON.stringify(plan("core")));
    }
    await writeFile(join(workspace, ".proofkit", "integration.mjs"), surface === "mobile" && expected.level === "core"
      ? `export default { name: 'host-evaluation-mobile-fixture', version: '1.0.0', oracles: [{
      name: 'resume.mobileTerminal', async check({ runId, steps, signal }) {
        const clicks = steps.filter(step => step.status === 'passed' && step.action.kind === 'click'
          && step.action.selector === 'accessibility=Acquire resume');
        const click = clicks.length === 1 ? clicks[0] : undefined;
        const before = click?.beforeSnapshot?.text ?? '';
        const after = click?.afterSnapshot?.text ?? '';
        const identities = [...after.matchAll(/Submission accepted #([1-9][0-9]{0,127})/g)];
        const fileId = !/Submission accepted #[1-9][0-9]*/.test(before) && identities.length === 1
          && identities[0][1] !== '101' ? identities[0][1] : undefined;
        if (!fileId) return { name: 'resume.mobileTerminal', passed: null,
          message: 'Current mobile action identity was not observed',
          evidence: [JSON.stringify({ runId, gap: 'current-action-id-missing' })], observedAt: new Date().toISOString() };
        const response = await fetch(${JSON.stringify(origin + "/api/v1/resumes/")} + fileId, { signal });
        if (!response.ok) return { name: 'resume.mobileTerminal', passed: null,
          message: 'Independent mobile business reader is unavailable',
          evidence: [JSON.stringify({ runId, captured: { fileId, jobId: '7' }, readerStatus: response.status })],
          observedAt: new Date().toISOString() };
        const data = (await response.json()).data;
        const identity = data.fileId === fileId && data.jobId === '7';
        const passed = !identity ? false : data.state === 'complete' ? true : null;
        return { name: 'resume.mobileTerminal', passed,
          message: !identity ? 'Current mobile resume belongs to the wrong job' : passed
            ? 'Current mobile resume reached terminal success' : 'Mobile worker terminal state is pending',
          evidence: [JSON.stringify({ runId, captured: { fileId, jobId: '7' }, observed: data })],
          observedAt: new Date().toISOString() };
      }
    }] };`
      : expected.noReader
      ? "export default { name: 'host-evaluation-fixture', version: '1.0.0', oracles: [] };\n"
      : `export default { name: 'host-evaluation-fixture', version: '1.0.0', oracles: [{
      name: 'resume.terminal', async check(context) {
        const capture = context.steps.find(step => step.action.kind === 'captureResponse')?.response;
        const fileId = capture?.fields.fileId;
        const jobId = capture?.fields.jobId;
        if (typeof fileId !== 'string' || typeof jobId !== 'string') {
          return { name: 'resume.terminal', passed: null, message: 'This Run has no captured acquisition identity',
            evidence: [JSON.stringify({ gap: 'current-acquisition-id-missing' })], observedAt: new Date().toISOString() };
        }
        const response = await fetch(${JSON.stringify(origin + "/api/v1/resumes/")} + encodeURIComponent(fileId), {signal: context.signal});
        if (!response.ok) return { name: 'resume.terminal', passed: null, message: 'Current resume reader is unavailable',
          evidence: [JSON.stringify({ captured: { fileId, jobId }, readerStatus: response.status })], observedAt: new Date().toISOString() };
        const data = (await response.json()).data;
        const identity = fileId !== '101' && data.fileId === fileId && data.jobId === jobId && jobId === '7';
        const passed = !identity ? false : data.state === 'complete' ? true : null;
        return { name: 'resume.terminal', passed,
          message: !identity ? 'Current resume belongs to the wrong job or was not created by this action' : passed ? 'Current resume reached terminal success' : 'Worker terminal state has not been observed',
          evidence: [JSON.stringify({ captured: { fileId, jobId }, expected: { jobId: '7', state: 'complete' }, observed: data })], observedAt: new Date().toISOString() };
      }
    }] };`);
    const setup = await setupAgent({ root: source, workspaceRoot: workspace, harness: agentHarness, installSkill: true,
      skillsDir: join(harness, agentHarness === "codex" ? ".agents" : ".claude", "skills") });
    const charterNames = expected.candidatePath ? ["resume-core.yml"]
      : expected.noCatalog ? [] : catalogLevels.map((level) => `resume-${level}.yml`);
    const contractPaths = ["config.yaml", "integration.mjs", ...charterNames.map((name) => `charters/${name}`)];
    const contractHashes = await Promise.all(contractPaths.map(async (path) => hash(await readFile(join(workspace, ".proofkit", path)))));
    return { root, source, workspace, harness, setup, corePlan: plan("core"),
      async sourceUnchanged() {
        const paths = await readdir(source);
        return paths.length === Object.keys(sourceFiles).length && (await Promise.all(Object.entries(sourceFiles).map(async ([path, content]) => hash(await readFile(join(source, path))) === hash(content)))).every(Boolean);
      },
      async workspaceContractsUnchanged() {
        try {
          const names = await readdir(join(workspace, ".proofkit", "charters"));
          if (JSON.stringify(names.sort()) !== JSON.stringify([...charterNames].sort())) return false;
          return (await Promise.all(contractPaths.map(async (path, index) =>
            hash(await readFile(join(workspace, ".proofkit", path))) === contractHashes[index]))).every(Boolean);
        } catch { return false; }
      },
      async close() {
        await stopElectron(electron);
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
        if (mobileSessions.size > 0) throw new Error("Host fixture left a WebDriver session open");
      },
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
