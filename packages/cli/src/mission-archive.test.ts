import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MissionResultSchema, TestCharterSchema } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { createProgram } from "./main.js";

let scratch: string | undefined;
const exitCode = process.exitCode;
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = exitCode; if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });
it("exports a saved snapshot and verifies the moved archive without project configuration, integration or original workspace", async () => {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-cli-archive-")); const project = join(scratch, "project"), workspace = join(scratch, "workspace");
  await mkdir(project); await writeFile(join(project, "package.json"), "{}");
  const store = new EvidenceStore(join(workspace, ".proofkit/runs")); const now = new Date().toISOString();
  await store.startRun({ runId: "cli-run", startedAt: now, endedAt: now, status: "completed", verdict: "inconclusive", projectRoot: project, workspaceRoot: workspace,
    charter: TestCharterSchema.parse({ intent: "CLI archive", actions: [], assertions: [] }), steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
  await store.writeText("cli-run", "facts.txt", "saved facts"); await store.writeManifest("cli-run");
  const runPath = join(workspace, ".proofkit/runs/cli-run/run.json"); const digest = createHash("sha256").update(await readFile(runPath)).digest("hex");
  const mission = MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-cli", projectRoot: project, workspaceRoot: workspace, intent: "CLI archive", status: "completed", running: false,
    verdict: "inconclusive", testVerdict: "inconclusive", level: "core", revision: 1, updatedAt: now, generatedAt: now,
    scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 1, settled: 1, failed: 0, blocked: 0, skipped: 0 }, expectedRuns: 1, observedRuns: 1,
    runs: [{ title: "Saved run", surface: "web", runKind: "primary", runId: "cli-run", verdict: "inconclusive", evidence: [{ evidenceId: "run", kind: "snapshot", path: runPath, sha256: digest, capturedAt: now, description: "saved" }], omittedEvidence: 0 }],
    omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
  const manifestPath = join(workspace, ".proofkit/runs/cli-run/manifest.json");
  mission.runs[0]!.evidence.push({ evidenceId: "manifest", kind: "snapshot", path: manifestPath, sha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"), capturedAt: now, description: "original seal" });
  const snapshot = join(workspace, ".proofkit/missions/mission-cli"); await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, "summary.json"), JSON.stringify(mission)); await writeFile(join(snapshot, "report.html"), "Saved report");
  await writeFile(join(workspace, ".proofkit/config.yaml"), "INVALID: [CONFIG MUST NOT BE LOADED");
  const log = vi.spyOn(console, "log").mockImplementation(() => {}); const destination = join(scratch, "archive");
  const alias = join(scratch, "workspace-alias"); await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(createProgram().parseAsync(["mission", "export", "mission-cli", "--root", project, "--workspace", alias, "--out", destination], { from: "user" })).rejects.toThrow("redirected");
  await createProgram().parseAsync(["mission", "export", "mission-cli", "--root", project, "--workspace", workspace, "--out", destination], { from: "user" });
  const exported = JSON.parse(log.mock.calls.at(-1)![0] as string); expect(exported.testVerdict).toBe("not-asserted");
  const moved = join(scratch, "moved"); await rename(destination, moved); await rm(workspace, { recursive: true }); await rm(project, { recursive: true });
  const verify = async () => {
    await createProgram().parseAsync(["verify-archive", moved, "--archive-sha256", exported.archiveSha256], { from: "user" });
    return JSON.parse(log.mock.calls.at(-1)![0] as string);
  };
  expect((await verify()).status).toBe("intact"); expect(process.exitCode).toBe(0);
  await writeFile(join(moved, ".proofkit/runs/cli-run/artifacts/facts.txt"), "changed");
  expect((await verify()).status).toBe("changed"); expect(process.exitCode).toBe(1);
  await writeFile(join(moved, "archive.json"), "{}");
  await createProgram().parseAsync(["verify-archive", moved], { from: "user" }); expect(process.exitCode).toBe(2);
});
