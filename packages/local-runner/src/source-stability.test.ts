import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSummary, TestCharter } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Mission source stability", () => {
  it("keeps a saved pass but makes current acceptance inconclusive after a source edit during the Run", async () => {
    const base = await mkdtemp(join(tmpdir(), "proofkit-source-drift-"));
    roots.push(base);
    const root = join(base, "source");
    const workspaceRoot = join(base, "workspace");
    await mkdir(root);
    await writeFile(join(root, "package.json"), '{"name":"source-stability-fixture"}');
    await writeFile(join(root, "app.ts"), "export const ready = true;\n");
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"], { cwd: root });

    const charter: TestCharter = { intent: "Check ready", level: "quick", mode: "deterministic", preconditions: [],
      actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }],
      sideEffectPolicy: "deny", metadata: {} };
    const now = new Date().toISOString();
    const runId = "source-drift-run";
    const snapshot = `${runId}/artifacts/assertion-snapshot.json`;
    const summary: RunSummary = { runId, startedAt: now, endedAt: now, status: "completed", verdict: "passed",
      charter, steps: [], assertions: [{ assertion: charter.assertions[0]!, passed: true, message: "Ready is visible", evidence: [snapshot] }],
      oracles: [], artifacts: [snapshot], findings: [] };
    const service = new LocalRunnerService({ root, workspaceRoot });
    service.start = async () => ({ runId, status: "completed", verdict: "passed", summary });
    let changed = false;
    service.wait = async () => {
      if (!changed) {
        await writeFile(join(root, "app.ts"), "export const ready = false;\n");
        changed = true;
      }
      return summary;
    };
    installMockRunEvidence(service);
    const mission = await service.createMission({ intent: charter.intent, charter, surface: "web" });
    await service.startMission(mission.missionId, { approve: true });
    await service.waitMission(mission.missionId);
    const result = await service.missionEvidence(mission.missionId);
    expect(result).toMatchObject({ verdict: "passed", sourceStability: "changed", testVerdict: "inconclusive",
      summary: { verdict: "passed", testVerdict: "inconclusive", scope: { sourceStability: "changed" } } });
    expect(result.testVerdictReason).toContain("source changed during this Mission");
  });
});
