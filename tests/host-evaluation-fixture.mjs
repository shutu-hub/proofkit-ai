import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ProofkitConfigSchema, TestCharterSchema } from "../packages/contracts/dist/index.js";
import { setupAgent } from "../packages/cli/dist/agent-setup.js";
import { hash } from "./host-evaluation-verifier.mjs";

export const hostCases = [
  { id: "core-pass", prompt: "测试简历获取功能", level: "core", coverage: "declared", verdict: "passed", state: "complete" },
  { id: "core-defect", prompt: "测试简历获取功能", level: "core", coverage: "declared", verdict: "failed", state: "complete", wrongRelation: true },
  { id: "core-pending", prompt: "测试简历获取功能", level: "core", coverage: "declared", verdict: "inconclusive", state: "pending" },
  { id: "project-gap", prompt: "测试整个项目的所有功能", level: "core", coverage: "project", verdict: "not-asserted", state: "complete" },
  { id: "quick-pass", prompt: "快速测试简历获取页面", level: "quick", coverage: "declared", verdict: "passed", state: "complete" },
  { id: "author-core", prompt: "测试简历获取功能", level: "core", coverage: "declared", verdict: "passed", state: "complete", noCatalog: true },
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
  try {
    const plan = (level) => TestCharterSchema.parse({ intent: "测试简历获取功能", level, sideEffectPolicy: "deny",
      actions: [{ kind: "goto", url: `${origin}/resumes` }, { kind: "observe" }],
      assertions: [{ kind: "text-visible", text: "Resume ready" }], ...(level === "core" ? { oracles: ["resume.terminal"] } : {}) });
    const charters = expected.noCatalog ? [] : ["core", "quick"].map((level) => ({ id: `resume-${level}`, path: `.proofkit/charters/resume-${level}.yml`,
      aliases: ["简历获取", "简历"], level, surfaces: ["web"], routeTargets: [{ kind: "web", path: "/resumes", source: "resume-page.js" }] }));
    const config = ProofkitConfigSchema.parse({ project: { root: source }, surfaces: { web: { baseUrl: origin,
      ...(process.env.PROOFKIT_BROWSER_PATH ? { executablePath: process.env.PROOFKIT_BROWSER_PATH }
        : process.platform === "win32" ? { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } : {}) } },
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
      async close() { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); },
    };
  } catch (error) { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); throw error; }
}
