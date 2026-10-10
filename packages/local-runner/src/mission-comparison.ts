import { resolve } from "node:path";
import {
  MissionComparisonSchema,
  SourceStateSchema,
  suiteChecks,
  type EvidenceRef,
  type MissionComparison,
  type MissionComparisonDefect,
  type MissionComparisonRun,
  type Observation,
  type OracleResult,
  type RunSummary,
  type SourceState,
  type TestCharter,
  type TestMission,
} from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { sameProjectPath } from "@proofkit/project";
import { sameInputFileFacts } from "@proofkit/runner";
import { hasCompleteCleanupEvidence } from "./cleanup-evidence.js";
import { materializedRunArtifact } from "./run-evidence.js";

type Surface = "web" | "electron" | "mobile";
type RunKind = "primary" | "replay" | "negative";
type Slot = { charterId?: string; charter: TestCharter; surface: Surface; runKind: RunKind; negativeCaseId?: string; expectedVerdict?: string };
type RunRecord = { observation: Observation; summary: RunSummary; runId: string };

/** Compare saved Mission outcomes without executing the project or interpreting raw business data. */
export async function compareMissionRecords(
  baseline: TestMission,
  candidate: TestMission,
  evidenceDir: string,
  loadRun: (runId: string) => Promise<RunSummary>,
): Promise<MissionComparison> {
  const baselineScopeHash = scopeHash(baseline);
  const candidateScopeHash = scopeHash(candidate);
  const baselineSourceState = sourceStateFor(baseline);
  const candidateSourceState = sourceStateFor(candidate);
  const candidateFinalSourceState = sourceStateFor(candidate, "project.source-state-final");
  const sourceChange: MissionComparison["sourceChange"] = baselineSourceState?.complete && candidateSourceState?.complete
    && baselineSourceState.method === "git" && candidateSourceState.method === "git"
    && baselineSourceState.worktreeSha256 && candidateSourceState.worktreeSha256
    ? baselineSourceState.worktreeSha256 === candidateSourceState.worktreeSha256 ? "unchanged" : "changed"
    : "unknown";
  const candidateSourceStability: MissionComparison["candidateSourceStability"] = candidateSourceState?.complete && candidateFinalSourceState?.complete
    && candidateSourceState.method === "git" && candidateFinalSourceState.method === "git"
    && candidateSourceState.worktreeSha256 && candidateFinalSourceState.worktreeSha256
    ? candidateSourceState.worktreeSha256 === candidateFinalSourceState.worktreeSha256 ? "stable" : "changed-during-run"
    : "unknown";
  const scopeMatched = baselineScopeHash === candidateScopeHash;
  const gaps: string[] = [];
  if (baseline.missionId === candidate.missionId) gaps.push("A Mission cannot be compared with itself.");
  if (candidate.replayOfMissionId !== baseline.missionId) gaps.push("Candidate is not a direct replay of the baseline Mission.");
  if (!scopeMatched) gaps.push("Project, workspace, Charter or suite snapshot, level, policy, or surface matrix differs.");
  if (!terminal(baseline)) gaps.push("Baseline Mission has not reached a terminal state.");
  if (!terminal(candidate)) gaps.push("Candidate Mission has not reached a terminal state.");
  if (baseline.verdict !== "failed") gaps.push("Baseline Mission did not record a failed verdict for its confirmed product defect.");
  if (candidateSourceStability === "changed-during-run") gaps.push("Candidate source changed while the Mission was executing.");

  const slots = slotsFor(baseline);
  const runs: MissionComparisonRun[] = [];
  const baselineRecords = new Map<string, RunRecord>();
  const candidateRecords = new Map<string, RunRecord>();
  for (const slot of slots) {
    const key = slotKey(slot);
    const before = await recordFor(baseline, slot, loadRun, gaps, "baseline");
    const after = await recordFor(candidate, slot, loadRun, gaps, "candidate");
    if (before) baselineRecords.set(key, before);
    if (after) candidateRecords.set(key, after);
    runs.push({
      charterId: slot.charterId,
      surface: slot.surface,
      runKind: slot.runKind,
      negativeCaseId: slot.negativeCaseId,
      baselineRunId: before?.runId,
      candidateRunId: after?.runId,
      baselineVerdict: before?.summary.verdict,
      candidateVerdict: after?.summary.verdict,
      baselineBusinessFacts: before ? businessFacts(before, evidenceDir).count : 0,
      candidateBusinessFacts: after ? businessFacts(after, evidenceDir).count : 0,
      baselineEvidence: before ? compactEvidence(before.observation.evidence) : [],
      candidateEvidence: after ? compactEvidence(after.observation.evidence) : [],
    });
    if (before && after) {
      compareTargetBinding(before.summary, after.summary, slot, gaps);
      compareInputFiles(before.summary, after.summary, slot, gaps);
    }
  }
  const structuralIssue = gaps.length > 0;

  const defects: MissionComparisonDefect[] = [];
  for (const slot of slots.filter((item) => item.runKind !== "negative")) {
    const before = baselineRecords.get(slotKey(slot));
    if (!before) continue;
    for (const oracle of before.summary.oracles.filter((item) => item.passed === false)) {
      const beforeFacts = oracleFacts(before, oracle, evidenceDir);
      if (beforeFacts.length === 0 || !hasConfirmedFinding(baseline, beforeFacts)) continue;
      const after = candidateRecords.get(slotKey(slot));
      const afterOracle = after?.summary.oracles.find((item) => item.name === oracle.name);
      const afterFacts = after && afterOracle ? oracleFacts(after, afterOracle, evidenceDir) : [];
      defects.push({
        charterId: slot.charterId,
        surface: slot.surface,
        oracleName: oracle.name,
        baselineRunId: before.runId,
        candidateRunId: after?.runId,
        outcome: afterFacts.length === 0 ? "unverified" : afterOracle?.passed === true ? "not-reproduced" : afterOracle?.passed === false ? "reproduced" : "unverified",
        baselineEvidence: compactEvidence(beforeFacts),
        candidateEvidence: compactEvidence(afterFacts),
      });
    }
  }
  if (defects.length === 0) gaps.push("Baseline has no confirmed product defect linked to an independent business source fact.");

  let candidateComplete = candidate.status === "completed" && candidate.verdict === "passed"
    && candidate.plan.graph.tasks.every((task) => task.status === "passed")
    && !candidate.findings.some((finding) => finding.category === "product" && finding.status === "confirmed");
  if (!candidateComplete) gaps.push("Candidate did not pass its complete Mission evidence gate.");
  for (const slot of slots) {
    const after = candidateRecords.get(slotKey(slot));
    if (!after) {
      candidateComplete = false;
      gaps.push(`Candidate is missing ${slotLabel(slot)}.`);
      continue;
    }
    const candidateEvidence = after.observation.evidence.filter((ref) => after.summary.artifacts.some((path) => ref.evidenceId === `${after.runId}:${path}`));
    if (!hasCompleteCleanupEvidence(after.summary.integrationCleanup, after.runId, candidateEvidence, evidenceDir)
      || !hasCompleteCleanupEvidence(after.observation.data.integrationCleanup, after.runId, candidateEvidence, evidenceDir)) {
      candidateComplete = false;
      gaps.push(`Candidate ${slotLabel(slot)} did not establish test resource cleanup.`);
    }
    if (slot.runKind === "negative") {
      const expected = slot.expectedVerdict ?? "passed";
      if (after.summary.verdict !== expected || after.observation.data.outcomeMatched !== true || !hasMaterializedEvidence(after, evidenceDir)) {
        candidateComplete = false;
        gaps.push(`Candidate ${slotLabel(slot)} lacks its expected outcome or materialized evidence.`);
      }
      continue;
    }
    const declaredOracles = slot.charter.oracles ?? [];
    const passedOracles = declaredOracles.every((name) => {
      const oracle = after.summary.oracles.find((item) => item.name === name && item.verificationKind !== "http-contract" && item.passed === true);
      return oracle !== undefined && (!candidate.plan.executionProfile.requireBusinessOracle || oracleFacts(after, oracle, evidenceDir).length > 0);
    });
    if (after.summary.verdict !== "passed" || !after.summary.assertions.some((item) => item.passed)
      || candidate.plan.executionProfile.requireBusinessOracle && (declaredOracles.length === 0 || !passedOracles)) {
      candidateComplete = false;
      gaps.push(`Candidate ${slotLabel(slot)} lacks a passing assertion, declared Oracle, or independent source fact.`);
    }
    if (slot.runKind === "replay") {
      const primary = candidateRecords.get(slotKey({ ...slot, runKind: "primary" }));
      if (!primary || after.observation.data.sourceRunId !== primary.runId) {
        candidateComplete = false;
        gaps.push(`Candidate ${slotLabel(slot)} does not reference its primary Run.`);
      }
    }
  }

  const reproduced = defects.some((item) => item.outcome === "reproduced");
  const allNotReproduced = defects.length > 0 && defects.every((item) => item.outcome === "not-reproduced");
  const status: MissionComparison["status"] = structuralIssue
    ? "inconclusive"
    : reproduced ? "defect-reproduced"
      : candidateComplete && allNotReproduced ? "verified-in-scope" : "inconclusive";
  const reason = status === "verified-in-scope"
    ? `The original evidenced business defect was not reproduced by a complete replay of the same configured test scope. ${sourceChange === "unchanged" ? "The captured source fingerprint did not change; product or environment state may explain the difference." : sourceChange === "changed" ? "The source fingerprint changed, but this does not establish which edit caused the outcome." : "Source change could not be established."}`
    : status === "defect-reproduced"
      ? "At least one original business Oracle still fails with independent source facts in the replay."
      : gaps[0] ?? "The evidence is insufficient to verify the original defect after replay.";
  return MissionComparisonSchema.parse({
    baselineMissionId: baseline.missionId,
    candidateMissionId: candidate.missionId,
    baselineVerdict: baseline.verdict,
    candidateVerdict: candidate.verdict,
    baselineScopeHash,
    candidateScopeHash,
    scopeMatched,
    baselineSourceState,
    candidateSourceState,
    sourceChange,
    candidateSourceStability,
    status,
    reason,
    gaps: gaps.slice(0, 30),
    runs: runs.slice(0, 25),
    omittedRuns: Math.max(0, runs.length - 25),
    defects: defects.slice(0, 25),
    omittedDefects: Math.max(0, defects.length - 25),
    comparedAt: new Date().toISOString(),
  });
}

