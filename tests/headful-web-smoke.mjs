import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "proofkit-headful-workspace-"));
const projectRoot = await mkdtemp(join(tmpdir(), "proofkit-headful-project-"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>ProofKit headful fixture</title><button id="complete" onclick="document.querySelector('#state').textContent='done'">Complete</button><p id="state">pending</p>`);
});

try {
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Headful fixture server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browserPath = process.env.PROOFKIT_BROWSER_PATH
    ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
      ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
  const runner = new LocalRunnerService({
    root: projectRoot,
    workspaceRoot,
    config: ProofkitConfigSchema.parse({
      project: { root: projectRoot },
      surfaces: { web: { baseUrl, ...(browserPath ? { executablePath: browserPath } : {}) } },
      policies: { sideEffects: "allow" },
    }),
  });
  const started = await runner.start({
    adapter: "web",
    url: baseUrl,
    headful: true,
    start: false,
    charter: {
      intent: "完成可见浏览器操作",
      level: "quick",
      mode: "deterministic",
      preconditions: [],
      actions: [
        { kind: "goto", url: baseUrl },
        { kind: "click", selector: "#complete" },
        { kind: "waitForText", text: "done" },
      ],
      assertions: [{ kind: "text-visible", text: "done" }],
      sideEffectPolicy: "allow",
      metadata: {},
    },
  });
  const summary = await runner.wait(started.runId);
  assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
  assert.equal(summary.execution?.visibility, "headful");
  const report = await readFile(resolve(runner.evidenceDir, started.runId, "report.html"), "utf8");
  assert.ok(report.includes("Visibility: headful"));
  console.log(JSON.stringify({ status: "passed", runId: started.runId, visibility: summary.execution?.visibility }, null, 2));
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
  await Promise.all([
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]);
}
