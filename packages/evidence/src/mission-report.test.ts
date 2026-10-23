import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionResultSchema, RunSummarySchema, type EvidenceRef, type MissionProofClassification, type MissionResult } from "@proofkit/contracts";
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
  it.each([34, 205])("shows late planned operations without exceeding the action bound for %i actions", async (count) => {
    const workspace = await root();
    const actions = Array.from({ length: count }, () => ({ kind: "observe" as const }));
    const summary = RunSummarySchema.parse({ runId: "run-1", workspaceRoot: workspace, projectRoot: "/source", startedAt: now,
      status: "completed", verdict: "inconclusive", charter: { intent: "Checkout with late independent evidence", actions },
      steps: actions.slice(0, 33).map((action, index) => ({ stepId: "step-" + String(index + 1).padStart(3, "0"), action, status: "passed" })) });
    summary.charter.actions[32] = { kind: "captureResponse", name: "invoice-created", trigger: { kind: "click", selector: "#private-confirm",
      expectedTarget: { observedAt: now, tag: "button", role: "button", name: "Confirm order", groupName: "" } },
      response: { url: "http://localhost/invoices", method: "POST", statuses: [201], fields: { invoiceId: { pointer: "/id", type: "identifier" } } },
      requestWindowMs: 500, timeoutMs: 10000 };
    summary.charter.actions[20] = { kind: "fill", selector: "#private-field", value: "PRIVATE_LATE_INPUT_VALUE" };
    const bytes = JSON.stringify(summary);
    const source = await file(join(workspace, ".proofkit/runs/run-1/run.json"), bytes);
    const report = await file(join(workspace, ".proofkit/runs/run-1/report.html"), "original detailed report");
    const input = result(workspace, [{ ...ref(source, createHash("sha256").update(bytes).digest("hex")), kind: "snapshot" },
      { ...ref(report, createHash("sha256").update("original detailed report").digest("hex")), kind: "report" }]);
    const store = new MissionReportStore(workspace);
    const markup = await readFile(await store.writeReport(input), "utf8");
    expect(markup).toContain("#step-033"); expect(markup).toContain("Submit and capture selected API facts · Confirm order");
    expect(markup).toContain("#step-034"); expect(markup).toContain("status-not-run");
    expect(markup).not.toContain("PRIVATE_LATE_INPUT_VALUE"); expect(markup).not.toContain("#private-confirm");
    if (count > 200) {
      expect(markup).toContain("#step-200"); expect(markup).not.toContain("#step-201");
      expect(markup).toContain("5 later planned action(s) omitted from this overview.");
    } else expect(markup).not.toContain("later planned action(s) omitted from this overview.");
    await writeFile(source, bytes.replace("Confirm order", "Forged late operation"));
    const changed = await readFile(await store.writeReport(input), "utf8");
    expect(changed).toContain("Workflow details are withheld"); expect(changed).not.toContain("Confirm order"); expect(changed).not.toContain("Forged late operation");
  });
  it("shows original workflow actions and checks while withholding altered source details and images", async () => {
    const workspace = await root();
    const runPath = join(workspace, ".proofkit", "runs", "run-1");
    const summary = RunSummarySchema.parse({ runId: "run-1", workspaceRoot: workspace, projectRoot: "/source", startedAt: now, endedAt: now,
      status: "completed", verdict: "passed", charter: { intent: "Save note", actions: [
        { kind: "fill", selector: "#private", value: "DO_NOT_DISPLAY_THIS_VALUE", expectedTarget: { observedAt: now, tag: "input", role: "textbox", name: "Note", groupName: "" } },
        { kind: "click", selector: "#save", expectedTarget: { observedAt: now, tag: "button", role: "button", name: "Save note", groupName: "" } },
        { kind: "waitForText", text: "Later expected text" }], assertions: [] },
      steps: [{ stepId: "step-001", action: { kind: "fill", selector: "#private", value: "DO_NOT_DISPLAY_THIS_VALUE" }, status: "passed", artifacts: ["run-1/artifacts/step-001.png"] },
        { stepId: "step-002", action: { kind: "click", selector: "#save" }, status: "passed" }],
      assertions: [{ assertion: { kind: "text-visible", text: "Note saved" }, passed: true, message: "Visible", evidence: [] }],
      oracles: [{ name: "current-note", passed: true, verificationKind: "business", message: "Stored", evidence: [] }] });
    const source = JSON.stringify(summary);
    const sourcePath = await file(join(runPath, "run.json"), source);
    const image = await file(join(runPath, "artifacts", "step-001.png"), "original pixels");
    const report = await file(join(runPath, "report.html"), "original report");
    const input = result(workspace, [{ ...ref(sourcePath, createHash("sha256").update(source).digest("hex")), kind: "snapshot" },
      { ...ref(image, createHash("sha256").update("original pixels").digest("hex")), kind: "screenshot" },
      { ...ref(report, createHash("sha256").update("original report").digest("hex")), kind: "report" }]);
    const store = new MissionReportStore(workspace);
    const intact = await readFile(await store.writeReport(input), "utf8");
    expect(intact).toContain("Workflow actions and checks");
    expect(intact).toContain("Fill input · Note");
    expect(intact).toContain("Click · Save note");
    expect(intact).toContain("Expected visible text: Note saved");
    expect(intact).toContain("current-note · Business: <strong>passed");
    expect(intact).toContain("not-run");
    expect(intact).toContain("#step-001");
    expect(intact).toContain('class="workflow-image"');
    expect(intact).toContain("img-src 'self' file:");
    expect(intact).not.toContain("DO_NOT_DISPLAY_THIS_VALUE");
    await writeFile(image, "changed pixels");
    const changedImage = await readFile(await store.writeReport(input), "utf8");
    expect(changedImage).toContain("Click · Save note");
    expect(changedImage).not.toContain('class="workflow-image"');
    await writeFile(sourcePath, source.replaceAll("Save note", "Forged operation"));
    const changedSource = await readFile(await store.writeReport(input), "utf8");
    expect(changedSource).toContain("Workflow details are withheld");
    expect(changedSource).not.toContain("Click · Save note");
    expect(changedSource).not.toContain("Forged operation");
  });

  it("does not turn a workflow presentation byte limit into an acceptance integrity failure", async () => {
    const workspace = await root();
    const summary = RunSummarySchema.parse({ runId: "run-1", workspaceRoot: workspace, projectRoot: "/source", startedAt: now, status: "completed",
      charter: { intent: "Large source", metadata: { context: "x".repeat(4 * 1024 * 1024) } } });
    const source = JSON.stringify(summary);
    const sourcePath = await file(join(workspace, ".proofkit", "runs", "run-1", "run.json"), source);
    const input = result(workspace, [{ ...ref(sourcePath, createHash("sha256").update(source).digest("hex")), kind: "snapshot" }]);
    const saved = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(saved.integrity.references.unavailable).toBe(0);
    expect(await readFile(saved.path, "utf8")).toContain("outside the bounded detail view");
  });

  it.each([1, 2])("rechecks %i planning-state sources independently of business acceptance references", async (sourceCount) => {
    const workspace = await root();
    const inspectionId = "inspection-1";
    const paths = ["artifacts/step-001-after.json", "report.html", "manifest.json"];
    const sources = await Promise.all(Array.from({ length: sourceCount }, async (_, index) => {
      const runId = index === 0 ? inspectionId : `inspection-${index + 1}`;
      const evidence = await Promise.all(paths.map(async (path) => {
        const target = await file(join(workspace, ".proofkit", "runs", runId, path), path);
        return { ...ref(target, createHash("sha256").update(path).digest("hex")), kind: "snapshot" as const };
      }));
      return { evidence, state: { capturedAt: now, controlsTruncated: false, source: { runId,
        manifestSha256: evidence[2]!.sha256!, snapshotPath: `${runId}/artifacts/step-001-after.json`, snapshotSha256: evidence[0]!.sha256! } } };
    }));
    const evidence = sources.flatMap((source) => source.evidence);
    const input = result(workspace);
    input.planningObservation = { status: "verified", reason: "Original planning source verified", evidence,
      observation: sourceCount === 1 ? sources[0]!.state : { capturedAt: now, controlsTruncated: false, sources: sources.map((source) => source.state) } };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity.references.total).toBe(0);
    expect(await readFile(intact.path, "utf8")).toContain(`../../runs/${inspectionId}/report.html`);
    for (const source of sources) expect(await readFile(intact.path, "utf8")).toContain(`../../runs/${source.state.source.runId}/report.html`);
    for (const ref of evidence) {
      const saved = await readFile(ref.path); await writeFile(ref.path, "changed planning context");
      const changed = await store.writeReportSnapshot(input);
      expect(changed.result.planningObservation).toMatchObject({ status: "unverified", evidence: [] });
      expect(changed.result.testVerdict).toBe(intact.result.testVerdict);
      expect(changed.integrity.references).toEqual(intact.integrity.references);
      expect(await readFile(changed.path, "utf8")).not.toContain(`href="../../runs/${inspectionId}/`);
      for (const source of sources) expect(await readFile(changed.path, "utf8")).not.toContain(`href="../../runs/${source.state.source.runId}/`);
      await writeFile(ref.path, saved);
    }
    input.planningObservation.evidence = [];
    expect((await store.writeReportSnapshot(input)).result.planningObservation?.status).toBe("unverified");
  });

  it.each(["recorded", "partial"] as const)("presents verified %s session video separately and withdraws links after evidence changes", async (status) => {
    const workspace = await root();
    const captureId = "session-network-00000000-0000-4000-8000-000000000001";
    const paths = ["run.json", "report.html", "events.jsonl", "artifacts/recording.webm", "manifest.json"];
    const evidence = await Promise.all(paths.map(async (path): Promise<EvidenceRef> => {
      const target = await file(join(workspace, ".proofkit", "runs", captureId, path), path);
      return { ...ref(target, createHash("sha256").update(path).digest("hex")), kind: path.endsWith(".webm") ? "video" : "other" };
    }));
    const input = result(workspace);
    input.sessionCaptures = { omittedSegments: 1, segments: [{ runId: captureId, sessionId: "00000000-0000-4000-8000-000000000001", integrity: "intact", reason: "Original local seal verified",
      capture: { runId: captureId, status: "partial", closed: true, events: 10, omittedEvents: 2, unresolvedRequests: 1, networkEnabled: true,
        recording: { status, artifact: `${captureId}/artifacts/recording.webm`, ...(status === "partial" ? { stopReason: "duration-limit" as const } : {}) } }, evidence }] };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    const markup = await readFile(intact.path, "utf8");
    expect(markup).toContain("Session evidence");
    expect(markup).toContain("Capture completeness: partial");
    if (status === "partial") expect(markup).toContain("Recording stopped: duration-limit. Requested evidence is incomplete.");
    expect(markup).toContain("10 event(s) · 2 omitted · 1 unresolved");
    expect(markup).toContain(`<video controls preload="metadata"`);
    expect(markup).toContain(`../../runs/${captureId}/artifacts/recording.webm`);
    expect(markup).toContain("media-src 'self' file:");
    expect(intact.integrity.references.total).toBe(0);
    for (const artifact of evidence) {
      const original = await readFile(artifact.path);
      await writeFile(artifact.path, "changed");
      const changed = await store.writeReportSnapshot(input);
      const rendered = await readFile(changed.path, "utf8");
      expect(changed.result.sessionCaptures?.segments[0]).toMatchObject({ integrity: "unverified", evidence: [] });
      expect(rendered).not.toContain("<video");
      expect(rendered).not.toContain(`href="../../runs/${captureId}/`);
      expect(changed.result.testVerdict).toBe(intact.result.testVerdict);
      expect(changed.integrity).toEqual({ ...intact.integrity, checkedAt: changed.integrity.checkedAt });
      await writeFile(artifact.path, original);
    }
  });

  it("presents every verified selected clip without treating footage as business acceptance", async () => {
    const workspace = await root();
    const runId = "session-network-00000000-0000-4000-8000-000000000001";
    const paths = ["run.json", "report.html", "events.jsonl", "artifacts/recording.webm", "artifacts/selected-page-001.webm", "artifacts/selected-page-002.webm", "manifest.json"];
    const evidence = await Promise.all(paths.map(async (item): Promise<EvidenceRef> => {
      const target = await file(join(workspace, ".proofkit", "runs", runId, item), item);
      return { ...ref(target, createHash("sha256").update(item).digest("hex")), kind: item.endsWith(".webm") ? "video" : "other" };
    }));
    const input = result(workspace);
    input.sessionCaptures = { omittedSegments: 0, segments: [{ runId, sessionId: "00000000-0000-4000-8000-000000000001", integrity: "intact", reason: "Original capture verified",
      capture: { runId, status: "sealed", closed: true, events: 0, omittedEvents: 0, unresolvedRequests: 0, networkEnabled: false,
        recording: { status: "recorded", artifact: `${runId}/artifacts/recording.webm`, selectedPages: { observed: 2, artifacts: [`${runId}/artifacts/selected-page-001.webm`, `${runId}/artifacts/selected-page-002.webm`], omitted: 0 } } }, evidence }] };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity.references.total).toBe(0);
    expect((await readFile(intact.path, "utf8")).match(/<video /g)).toHaveLength(3);
    expect(await readFile(intact.path, "utf8")).toContain("Video pixels are not redacted and may contain sensitive data");
    const selectedPath = evidence.find((entry) => entry.path.endsWith("selected-page-002.webm"))!.path;
    await writeFile(selectedPath, "tampered window");
    const changed = await store.writeReportSnapshot(input);
    expect(changed.result.sessionCaptures!.segments[0]).toMatchObject({ evidence: [], integrity: "unverified" });
    expect(changed.result.testVerdict).toBe(intact.result.testVerdict);
    expect(await readFile(changed.path, "utf8")).not.toContain("<video");
  });

  it("rechecks frozen prior-session evidence without counting it as Mission acceptance proof", async () => {
    const workspace = await root();
    const current = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "fact.json"));
    const previous = await file(join(workspace, ".proofkit", "runs", "prior-run", "artifacts", "step-001.png"), "prior pixels");
    const digest = (content: string) => createHash("sha256").update(content).digest("hex");
    const input = result(workspace, [ref(current, digest("fact"))]);
    input.sessionContext = { sessionId: "00000000-0000-4000-8000-000000000001", capturedAt: now, omittedRuns: 1,
      runs: [{ runId: "prior-run", startedAt: now, evidence: [{ ...ref(previous, digest("prior pixels")), kind: "screenshot" }] }] };
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    const markup = await readFile(intact.path, "utf8");
    expect(markup).toContain("Prior session context");
    expect(markup).toContain("they are not execution or business proof for this Mission");
    expect(markup).toContain("../../runs/prior-run/artifacts/step-001.png");
    expect(markup).toContain("1 prior Run(s) omitted or unavailable");
    expect(intact.integrity.references).toMatchObject({ total: 1, intact: 1 });
    await writeFile(previous, "changed pixels");
    const changed = await store.writeReportSnapshot(input);
    expect(await readFile(changed.path, "utf8")).toContain("Screenshot unavailable or changed");
    expect(changed.integrity.references).toMatchObject({ total: 1, intact: 1 });
    expect(changed.result.testVerdict).toBe(intact.result.testVerdict);
    expect(changed.result.sessionContext).toEqual(input.sessionContext);
    await rm(previous);
    expect(await readFile(await store.writeReport(input), "utf8")).toContain("Screenshot unavailable or changed");
  });

  it("rejects a context artifact belonging to another Run even when that artifact is valid Mission evidence", async () => {
    const workspace = await root();
    const current = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "fact.json"));
    const evidence = ref(current, createHash("sha256").update("fact").digest("hex"));
    const input = result(workspace, [evidence]);
    input.sessionContext = { sessionId: "00000000-0000-4000-8000-000000000001", capturedAt: now, omittedRuns: 0,
      runs: [{ runId: "prior-run", startedAt: now, evidence: [evidence] }] };
    const snapshot = await new MissionReportStore(workspace).writeReportSnapshot(input);
    expect(snapshot.integrity.references).toMatchObject({ total: 1, intact: 1 });
    expect(await readFile(snapshot.path, "utf8")).toContain("Business fact unavailable or changed");
  });

  it("renders the bounded plan narrative alongside execution evidence", async () => {
    const workspace = await root();
    const input = result(workspace);
    input.planSummary = {
      planId: "plan-report",
      generatedBy: "deterministic-planner-v1",
      successCriteria: ["页面显示登录成功"],
      assumptions: ["使用隔离测试账号"],
      tasks: [{ taskId: "execute-login", title: "执行登录主流程", objective: "确认登录后的页面状态", tool: "surface.run-charter", dependsOn: ["reconnaissance"], status: "passed" }],
    };
    input.planning = { source: "model", confidence: 0.8, assumptions: [], missingInputs: [], evidenceGaps: [] };
    const markup = await readFile(await new MissionReportStore(workspace).writeReport(input), "utf8");
    expect(markup).toContain("Test plan");
    expect(markup).toContain("页面显示登录成功");
    expect(markup).toContain("执行登录主流程");
    expect(markup).toContain("确认登录后的页面状态");
    expect(markup).toContain("Planning source: model");
    expect(markup).toContain("confidence: 0.8");
    expect(markup).toContain("no evidence gaps recorded");
  });

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
    expect(await readFile(intact.path, "utf8")).toContain("saved confirmed product finding occurrence(s)");
    expect(await readFile(intact.path, "utf8")).toContain("Acceptance evidence intact");

    input.repairSuggestions = [{ suggestionId: "advisory-only", title: "Investigate an unrelated observation",
      rationale: "This proposal has no acceptance role", changes: ["Inspect the source"], confidence: 0.2,
      evidence: [{ ...evidence, evidenceId: "missing-advisory", path: join(dirname(factPath), "missing-advisory.json") }],
      status: "proposed" }];
    const unsupportedAdvice = await store.writeReportSnapshot(input);
    expect(unsupportedAdvice.result).toMatchObject({ verdict: "passed", testVerdict: "passed",
      evidenceIntegrity: { status: "degraded", diagnosticSupport: { repairSuggestions: [{ status: "unsupported" }] } },
      acceptanceEvidenceIntegrity: { status: "intact" } });
    input.repairSuggestions = [];

    input.runs[0]!.omittedEvidence = 1;
    const partial = await store.writeReportSnapshot(input);
    expect(partial.result).toMatchObject({ verdict: "passed", testVerdict: "passed",
      acceptanceEvidenceIntegrity: { status: "intact" }, evidenceIntegrity: { status: "partial" } });
    expect(JSON.parse(await readFile(join(dirname(partial.path), "summary.json"), "utf8")))
      .toMatchObject({ verdict: "passed", testVerdict: "passed" });
    expect(await readFile(partial.path, "utf8")).toContain('data-verdict="passed"');
    expect(await readFile(partial.path, "utf8")).toContain("Acceptance evidence intact");
    expect(await readFile(partial.path, "utf8")).toContain("1 detail reference(s) omitted from overview");
    expect(await readFile(partial.path, "utf8")).not.toContain("Evidence partial");

    input.runs[0]!.omittedEvidence = 0;
    await writeFile(factPath, "changed");
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([evidence], new Set(["run-1"]));
    const degraded = await store.writeReportSnapshot(input);
    expect(degraded.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      acceptanceEvidenceIntegrity: { status: "degraded" }, evidenceIntegrity: { status: "degraded" } });
    expect(await readFile(degraded.path, "utf8")).toContain("Saved pass · current evidence unverified");
    expect(await readFile(degraded.path, "utf8")).toContain("Acceptance evidence degraded");

    await writeFile(factPath, "accepted");
    input.acceptanceEvidenceIntegrity = { status: "partial", scope: "mission-evidence", checkedAt: now,
      references: { total: 2049, intact: 2048, unavailable: 0, legacy: 0, omitted: 1 } };
    const exceeded = await store.writeReportSnapshot(input);
    expect(exceeded.result).toMatchObject({ verdict: "passed", testVerdict: "inconclusive",
      testVerdictReason: expect.stringContaining("within its limits"), acceptanceEvidenceIntegrity: { status: "partial" } });
    expect(await readFile(exceeded.path, "utf8")).toContain("Acceptance evidence partial");
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
    input.diagnosis = { diagnosisId: "diagnosis-1", findingId: "binding", summary: "Inspect candidate relation", confidence: 0.8,
      sourceLocations: [], evidence: [source], createdAt: now };
    input.repairSuggestions = [{ suggestionId: "repair-1", findingId: "binding", title: "Repair candidate relation",
      rationale: "The observed relation is wrong", changes: ["Trace the relation writer"], confidence: 0.4,
      evidence: [source], status: "proposed" }];
    const store = new MissionReportStore(workspace);
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity.diagnosticSupport).toMatchObject({ diagnosis: { status: "supported" },
      repairSuggestions: [{ suggestionId: "repair-1", status: "supported" }] });
    expect(intact.result.testVerdict).toBe("failed");
    expect(await readFile(intact.path, "utf8")).toContain("For finding: Wrong binding");

    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([source], new Set(["run-1"]));
    input.repairSuggestions[0]!.findingId = "another-finding";
    const wrongFinding = await store.writeReportSnapshot(input);
    expect(wrongFinding.integrity.diagnosticSupport?.repairSuggestions[0])
      .toMatchObject({ status: "unsupported", reason: "unlinked-failure" });
    expect(wrongFinding.result.testVerdict).toBe("failed");
    expect(await readFile(wrongFinding.path, "utf8")).toContain("Finding link unavailable");
    input.repairSuggestions[0]!.findingId = "binding";

    delete input.diagnosis.findingId;
    delete input.repairSuggestions[0]!.findingId;
    const historical = await store.writeReportSnapshot(input);
    expect(historical.integrity.diagnosticSupport).toMatchObject({ diagnosis: { status: "supported" },
      repairSuggestions: [{ status: "supported" }] });
    input.diagnosis.findingId = "binding";
    input.repairSuggestions[0]!.findingId = "binding";

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

  it("shows each scenario diagnosis with its own Finding and Run evidence", async () => {
    const workspace = await root();
    const uiPath = await file(join(workspace, ".proofkit", "runs", "run-1", "artifacts", "ui.json"), "ui mismatch");
    const businessPath = await file(join(workspace, ".proofkit", "runs", "run-2", "artifacts", "business.json"), "wrong relation");
    const ui = ref(uiPath, createHash("sha256").update("ui mismatch").digest("hex"));
    const business = ref(businessPath, createHash("sha256").update("wrong relation").digest("hex"));
    const input = result(workspace, [ui]);
    input.verdict = "failed";
    input.proofClassification = explicitProof(false);
    input.runs.push({ title: "Business", surface: "electron", runKind: "primary", runId: "run-2",
      verdict: "failed", evidence: [business], omittedEvidence: 0 });
    input.findings = [
      { findingId: "ui", category: "unknown", status: "confirmed", severity: "medium", title: "UI mismatch",
        message: "Wrong page state", evidence: [ui], createdAt: now },
      { findingId: "business", category: "product", status: "confirmed", severity: "high", title: "Wrong relation",
        message: "Candidate relation is wrong", evidence: [business], createdAt: now },
    ];
    input.confirmedProductFindings = 1;
    input.diagnosis = { diagnosisId: "business-diagnosis", findingId: "business", summary: "Trace relation writer",
      confidence: 0.6, sourceLocations: [], evidence: [business], createdAt: now };
    input.diagnoses = [input.diagnosis, { diagnosisId: "ui-diagnosis", findingId: "ui",
      summary: "Check page expectation", confidence: 0.4, sourceLocations: [], evidence: [ui], createdAt: now }];
    const store = new MissionReportStore(workspace);
    input.acceptanceEvidenceIntegrity = await store.inspectMissionEvidence([ui, business], new Set(["run-1", "run-2"]));
    const intact = await store.writeReportSnapshot(input);
    expect(intact.integrity.diagnosticSupport?.diagnoses).toMatchObject([
      { diagnosisId: "business-diagnosis", status: "supported" },
      { diagnosisId: "ui-diagnosis", status: "supported" },
    ]);
    const markup = await readFile(intact.path, "utf8");
    expect(markup).toContain("Diagnosis 1 · Mission headline");
    expect(markup).toContain("For finding: Wrong relation");
    expect(markup).toContain("For finding: UI mismatch");
    expect(markup).toContain("Check page expectation");

    input.diagnoses[1]!.findingId = "business";
    const wrongLink = await store.writeReportSnapshot(input);
    expect(wrongLink.integrity.diagnosticSupport?.diagnoses[1])
      .toMatchObject({ status: "unsupported", reason: "unlinked-failure" });
    expect(wrongLink.result.testVerdict).toBe("failed");
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