function compareInputFiles(baseline: RunSummary, candidate: RunSummary, slot: Slot, gaps: string[]): void {
  for (const [index, action] of baseline.charter.actions.entries()) {
    if (action.kind !== "setInputFiles") continue;
    const stepId = `step-${String(index + 1).padStart(3, "0")}`;
    const before = baseline.steps.find((step) => step.stepId === stepId)?.inputFiles;
    const after = candidate.steps.find((step) => step.stepId === stepId)?.inputFiles;
    if (!before?.length || !after?.length || !sameInputFileFacts(before, after)) {
      gaps.push(`${slotLabel(slot)} ${stepId} fixture facts are missing or changed.`);
    }
  }
}

function compareTargetBinding(baseline: RunSummary, candidate: RunSummary, slot: Slot, gaps: string[]): void {
  const before = baseline.targetBinding;
  const after = candidate.targetBinding;
  if (!before && !after) return; // Historical Runs did not record this association.
  if (!before || !after) {
    gaps.push(`${slotLabel(slot)} has target association evidence on only one side of the replay.`);
    return;
  }
  if (before.status === "different-project" || after.status === "different-project") {
    gaps.push(`${slotLabel(slot)} includes a target process from a different Git checkout.`);
  }
  if (before.targetOrigin !== after.targetOrigin) {
    gaps.push(`${slotLabel(slot)} used a different target origin in the replay.`);
  }
  if (before.observedProjectRoot && after.observedProjectRoot
    && !sameProjectPath(before.observedProjectRoot, after.observedProjectRoot)) {
    gaps.push(`${slotLabel(slot)} listener process paths belong to different Git checkouts.`);
  }
}

