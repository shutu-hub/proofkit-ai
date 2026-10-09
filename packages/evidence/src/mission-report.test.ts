import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionResultSchema, type EvidenceRef, type MissionResult } from "@proofkit/contracts";
import { MissionReportStore } from "./mission-report.js";

const roots: string[] = [];
const now = "2026-10-10T00:00:00.000Z";
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "proofkit-mission-report-"));
  roots.push(path);
  return path;
}

function result(workspaceRoot: string, evidence: EvidenceRef[] = []): MissionResult {
  return MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-report", projectRoot: "/source", workspaceRoot, intent: "Test resume", status: "completed", running: false, verdict: "inconclusive", level: "core", revision: 7, updatedAt: now, generatedAt: now,
    scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 3, settled: 3, failed: 0, blocked: 0, skipped: 0 }, expectedRuns: 1, observedRuns: 1,
    runs: [{ title: "Resume", surface: "web", runKind: "primary", runId: "run-1", verdict: "passed", evidence, omittedEvidence: 0 }], omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
}

function ref(path: string, sha256?: string): EvidenceRef {
  return { evidenceId: path, kind: "business", path, sha256, capturedAt: now, description: `Evidence 'quoted' <tag>` };
}

async function file(path: string, content = "fact"): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("Mission report", () => {
  it("writes escaped static snapshots without changing saved acceptance or original state", async () => {
    const workspace = await root();
    const missionPath = await file(join(workspace, ".proofkit", "missions", "mission-report.json"), "original Mission");
    const input = result(workspace);
    input.intent = '<script>alert("bad")</script> & Resume';
    input.runs[0]!.title = 'Resume <img src="https://invalid.example/" onerror="bad">';
    input.runs.push({ title: "Rejected input", surface: "web", runKind: "negative", runId: "run-negative", verdict: "failed", expectedVerdict: "failed", outcomeMatched: true, evidence: [], omittedEvidence: 0 });
    const before = JSON.stringify(input);
    const report = await new MissionReportStore(workspace).writeReport(input);
    const markup = await readFile(report, "utf8");
    expect(markup).toContain("Acceptance inconclusive");
    expect(markup).toContain("Expected outcome matched");
    expect(markup).toContain("Raw: failed · Expected: failed");
    expect(markup).toContain("&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt; &amp; Resume");
    expect(markup).not.toMatch(/<script|<img/);
    expect(markup).toContain("default-src 'none'");
    expect(markup).toContain("Acceptance scope not recorded");
    expect(markup).toContain("Workflow coverage: not recorded");
    expect(markup).toContain("revision 7");
    expect(markup).toContain("does not refresh");
    expect(JSON.parse(await readFile(join(dirname(report), "summary.json"), "utf8"))).toEqual(input);
    expect(await readFile(missionPath, "utf8")).toBe("original Mission");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("shows partial and whole-project limits even beside a saved passed result", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "passed";
    input.planning = { source: "submitted", confidence: 0.5, assumptions: [], missingInputs: [], evidenceGaps: ["project-workflow-coverage"], coverage: { requested: "project", source: "explicit", reason: "Requested whole project", inventory: "partial", workflowCoverage: "unmeasured", gaps: ["project-map-truncated"] } };
    input.scope.uncoveredCharterIds = ["billing"];
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup).toContain("Whole project requested");
    expect(markup).toContain("workflow coverage has not been proven");
    expect(markup).toContain("source inventory is partial");
    expect(markup).toContain("outside this suite: billing");
    expect(markup).toContain("Missing test requirements");
    expect(markup).toContain('id="outcome">Passed');
  });

  it("encodes valid evidence paths and rejects missing, external, remote and unrelated files", async () => {
    const workspace = await root();
    const outside = await root();
    const valid = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "事实 # 'quote'.json"));
    const unrelated = await file(join(workspace, ".proofkit", "runs", "run-other", "artifacts", "fact.json"));
    const secret = await file(join(workspace, ".proofkit", "runs", "run-1", "config.yaml"));
    const external = await file(join(outside, "external.json"));
    const input = result(workspace, [ref(valid), ref(unrelated), ref(secret), ref(external), ref("https://invalid.example/fact"), ref("run-1/artifacts/missing.json")]);
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup).toContain("../../runs/run-1/artifacts/%E4%BA%8B%E5%AE%9E%20%23%20&#39;quote&#39;.json");
    expect(markup.match(/Business fact unavailable/g)).toHaveLength(5);
    expect(markup).not.toContain('href="https:');
    expect(markup).not.toContain('href="file:');
    expect(markup).not.toContain('href="../../runs/run-other');
    expect(markup).toContain("5 evidence reference(s)");
  });

  it("makes a changed evidence digest unavailable and permits an intact copy", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "fact.json"), "original");
    const digest = createHash("sha256").update("original").digest("hex");
    const input = result(workspace, [ref(path, digest)]);
    const store = new MissionReportStore(workspace);
    expect(await readFile(await store.writeReport(input), "utf8")).toContain('href="../../runs/run-1/artifacts/fact.json"');
    await writeFile(path, "changed");
    expect(await readFile(await store.writeReport(input), "utf8")).toContain("Business fact unavailable");
    expect((await readdir(join(workspace, ".proofkit", "missions", input.missionId))).sort()).toEqual(["report.html", "summary.json"]);
  });

  it("rejects artifact directory links outside the workspace and across Runs", async () => {
    const workspace = await root();
    const outside = await root();
    const artifacts = join(workspace, ".proofkit", "runs", "run-1", "artifacts");
    const other = join(workspace, ".proofkit", "runs", "run-other", "artifacts");
    await file(join(other, "fact.json"));
    await file(join(outside, "fact.json"));
    await mkdir(artifacts, { recursive: true });
    await symlink(outside, join(artifacts, "outside"), process.platform === "win32" ? "junction" : "dir");
    await symlink(other, join(artifacts, "other-run"), process.platform === "win32" ? "junction" : "dir");
    const input = result(workspace, [ref(join(artifacts, "outside", "fact.json")), ref(join(artifacts, "other-run", "fact.json"))]);
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup.match(/Business fact unavailable/g)).toHaveLength(2);
  });

  it("refuses redirected report directories before creating files outside the workspace", async () => {
    const workspace = await root();
    const outside = await root();
    await mkdir(join(workspace, ".proofkit"));
    await symlink(outside, join(workspace, ".proofkit", "missions"), process.platform === "win32" ? "junction" : "dir");
    await expect(new MissionReportStore(workspace).writeReport(result(workspace))).rejects.toThrow("within its workspace");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses another workspace and an invalid Mission ID", async () => {
    const workspace = await root();
    const outside = await root();
    await expect(new MissionReportStore(workspace).writeReport(result(outside))).rejects.toThrow("another workspace");
    await expect(new MissionReportStore(workspace).writeReport({ ...result(workspace), missionId: "../escape" })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
