import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElectronAdapter } from "../packages/adapters/dist/index.js";
import { planIntent } from "../packages/planner/dist/index.js";
import { ExecutionRunner } from "../packages/runner/dist/index.js";

const electron = "D:\\code\\Python\\AIHR-Microservices\\node_modules\\.pnpm\\electron@28.3.3\\node_modules\\electron\\dist\\electron.exe";
const userData = await mkdtemp(join(tmpdir(), "proofkit-electron-"));
const child = spawn(electron, ["tests/fixtures/electron-app.cjs", "--remote-debugging-port=9229", `--user-data-dir=${userData}`, "--no-sandbox", "--disable-gpu"], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });

try {
  await waitForCdp("http://127.0.0.1:9229/json/version");
  const portFile = join(userData, "DevToolsActivePort");
  await writeFile(portFile, "9229\n/devtools/browser/proofkit-smoke\n", "utf8");
  const adapter = new ElectronAdapter({ devtoolsActivePortPath: portFile });
  const charter = planIntent("验证 Electron 简历获取", { expect: ["Resume desktop", "Resume ready"] });
  charter.actions.push({ kind: "click", selector: "#fetch" }, { kind: "waitForText", text: "Resume ready" });
  const summary = await new ExecutionRunner(adapter, { evidenceDir: ".proofkit/electron-runs" }).run(charter);
  assert.equal(summary.verdict, "passed", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, artifacts: summary.artifacts.length }, null, 2));
} finally {
  child.kill();
}

async function waitForCdp(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
