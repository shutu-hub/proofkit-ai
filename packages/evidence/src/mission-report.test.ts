import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionResultSchema, type EvidenceRef, type MissionProofClassification, type MissionResult } from "@proofkit/contracts";
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
    executionAudit: { status: "complete", expectedSlots: 1, matchedSlots: 1, unexpectedObservations: 0, issues: [], omittedIssues: 0 },
    agentTraceAudit: { status: "complete", checkedSteps: 3, checkedCalls: 3, checkedObservations: 2, issues: [], omittedIssues: 0 },
    runs: [{ title: "Resume", surface: "web", runKind: "primary", runId: "run-1", verdict: "passed", evidence, omittedEvidence: 0 }], omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
}

function ref(path: string, sha256?: string): EvidenceRef {
  return { evidenceId: path, kind: "business", path, sha256, capturedAt: now, description: `Evidence 'quoted' <tag>` };
}

function explicitProof(passed: boolean): MissionProofClassification {
  return { status: "explicit", checkedRuns: 1, classifiedOracles: 1, businessOracles: 1,
    passedBusinessOracles: passed ? 1 : 0, failedBusinessOracles: passed ? 0 : 1, httpContractOracles: 0,
    requiredBusinessRuns: 1, requiredRunsWithPassingBusiness: passed ? 1 : 0,
    confirmedProductFindings: passed ? 0 : 1, findingsLinkedToFailingBusiness: passed ? 0 : 1,
    unlinkedFindingIds: [], omittedUnlinkedFindingIds: 0,
    legacyOracles: 0, unavailableRuns: 0, omittedRuns: 0, legacyRunIds: [], unavailableRunIds: [] };
}

