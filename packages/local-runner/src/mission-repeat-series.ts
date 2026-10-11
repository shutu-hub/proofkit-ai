import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalExecutionOwnership } from "@proofkit/evidence";
import { MissionRepeatSeriesSchema, MissionRepeatSeriesStatusSchema, type MissionRepeatSeries, type MissionRepeatSeriesStatus, type SourceState, type TestMission } from "@proofkit/contracts";
import { resolveWithinWorkspace, sameProjectPath } from "@proofkit/project";
import { missionScopeHash } from "./mission-comparison.js";
import { expectedProductRunFailure, hasStableOwnedBinding } from "./mission-stability.js";
import type { LocalRunnerService } from "./index.js";

const TERMINAL = new Set<TestMission["status"]>(["completed", "failed", "blocked", "cancelled"]);

/** The immutable request lives outside the tested source; each replay is an idempotent Mission slot. */
export class MissionRepeatSeriesService {
  private readonly rootDir: string;
  private readonly ownership: LocalExecutionOwnership;

  constructor(private readonly runner: LocalRunnerService) {
    this.rootDir = resolveWithinWorkspace(runner.workspaceRoot, ".proofkit/repeat-series");
    this.ownership = new LocalExecutionOwnership(this.rootDir, "workspace");
  }

  async create(baselineMissionId: string, targetSamples: number): Promise<MissionRepeatSeriesStatus> {
    if (!Number.isInteger(targetSamples) || targetSamples < 3 || targetSamples > 5) throw new Error("Repeat series requires 3 to 5 total samples");
    const baseline = (await this.runner.missionStatus(baselineMissionId)).mission;
    if (!TERMINAL.has(baseline.status)) throw new Error("Repeat series requires a terminal baseline Mission");
    const evidence = await this.runner.missionEvidence(baselineMissionId);
    if (!eligibleEvidence(evidence)) throw new Error("Baseline Mission lacks current, complete Git and business evidence for a repeat series");
    const series = MissionRepeatSeriesSchema.parse({
      seriesId: `repeat-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      baselineMissionId,
      projectRoot: this.runner.root,
      workspaceRoot: this.runner.workspaceRoot,
      targetSamples,
      createdAt: new Date().toISOString(),
    });
    const path = this.path(series.seriesId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(`${JSON.stringify(series, null, 2)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await link(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    return this.status(series.seriesId);
  }

  async status(seriesId: string): Promise<MissionRepeatSeriesStatus> {
    const series = await this.load(seriesId);
    const ids = [series.baselineMissionId];
    let baseline: TestMission;
    let baselineEvidence: Evidence;
    try {
      baseline = (await this.runner.missionStatus(series.baselineMissionId)).mission;
      baselineEvidence = await this.runner.missionEvidence(baseline.missionId);
    } catch {
      return this.result(series, "inconclusive", ids, "Baseline Mission or its evidence is unavailable");
    }
    if (!eligibleEvidence(baselineEvidence)) return this.result(series, "inconclusive", ids, "Baseline business or Git evidence is no longer complete");
    const baseSource = baselineEvidence.finalSourceState!;
    const baseScope = missionScopeHash(baseline);
    let missingSlot = false;
    for (let ordinal = 1; ordinal < series.targetSamples; ordinal += 1) {
      const slotId = missionSlotId(seriesId, ordinal);
      let child: TestMission;
      try { child = (await this.runner.missionStatus(slotId)).mission; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return this.result(series, "inconclusive", [...ids, slotId], `Repeat slot ${ordinal} is unreadable or has invalid ownership`);
        }
        missingSlot = true;
        continue;
      }
      if (missingSlot) return this.result(series, "inconclusive", ids, `Repeat slot ${ordinal} exists after a missing earlier slot`);
      if (child.repeatSeries?.seriesId !== seriesId || child.repeatSeries.ordinal !== ordinal
        || child.replayOfMissionId !== ids[ordinal - 1]
        || missionScopeHash(child) !== baseScope) {
        return this.result(series, "inconclusive", ids, `Repeat slot ${ordinal} has a mismatched owner, replay link or scope`);
      }
      ids.push(slotId);
      if (!TERMINAL.has(child.status)) {
        const running = (await this.runner.missionStatus(slotId)).running;
        if (running) return this.result(series, "running", ids, undefined, slotId, ordinal);
        if (child.status === "awaiting-approval") return this.result(series, "awaiting-approval", ids, undefined, slotId, ordinal, true);
        if (["approved", "paused", "running"].includes(child.status)) {
          return this.result(series, "ready", ids, "Resume the existing Mission slot under its execution recovery policy", slotId, ordinal);
        }
        return this.result(series, "inconclusive", ids, `Repeat slot ${ordinal} has unsupported status ${child.status}`);
      }
      let evidence: Evidence;
      try { evidence = await this.runner.missionEvidence(slotId); }
      catch { return this.result(series, "inconclusive", ids, `Repeat slot ${ordinal} evidence is unreadable`); }
      if (!eligibleEvidence(evidence) || !sameGitSource(baseSource, evidence.sourceState) || !sameGitSource(baseSource, evidence.finalSourceState)) {
        return this.result(series, "inconclusive", ids, `Repeat slot ${ordinal} lacks matching current Git and business evidence`);
      }
    }
    if (ids.length < series.targetSamples) {
      const previous = (await this.runner.missionStatus(ids.at(-1)!)).mission;
      const nextOrdinal = ids.length;
      return this.result(series, "ready", ids, undefined, undefined, nextOrdinal, replayNeedsApproval(previous));
    }
    const analysis = await this.runner.analyzeMissionStability(ids);
    return MissionRepeatSeriesStatusSchema.parse({ series, state: analysis.status === "inconclusive" ? "inconclusive" : "complete",
      missionIds: ids, ...(analysis.gaps.length ? { reason: analysis.gaps[0] } : {}), analysis });
  }

  async advance(seriesId: string, approve = false): Promise<MissionRepeatSeriesStatus> {
    const series = await this.load(seriesId);
    const lease = await this.ownership.acquire(seriesId);
    if (!lease) return this.result(series, "running", (await this.status(seriesId)).missionIds, "Another runner is advancing this repeat series");
    try {
      const current = await this.status(seriesId);
      if (current.state === "complete" || current.state === "inconclusive" || current.state === "running") return current;
      if (current.state === "awaiting-approval" && !approve) return current;
      if (current.currentMissionId) {
        await this.runner.startMission(current.currentMissionId, { approve });
        return this.result(series, "running", current.missionIds, undefined, current.currentMissionId, current.nextOrdinal);
      }
      const previousId = current.missionIds.at(-1)!;
      const started = await this.runner.replayMission(previousId, { approve, repeatSeries: { seriesId, ordinal: current.nextOrdinal! } });
      if (started.mission.status === "awaiting-approval" && !approve) return this.status(seriesId);
      return this.result(series, "running", [...current.missionIds, started.mission.missionId], undefined,
        started.mission.missionId, current.nextOrdinal);
    } finally { await lease.release(); }
  }

  /** Automate only approval-free slots; one explicit approval can authorize at most one interactive replay. */
  async drive(seriesId: string, approveNext = false): Promise<MissionRepeatSeriesStatus> {
    const initial = await this.status(seriesId);
    const approvalOrdinal = approveNext && (initial.state === "ready" || initial.state === "awaiting-approval")
      ? initial.nextOrdinal : undefined;
    for (;;) {
      const current = await this.status(seriesId);
      const credit = approvalOrdinal !== undefined && current.nextOrdinal === approvalOrdinal;
      if (current.state === "complete" || current.state === "inconclusive") return current;
      if (current.state === "awaiting-approval" && !credit) return current;
      if (current.state === "running") {
        if (current.currentMissionId) await this.runner.waitMission(current.currentMissionId);
        else await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      const next = await this.advance(seriesId, credit);
      if (next.state === "awaiting-approval" || next.state === "complete" || next.state === "inconclusive") return next;
      if (next.currentMissionId) await this.runner.waitMission(next.currentMissionId);
    }
  }

  private async load(seriesId: string): Promise<MissionRepeatSeries> {
    const series = MissionRepeatSeriesSchema.parse(JSON.parse(await readFile(this.path(seriesId), "utf8")));
    if (series.seriesId !== seriesId || !sameProjectPath(series.projectRoot, this.runner.root)
      || !sameProjectPath(series.workspaceRoot, this.runner.workspaceRoot)) throw new Error("Repeat series belongs to another project or workspace");
    return series;
  }

  private path(seriesId: string): string {
    if (!/^repeat-[a-f0-9]{12}$/.test(seriesId)) throw new Error("Invalid repeat series id");
    return resolveWithinWorkspace(this.runner.workspaceRoot, join(".proofkit", "repeat-series", `${seriesId}.json`));
  }

  private result(series: MissionRepeatSeries, state: MissionRepeatSeriesStatus["state"], missionIds: string[], reason?: string,
    currentMissionId?: string, nextOrdinal?: number, requiresApproval?: boolean): MissionRepeatSeriesStatus {
    return MissionRepeatSeriesStatusSchema.parse({ series, state, missionIds, reason, currentMissionId, nextOrdinal, requiresApproval });
  }
}

function missionSlotId(seriesId: string, ordinal: number): string { return `mission-${seriesId}-${ordinal}`; }

function replayNeedsApproval(mission: TestMission): boolean {
  const charters = mission.charter ? [mission.charter] : mission.suite?.charters.map((item) => item.charter) ?? [];
  return mission.policy.requireApproval || mission.policy.sideEffectPolicy !== "deny"
    || charters.some((charter) => charter.sideEffectPolicy !== "deny"
      || charter.negativeCases?.some((item) => item.sideEffectPolicy !== "deny"));
}

function completeGit(state: SourceState | undefined): state is SourceState & { headSha: string; worktreeSha256: string } {
  return state?.complete === true && state.method === "git" && Boolean(state.headSha && state.worktreeSha256);
}

function sameGitSource(left: SourceState, right: SourceState | undefined): boolean {
  return completeGit(left) && completeGit(right) && left.headSha === right.headSha && left.worktreeSha256 === right.worktreeSha256;
}

type Evidence = Awaited<ReturnType<LocalRunnerService["missionEvidence"]>>;
function eligibleEvidence(value: Evidence): boolean {
  const summary = value.summary;
  const proof = value.proofClassification;
  const businessProof = value.testVerdict === "passed"
    ? Boolean(proof.requiredBusinessRuns && proof.requiredRunsWithPassingBusiness === proof.requiredBusinessRuns)
    : Boolean(value.testVerdict === "failed" && summary.confirmedProductFindings
      && proof.findingsLinkedToFailingBusiness === summary.confirmedProductFindings);
  return value.level !== "quick" && (value.testVerdict === "passed" || value.testVerdict === "failed")
    && value.summary.scope.sourceStability === "stable" && value.summary.scope.sourceFreshness === "matching"
    && summary.executionAudit?.status === "complete" && summary.agentTraceAudit?.status === "complete"
    && summary.acceptanceEvidenceIntegrity?.status === "intact"
    && summary.expectedRuns > 0 && !summary.omittedRunResults && summary.observedRuns === summary.expectedRuns
    && summary.runs.length === summary.expectedRuns
    && summary.runs.every((run) => run.runId && (!run.issue || expectedProductRunFailure(run))
      && run.evidence.some((ref) => ref.sha256 && ref.evidenceId.startsWith(`${run.runId}:`))
      && hasStableOwnedBinding(run.targetBinding, run.targetBindingAfterRun, run.targetContinuity)
      && (run.surface !== "electron" || hasStableOwnedBinding(run.applicationBinding, run.applicationBindingAfterRun, run.applicationContinuity))
      && (run.surface === "electron" || run.applicationContinuity !== "changed" && run.applicationContinuity !== "unverified")
      && run.integrationPostRunCheck?.passed !== false
      && (!run.integrationCleanup || ["verified", "not-required"].includes(run.integrationCleanup.status)))
    && proof.status === "explicit" && businessProof
    && completeGit(value.sourceState) && sameGitSource(value.sourceState, value.finalSourceState);
}
