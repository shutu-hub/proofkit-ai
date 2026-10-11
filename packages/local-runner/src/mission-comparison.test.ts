import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JsonMissionStore } from "@proofkit/agent";
import { RunSummarySchema, TestCharterSchema, TestMissionSchema, type EvidenceRef, type RunSummary, type TestCharter, type TestMission, type Verdict } from "@proofkit/contracts";
import { auditComparisonCurrentSource, compareMissionRecords } from "./mission-comparison.js";
import { sha256 } from "@proofkit/evidence";
import { captureSourceState } from "@proofkit/project";
import { LocalRunnerService } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Mission repair comparison", () => {
  it("withdraws a historical repair claim after candidate source drift or an unavailable recheck", async () => {
    const fixture = await createFixture();
    const saved = await fixture.compare();
    expect(saved.status).toBe("verified-in-scope");
    const final = { method: "git" as const, complete: true, headSha: "a".repeat(40), worktreeSha256: "b".repeat(64),
      trackedDiffBytes: 0, untrackedFiles: 0, capturedAt: new Date().toISOString() };
    const matching = auditComparisonCurrentSource(saved, final, final);
    expect(matching).toMatchObject({ status: "verified-in-scope", candidateSourceFreshness: "matching" });
    const changed = auditComparisonCurrentSource(saved, final, { ...final, worktreeSha256: "c".repeat(64) });
    expect(changed).toMatchObject({ status: "inconclusive", historicalStatus: "verified-in-scope",
      candidateSourceFreshness: "changed", candidateFinalSourceState: final });
    expect(changed.reason).toContain("does not establish the current repair");
    const unavailable = auditComparisonCurrentSource(saved, final, { method: "unavailable", complete: false,
      trackedDiffBytes: 0, untrackedFiles: 0, capturedAt: final.capturedAt });
    expect(unavailable).toMatchObject({ status: "inconclusive", historicalStatus: "verified-in-scope",
      candidateSourceFreshness: "unavailable" });
    expect(auditComparisonCurrentSource(saved, undefined, undefined)).toMatchObject({
      status: "verified-in-scope", candidateSourceFreshness: "unverified" });
  });

  it("rechecks a persisted replay from the service entry point after a Git source edit", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "app.ts"), "export const ready = true;\n");
    await execFileAsync("git", ["init", "-q"], { cwd: fixture.root });
    await execFileAsync("git", ["add", "app.ts"], { cwd: fixture.root });
    await execFileAsync("git", ["-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture.root });
    const final = await captureSourceState(fixture.root);
    expect(final).toMatchObject({ method: "git", complete: true });
    const now = new Date().toISOString();
    fixture.candidate.observations.push({ observationId: "candidate-source-start", source: "planner", kind: "project.source-state",
      data: final, evidence: [], observedAt: now });
    fixture.candidate.observations.push({ observationId: "candidate-source-final", source: "planner", kind: "project.source-state-final",
      data: final, evidence: [], observedAt: now });
    const store = new JsonMissionStore(join(fixture.root, ".proofkit", "missions"));
    await store.save(fixture.baseline);
    await store.save(fixture.candidate);
    const service = new LocalRunnerService({ root: fixture.root, workspaceRoot: fixture.root });
    expect(await service.compareMissions(fixture.baseline.missionId, fixture.candidate.missionId)).toMatchObject({
      status: "verified-in-scope", candidateSourceFreshness: "matching" });
    await writeFile(join(fixture.root, "app.ts"), "export const ready = false;\n");
    const direct = await service.compareMissions(fixture.baseline.missionId, fixture.candidate.missionId);
    expect(direct).toMatchObject({ status: "inconclusive", historicalStatus: "verified-in-scope", candidateSourceFreshness: "changed" });
    const evidence = await service.missionEvidence(fixture.candidate.missionId);
    expect(evidence.summary.comparison).toMatchObject({ status: "inconclusive", historicalStatus: "verified-in-scope",
      candidateSourceFreshness: "changed" });
  });

  it.each(["failed", "unverified", "missing", "tampered", "wrong-scope", "wrong-run", "unlisted", "cross-run-link", "before-release"] as const)("rejects repair certification with %s cleanup evidence", async (mode) => {
    const fixture = await createFixture();
    const path = "after-primary/artifacts/integration-cleanup.json";
    const absolute = join(fixture.evidenceDir, path);
    const now = new Date().toISOString();
    const proof = {
      runId: "after-primary", startedAt: now, endedAt: now, status: "verified", declaredResources: 1, verifiedResources: 1,
      resources: [{ resourceId: "tenant", kind: "test-tenant", scope: "after-primary", evidence: { owner: "after-primary" } }],
      observations: [{ resourceId: "tenant", status: "removed", releaseStartedAt: now, evidence: { statusCode: 404 }, readback: { reader: "fixture.get", scope: "after-primary", observedAt: now, exists: false } }], issues: [],
    };
    const summaryFile = join(fixture.evidenceDir, "after-primary/run.json");
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.integrationCleanup = { status: "verified", declaredResources: 1, verifiedResources: 1, artifact: path, sha256: sha256(JSON.stringify(proof)) };
    summary.artifacts.push(path);
    await writeFile(absolute, JSON.stringify(proof));
    await writeFile(summaryFile, JSON.stringify(summary));
    const observation = fixture.candidate.observations[0]!;
    observation.data.integrationCleanup = summary.integrationCleanup;
    observation.evidence.push({ evidenceId: `after-primary:${path}`, kind: "runtime", path: absolute, capturedAt: now, sha256: summary.integrationCleanup.sha256 });
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    if (mode === "failed" || mode === "unverified") {
      summary.integrationCleanup = { status: mode, declaredResources: 1, verifiedResources: 0 };
    } else if (mode === "missing") await rm(absolute);
    else if (mode === "unlisted") summary.artifacts = summary.artifacts.filter((item: string) => item !== path);
    else if (mode === "cross-run-link") {
      const foreignRun = join(fixture.evidenceDir, "foreign-run");
      await mkdir(foreignRun);
      await rename(join(fixture.evidenceDir, "after-primary/artifacts"), join(foreignRun, "artifacts"));
      await symlink(join(foreignRun, "artifacts"), join(fixture.evidenceDir, "after-primary/artifacts"), process.platform === "win32" ? "junction" : "dir");
    }
    else {
      if (mode === "tampered") proof.observations[0]!.readback.exists = true;
      if (mode === "wrong-scope") proof.observations[0]!.readback.scope = "another-run";
      if (mode === "wrong-run") proof.runId = "another-run";
      if (mode === "before-release") {
        proof.startedAt = new Date(Date.parse(now) - 500).toISOString();
        proof.observations[0]!.readback.observedAt = new Date(Date.parse(now) - 200).toISOString();
        proof.observations[0]!.releaseStartedAt = new Date(Date.parse(now) - 100).toISOString();
      }
      await writeFile(absolute, JSON.stringify(proof));
      if (mode !== "tampered") {
        summary.integrationCleanup.sha256 = sha256(JSON.stringify(proof));
        observation.evidence.at(-1)!.sha256 = summary.integrationCleanup.sha256;
      }
    }
    await writeFile(summaryFile, JSON.stringify(summary));
    observation.data.integrationCleanup = summary.integrationCleanup;
    const result = await fixture.compare();
    expect(result.status).toBe("inconclusive");
    expect(result.gaps.some((gap) => gap.includes("test resource cleanup"))).toBe(true);
  });

  it("verifies only the same replay scope with a failed and then passing independent business fact", async () => {
    const fixture = await createFixture();
    const result = await fixture.compare();
    expect(result).toMatchObject({ status: "verified-in-scope", scopeMatched: true, baselineVerdict: "failed", candidateVerdict: "passed" });
    expect(result.defects).toEqual([expect.objectContaining({ oracleName: "resume-binding", outcome: "not-reproduced", baselineRunId: "before-primary", candidateRunId: "after-primary" })]);
    expect(result.defects[0]?.baselineEvidence[0]?.kind).toBe("business");
    expect(result.defects[0]?.candidateEvidence[0]?.kind).toBe("business");
    expect(result.runs).toEqual([expect.objectContaining({ surface: "web", runKind: "primary", baselineBusinessFacts: 1, candidateBusinessFacts: 1 })]);
    expect(result).toMatchObject({ sourceChange: "unknown" });
    expect(result.reason).toContain("Source change could not be established");
  });

  it("withdraws a multi-finding repair claim when any confirmed baseline business fact is lost", async () => {
    const fixture = await createFixture();
    const runId = "before-primary";
    const path = `${runId}/artifacts/second-source.json`;
    const content = '{"second":"defect"}';
    const absolute = join(fixture.evidenceDir, path);
    await writeFile(absolute, content);
    const summaryPath = join(fixture.evidenceDir, runId, "run.json");
    const summary = RunSummarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
    summary.artifacts.push(path);
    summary.oracles.push({ ...summary.oracles[0]!, name: "resume-role", sourceEvidenceArtifacts: [path],
      sourceEvidenceCount: 1, evidence: [path] });
    await writeFile(summaryPath, JSON.stringify(summary));
    const candidateSummaryPath = join(fixture.evidenceDir, "after-primary", "run.json");
    const candidateSummary = RunSummarySchema.parse(JSON.parse(await readFile(candidateSummaryPath, "utf8")));
    candidateSummary.oracles.push({ ...candidateSummary.oracles[0]!, name: "resume-role" });
    await writeFile(candidateSummaryPath, JSON.stringify(candidateSummary));
    const ref: EvidenceRef = { evidenceId: `${runId}:${path}`, kind: "business", path: absolute,
      sha256: sha256(content), capturedAt: new Date().toISOString() };
    fixture.baseline.observations[0]!.evidence.push(ref);
    fixture.baseline.evidence.push(ref);
    fixture.baseline.findings.push({ findingId: "second-defect", severity: "high", category: "product", status: "confirmed",
      title: "Second binding defect", message: "Another saved relation is wrong.", evidence: [ref], createdAt: new Date().toISOString() });
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    await writeFile(join(fixture.evidenceDir, runId, "artifacts", "oracle-source.json"), '{"bound":"tampered"}');
    const stale = await fixture.compare();
    expect(stale.status).toBe("inconclusive");
    expect(stale.gaps).toContain("Baseline confirmed finding binding-defect lacks complete business facts from a failing Oracle in the saved Run scope.");
    expect(stale.defects).toHaveLength(1);
  });

  it.each(["surface", "charter"] as const)("does not borrow a failing Oracle fact for a finding with a different %s", async (mismatch) => {
    const fixture = await createFixture();
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    if (mismatch === "surface") fixture.baseline.findings[0]!.surface = "electron";
    else fixture.baseline.findings[0]!.charterId = "another-charter";
    const result = await fixture.compare();
    expect(result.status).toBe("inconclusive");
    expect(result.gaps).toContain("Baseline confirmed finding binding-defect lacks complete business facts from a failing Oracle in the saved Run scope.");
  });

  it("requires every declared candidate Oracle source artifact to remain materialized", async () => {
    const fixture = await createFixture();
    const runId = "after-primary";
    const path = `${runId}/artifacts/second-source.json`;
    const content = '{"second":"correct"}';
    const absolute = join(fixture.evidenceDir, path);
    await writeFile(absolute, content);
    const summaryPath = join(fixture.evidenceDir, runId, "run.json");
    const summary = RunSummarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
    summary.artifacts.push(path);
    summary.oracles[0]!.sourceEvidenceArtifacts!.push(path);
    summary.oracles[0]!.sourceEvidenceCount = 2;
    await writeFile(summaryPath, JSON.stringify(summary));
    const ref: EvidenceRef = { evidenceId: `${runId}:${path}`, kind: "business", path: absolute,
      sha256: sha256(content), capturedAt: new Date().toISOString() };
    fixture.candidate.observations[0]!.evidence.push(ref);
    fixture.candidate.evidence.push(ref);
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    await rm(absolute);
    const stale = await fixture.compare();
    expect(stale.status).toBe("inconclusive");
    expect(stale.defects[0]?.outcome).toBe("unverified");
    expect(stale.gaps).toContain("Candidate web/primary lacks a passing assertion, declared Oracle, or independent source fact.");
  });

  it("reports the same defect when the replay Oracle still fails with source facts", async () => {
    const fixture = await createFixture({ candidateVerdict: "failed" });
    const result = await fixture.compare();
    expect(result.status).toBe("defect-reproduced");
    expect(result.defects[0]?.outcome).toBe("reproduced");
  });

  it("requires identical saved input bytes even when the candidate business Oracle passes", async () => {
    const fixture = await createFixture();
    const action = { kind: "setInputFiles" as const, selector: "#resume", files: [".proofkit/fixtures/resume.pdf"] };
    fixture.baseline.charter!.actions = [action];
    fixture.candidate.charter!.actions = [action];
    const fact = { fixture: action.files[0]!, name: "resume.pdf", sizeBytes: 12, sha256: "a".repeat(64), mimeType: "application/pdf" };
    const setInputs = async (runId: string, facts?: typeof fact[]) => {
      const path = join(fixture.evidenceDir, runId, "run.json");
      const run = RunSummarySchema.parse(JSON.parse(await readFile(path, "utf8")));
      run.charter.actions = [action];
      run.steps = [{ stepId: "step-001", action, status: "passed", artifacts: [], ...(facts ? { inputFiles: facts } : {}) }];
      await writeFile(path, JSON.stringify(run));
    };
    await setInputs("before-primary", [fact]);
    await setInputs("after-primary", [fact]);
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    await setInputs("after-primary", [{ ...fact, sha256: "b".repeat(64) }]);
    const changed = await fixture.compare();
    expect(changed.status).toBe("inconclusive");
    expect(changed.gaps).toContain("web/primary step-001 fixture facts are missing or changed.");
    await setInputs("after-primary");
    expect((await fixture.compare()).status).toBe("inconclusive");
  });

  it("does not verify a changed Charter scope or an unrelated Mission", async () => {
    const fixture = await createFixture();
    fixture.candidate.charter = { ...fixture.candidate.charter!, intent: "test another workflow" };
    expect((await fixture.compare()).status).toBe("inconclusive");
    expect((await fixture.compare()).scopeMatched).toBe(false);
    fixture.candidate.charter = fixture.baseline.charter;
    fixture.candidate.replayOfMissionId = undefined;
    expect((await fixture.compare()).gaps).toContain("Candidate is not a direct replay of the baseline Mission.");
  });

  it("rejects an Oracle report that has lost either source artifact", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.evidenceDir, "before-primary", "artifacts", "oracle-source.json"));
    expect((await fixture.compare()).status).toBe("inconclusive");
    expect((await fixture.compare()).defects).toHaveLength(0);

    await writeFile(join(fixture.evidenceDir, "before-primary", "artifacts", "oracle-source.json"), '{"bound":false}');
    await rm(join(fixture.evidenceDir, "after-primary", "artifacts", "oracle-source.json"));
    const result = await fixture.compare();
    expect(result.status).toBe("inconclusive");
    expect(result.defects[0]?.outcome).toBe("unverified");
  });

  it("does not confirm a defect or repair after saved business facts are rewritten", async () => {
    const changedBaseline = await createFixture();
    await writeFile(join(changedBaseline.evidenceDir, "before-primary", "artifacts", "oracle-source.json"), '{"bound":true}');
    const baselineResult = await changedBaseline.compare();
    expect(baselineResult.status).toBe("inconclusive");
    expect(baselineResult.defects).toHaveLength(0);

    const changedCandidate = await createFixture();
    await writeFile(join(changedCandidate.evidenceDir, "after-primary", "artifacts", "oracle-source.json"), '{"bound":false}');
    const candidateResult = await changedCandidate.compare();
    expect(candidateResult.status).toBe("inconclusive");
    expect(candidateResult.defects[0]?.outcome).toBe("unverified");
  });

  it("requires every declared negative case and release replay slot before verifying", async () => {
    const fixture = await createFixture({ negativeCase: true });
    const missingNegative = await fixture.compare();
    expect(missingNegative.status).toBe("inconclusive");
    expect(missingNegative.gaps.some((gap) => gap.includes("negative/duplicate"))).toBe(true);

    const negative = await writeRun(fixture.evidenceDir, fixture.candidate.charter!, "after-negative", "passed", { negativeCaseId: "duplicate" });
    fixture.candidate.observations.push(runObservation("after-negative", "passed", negative.ref, "negative", "duplicate"));
    expect((await fixture.compare()).status).toBe("verified-in-scope");

    fixture.baseline.plan.executionProfile.requireReplay = true;
    fixture.candidate.plan.executionProfile.requireReplay = true;
    const missingReplay = await fixture.compare();
    expect(missingReplay.status).toBe("inconclusive");
    expect(missingReplay.gaps.some((gap) => gap.includes("web/replay"))).toBe(true);
  });

  it("does not compare a still-running candidate as a verified repair", async () => {
    const fixture = await createFixture();
    fixture.candidate.status = "running";
    fixture.candidate.verdict = undefined;
    expect((await fixture.compare()).status).toBe("inconclusive");
  });

  it("reports changed, unchanged, and unavailable source fingerprints separately from business success", async () => {
    const fixture = await createFixture();
    const source = (missionId: string, digest: string) => ({
      observationId: `source-${missionId}`, source: "planner" as const, kind: "project.source-state",
      data: { method: "git", headSha: "a".repeat(40), worktreeSha256: digest, complete: true, trackedDiffBytes: 0, untrackedFiles: 0, capturedAt: new Date().toISOString() },
      evidence: [], observedAt: new Date().toISOString(),
    });
    fixture.baseline.observations.push(source("before", "b".repeat(64)));
    fixture.candidate.observations.push(source("after", "c".repeat(64)));
    fixture.candidate.observations.push({ ...source("after-final", "c".repeat(64)), kind: "project.source-state-final" });
    expect(await fixture.compare()).toMatchObject({ status: "verified-in-scope", sourceChange: "changed", candidateSourceStability: "stable" });
    fixture.candidate.observations.at(-2)!.data.worktreeSha256 = "b".repeat(64);
    fixture.candidate.observations.at(-1)!.data.worktreeSha256 = "b".repeat(64);
    const unchanged = await fixture.compare();
    expect(unchanged.sourceChange).toBe("unchanged");
    expect(unchanged.reason).toContain("did not change");
    fixture.candidate.observations.at(-1)!.data.complete = false;
    expect((await fixture.compare()).candidateSourceStability).toBe("unknown");
  });

  it("refuses repair verification if the candidate source changed during the Run", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    fixture.candidate.observations.push({ observationId: "source-start", source: "planner", kind: "project.source-state", data: { method: "git", headSha: "a".repeat(40), worktreeSha256: "b".repeat(64), complete: true, capturedAt: now }, evidence: [], observedAt: now });
    fixture.candidate.observations.push({ observationId: "source-end", source: "planner", kind: "project.source-state-final", data: { method: "git", headSha: "a".repeat(40), worktreeSha256: "c".repeat(64), complete: true, capturedAt: now }, evidence: [], observedAt: now });
    const result = await fixture.compare();
    expect(result).toMatchObject({ status: "inconclusive", candidateSourceStability: "changed-during-run" });
    expect(result.gaps).toContain("Candidate source changed while the Mission was executing.");
  });

  it("refuses repair verification when the baseline source changed during its Run", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    const source = (kind: "project.source-state" | "project.source-state-final", headSha: string, digest: string) => ({
      observationId: `baseline-${kind}`, source: "planner" as const, kind,
      data: { method: "git", headSha, worktreeSha256: digest, complete: true, capturedAt: now },
      evidence: [], observedAt: now,
    });
    fixture.baseline.observations.push(source("project.source-state", "a".repeat(40), "b".repeat(64)));
    fixture.baseline.observations.push(source("project.source-state-final", "c".repeat(40), "b".repeat(64)));
    const changed = await fixture.compare();
    expect(changed).toMatchObject({ status: "inconclusive", baselineSourceStability: "changed-during-run" });
    expect(changed.gaps).toContain("Baseline source changed while the Mission was executing.");

    fixture.baseline.observations.at(-1)!.data.headSha = "a".repeat(40);
    const stable = await fixture.compare();
    expect(stable).toMatchObject({ status: "verified-in-scope", baselineSourceStability: "stable" });
  });

  it("does not verify a repair across a changed or differently owned target", async () => {
    const fixture = await createFixture();
    const expected = fixture.root;
    const other = join(fixture.root, "other-checkout");
    await setTargetBinding(fixture.evidenceDir, "before-primary", expected, "http://localhost:5174");
    await setTargetBinding(fixture.evidenceDir, "after-primary", other, "http://localhost:5174", "different-project");
    const different = await fixture.compare();
    expect(different.status).toBe("inconclusive");
    expect(different.gaps.some((gap) => gap.includes("different Git checkout"))).toBe(true);

    await setTargetBinding(fixture.evidenceDir, "after-primary", expected, "http://localhost:5174");
    expect((await fixture.compare()).status).toBe("verified-in-scope");
    await setTargetBinding(fixture.evidenceDir, "after-primary", expected, "http://localhost:5175");
    expect((await fixture.compare()).gaps.some((gap) => gap.includes("different target origin"))).toBe(true);

    const beforePath = join(fixture.evidenceDir, "before-primary", "run.json");
    const before = RunSummarySchema.parse(JSON.parse(await readFile(beforePath, "utf8")));
    delete before.targetBinding;
    await writeFile(beforePath, JSON.stringify(before));
    expect((await fixture.compare()).gaps.some((gap) => gap.includes("only one side"))).toBe(true);
  });
});