async function file(path: string, content = "fact"): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("Mission report", () => {
  it("withdraws a saved result when Agent trace ownership cannot be verified", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "failed";
    delete input.agentTraceAudit;
    const missing = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(missing.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("ownership is missing or inconsistent") });
    input.agentTraceAudit = { status: "incomplete", checkedSteps: 1, checkedCalls: 1,
      checkedObservations: 1, issues: ["Observation run-1 is unowned."], omittedIssues: 0 };
    const mismatched = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(mismatched.result.testVerdict).toBe("inconclusive");
    expect(await readFile(mismatched.path, "utf8")).toContain("Agent trace gap: Observation run-1 is unowned.");
  });

  it("does not accept a saved project pass without a current frozen-review audit", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "passed";
    input.proofClassification = explicitProof(true);
    input.planning = { source: "workflow-inventory", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [],
      coverage: { requested: "project", source: "explicit", reason: "whole project", inventory: "bounded",
        workflowCoverage: "unmeasured", gaps: [] } };
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("reviewed source scope") });
  });

  it("labels an audited project pass as the reviewed source workflow scope", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "business.json"));
    const evidence = ref(path, createHash("sha256").update("fact").digest("hex"));
    const input = result(workspace, [evidence]);
    input.verdict = "passed";
    input.proofClassification = explicitProof(true);
    input.planning = { source: "workflow-inventory", confidence: 1, assumptions: [], missingInputs: [], evidenceGaps: [],
      coverage: { requested: "project", source: "explicit", reason: "whole project", inventory: "bounded",
        workflowCoverage: "unmeasured", gaps: [] } };
    input.scope.workflowReviewAudit = { status: "verified", keyId: "operator", scope: "reviewed-source-workflows" };
    const store = new MissionReportStore(workspace);
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([evidence], new Set(["run-1"]));
    const snapshot = await store.writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ testVerdict: "passed",
      testVerdictReason: expect.stringContaining("signed, source-bound reviewed workflow inventory") });
    const markup = await readFile(snapshot.path, "utf8");
    expect(markup).toContain("Reviewed source workflows");
    expect(markup).toContain("review quality determines whether its business list is semantically complete");
    expect(markup).not.toContain("Whole-project workflow coverage has not been proven.");
  });

  it("does not accept a saved pass without a recomputed execution-slot audit", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "passed";
    input.proofClassification = explicitProof(true);
    delete input.executionAudit;
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("execution Runs") });
  });

  it("does not present a confirmed product failure when observed Run facts are unaudited", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "failed";
    input.confirmedProductFindings = 1;
    input.proofClassification = explicitProof(false);
    delete input.executionAudit;
    const missing = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(missing.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("mismatched observed Runs") });
    input.executionAudit = { status: "incomplete", scope: "observed-failure", expectedSlots: 1,
      matchedSlots: 1, unexecutedSlots: 0, unexpectedObservations: 0,
      issues: ["Saved Run Charter differs from the frozen Mission scenario."], omittedIssues: 0 };
    const mismatched = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(mismatched.result.testVerdict).toBe("inconclusive");
    expect(await readFile(mismatched.path, "utf8")).toContain("Execution slot gap: Saved Run Charter differs");
  });

  it("downgrades a saved pass when the tested Git source changed during execution", async () => {
    const workspace = await root();
    const path = join(workspace, ".proofkit", "runs", "run-1", "artifacts", "fact.json");
    await file(path);
    const evidence = ref("run-1/artifacts/fact.json", createHash("sha256").update("fact").digest("hex"));
    const input = result(workspace, [evidence]);
    input.verdict = "passed";
    input.proofClassification = explicitProof(true);
    input.scope.sourceStability = "changed";
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("source changed during this Mission") });
    const markup = await readFile(snapshot.path, "utf8");
    expect(markup).toContain("Saved pass · source changed during execution");
    expect(markup).toContain("Git source stability during this Mission: changed");
    input.verdict = "failed";
    const failed = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(failed.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("source changed during this Mission") });
  });

  it("keeps a historical failure but withdraws a current defect claim after the checkout changes", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "failed";
    input.scope.sourceStability = "stable";
    input.scope.sourceFreshness = "changed";
    const changed = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(changed.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("changed since this Mission ended") });
    expect(await readFile(changed.path, "utf8")).toContain("Saved failure · source changed since execution");

    input.scope.sourceFreshness = "unavailable";
    const unavailable = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(unavailable.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("cannot be rechecked now") });
  });

  it("writes escaped static snapshots without changing saved acceptance or original state", async () => {
    const workspace = await root();
    const missionPath = await file(join(workspace, ".proofkit", "missions", "mission-report.json"), "original Mission");
    const input = result(workspace);
    input.intent = '<script>alert("bad")</script> & Resume';
    input.runs[0]!.title = 'Resume <img src="https://invalid.example/" onerror="bad">';
    input.runs[0]!.targetContinuity = "changed";
    input.runs.push({ title: "Rejected input", surface: "web", runKind: "negative", runId: "run-negative", verdict: "failed", expectedVerdict: "failed", outcomeMatched: true, evidence: [], omittedEvidence: 0 });
    const before = JSON.stringify(input);
    const report = await new MissionReportStore(workspace).writeReport(input);
    const markup = await readFile(report, "utf8");
    expect(markup).toContain("Acceptance inconclusive");
    expect(markup).toContain("Expected outcome matched");
    expect(markup).toContain("Target continuity: changed");
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
    input.proofClassification = explicitProof(true);
    input.planning = { source: "submitted", confidence: 0.5, assumptions: [], missingInputs: [], evidenceGaps: ["project-workflow-coverage"], coverage: { requested: "project", source: "explicit", reason: "Requested whole project", inventory: "partial", workflowCoverage: "unmeasured", gaps: ["project-map-truncated"] } };
    input.scope.uncoveredCharterIds = ["billing"];
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup).toContain("Whole project requested");
    expect(markup).toContain("workflow coverage has not been proven");
    expect(markup).toContain("source inventory is partial");
    expect(markup).toContain("Registered scenarios outside this Mission matrix: billing");
    expect(markup).toContain("Missing test requirements");
    expect(markup).toContain('id="outcome">Saved pass · current evidence unverified');
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

  it("keeps a compact partial report green only when the full Mission evidence audit is intact", async () => {
    const workspace = await root();
    const factPath = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "business.json"), "accepted");
    const evidence = ref(factPath, createHash("sha256").update("accepted").digest("hex"));
    const input = result(workspace, [evidence]);
    input.verdict = "passed";
    input.proofClassification = explicitProof(true);
    const store = new MissionReportStore(workspace);
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([evidence], new Set(["run-1"]));
    expect(input.acceptanceEvidenceIntegrity).toMatchObject({ status: "intact", references: { total: 1, intact: 1, omitted: 0 } });
    expect(await store.inspectMissionEvidence([evidence], new Set(["foreign-run"])))
      .toMatchObject({ status: "degraded", references: { unavailable: 1 } });
    const intact = await store.writeReportSnapshot(input);
    expect(intact.result).toMatchObject({ verdict: "passed", testVerdict: "passed", evidenceIntegrity: { status: "intact" } });
    expect(await readFile(intact.path, "utf8")).toContain('data-verdict="passed"');

    input.runs[0]!.omittedEvidence = 1;
    const partial = await store.writeReportSnapshot(input);
    expect(partial.result).toMatchObject({ verdict: "passed", testVerdict: "passed",
      acceptanceEvidenceIntegrity: { status: "intact" }, evidenceIntegrity: { status: "partial" } });
    expect(JSON.parse(await readFile(join(dirname(partial.path), "summary.json"), "utf8")))
      .toMatchObject({ verdict: "passed", testVerdict: "passed" });
    expect(await readFile(partial.path, "utf8")).toContain('data-verdict="passed"');

    input.runs[0]!.omittedEvidence = 0;
    await writeFile(factPath, "changed");
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([evidence], new Set(["run-1"]));
    const degraded = await store.writeReportSnapshot(input);
    expect(degraded.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      acceptanceEvidenceIntegrity: { status: "degraded" }, evidenceIntegrity: { status: "degraded" } });
    expect(await readFile(degraded.path, "utf8")).toContain("Saved pass · current evidence unverified");

    await writeFile(factPath, "accepted");
    input.acceptanceEvidenceIntegrity = { status: "partial", scope: "mission-evidence", checkedAt: now,
      references: { total: 2049, intact: 2048, unavailable: 0, legacy: 0, omitted: 1 } };
    const exceeded = await store.writeReportSnapshot(input);
    expect(exceeded.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("within its limits"), acceptanceEvidenceIntegrity: { status: "partial" } });
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
    input.proofClassification = explicitProof(false);
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "finding-1", category: "product", status: "confirmed", severity: "high",
      title: "Wrong binding", message: "Candidate relation is wrong", evidence: [evidence], createdAt: now }];
    const store = new MissionReportStore(workspace);
    const before = await store.writeReportSnapshot(input);
    expect(before.result.testVerdict).toBe("failed");
    expect(before.integrity).toMatchObject({ status: "intact", references: { total: 1, intact: 1, unavailable: 0, legacy: 0 },
      visibleConfirmedFindings: { saved: 1, supported: 1, unsupportedFindingIds: [] } });
    expect(await readFile(before.path, "utf8")).toContain("1 / 1 visible saved confirmed product finding(s) have all cited evidence");
    await writeFile(path, "changed binding");
    const current = await store.writeReportSnapshot(input);
    expect(current.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("cited evidence") });
    expect(current.integrity).toMatchObject({ status: "degraded", references: { total: 1, intact: 0, unavailable: 1, legacy: 0 },
      visibleConfirmedFindings: { saved: 1, supported: 0, unsupportedFindingIds: ["finding-1"] } });
    expect(await store.inspectIntegrity(input)).toMatchObject({ status: "degraded", visibleConfirmedFindings: { supported: 0 } });
    const markup = await readFile(current.path, "utf8");
    expect(markup).toContain("Saved failure · current evidence unverified");
    expect(markup).toContain('data-verdict="inconclusive"');
    expect(markup).toContain("saved confirmed · evidence currently unverified");
    expect(markup).toContain("0 / 1 visible saved confirmed product finding(s) have all cited evidence");
    expect(markup).toContain("cannot be independently confirmed from this report");
  });

  it("audits saved diagnosis and proposal support against real files and their failure Run", async () => {
    const workspace = await root();
    const sourcePath = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "failure.json"), "wrong binding");
    const otherPath = await file(join(workspace, ".proofkit", "runs", "run-2", "artifacts", "other.json"), "other fact");
    const source = ref(sourcePath, createHash("sha256").update("wrong binding").digest("hex"));
    const other = ref(otherPath, createHash("sha256").update("other fact").digest("hex"));
    const input = result(workspace, [source]);
    input.verdict = "failed";
    input.proofClassification = explicitProof(false);
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "binding", category: "product", status: "confirmed", severity: "high",
      title: "Wrong binding", message: "Current candidate relation is wrong", evidence: [source], createdAt: now }];
    input.diagnosis = { diagnosisId: "diagnosis-1", summary: "Inspect candidate relation", confidence: 0.8,
      sourceLocations: [], evidence: [source], createdAt: now };
    input.repairSuggestions = [{ suggestionId: "repair-1", title: "Repair candidate relation",
      rationale: "The observed relation is wrong", changes: ["Trace the relation writer"], confidence: 0.4,
      evidence: [source], status: "proposed" }];
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity.diagnosticSupport).toMatchObject({ diagnosis: { status: "supported" },
      repairSuggestions: [{ suggestionId: "repair-1", status: "supported" }] });
    expect(intact.result.testVerdict).toBe("failed");

    input.runs.push({ title: "Other Run", surface: "web", runKind: "primary", runId: "run-2",
      verdict: "passed", evidence: [other], omittedEvidence: 0 });
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([source, other], new Set(["run-1", "run-2"]));
    input.repairSuggestions[0]!.evidence = [source, other];
    const crossRun = await store.writeReportSnapshot(input);
    expect(crossRun.integrity.diagnosticSupport?.repairSuggestions[0]).toMatchObject({ status: "unsupported", reason: "cross-run-evidence" });
    expect(crossRun.result.testVerdict).toBe("failed");
    expect(JSON.parse(await readFile(join(dirname(crossRun.path), "summary.json"), "utf8")))
      .toMatchObject({ evidenceIntegrity: { diagnosticSupport: { repairSuggestions: [{ reason: "cross-run-evidence" }] } } });
    expect(await readFile(crossRun.path, "utf8")).toContain("Current proposal support: unsupported: cites evidence from multiple Runs");

    input.repairSuggestions[0]!.evidence = [other];
    expect((await store.writeReportSnapshot(input)).integrity.diagnosticSupport?.repairSuggestions[0])
      .toMatchObject({ status: "unsupported", reason: "unlinked-failure" });
    input.repairSuggestions[0]!.evidence = [source];
    await rm(sourcePath);
    const missing = await store.writeReportSnapshot(input);
    expect(missing.integrity.diagnosticSupport).toMatchObject({ diagnosis: { status: "unsupported", reason: "unavailable-evidence" },
      repairSuggestions: [{ status: "unsupported", reason: "unavailable-evidence" }] });
    expect(missing.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive" });
    expect(await readFile(missing.path, "utf8")).toContain("Current diagnosis support: unsupported: cited evidence is missing, changed or unverifiable");
    expect(input.repairSuggestions[0]!.status).toBe("proposed");
  });

  it("requires classified business proof for a saved product finding but preserves an evidenced test failure", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "failure.json"), "observed mismatch");
    const evidence = ref(path, createHash("sha256").update("observed mismatch").digest("hex"));
    const input = result(workspace, [evidence]);
    input.verdict = "failed";
    const store = new MissionReportStore(workspace);
    expect((await store.writeReportSnapshot(input)).result.testVerdict).toBe("failed");
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "legacy-finding", category: "product", status: "confirmed", severity: "high",
      title: "Business mismatch", message: "Saved without an Oracle kind", evidence: [evidence], createdAt: now }];
    const legacy = await store.writeReportSnapshot(input);
    expect(legacy.result).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("classified failing business Oracle in its own Run") });
    expect(await readFile(legacy.path, "utf8")).toContain("Saved failure · current business proof unverified");
    input.proofClassification = { status: "explicit", checkedRuns: 1, classifiedOracles: 1,
      businessOracles: 0, passedBusinessOracles: 0, failedBusinessOracles: 0, httpContractOracles: 1,
      requiredBusinessRuns: 1, requiredRunsWithPassingBusiness: 0,
      confirmedProductFindings: 1, findingsLinkedToFailingBusiness: 0,
      legacyOracles: 0, unavailableRuns: 0, omittedRuns: 0, legacyRunIds: [], unavailableRunIds: [] };
    expect((await store.writeReportSnapshot(input)).result.testVerdict).toBe("inconclusive");
  });

  it("does not treat a classified HTTP contract as passing business proof", async () => {
    const workspace = await root();
    const path = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "status.json"), "200");
    const input = result(workspace, [ref(path, createHash("sha256").update("200").digest("hex"))]);
    input.verdict = "passed";
    input.proofClassification = { status: "explicit", checkedRuns: 1, classifiedOracles: 1,
      businessOracles: 0, passedBusinessOracles: 0, failedBusinessOracles: 0, httpContractOracles: 1,
      requiredBusinessRuns: 1, requiredRunsWithPassingBusiness: 0,
      confirmedProductFindings: 0, findingsLinkedToFailingBusiness: 0,
      legacyOracles: 0, unavailableRuns: 0, omittedRuns: 0, legacyRunIds: [], unavailableRunIds: [] };
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      proofClassification: { status: "explicit", passedBusinessOracles: 0 } });
    expect(await readFile(snapshot.path, "utf8")).toContain("Saved pass · current business proof unverified");
  });

  it("does not let one Run's business pass certify another required Run", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.verdict = "passed";
    input.runs.push({ title: "Resume replay", surface: "web", runKind: "replay", runId: "run-2",
      verdict: "passed", evidence: [], omittedEvidence: 0 });
    input.proofClassification = { ...explicitProof(true), checkedRuns: 2, classifiedOracles: 2,
      httpContractOracles: 1, requiredBusinessRuns: 2, requiredRunsWithPassingBusiness: 1 };
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("every required Run") });
    const markup = await readFile(snapshot.path, "utf8");
    expect(markup).toContain("Required Run business proof: 1/2");
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
    input.proofClassification = explicitProof(false);
    input.confirmedProductFindings = 1;
    input.findings = [{ findingId: "finding-1", category: "product", status: "confirmed", severity: "high",
      title: "Wrong relation", message: "Two facts establish the wrong relation", evidence: [baseline, relation], createdAt: now }];
    input.comparison = {
      baselineMissionId: "baseline-mission", candidateMissionId: "candidate-mission",
      baselineScopeHash: "a".repeat(64), candidateScopeHash: "a".repeat(64), scopeMatched: true,
      sourceChange: "changed", baselineSourceStability: "stable", candidateSourceStability: "stable", status: "verified-in-scope",
      reason: "Saved comparison", gaps: [], runs: [{ surface: "web", runKind: "primary", baselineRunId: "run-3",
        baselineBusinessFacts: 1, candidateBusinessFacts: 0, baselineEvidence: [rowFact], candidateEvidence: [] }], omittedRuns: 0,
      defects: [{ surface: "web", oracleName: "relation", baselineRunId: "run-1", candidateRunId: "run-2",
        outcome: "not-reproduced", baselineEvidence: [baseline, relation], candidateEvidence: [candidate] }],
      omittedDefects: 0, comparedAt: now,
    };
    input.replayConsistency = { status: "diverge", expectedPairs: 1, comparedPairs: 1, divergentPairs: 1,
      unverifiedPairs: 0, pairs: [{ surface: "web", primaryRunId: "run-1", replayRunId: "run-2",
        primaryVerdict: "failed", replayVerdict: "passed", agreement: "diverge" }], omittedPairs: 0 };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity).toMatchObject({ status: "intact", comparison: "intact",
      references: { total: 4, intact: 4 },
      visibleConfirmedFindings: { supported: 1 } });
    const intactHtml = await readFile(intact.path, "utf8");
    expect(intactHtml).toContain('href="../../runs/run-2/artifacts/candidate.json"');
    expect(intactHtml).toContain("Baseline source: stable · Candidate source during replay: stable · Candidate source now: unverified");
    expect(intactHtml).toContain("Primary and replay verdicts differ");
    expect(intactHtml).toContain("two runs alone do not establish flakiness");

    input.comparison.status = "inconclusive";
    input.comparison.historicalStatus = "verified-in-scope";
    input.comparison.candidateSourceFreshness = "changed";
    input.comparison.reason = "Candidate source changed after replay.";
    const staleHtml = await readFile((await store.writeReportSnapshot(input)).path, "utf8");
    expect(staleHtml).toContain("Repair replay · current check");
    expect(staleHtml).toContain("Saved comparison before current source recheck: Original defect not reproduced in tested scope.");
    expect(staleHtml).toContain("Candidate source now: changed");
    input.comparison.status = "verified-in-scope";
    delete input.comparison.historicalStatus;
    delete input.comparison.candidateSourceFreshness;
    input.comparison.reason = "Saved comparison";

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
