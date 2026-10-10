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
    expect(JSON.parse(await readFile(join(dirname(report), "summary.json"), "utf8"))).toMatchObject({ ...input,
      evidenceIntegrity: { status: "no-evidence", scope: "presented-result", references: { total: 0, intact: 0 } } });
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
    expect(markup).toContain("Registered scenarios outside this Mission matrix: billing");
    expect(markup).toContain("Missing test requirements");
    expect(markup).toContain('id="outcome">Passed');
  });

  it("labels a historical pass unverified when saved Oracle classification is missing", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "passed";
    input.proofClassification = { status: "unverified", checkedRuns: 1, classifiedOracles: 0,
      legacyOracles: 1, unavailableRuns: 0, omittedRuns: 0, legacyRunIds: ["run-1"], unavailableRunIds: [] };
    const path = await new MissionReportStore(workspace).writeReport(input);
    const markup = await readFile(path, "utf8");
    expect(markup).toContain("Saved pass · current business proof unverified");
    expect(markup).toContain("1 saved Oracle result(s) lack a verification kind");
    expect(JSON.parse(await readFile(join(dirname(path), "summary.json"), "utf8")).proofClassification)
      .toMatchObject({ status: "unverified", legacyRunIds: ["run-1"] });
  });

  it("marks bounded results partial when run evidence or results were omitted", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.runs[0]!.omittedEvidence = 2;
    input.omittedRunResults = 1;
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.integrity).toMatchObject({
      status: "partial", omittedEvidenceReferences: 2, omittedRunResults: 1,
      references: { total: 0, intact: 0 },
    });
    expect(JSON.parse(await readFile(join(dirname(snapshot.path), "summary.json"), "utf8"))).toMatchObject({
      evidenceIntegrity: { status: "partial", omittedEvidenceReferences: 2 },
    });
  });

  it("encodes valid evidence paths and rejects missing, external, remote and unrelated files", async () => {
    const workspace = await root();
    const outside = await root();
    const valid = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "事实 # 'quote'.json"));
    const unrelated = await file(join(workspace, ".proofkit", "runs", "run-other", "artifacts", "fact.json"));
    const secret = await file(join(workspace, ".proofkit", "runs", "run-1", "config.yaml"));
    const external = await file(join(outside, "external.json"));
    const digest = createHash("sha256").update("fact").digest("hex");
    const input = result(workspace, [ref(valid, digest), ref(unrelated, digest), ref(secret, digest), ref(external, digest), ref("https://invalid.example/fact", digest), ref("run-1/artifacts/missing.json", digest)]);
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

  it("does not present a saved confirmed finding as currently verified after its evidence changes", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "failure.json"), "wrong binding");
    const evidence = ref(path, createHash("sha256").update("wrong binding").digest("hex"));
    const input = result(workspace, [evidence]);
    input.verdict = "failed";
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "finding-1", category: "product", status: "confirmed", severity: "high",
      title: "Wrong binding", message: "Candidate relation is wrong", evidence: [evidence], createdAt: now }];
    const store = new MissionReportStore(workspace);
    const before = await store.writeReportSnapshot(input);
    expect(before.integrity).toMatchObject({ status: "intact", references: { total: 1, intact: 1, unavailable: 0, legacy: 0 },
      visibleConfirmedFindings: { saved: 1, supported: 1, unsupportedFindingIds: [] } });
    expect(await readFile(before.path, "utf8")).toContain("1 / 1 visible saved confirmed product finding(s) have all cited evidence");
    await writeFile(path, "changed binding");
    const current = await store.writeReportSnapshot(input);
    expect(current.integrity).toMatchObject({ status: "degraded", references: { total: 1, intact: 0, unavailable: 1, legacy: 0 },
      visibleConfirmedFindings: { saved: 1, supported: 0, unsupportedFindingIds: ["finding-1"] } });
    expect(await store.inspectIntegrity(input)).toMatchObject({ status: "degraded", visibleConfirmedFindings: { supported: 0 } });
    const markup = await readFile(current.path, "utf8");
    expect(markup).toContain("saved confirmed · evidence currently unverified");
    expect(markup).toContain("0 / 1 visible saved confirmed product finding(s) have all cited evidence");
    expect(markup).toContain("cannot be independently confirmed from this report");
  });

  it("requires every cited finding and comparison fact to remain intact", async () => {
    const workspace = await root();
    const baselinePath = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "baseline.json"), "baseline");
    const secondPath = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "relation.json"), "relation");
    const candidatePath = await file(join(workspace, ".proofkit", "runs", "run-2", "artifacts", "candidate.json"), "candidate");
    const rowPath = await file(join(workspace, ".proofkit", "runs", "run-3", "artifacts", "row.json"), "row fact");
    const fact = (path: string, content: string) => ref(path, createHash("sha256").update(content).digest("hex"));
    const baseline = fact(baselinePath, "baseline");
    const relation = fact(secondPath, "relation");
    const candidate = fact(candidatePath, "candidate");
    const rowFact = fact(rowPath, "row fact");
    const input = result(workspace, [baseline, relation]);
    input.verdict = "failed";
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "finding-1", category: "product", status: "confirmed", severity: "high",
      title: "Wrong relation", message: "Two facts establish the wrong relation", evidence: [baseline, relation], createdAt: now }];
    input.comparison = {
      baselineMissionId: "baseline-mission", candidateMissionId: "candidate-mission",
      baselineScopeHash: "a".repeat(64), candidateScopeHash: "a".repeat(64), scopeMatched: true,
      sourceChange: "changed", candidateSourceStability: "stable", status: "verified-in-scope",
      reason: "Saved comparison", gaps: [], runs: [{ surface: "web", runKind: "primary", baselineRunId: "run-3",
        baselineBusinessFacts: 1, candidateBusinessFacts: 0, baselineEvidence: [rowFact], candidateEvidence: [] }], omittedRuns: 0,
      defects: [{ surface: "web", oracleName: "relation", baselineRunId: "run-1", candidateRunId: "run-2",
        outcome: "not-reproduced", baselineEvidence: [baseline, relation], candidateEvidence: [candidate] }],
      omittedDefects: 0, comparedAt: now,
    };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity).toMatchObject({ status: "intact", comparison: "intact",
      references: { total: 4, intact: 4 },
      visibleConfirmedFindings: { supported: 1 } });
    expect(await readFile(intact.path, "utf8")).toContain('href="../../runs/run-2/artifacts/candidate.json"');

    input.comparison.defects[0]!.baselineEvidence = [candidate];
    const misbound = await store.writeReportSnapshot(input);
    expect(misbound.integrity).toMatchObject({ status: "degraded", comparison: "degraded",
      references: { unavailable: 0 }, visibleConfirmedFindings: { supported: 1 } });
    expect(await readFile(misbound.path, "utf8")).toContain("Before: <span class=\"unavailable\"");
    input.comparison.defects[0]!.baselineEvidence = [baseline, relation];

    input.comparison.runs[0]!.baselineEvidence = [candidate];
    expect(await store.inspectIntegrity(input)).toMatchObject({ status: "degraded", comparison: "degraded",
      references: { unavailable: 0 } });
    input.comparison.runs[0]!.baselineEvidence = [rowFact];

    await writeFile(rowPath, "changed row fact");
    expect(await store.inspectIntegrity(input)).toMatchObject({ status: "degraded", comparison: "degraded",
      references: { unavailable: 1 }, visibleConfirmedFindings: { supported: 1 } });
    await writeFile(rowPath, "row fact");

    input.comparison.omittedRuns = 1;
    input.comparison.omittedDefects = 2;
    expect(await store.inspectIntegrity(input)).toMatchObject({
      status: "partial", omittedComparisonRuns: 1, omittedComparisonDefects: 2,
    });
    input.comparison.omittedRuns = 0;
    input.comparison.omittedDefects = 0;
    await writeFile(secondPath, "changed relation");
    const degraded = await store.writeReportSnapshot(input);
    expect(degraded.integrity).toMatchObject({ status: "degraded", comparison: "degraded",
      references: { intact: 3, unavailable: 1 },
      visibleConfirmedFindings: { supported: 0, unsupportedFindingIds: ["finding-1"] } });
    const markup = await readFile(degraded.path, "utf8");
    expect(markup).toContain("saved confirmed · evidence currently unverified");
    expect(markup).toContain("Current evidence cannot verify this saved comparison");
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
    const digest = createHash("sha256").update("fact").digest("hex");
    const input = result(workspace, [ref(join(artifacts, "outside", "fact.json"), digest), ref(join(artifacts, "other-run", "fact.json"), digest)]);
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup.match(/Business fact unavailable/g)).toHaveLength(2);
  });

  it("labels legacy references without a digest as integrity unverified", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "legacy.json"));
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(result(workspace, [ref(path)])), "utf8");
    expect(markup).toContain("Business fact integrity unverified");
    expect(markup).toContain("1 lack a saved digest");
    expect(markup).not.toContain('href="../../runs/run-1/artifacts/legacy.json"');
    const integrity = await new MissionReportStore(workspace).inspectIntegrity(result(workspace, [ref(path)]));
    expect(integrity).toMatchObject({ status: "degraded", references: { total: 1, intact: 0, unavailable: 0, legacy: 1 } });
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
