import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionResultSchema, RunSummarySchema, type Assertion, type EvidenceRef } from "@proofkit/contracts";
import { projectMissionChecks, type MissionCheckSource } from "./mission-checks.js";
import { MissionReportStore } from "./mission-report.js";

const now = "2026-10-21T00:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
function source(): MissionCheckSource {
  return { run: { runId: "run-checks", title: "Save private note", runKind: "primary", evidence: [], omittedEvidence: 0 },
    summaryEvidence: { evidenceId: "summary", kind: "snapshot", path: "run-checks/run.json", sha256: "a".repeat(64), capturedAt: now },
    summary: RunSummarySchema.parse({ runId: "run-checks", startedAt: now, status: "completed", verdict: "inconclusive",
      charter: { intent: "Save private note", actions: [], assertions: [{ kind: "text-visible", text: "Note saved" }, { kind: "text-visible", text: "Reloaded note" }], oracles: ["current-note", "other-account"] },
      assertions: [{ assertion: { kind: "text-visible", text: "Note saved" }, passed: true, message: "Visible", evidence: [] }],
      oracles: [{ name: "current-note", passed: null, verificationKind: "business", message: "Independent observation unavailable", evidence: [] }] }) };
}
const identity = (value: string) => value;

describe("saved Mission check overview", () => {
  it("keeps successful UI, unknown business and unreached expectations separate", () => {
    const overview = projectMissionChecks([source()], 0, identity);
    expect(overview.counts).toEqual({ passed: 1, failed: 0, inconclusive: 1, "not-recorded": 2, unverified: 0 });
    expect(overview.items[0]).toMatchObject({ expected: "current-note", kind: "business", status: "inconclusive" });
    expect(overview.items.find((item) => item.expected.includes("Reloaded note"))).toMatchObject({ status: "not-recorded" });
    expect(overview.items.find((item) => item.expected === "other-account")).toMatchObject({ status: "not-recorded", kind: "unclassified" });
  });

  it("matches assertions by their declaration rather than result array position", () => {
    const input = source();
    input.summary!.assertions.unshift({ assertion: { kind: "text-visible", text: "Reloaded note" }, passed: false, message: "Missing after reload", evidence: [] });
    const overview = projectMissionChecks([input], 0, identity);
    expect(overview.items[0]).toMatchObject({ expected: "Expected visible text: Reloaded note", status: "failed", observed: "Missing after reload" });
    expect(overview.counts.passed).toBe(1);
  });

  it("never promotes an undeclared or ambiguous result to a matching pass", () => {
    const input = source();
    input.summary!.assertions.push({ ...input.summary!.assertions[0]!, passed: false });
    input.summary!.oracles.push({ ...input.summary!.oracles[0]!, passed: true }, { name: "invented-proof", passed: true, verificationKind: "business", message: "Pass", evidence: [] });
    const overview = projectMissionChecks([input], 0, identity);
    expect(overview.counts.passed).toBe(0);
    expect(overview.counts.unverified).toBe(4);
    expect(overview.items.find((item) => item.expected === "invented-proof")?.status).toBe("unverified");
  });

  it("does not label an HTTP contract or legacy reader as independent business proof", () => {
    const input = source();
    input.summary!.oracles = [{ name: "current-note", passed: true, verificationKind: "http-contract", message: "HTTP200", evidence: [] },
      { name: "other-account", passed: true, message: "Legacy observation", evidence: [] }];
    const overview = projectMissionChecks([input], 0, identity);
    expect(overview.items.find((item) => item.expected === "current-note")?.kind).toBe("http-contract");
    expect(overview.items.find((item) => item.expected === "other-account")?.kind).toBe("unclassified");
  });

  it("withholds unavailable summaries instead of trusting aggregate pass counts", () => {
    const input = source(); input.summary = undefined; input.run.assertions = { passed: 9, total: 9 };
    const overview = projectMissionChecks([input], 3, identity);
    expect(overview).toMatchObject({ inspectedRuns: 0, unavailableRuns: [{ runId: "run-checks" }], omittedRuns: 3, items: [], counts: { passed: 0 } });
  });

  it("prioritizes late failures while bounding rows and preserving complete inspected counts", () => {
    const input = source();
    input.summary!.charter.assertions = Array.from({ length: 105 }, (_, index): Assertion => ({ kind: "text-visible", text: "Check " + index }));
    input.summary!.assertions = input.summary!.charter.assertions.map((assertion, index) => ({ assertion, passed: index !== 104, message: "Result " + index, evidence: [] }));
    input.summary!.charter.oracles = []; input.summary!.oracles = [];
    const overview = projectMissionChecks([input], 0, identity);
    expect(overview.items).toHaveLength(100); expect(overview.omittedChecks).toBe(5);
    expect(overview.counts).toMatchObject({ passed: 104, failed: 1 });
    expect(overview.items[0]).toMatchObject({ expected: "Expected visible text: Check 104", status: "failed" });
  });

  it("links only supplied verified check artifacts and keeps unmatched paths explicit", () => {
    const input = source();
    const sourceRef = { evidenceId: "facts", kind: "business" as const, path: "C:/workspace/.proofkit/runs/run-checks/artifacts/facts.json", sha256: "b".repeat(64), capturedAt: now };
    input.checkEvidence = [sourceRef];
    input.summary!.oracles[0]!.sourceEvidenceArtifacts = ["run-checks/artifacts/facts.json"];
    input.summary!.oracles[0]!.evidence = ["run-checks/artifacts/facts.json", "run-checks/artifacts/result.json", "other-run/artifacts/facts.json", "run-checks/../run-checks/artifacts/facts.json"];
    const item = projectMissionChecks([input], 0, identity).items.find((check) => check.expected === "current-note");
    expect(item?.evidence).toEqual([sourceRef]); expect(item?.unlinkedEvidence).toBe(3);
    expect(item?.status).toBe("inconclusive");
  });

  it("presents connector-declared field names only with a unique failing business result and linked source", () => {
    const input = source();
    const sourceRef = { evidenceId: "source", kind: "business" as const, path: "C:/workspace/.proofkit/runs/run-checks/artifacts/oracle-source.json",
      sha256: "a".repeat(64), capturedAt: now };
    input.summary!.oracles[0]!.passed = false;
    input.summary!.oracles[0]!.fieldMismatches = ["note.title"];
    input.summary!.oracles[0]!.sourceEvidenceArtifacts = ["run-checks/artifacts/oracle-source.json"];
    expect(projectMissionChecks([input], 0, identity).items.find((item) => item.expected === "current-note")?.fieldMismatches).toBeUndefined();
    input.checkEvidence = [sourceRef];
    const check = projectMissionChecks([input], 0, identity).items.find((item) => item.expected === "current-note");
    expect(check).toMatchObject({ status: "failed", fieldMismatches: ["note.title"], evidence: [sourceRef] });
    input.summary!.charter.oracles = ["current-note", "current-note"];
    expect(projectMissionChecks([input], 0, identity).items.find((item) => item.expected === "current-note")?.fieldMismatches).toBeUndefined();
  });

  it("does not hide repeated independent expectations behind a single result", () => {
    const input = source(); input.summary!.charter.oracles = ["current-note", "current-note"];
    input.summary!.oracles[0]!.passed = true;
    const overview = projectMissionChecks([input], 0, identity);
    expect(overview.items.find((check) => check.expected === "current-note")).toMatchObject({ status: "unverified" });
    expect(overview.counts.passed).toBe(1);
  });

  it("includes a later Run beyond the old ten-Run workflow presentation cap", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-late-check-")); roots.push(workspace);
    const original = source();
    const runs = [];
    for (let index = 0; index < 11; index++) {
      const runId = "run-" + index; const summary = structuredClone(original.summary!);
      summary.runId = runId; summary.workspaceRoot = workspace; summary.projectRoot = "/source";
      summary.charter.assertions = [{ kind: "text-visible", text: "Expected " + index }]; summary.charter.oracles = []; summary.oracles = [];
      summary.assertions = [{ assertion: summary.charter.assertions[0]!, passed: index !== 10, message: "Saved outcome " + index, evidence: [] }];
      const directory = join(workspace, ".proofkit", "runs", runId); await mkdir(directory, { recursive: true });
      const sourcePath = join(directory, "run.json"); const bytes = JSON.stringify(summary); await writeFile(sourcePath, bytes);
      runs.push({ ...original.run, runId, title: "Scenario " + index, evidence: [{ ...original.summaryEvidence!, path: sourcePath, evidenceId: runId, sha256: createHash("sha256").update(bytes).digest("hex") }] });
    }
    const mission = MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-late", projectRoot: "/source", workspaceRoot: workspace,
      intent: "Review all scenarios", status: "completed", running: false, verdict: "inconclusive", level: "core", revision: 1, updatedAt: now, generatedAt: now,
      scope: { surfaces: ["web"], charterCount: 11, uncoveredCharterIds: [] }, tasks: { total: 11, settled: 11, failed: 1, blocked: 0, skipped: 0 }, expectedRuns: 11, observedRuns: 11,
      runs, omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
    const saved = await new MissionReportStore(workspace).writeReportSnapshot(mission);
    expect(saved.result.checkOverview).toMatchObject({ inspectedRuns: 11, unavailableRuns: [], counts: { passed: 10, failed: 1 } });
    expect(saved.result.checkOverview?.items[0]).toMatchObject({ runId: "run-10", status: "failed" });
  });

  it("regenerates HTML and JSON from pinned original summaries and withdraws changed details", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-check-overview-")); roots.push(workspace);
    const input = source(); input.summary!.projectRoot = "/source"; input.summary!.workspaceRoot = workspace;
    input.summary!.charter.assertions[0] = { kind: "text-visible", text: "Email owner@example.invalid token=private-value <script>" };
    input.summary!.assertions[0]!.assertion = input.summary!.charter.assertions[0]!;
    input.summary!.assertions[0]!.message = "Bearer private-access-token owner@example.invalid <script>";
    const directory = join(workspace, ".proofkit", "runs", "run-checks"); await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify(input.summary); const summaryPath = join(directory, "run.json"); await writeFile(summaryPath, bytes);
    const reportPath = join(directory, "report.html"); await writeFile(reportPath, "Original Run report");
    const ref = (path: string, content: string, kind: EvidenceRef["kind"]): EvidenceRef => ({ evidenceId: path, kind, path, sha256: createHash("sha256").update(content).digest("hex"), capturedAt: now });
    const mission = MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-checks", projectRoot: "/source", workspaceRoot: workspace,
      intent: "Verify private note", status: "completed", running: false, verdict: "inconclusive", level: "core", revision: 1, updatedAt: now, generatedAt: now,
      scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 1, settled: 1, failed: 0, blocked: 0, skipped: 0 }, expectedRuns: 1, observedRuns: 1,
      runs: [{ ...input.run, evidence: [ref(summaryPath, bytes, "snapshot"), ref(reportPath, "Original Run report", "report")] }], omittedRunResults: 0, findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
    const store = new MissionReportStore(workspace); const saved = await store.writeReportSnapshot(mission);
    const markup = await readFile(saved.path, "utf8");
    expect(markup).toContain("Expected outcomes and recorded checks"); expect(markup).toContain('href="#checks"');
    expect(markup.indexOf('id="checks"')).toBeLessThan(markup.indexOf('id="workflow-detail"'));
    const overview = JSON.stringify(saved.result.checkOverview);
    expect(overview).toContain("[REDACTED_EMAIL]"); expect(overview).not.toContain("private-value"); expect(overview).not.toContain("private-access-token");
    expect(markup).toContain("&lt;script&gt;"); expect(markup).not.toContain("<script>");
    expect(saved.result.checkOverview?.counts).toMatchObject({ passed: 1, inconclusive: 1, "not-recorded": 2 });
    expect(JSON.parse(await readFile(join(workspace, ".proofkit", "missions", "mission-checks", "summary.json"), "utf8")).checkOverview).toEqual(saved.result.checkOverview);
    await writeFile(summaryPath, bytes.replace("Independent observation unavailable", "Forged result"));
    const changed = await store.writeReportSnapshot({ ...mission, checkOverview: saved.result.checkOverview });
    expect(changed.result.checkOverview).toMatchObject({ inspectedRuns: 0, unavailableRuns: [{ runId: "run-checks" }], items: [] });
    expect(await readFile(changed.path, "utf8")).not.toContain("Forged result");
  });

  it("links a selected assertion screenshot and withdraws it when its saved bytes change", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-selected-check-")); roots.push(workspace);
    const input = source(); input.summary!.projectRoot = "/source"; input.summary!.workspaceRoot = workspace;
    const paths = ["run.json", "report.html", "artifacts/assertion-001-snapshot.json", "artifacts/assertion-001.png"];
    input.summary!.assertions[0]!.evidence = paths.slice(2).map((path) => "run-checks/" + path);
    const refs = await Promise.all(paths.map(async (path): Promise<EvidenceRef> => {
      const target = join(workspace, ".proofkit", "runs", "run-checks", path);
      await mkdir(join(target, ".."), { recursive: true });
      const bytes = path === "run.json" ? JSON.stringify(input.summary) : "saved " + path;
      await writeFile(target, bytes);
      return { evidenceId: "run-checks:" + path, kind: path.endsWith(".png") ? "screenshot" : path.endsWith("report.html") ? "report" : "snapshot",
        path: target, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: now };
    }));
    const mission = MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-selected-check", projectRoot: "/source", workspaceRoot: workspace,
      intent: "Verify a saved note", status: "completed", running: false, verdict: "inconclusive", level: "core", revision: 1, updatedAt: now, generatedAt: now,
      scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 1, settled: 1, failed: 0, blocked: 0, skipped: 0 },
      expectedRuns: 1, observedRuns: 1, runs: [{ ...input.run, evidence: refs }], omittedRunResults: 0, findings: [], omittedFindings: 0,
      confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
    const store = new MissionReportStore(workspace);
    const first = await store.writeReportSnapshot(mission);
    const check = first.result.checkOverview!.items.find((item) => item.expected === "Expected visible text: Note saved")!;
    expect(check).toMatchObject({ status: "passed", unlinkedEvidence: 0, evidence: [{ path: refs[2]!.path }, { path: refs[3]!.path }] });
    expect(await readFile(first.path, "utf8")).toContain("../../runs/run-checks/artifacts/assertion-001.png");
    await writeFile(refs[3]!.path, "changed image");
    const changed = await store.writeReportSnapshot(mission);
    const withdrawn = changed.result.checkOverview!.items.find((item) => item.expected === "Expected visible text: Note saved")!;
    expect(withdrawn).toMatchObject({ evidence: [{ path: refs[2]!.path }], unlinkedEvidence: 1 });
    expect(await readFile(changed.path, "utf8")).not.toContain('href="../../runs/run-checks/artifacts/assertion-001.png"');
  });

  it("withdraws a failed Oracle's field summary when its independent source changes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "proofkit-failed-fields-")); roots.push(workspace);
    const input = source(); input.summary!.projectRoot = "/source"; input.summary!.workspaceRoot = workspace;
    input.summary!.oracles[0]!.passed = false;
    input.summary!.oracles[0]!.fieldMismatches = ["note.title"];
    input.summary!.oracles[0]!.sourceEvidenceArtifacts = ["run-checks/artifacts/oracle-1-source.json"];
    const contents = { "report.html": "Saved Run report", "artifacts/oracle-1-source.json": JSON.stringify({ actual: "PRIVATE_UNREVIEWED_VALUE" }) };
    const refs: EvidenceRef[] = [];
    for (const path of ["run.json", "report.html", "artifacts/oracle-1-source.json"]) {
      const target = join(workspace, ".proofkit", "runs", "run-checks", path);
      await mkdir(join(target, ".."), { recursive: true });
      const bytes = path === "run.json" ? JSON.stringify(input.summary) : contents[path as keyof typeof contents];
      await writeFile(target, bytes);
      refs.push({ evidenceId: "run-checks:" + path, kind: path.endsWith("source.json") ? "business" : path.endsWith("report.html") ? "report" : "snapshot",
        path: target, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: now });
    }
    const mission = MissionResultSchema.parse({ schemaVersion: "1", missionId: "mission-failed-fields", projectRoot: "/source", workspaceRoot: workspace,
      intent: "Verify a saved note", status: "completed", running: false, verdict: "failed", level: "core", revision: 1, updatedAt: now, generatedAt: now,
      scope: { surfaces: ["web"], charterCount: 1, uncoveredCharterIds: [] }, tasks: { total: 1, settled: 1, failed: 1, blocked: 0, skipped: 0 },
      expectedRuns: 1, observedRuns: 1, runs: [{ ...input.run, verdict: "failed", evidence: refs }], omittedRunResults: 0,
      findings: [], omittedFindings: 0, confirmedProductFindings: 0, repairSuggestions: [], omittedRepairSuggestions: 0 });
    const store = new MissionReportStore(workspace); const initial = await store.writeReportSnapshot(mission);
    expect(initial.result.checkOverview?.items.find((item) => item.expected === "current-note")?.fieldMismatches).toEqual(["note.title"]);
    const originalHtml = await readFile(initial.path, "utf8");
    expect(originalHtml).toContain('class="check-highlights"');
    expect(originalHtml).toContain('class="check-highlight status-failed"');
    expect(originalHtml).toContain("Oracle-declared different fields: note.title");
    expect(originalHtml).not.toContain("PRIVATE_UNREVIEWED_VALUE");
    await writeFile(refs[2]!.path, "changed independent source");
    const changed = await store.writeReportSnapshot(mission);
    expect(changed.result.checkOverview?.items.find((item) => item.expected === "current-note")?.fieldMismatches).toBeUndefined();
    expect(await readFile(changed.path, "utf8")).not.toContain("Oracle-declared different fields: note.title");
    expect(await readFile(changed.path, "utf8")).not.toContain('href="../../runs/run-checks/artifacts/oracle-1-source.json"');
  });
});