async function setTargetBinding(evidenceDir: string, runId: string, observedProjectRoot: string, targetOrigin: string, status: "matching-process-path" | "different-project" = "matching-process-path") {
  const path = join(evidenceDir, runId, "run.json");
  const summary = RunSummarySchema.parse(JSON.parse(await readFile(path, "utf8")));
  summary.targetBinding = {
    status, method: "windows-listener-process", expectedProjectRoot: evidenceDir,
    observedProjectRoot, targetOrigin, processId: 12,
    reason: "Listener process path observed.", observedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(summary));
}

async function createFixture(options: { candidateVerdict?: Verdict; negativeCase?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-compare-"));
  roots.push(root);
  const evidenceDir = join(root, ".proofkit", "runs");
  const charter = TestCharterSchema.parse({
    intent: "verify resume binding", level: "core", mode: "deterministic", preconditions: [],
    actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Resume ready" }],
    oracles: ["resume-binding"], sideEffectPolicy: "deny", metadata: {},
    ...(options.negativeCase ? { negativeCases: [{ caseId: "duplicate", title: "Duplicate resume", actions: [{ kind: "observe" }], assertions: [], oracles: ["resume-binding"], sideEffectPolicy: "deny", metadata: {} }] } : {}),
  });
  const before = await writeRun(evidenceDir, charter, "before-primary", "failed");
  const after = await writeRun(evidenceDir, charter, "after-primary", options.candidateVerdict ?? "passed");
  const baseline = mission(root, "mission-before", charter, "failed", "failed", [runObservation("before-primary", "failed", before.ref)]);
  baseline.findings.push({ findingId: "binding-defect", severity: "high", category: "product", status: "confirmed", title: "Wrong candidate binding", message: "The saved relation points at another candidate.", evidence: [before.ref], createdAt: new Date().toISOString() });
  const candidateVerdict = options.candidateVerdict ?? "passed";
  const candidate = mission(root, "mission-after", charter, candidateVerdict === "passed" ? "completed" : "failed", candidateVerdict, [runObservation("after-primary", candidateVerdict, after.ref)]);
  candidate.replayOfMissionId = baseline.missionId;
  const compare = () => compareMissionRecords(baseline, candidate, evidenceDir, async (runId) => RunSummarySchema.parse(JSON.parse(await readFile(join(evidenceDir, runId, "run.json"), "utf8"))));
  return { root, evidenceDir, baseline, candidate, compare };
}

async function writeRun(evidenceDir: string, charter: TestCharter, runId: string, verdict: Verdict, options: { negativeCaseId?: string } = {}): Promise<{ ref: EvidenceRef }> {
  const runDir = join(evidenceDir, runId);
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const path = `${runId}/artifacts/oracle-source.json`;
  const source = JSON.stringify({ bound: verdict === "passed" });
  await writeFile(join(runDir, "artifacts", "oracle-source.json"), source);
  const now = new Date().toISOString();
  const summary: RunSummary = {
    runId, startedAt: now, endedAt: now, status: "completed", verdict,
    charter: options.negativeCaseId ? { ...charter, metadata: { ...charter.metadata, negativeCaseId: options.negativeCaseId }, assertions: [] } : charter,
    steps: [], assertions: options.negativeCaseId ? [] : [{ assertion: charter.assertions[0]!, passed: true, message: "visible", evidence: [] }],
    oracles: [{ name: "resume-binding", passed: verdict === "passed", message: verdict === "passed" ? "correct candidate" : "wrong candidate", evidence: [path], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [path], observedAt: now }],
    artifacts: [path], findings: [],
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(summary));
  const ref: EvidenceRef = { evidenceId: `${runId}:${path}`, kind: "business", path: resolve(evidenceDir, path), sha256: sha256(source), capturedAt: now };
  return { ref };
}

function runObservation(runId: string, verdict: Verdict, ref: EvidenceRef, runKind: "primary" | "negative" = "primary", negativeCaseId?: string) {
  return {
    observationId: `observation-${runId}`, source: "surface" as const, kind: "surface.run", observedAt: new Date().toISOString(),
    data: { runId, surface: "web", runKind, negativeCaseId, verdict, ...(runKind === "negative" ? { expectedVerdict: "passed", outcomeMatched: true } : {}) },
    evidence: [ref],
  };
}

function mission(root: string, missionId: string, charter: TestCharter, status: TestMission["status"], verdict: Verdict, observations: ReturnType<typeof runObservation>[]): TestMission {
  const now = new Date().toISOString();
  return TestMissionSchema.parse({
    missionId, intent: charter.intent, projectRoot: root, workspaceRoot: root, surface: "web", level: "core",
    policy: { level: "core", environment: "test", sideEffectPolicy: "deny", requireApproval: false, requireEvidence: true },
    status, verdict, charter,
    plan: {
      planId: `plan-${missionId}`, version: "1", generatedBy: "test", level: "core", createdAt: now,
      graph: { tasks: [{ taskId: "verify-result", title: "verify", objective: "verify", tool: "mission.verify", status: status === "completed" ? "passed" : "failed" }], terminalTaskIds: ["verify-result"] },
      executionProfile: { surfaceMatrix: ["web"], negativeCases: [], declaredNegativeCases: [], requireBusinessOracle: true, requireReplay: false, requireNegativeCases: Boolean(charter.negativeCases?.length), minimumEvidence: 2 },
    },
    observations, evidence: observations.flatMap((item) => item.evidence), findings: [], createdAt: now, updatedAt: now,
  });
}
