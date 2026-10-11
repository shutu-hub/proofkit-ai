import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ElectronAdapter } from "../packages/adapters/dist/index.js";
import { TestCharterSchema } from "../packages/contracts/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

// Models AIHR's UI -> IPC -> shell-renderer fetch. It does not run AIHR.
const executable = process.env.PROOFKIT_ELECTRON_PATH;
assert.ok(executable, "Set PROOFKIT_ELECTRON_PATH for the Electron IPC response smoke");
const root = await mkdtemp(join(tmpdir(), "proofkit-ipc-response-"));
const objects = new Map();
let nextId = 0;
const paths = [];
const http = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  paths.push(`${request.method} ${url.pathname}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>IPC bridge fixture</title>
      <h1>Desktop acquisition</h1><button id="renderer">Renderer bridge</button>
      <button id="main">Main process bridge</button><p id="result"></p>
      <script>
        window.bridge.onResult(() => { document.querySelector('#result').textContent = 'Accepted'; });
        document.querySelector('#renderer').onclick = () => window.bridge.start('renderer');
        document.querySelector('#main').onclick = () => window.bridge.start('main');
      </script>`);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/resume-collection/runs") {
    const id = String(++nextId);
    objects.set(id, { run_id: id, status: "completed" });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { run_id: id } }));
    return;
  }
  const match = /^\/api\/v1\/resume-collection\/runs\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && match) {
    const object = objects.get(match[1]);
    response.writeHead(object ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: object ?? null }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${http.address().port}`;
const endpoint = `${baseUrl}/api/v1/resume-collection/runs`;
const preloadPath = join(root, "preload.cjs");
const appPath = join(root, "app.cjs");
await writeFile(preloadPath, `const {contextBridge,ipcRenderer}=require('electron');
  const listeners=[];
  contextBridge.exposeInMainWorld('bridge',{
    start:(mode)=>ipcRenderer.invoke('start',mode).then((id)=>{if(id)listeners.forEach((listener)=>listener(id));}),
    onResult:(listener)=>listeners.push(listener),
  });
  ipcRenderer.on('backend-request',async()=>{
    const response=await fetch(${JSON.stringify(endpoint)},{method:'POST'});
    const body=await response.json();
    listeners.forEach((listener)=>listener(body.data.run_id));
  });`);
await writeFile(appPath, `const {app,BrowserWindow,ipcMain}=require('electron');
  app.setPath('userData',${JSON.stringify(root)});
  app.commandLine.appendSwitch('remote-debugging-port','0');
  app.commandLine.appendSwitch('disable-gpu');
  ipcMain.handle('start',async(event,mode)=>{
    if(mode==='renderer'){event.sender.send('backend-request');return null;}
    const response=await fetch(${JSON.stringify(endpoint)},{method:'POST'});
    return (await response.json()).data.run_id;
  });
  app.whenReady().then(()=>{
    const window=new BrowserWindow({show:false,width:900,height:700,webPreferences:{
      preload:${JSON.stringify(preloadPath)},contextIsolation:true,nodeIntegration:false,
      offscreen:true,backgroundThrottling:false}});
    window.loadURL(${JSON.stringify(baseUrl)});
  });
  app.on('window-all-closed',()=>app.quit());`);
let child;
try {
  child = spawn(executable, [appPath], { stdio: "ignore", windowsHide: true });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const portFile = join(root, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error("Electron exited before CDP became available");
    try {
      const port = (await readFile(portFile, "utf8")).split(/\r?\n/)[0];
      if (/^\d+$/.test(port) && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch { /* Wait for this isolated Electron profile. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) throw new Error("Electron CDP endpoint did not appear");

  const oracle = { name: "current-run", async check({ steps, signal }) {
    const id = steps.find((step) => step.action.kind === "captureResponse")?.response?.fields.runId;
    if (!id) return { name: "current-run", passed: null, message: "No captured current Run ID", observedAt: new Date().toISOString() };
    const response = await fetch(`${endpoint}/${id}`, { signal });
    const fact = (await response.json()).data;
    const passed = response.status === 200 && fact?.run_id === id && fact?.status === "completed";
    return { name: "current-run", passed, message: passed ? "Current Run identity and terminal state agree" : "Current Run facts differ",
      evidence: [JSON.stringify({ capturedId: id, observedId: fact?.run_id, status: fact?.status })], observedAt: new Date().toISOString() };
  } };
  const execute = (mode) => new ExecutionRunner(new ElectronAdapter({ devtoolsActivePortPath: portFile }), {
    evidenceDir: join(root, "runs"), oracles: [oracle], timeoutMs: 8_000,
  }).run(TestCharterSchema.parse({ intent: `Check ${mode} IPC backend request visibility`, level: "core", mode: "deterministic",
    sideEffectPolicy: "allow", actions: [
      { kind: "captureResponse", name: "current-run", trigger: { kind: "click", selector: `#${mode}` },
        requestStartTimeoutMs: 1_500, requestWindowMs: 150, timeoutMs: 3_000,
        response: { url: endpoint, method: "POST", statuses: [201], fields: { runId: { pointer: "/data/run_id", type: "id" } } } },
      { kind: "waitForText", text: "Accepted", timeoutMs: 1_000 },
    ], assertions: [{ kind: "text-visible", text: "Accepted" }], oracles: ["current-run"] }));

  const renderer = await execute("renderer");
  assert.equal(renderer.verdict, "passed", JSON.stringify(renderer.findings));
  const capturedId = renderer.steps[0].response?.fields.runId;
  assert.equal(capturedId, "1");
  assert.equal(renderer.oracles[0]?.passed, true);
  const rendererEvents = (await readFile(join(root, "runs", renderer.runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rendererEvents.some((event) => event.type === "adapter.event" && event.payload.eventType === "request"
    && event.payload.method === "POST"), "The shell-renderer request must appear in the attached page network stream");

  const main = await execute("main");
  assert.equal(main.verdict, "inconclusive", JSON.stringify(main.findings));
  assert.equal(main.steps[0].response, undefined);
  assert.ok(objects.has("2"), "The backend request occurred outside page network observation");
  const mainEvents = (await readFile(join(root, "runs", main.runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!mainEvents.some((event) => event.type === "adapter.event" && event.payload.eventType === "request"
    && event.payload.method === "POST"), "A main-process request must not be attributed to the page");
  assert.ok(!main.oracles.some((result) => result.passed === true));
  assert.ok(paths.includes("POST /api/v1/resume-collection/runs"));
  console.log(JSON.stringify({ renderer: renderer.verdict, rendererRunId: capturedId, main: main.verdict,
    mainBackendObjectCreated: objects.has("2"), scope: "isolated IPC topology; not AIHR acceptance" }, null, 2));
} finally {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(); await exited;
  }
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
