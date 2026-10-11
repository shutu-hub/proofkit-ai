import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { LocalExecutionOwnership } from "@proofkit/evidence";
import { inspectEvidenceRetention } from "./evidence-retention.js";

const scratch: string[] = [];
const past = "2020-01-01T00:00:00.000Z";
const charter = TestCharterSchema.parse({ intent: "Inspect fixture", level: "quick", actions: [], assertions: [] });

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-retention-"));
  scratch.push(base);
  const project = join(base, "source");
  const workspace = join(base, "workspace");
  const metadata = join(workspace, ".proofkit");
  const runs = join(metadata, "runs");
  await Promise.all([mkdir(project), mkdir(runs, { recursive: true })]);
  await writeFile(join(project, "package.json"), "{}");
  return { project, workspace, metadata, runs };
}

async function run(runs: string, id: string, extra: Record<string, unknown> = {}) {
  const dir = join(runs, id);
  const workspaceRoot = resolve(runs, "..", "..");
  await mkdir(dir);
  await writeFile(join(dir, "run.json"), `${JSON.stringify({
    runId: id, projectRoot: resolve(workspaceRoot, "..", "source"), workspaceRoot,
    startedAt: past, endedAt: past, status: "completed", verdict: "passed", charter,
    steps: [], assertions: [], oracles: [], artifacts: [], findings: [], ...extra,
  })}\n`);
  return dir;
}

describe("read-only evidence retention audit", () => {
  it("retains Mission, snapshot, replay and recovery sources while flagging an orphan for review", async () => {
    const f = await fixture();
    for (const id of ["mission-owned", "mission-owned-extra", "snapshot-owned", "replay-source", "replay-child", "recovery-held", "orphan"]) await run(f.runs, id);
    await writeFile(join(f.runs, "replay-child", "run.json"), JSON.stringify({
      runId: "replay-child", projectRoot: f.project, workspaceRoot: f.workspace,
      startedAt: past, endedAt: past, status: "completed", verdict: "passed", charter,
      execution: { adapter: "web", replayOfRunId: "replay-source" },
    }));
    const missions = join(f.metadata, "missions");
    await mkdir(join(missions, "mission-1"), { recursive: true });
    await writeFile(join(missions, "mission-1.json"), JSON.stringify({ observations: [{ data: { runId: "mission-owned" } }] }));
    await writeFile(join(missions, "mission-1", "summary.json"), JSON.stringify({ runs: [{ runId: "snapshot-owned" }] }));
    await mkdir(join(f.metadata, "recoveries", "recovery-held"), { recursive: true });

    const before = await readFile(join(f.runs, "orphan", "run.json"), "utf8");
    const audit = await inspectEvidenceRetention(f.project, f.workspace);
    const byId = Object.fromEntries(audit.runs.map((row) => [row.runId, row]));
    expect(audit).toMatchObject({ status: "complete", testVerdict: "not-asserted", totalRuns: 7,
      retainedRuns: 4, reviewRuns: 3, unverifiedRuns: 0, deletionSupported: false });
    expect(byId["mission-owned"]).toMatchObject({ disposition: "retain", reasons: ["mission"] });
    expect(byId["snapshot-owned"]).toMatchObject({ disposition: "retain", reasons: ["mission-report"] });
    expect(byId["replay-source"]).toMatchObject({ disposition: "retain", reasons: ["run-replay-or-reference"] });
    expect(byId["recovery-held"]).toMatchObject({ disposition: "retain", reasons: ["resource-recovery"] });
    expect(byId.orphan).toMatchObject({ disposition: "review", reasons: [] });
    expect(byId["mission-owned-extra"]).toMatchObject({ disposition: "review", reasons: [] });
    expect(audit.totalBytes).toBeGreaterThan(0);
    expect(await readFile(join(f.runs, "orphan", "run.json"), "utf8")).toBe(before);
    expect(await readFile(join(f.project, "package.json"), "utf8")).toBe("{}");
  });

  it("retains recent, active and integration resource Runs", async () => {
    const f = await fixture();
    await run(f.runs, "recent", { endedAt: new Date().toISOString() });
    await run(f.runs, "active");
    const integrated = await run(f.runs, "integrated");
    await mkdir(join(integrated, "artifacts"));
    await writeFile(join(integrated, "artifacts", "integration-setup.json"), "{}");
    const lease = await new LocalExecutionOwnership(f.runs, "run").acquire("active");
    expect(lease).toBeDefined();
    try {
      const audit = await inspectEvidenceRetention(f.project, f.workspace);
      const byId = Object.fromEntries(audit.runs.map((row) => [row.runId, row]));
      expect(audit.reviewRuns).toBe(0);
      expect(byId.recent!.reasons).toContain("within-retention-window");
      expect(byId.active!.reasons).toContain("active-run-owner");
      expect(byId.integrated!.reasons).toContain("integration-resource-history");
    } finally { await lease!.release(); }
  });

  it("fails closed when a saved reference or Run manifest is invalid", async () => {
    const f = await fixture();
    await run(f.runs, "orphan");
    await mkdir(join(f.metadata, "missions"));
    await writeFile(join(f.metadata, "missions", "broken.json"), "{not-json");
    let audit = await inspectEvidenceRetention(f.project, f.workspace);
    expect(audit).toMatchObject({ status: "incomplete", reviewRuns: 0, unverifiedRuns: 1 });
    await rm(join(f.metadata, "missions", "broken.json"));
    await run(f.runs, "broken");
    await writeFile(join(f.runs, "broken", "run.json"), "{not-json");
    audit = await inspectEvidenceRetention(f.project, f.workspace);
    expect(audit).toMatchObject({ status: "incomplete", reviewRuns: 0, unverifiedRuns: 2 });
    expect(audit.runs.find((row) => row.runId === "broken")?.reasons).toContain("unverifiable-run-manifest");
  });

  it("rejects invalid retention ages", async () => {
    const f = await fixture();
    await expect(inspectEvidenceRetention(f.project, f.workspace, 0)).rejects.toThrow("1–3650");
    await expect(inspectEvidenceRetention(f.project, f.workspace, 1.5)).rejects.toThrow("1–3650");
  });

  it("does not report a missing workspace as an empty complete inventory", async () => {
    const f = await fixture();
    await rm(f.workspace, { recursive: true });
    expect(await inspectEvidenceRetention(f.project, f.workspace)).toMatchObject({
      status: "incomplete", reviewRuns: 0, deletionSupported: false,
      issues: ["Test workspace is unavailable."],
    });
  });
});