function terminal(mission: TestMission): boolean {
  return ["completed", "failed", "blocked", "cancelled"].includes(mission.status);
}

function sourceStateFor(mission: TestMission, kind = "project.source-state"): SourceState | undefined {
  const observed = [...mission.observations].reverse().find((item) => item.kind === kind);
  const parsed = SourceStateSchema.safeParse(observed?.data);
  return parsed.success ? parsed.data : undefined;
}

function scopeHash(mission: TestMission): string {
  return sha256(canonical({
    projectRoot: resolve(mission.projectRoot),
    workspaceRoot: resolve(mission.workspaceRoot ?? mission.projectRoot),
    intent: mission.intent,
    surface: mission.surface,
    level: mission.level,
    environment: mission.policy.environment,
    sideEffectPolicy: mission.policy.sideEffectPolicy,
    charter: mission.charter,
    suite: mission.suite,
    executionProfile: mission.plan.executionProfile,
  }));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function slotsFor(mission: TestMission): Slot[] {
  const checks = mission.suite ? suiteChecks(mission.suite)
    : mission.charter ? (mission.plan.executionProfile.surfaceMatrix as Surface[]).map((surface) => ({
      charterId: typeof mission.charter!.metadata.catalogId === "string" ? mission.charter!.metadata.catalogId : undefined,
      charter: mission.charter!, surface,
    })) : [];
  return checks.flatMap(({ charterId, charter, surface }): Slot[] => [
    { charterId, charter, surface, runKind: "primary" },
    ...(mission.plan.executionProfile.requireReplay ? [{ charterId, charter, surface, runKind: "replay" as const }] : []),
    ...(charter.negativeCases ?? []).map((item) => ({ charterId, charter, surface, runKind: "negative" as const, negativeCaseId: item.caseId, expectedVerdict: item.expectedVerdict ?? "passed" })),
  ]);
}

function slotKey(slot: Pick<Slot, "charterId" | "surface" | "runKind" | "negativeCaseId">): string {
  return [slot.charterId ?? "", slot.surface, slot.runKind, slot.negativeCaseId ?? ""].join("\0");
}

function slotLabel(slot: Slot): string {
  return `${slot.charterId ? `${slot.charterId}/` : ""}${slot.surface}/${slot.runKind}${slot.negativeCaseId ? `/${slot.negativeCaseId}` : ""}`;
}

async function recordFor(mission: TestMission, slot: Slot, loadRun: (runId: string) => Promise<RunSummary>, gaps: string[], side: string): Promise<RunRecord | undefined> {
  const matches = mission.observations.filter((item) => item.kind === "surface.run"
    && item.charterId === slot.charterId && item.data.surface === slot.surface
    && (item.data.runKind ?? "primary") === slot.runKind
    && (slot.runKind !== "negative" || item.data.negativeCaseId === slot.negativeCaseId));
  if (matches.length !== 1) {
    if (matches.length > 1) gaps.push(`${side} ${slotLabel(slot)} has duplicate Run observations.`);
    return undefined;
  }
  const observation = matches[0]!;
  const runId = observation.data.runId;
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    gaps.push(`${side} ${slotLabel(slot)} has an invalid Run ID.`);
    return undefined;
  }
  try {
    const summary = await loadRun(runId);
    if (summary.runId !== runId || summary.status !== "completed" || !summary.endedAt || summary.verdict !== observation.data.verdict) {
      gaps.push(`${side} ${slotLabel(slot)} Run summary conflicts with the Mission observation.`);
      return undefined;
    }
    if (slot.runKind !== "negative" && canonical(summary.charter) !== canonical(slot.charter)) {
      gaps.push(`${side} ${slotLabel(slot)} Run used a different Charter snapshot.`);
      return undefined;
    }
    if (slot.runKind === "negative" && summary.charter.metadata.negativeCaseId !== slot.negativeCaseId) {
      gaps.push(`${side} ${slotLabel(slot)} Run used a different negative case.`);
      return undefined;
    }
    return { observation, summary, runId };
  } catch {
    gaps.push(`${side} ${slotLabel(slot)} Run summary is unavailable.`);
    return undefined;
  }
}

function businessFacts(record: RunRecord, evidenceDir: string): { count: number; refs: EvidenceRef[] } {
  const businessOracles = record.summary.oracles.filter((oracle) => oracle.verificationKind !== "http-contract");
  const refs = businessOracles.flatMap((oracle) => oracleFacts(record, oracle, evidenceDir));
  const count = businessOracles.reduce((total, oracle) => total + (oracleFacts(record, oracle, evidenceDir).length > 0 ? oracle.sourceEvidenceCount ?? 0 : 0), 0);
  return { count, refs: [...new Map(refs.map((item) => [item.evidenceId, item])).values()] };
}

function oracleFacts(record: RunRecord, oracle: OracleResult, evidenceDir: string): EvidenceRef[] {
  if (oracle.verificationKind === "http-contract") return [];
  if (!oracle.sourceEvidenceCount || !oracle.sourceEvidenceArtifacts?.length) return [];
  return oracle.sourceEvidenceArtifacts.flatMap((path) => {
    if (!record.summary.artifacts.includes(path)) return [];
    const ref = record.observation.evidence.find((item) => item.kind === "business" && item.evidenceId === `${record.runId}:${path}`);
    return ref && materialized(ref, record.runId, path, evidenceDir) ? [ref] : [];
  });
}

function hasMaterializedEvidence(record: RunRecord, evidenceDir: string): boolean {
  return record.summary.artifacts.some((path) => record.observation.evidence.some((ref) => ref.kind !== "report"
    && ref.evidenceId === `${record.runId}:${path}` && materialized(ref, record.runId, path, evidenceDir)));
}

function materialized(ref: EvidenceRef, runId: string, path: string, evidenceDir: string): boolean {
  return Boolean(ref.sha256 && materializedRunArtifact(ref, runId, path, evidenceDir));
}

function hasConfirmedFinding(mission: TestMission, facts: EvidenceRef[]): boolean {
  const ids = new Set(facts.map((item) => item.evidenceId));
  return mission.findings.some((finding) => finding.category === "product" && finding.status === "confirmed"
    && finding.evidence.some((ref) => ref.kind === "business" && ids.has(ref.evidenceId)));
}

function compactEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const priority = (ref: EvidenceRef): number => ref.kind === "business" ? 0
    : ref.kind === "screenshot" || ref.kind === "snapshot" ? 1
      : ref.kind === "network" || ref.kind === "process" ? 2 : 3;
  return [...new Map(refs.map((item) => [item.evidenceId, item])).values()]
    .sort((a, b) => priority(a) - priority(b)).slice(0, 4);
}
