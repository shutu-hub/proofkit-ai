import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MissionAcceptanceIntegritySchema, MissionEvidenceIntegritySchema, MissionResultSchema, type EvidenceRef, type MissionAcceptanceIntegrity, type MissionEvidenceIntegrity, type MissionResult, type MissionRunResult } from "@proofkit/contracts";

type EvidenceLink = { href?: string; runId?: string };
const MAX_MISSION_AUDIT_REFERENCES = 2048;
const MISSION_AUDIT_CONCURRENCY = 8;
const MAX_MISSION_AUDIT_MS = 15_000;

/** Static Mission snapshots live beside the existing Mission store, inside its workspace. */
export class MissionReportStore {
  private readonly workspaceRoot: string;
  private readonly runRoot: string;

  constructor(workspaceRoot: string, runRoot = join(workspaceRoot, ".proofkit", "runs")) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.runRoot = resolve(runRoot);
  }

  async writeReport(input: MissionResult): Promise<string> {
    return (await this.writeReportSnapshot(input)).path;
  }

  async writeReportSnapshot(input: MissionResult): Promise<{ path: string; result: MissionResult; integrity: MissionEvidenceIntegrity }> {
    const result = MissionResultSchema.parse(input);
    const workspace = await realpath(this.workspaceRoot);
    if (!samePath(workspace, await realpath(result.workspaceRoot))) throw new Error("Report belongs to another workspace");
    const requestedDir = join(this.workspaceRoot, ".proofkit", "missions", result.missionId);
    // Check the existing ancestor before mkdir can traverse an escaping symlink.
    if (!within(workspace, await existingAncestor(requestedDir))) throw new Error("Mission report directory must stay within its workspace");
    await mkdir(requestedDir, { recursive: true });
    const reportDir = await realpath(requestedDir);
    if (!within(workspace, reportDir)) throw new Error("Mission report directory must stay within its workspace");
    const links = await this.buildLinks(result, workspace, reportDir);
    const integrity = summarizeIntegrity(result, links);
    const snapshot = MissionResultSchema.parse({ ...result, evidenceIntegrity: integrity, ...auditMissionVerdict(result, integrity) });
    await atomicWrite(join(reportDir, "summary.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    const path = join(reportDir, "report.html");
    await atomicWrite(path, renderMissionReport(snapshot, links));
    return { path, result: snapshot, integrity };
  }

  /** Read current evidence integrity even when the static report directory is not writable. */
  async inspectIntegrity(input: MissionResult): Promise<MissionEvidenceIntegrity> {
    const result = MissionResultSchema.parse(input);
    let links = new Map<string, EvidenceLink>();
    try {
      const workspace = await realpath(this.workspaceRoot);
      if (samePath(workspace, await realpath(result.workspaceRoot))) {
        links = await this.buildLinks(result, workspace, workspace);
      }
    } catch { /* Missing workspaces leave every reference unavailable. */ }
    return summarizeIntegrity(result, links);
  }

  /** Audit every supplied acceptance reference; presentation caps do not make an ordinary Run fail. */
  async inspectMissionEvidence(refs: EvidenceRef[], runIds: Set<string>): Promise<MissionAcceptanceIntegrity> {
    const unique = [...new Map(refs.map((ref) => [evidenceKey(ref), ref])).values()];
    const inspected = unique.slice(0, MAX_MISSION_AUDIT_REFERENCES);
    const deadline = Date.now() + MAX_MISSION_AUDIT_MS;
    let checked = 0;
    let intact = 0;
    let unavailable = 0;
    let legacy = 0;
    let workspace: string | undefined;
    try { workspace = await realpath(this.workspaceRoot); } catch { /* Missing workspace makes refs unavailable. */ }
    for (let start = 0; start < inspected.length; start += MISSION_AUDIT_CONCURRENCY) {
      if (Date.now() >= deadline) break;
      const batch = inspected.slice(start, start + MISSION_AUDIT_CONCURRENCY);
      const results = await Promise.all(batch.map(async (ref) => {
        if (!ref.sha256) return "legacy" as const;
        if (!workspace) return "unavailable" as const;
        const link = await this.evidenceLink(ref, workspace, workspace, runIds);
        return link.href ? "intact" as const : "unavailable" as const;
      }));
      for (const result of results) {
        if (result === "intact") intact++;
        else if (result === "legacy") legacy++;
        else unavailable++;
      }
      checked += batch.length;
    }
    const omitted = unique.length - checked;
    return MissionAcceptanceIntegritySchema.parse({
      status: unavailable || legacy ? "degraded" : omitted ? "partial" : unique.length ? "intact" : "no-evidence",
      scope: "mission-evidence", checkedAt: new Date().toISOString(),
      references: { total: unique.length, intact, unavailable, legacy, omitted },
    });
  }

  private async buildLinks(result: MissionResult, workspace: string, reportDir: string): Promise<Map<string, EvidenceLink>> {
    const runIds = referencedRunIds(result);
    const links = new Map<string, EvidenceLink>();
    const refs = uniqueEvidence(result);
    for (let start = 0; start < refs.length; start += MISSION_AUDIT_CONCURRENCY) {
      await Promise.all(refs.slice(start, start + MISSION_AUDIT_CONCURRENCY).map(async (ref) => {
        links.set(evidenceKey(ref), await this.evidenceLink(ref, workspace, reportDir, runIds));
      }));
    }
    return links;
  }

  private async evidenceLink(ref: EvidenceRef, workspace: string, reportDir: string, runIds: Set<string>): Promise<EvidenceLink> {
    try {
      if (!ref.sha256) return {};
      const path = ref.path;
      const target = isAbsolute(path) ? resolve(path) : resolve(this.runRoot, path);
      const parts = relative(this.runRoot, target).split(sep);
      const runId = parts[0];
      if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId) || !runIds.has(runId) || !allowedRunFile(parts.slice(1))) return {};
      const canonicalRoot = await realpath(this.runRoot);
      const canonicalRun = await realpath(join(this.runRoot, runId));
      const canonicalTarget = await realpath(target);
      if (!within(workspace, canonicalRoot) || !samePath(canonicalRun, join(canonicalRoot, runId))
        || !within(canonicalRun, canonicalTarget) || !allowedRunFile(relative(canonicalRun, canonicalTarget).split(sep))) return {};
      const file = await stat(canonicalTarget);
      if (!file.isFile() || file.size <= 0 || file.size > 64 * 1024 * 1024) return {};
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(canonicalTarget)) digest.update(chunk);
      if (digest.digest("hex") !== ref.sha256.toLowerCase()) return {};
      return { href: relative(reportDir, canonicalTarget).split(sep).map(encodeURIComponent).join("/"), runId };
    } catch {
      return {};
    }
  }
}

/** Keep the saved verdict separate from what the currently readable evidence supports. */
export function auditMissionVerdict(result: MissionResult, integrity: MissionEvidenceIntegrity): Pick<MissionResult, "testVerdict" | "testVerdictReason"> {
  const saved = result.verdict ?? "not-asserted";
  if (saved !== "passed" && saved !== "failed") return { testVerdict: saved };
  if (result.agentTraceAudit?.status !== "complete") {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved AgentStep, ToolCall and Observation ownership is missing or inconsistent; rerun or review the trace before trusting this result." };
  }
  if (saved === "passed" && result.planning?.coverage?.requested === "project"
    && result.scope.workflowReviewAudit?.status !== "verified") {
    return { testVerdict: "inconclusive", testVerdictReason: "The saved whole-project pass lacks a currently verified reviewed source scope and matching workflow Runs." };
  }
  if (saved === "passed" && result.executionAudit?.status !== "complete") {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved Mission has missing, duplicated or mismatched execution Runs; rerun the declared scope before claiming acceptance." };
  }
  if (saved === "failed" && result.confirmedProductFindings > 0
    && result.executionAudit?.status !== "complete") {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved product failure has missing, duplicated or mismatched observed Runs; recheck the failing scenario before claiming a product defect." };
  }
  if (result.scope.sourceStability === "changed") {
    return { testVerdict: "inconclusive", testVerdictReason: "The tested Git source changed during this Mission; rerun the same scope against a stable checkout before claiming current acceptance or a product defect." };
  }
  if (result.scope.sourceFreshness === "changed") {
    return { testVerdict: "inconclusive", testVerdictReason: "The project Git source changed since this Mission ended; rerun the same scope before claiming current acceptance or a product defect." };
  }
  if (result.scope.sourceFreshness === "unavailable") {
    return { testVerdict: "inconclusive", testVerdictReason: "The tested Git source was verifiable when this Mission ended but cannot be rechecked now; restore source access or rerun before claiming current acceptance or a product defect." };
  }
  const proof = result.proofClassification;
  if (saved === "passed" && result.level !== "quick"
    && (proof?.status !== "explicit" || !proof.requiredBusinessRuns
      || proof.requiredRunsWithPassingBusiness !== proof.requiredBusinessRuns)) {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved core/release pass lacks a classified passing business Oracle in every required Run; rerun affected scenarios." };
  }
  if (saved === "failed" && result.confirmedProductFindings > 0
    && (proof?.status !== "explicit" || proof.confirmedProductFindings !== result.confirmedProductFindings
      || proof.findingsLinkedToFailingBusiness !== result.confirmedProductFindings)) {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved confirmed product finding is not linked to a classified failing business Oracle in its own Run; rerun before claiming a product defect." };
  }
  const full = result.acceptanceEvidenceIntegrity;
  if (full && full.status !== "intact") {
    const reason = full.status === "partial"
      ? "Saved Mission evidence audit did not cover every reference within its limits; rerun or split the scope before claiming current acceptance."
      : "Saved Mission has unavailable or unverifiable evidence; rerun before claiming acceptance.";
    return { testVerdict: "inconclusive", testVerdictReason: reason };
  }
  if (saved === "failed" && integrity.visibleConfirmedFindings.supported < integrity.visibleConfirmedFindings.saved) {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved confirmed product finding has missing or changed cited evidence; rerun before claiming a product defect." };
  }
  if (!full && integrity.status !== "intact") {
    return { testVerdict: "inconclusive", testVerdictReason: "Saved result has unavailable or incompletely audited presented evidence; rerun before claiming current acceptance." };
  }
  return saved === "passed" && result.planning?.coverage?.requested === "project"
    ? { testVerdict: "passed", testVerdictReason: "Pass is limited to the signed, source-bound reviewed workflow inventory and its audited Run matrix." }
    : { testVerdict: saved };
}

function renderMissionReport(result: MissionResult, links: Map<string, EvidenceLink>): string {
  const evidence = (refs: EvidenceRef[], expectedRunId?: string) => refs.map((ref) => {
    const label = evidenceLabel(ref.kind);
    const link = links.get(evidenceKey(ref));
    const href = expectedRunId === undefined || link?.runId === expectedRunId ? link?.href : undefined;
    return href ? `<a class="evidence-link" href="${html(href)}" title="${html(ref.description ?? label)}">${html(label)}</a>`
      : ref.sha256 ? `<span class="unavailable" title="Saved evidence is missing, changed or outside this Run.">${html(label)} unavailable</span>`
        : `<span class="unavailable" title="Legacy evidence has no saved digest.">${html(label)} integrity unverified</span>`;
  }).join(" ");
  const coverage = result.planning?.coverage;
  const scopeLabel = coverage?.requested === "project" && result.scope.workflowReviewAudit?.status === "verified"
    ? "Reviewed source workflows" : coverage?.requested === "project" ? "Whole project requested"
      : coverage?.requested === "declared" ? "Declared scenarios" : "Acceptance scope not recorded";
  const outcome = result.verdict ?? "not evaluated";
  const route = result.scope.routeCoverage;
  const workflowInventory = result.scope.workflowInventory;
  const workflowExecution = result.scope.workflowExecution;
  const workflowReviewAudit = result.scope.workflowReviewAudit;
  const executionAudit = result.executionAudit;
  const agentTraceAudit = result.agentTraceAudit;
  const unavailable = [...links.values()].filter((link) => !link.href).length;
  const unverified = [...new Map(collectEvidence(result).map((ref) => [evidenceKey(ref), ref])).values()].filter((ref) => !ref.sha256).length;
  const savedConfirmed = result.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed");
  const currentlyVerified = savedConfirmed.filter((finding) => hasCompleteEvidence(finding.evidence, links)).length;
  const staleFindings = savedConfirmed.length - currentlyVerified;
  const comparisonEvidenceUnavailable = comparisonEvidenceStatus(result, links) === "degraded";
  const proofUnverified = result.proofClassification?.status === "unverified";
  const businessPassUnverified = result.verdict === "passed" && result.level !== "quick"
    && (result.proofClassification?.status !== "explicit" || !result.proofClassification.requiredBusinessRuns
      || result.proofClassification.requiredRunsWithPassingBusiness !== result.proofClassification.requiredBusinessRuns);
  const businessFailureUnverified = result.verdict === "failed" && result.confirmedProductFindings > 0
    && (result.proofClassification?.status !== "explicit"
      || result.proofClassification.confirmedProductFindings !== result.confirmedProductFindings
      || result.proofClassification.findingsLinkedToFailingBusiness !== result.confirmedProductFindings);
  const evidenceUnverified = (result.verdict === "passed" || result.verdict === "failed")
    && result.testVerdict === "inconclusive" && !businessPassUnverified && !businessFailureUnverified;
  const currentOutcomeLabel = (result.verdict === "passed" || result.verdict === "failed") && result.scope.sourceStability === "changed"
    ? `Saved ${result.verdict === "passed" ? "pass" : "failure"} · source changed during execution`
    : (result.verdict === "passed" || result.verdict === "failed") && result.scope.sourceFreshness === "changed"
      ? `Saved ${result.verdict === "passed" ? "pass" : "failure"} · source changed since execution`
    : (result.verdict === "passed" || result.verdict === "failed") && result.scope.sourceFreshness === "unavailable"
      ? `Saved ${result.verdict === "passed" ? "pass" : "failure"} · current source unavailable`
    : businessPassUnverified ? "Saved pass · current business proof unverified"
    : businessFailureUnverified ? "Saved failure · current business proof unverified"
      : evidenceUnverified ? `Saved ${result.verdict === "passed" ? "pass" : "failure"} · current evidence unverified` : outcomeLabel(outcome);
  const limits = [
    result.evidenceIntegrity ? `Current presented evidence integrity: ${result.evidenceIntegrity.status}; ${result.evidenceIntegrity.references.intact}/${result.evidenceIntegrity.references.total} reference(s) verified at ${result.evidenceIntegrity.checkedAt}. This does not change the saved acceptance verdict.` : undefined,
    result.acceptanceEvidenceIntegrity ? `Current Mission acceptance evidence integrity: ${result.acceptanceEvidenceIntegrity.status}; ${result.acceptanceEvidenceIntegrity.references.intact}/${result.acceptanceEvidenceIntegrity.references.total} saved execution and Finding reference(s) verified, ${result.acceptanceEvidenceIntegrity.references.omitted} beyond the audit limit. Advisory diagnosis and repair evidence is assessed separately. This does not prove whole-project coverage or application state after the Run.` : undefined,
    result.testVerdictReason,
    executionAudit ? `Execution slots (${executionAudit.scope}): ${executionAudit.matchedSlots}/${executionAudit.expectedSlots} uniquely matched; ${executionAudit.unexecutedSlots} unexecuted, ${executionAudit.unexpectedObservations} unexpected Run observation(s).` : undefined,
    agentTraceAudit ? `Agent trace: ${agentTraceAudit.status}; ${agentTraceAudit.checkedSteps} step(s), ${agentTraceAudit.checkedCalls} call(s), ${agentTraceAudit.checkedObservations} observation(s) checked.` : undefined,
    ...(agentTraceAudit?.issues ?? []).map((issue) => `Agent trace gap: ${issue}`),
    agentTraceAudit?.omittedIssues ? `${agentTraceAudit.omittedIssues} additional Agent trace gaps are omitted from this report.` : undefined,
    ...(executionAudit?.issues ?? []).map((issue) => `Execution slot gap: ${issue}`),
    executionAudit?.omittedIssues ? `${executionAudit.omittedIssues} additional execution slot gaps are omitted from this report.` : undefined,
    result.scope.sourceStability ? `Git source stability during this Mission: ${result.scope.sourceStability}. This fingerprint excludes generated output and does not attest served bytes.` : undefined,
    result.scope.sourceFreshness ? `Git source at report check: ${result.scope.sourceFreshness}${result.scope.currentSourceState ? ` (captured ${result.scope.currentSourceState.capturedAt})` : ""}. A match does not attest served bytes or backend state.` : undefined,
    proofUnverified ? `Current business proof classification is unverified: ${result.proofClassification!.legacyOracles} saved Oracle result(s) lack a verification kind, ${result.proofClassification!.unavailableRuns} Run(s) could not be read, and ${result.proofClassification!.omittedRuns} Run(s) exceeded the audit bound. Rerun affected scenarios before treating the saved business verdict or finding as current proof.` : undefined,
    result.proofClassification?.requiredBusinessRuns !== undefined ? `Required Run business proof: ${result.proofClassification.requiredRunsWithPassingBusiness ?? 0}/${result.proofClassification.requiredBusinessRuns} primary/replay Run(s) have a classified passing business Oracle.` : undefined,
    result.confirmedProductFindings ? `Confirmed product finding proof: ${result.proofClassification?.findingsLinkedToFailingBusiness ?? 0}/${result.confirmedProductFindings} finding(s) link to a classified failing business Oracle in the same Run.` : undefined,
    result.proofClassification?.unlinkedFindingIds?.length ? `Unlinked finding IDs: ${result.proofClassification.unlinkedFindingIds.join(", ")}${result.proofClassification.omittedUnlinkedFindingIds ? ` and ${result.proofClassification.omittedUnlinkedFindingIds} more` : ""}.` : undefined,
    coverage?.requested === "project" && result.scope.workflowReviewAudit?.status === "verified"
      ? "Acceptance covers the signed source workflow inventory; review quality determines whether its business list is semantically complete."
      : coverage?.requested === "project" ? "Whole-project workflow coverage has not been proven."
        : "Acceptance applies to the saved scenarios. Whole-project workflow coverage has not been measured.",
    coverage?.inventory === "partial" || route?.inventoryTruncated ? "The source inventory is partial; it cannot establish complete project coverage." : undefined,
    !coverage ? "This saved Mission has no recorded acceptance scope." : undefined,
    result.scope.uncoveredCharterIds.length ? `Registered scenarios outside this Mission matrix: ${result.scope.uncoveredCharterIds.join(", ")}.` : undefined,
    workflowInventory ? `Workflow inventory: ${workflowInventory.status}; ${workflowInventory.linkedWorkflowCount}/${workflowInventory.workflowCount} workflows linked to registered Charters; source ${workflowInventory.sourceMatch}; ${workflowInventory.exclusionCount} exclusions. This declaration does not prove completeness or execution.` : undefined,
    ...(workflowInventory?.issues ?? []).map((issue) => `Workflow inventory gap: ${workflowInventoryIssueLabel(issue)}`),
    workflowInventory?.missingCharterIds.length ? `Unregistered workflow Charters: ${workflowInventory.missingCharterIds.join(", ")}${workflowInventory.omittedMissingCharterIds ? ` and ${workflowInventory.omittedMissingCharterIds} more` : ""}.` : undefined,
    workflowInventory?.uncoveredSurfaces.length ? `Uncovered workflow surfaces: ${workflowInventory.uncoveredSurfaces.map((item) => `${item.workflowId}/${item.surface}`).join(", ")}${workflowInventory.omittedUncoveredSurfaces ? ` and ${workflowInventory.omittedUncoveredSurfaces} more` : ""}.` : undefined,
    workflowInventory?.missingSourcePaths.length ? `Missing workflow source paths: ${workflowInventory.missingSourcePaths.join(", ")}${workflowInventory.omittedMissingSourcePaths ? ` and ${workflowInventory.omittedMissingSourcePaths} more` : ""}.` : undefined,
    workflowInventory?.candidateAudit ? `Static candidate review: ${workflowInventory.candidateAudit.routeCandidates} routes, ${workflowInventory.candidateAudit.entryCandidates} entry points; ${workflowInventory.candidateAudit.unclaimed} unclaimed, ${workflowInventory.candidateAudit.unlinkedRoutes} routes without a linked Charter, ${workflowInventory.candidateAudit.overlappingExclusions} ownership/exclusion overlaps. This bounded scan cannot establish business workflow completeness.` : undefined,
    ...(workflowInventory?.candidateAudit?.gaps.slice(0, 5) ?? []).map((gap) => `Candidate review: ${gap.source}${gap.path ? ` · ${gap.path}` : ""} · ${gap.reason}.`),
    workflowInventory?.candidateAudit?.omittedGaps ? `${workflowInventory.candidateAudit.omittedGaps} candidate review gaps are omitted from the bounded summary.` : undefined,
    workflowExecution ? `Declared workflow execution: ${workflowExecution.evidencedChecks}/${workflowExecution.requiredChecks} Charter/platform checks and ${workflowExecution.evidencedWorkflowCount}/${workflowExecution.workflowCount} workflows evidenced; required proof ${workflowExecution.requiredProof ?? "not recorded"}; source binding ${workflowExecution.sourceBinding}. This does not prove the inventory is complete.` : undefined,
    workflowReviewAudit && workflowReviewAudit.status !== "not-applicable"
      ? `Reviewed source scope: ${workflowReviewAudit.status}${workflowReviewAudit.reason ? ` (${workflowReviewAudit.reason})` : ""}. A verified review authenticates the declared scope, not an unknowable universal workflow list.` : undefined,
    ...(workflowExecution?.gaps.slice(0, 10) ?? []).map((gap) => `Missing workflow check: ${gap.workflowId} · ${gap.charterId}/${gap.surface} · ${gap.reason}.`),
    workflowExecution?.gaps.length && workflowExecution.gaps.length > 10 ? `${workflowExecution.gaps.length - 10} more workflow check gaps are in summary.json.` : undefined,
    workflowExecution?.omittedGaps ? `${workflowExecution.omittedGaps} workflow check gaps are omitted from the bounded summary.` : undefined,
    route ? `Static routes: ${route.observedCandidates} observed, ${route.mappedCandidates} mapped, ${route.candidateRoutes} candidates. ${route.gapCount} route gaps and ${route.unresolvedTargetCount} unresolved declarations. Route counts are not business workflow coverage.` : undefined,
    unavailable ? `${unavailable} evidence reference(s) cannot be verified and opened from this report${unverified ? `; ${unverified} lack a saved digest` : ""}.` : undefined,
    staleFindings ? `${staleFindings} saved confirmed product finding(s) lack currently verifiable evidence and cannot be independently confirmed from this report.` : undefined,
    comparisonEvidenceUnavailable ? "Saved repair comparison contains evidence that cannot be verified now; rerun comparison before claiming a repair is verified." : undefined,
    result.omittedRunResults ? `${result.omittedRunResults} execution row(s) omitted from this bounded summary.` : undefined,
  ].filter((item): item is string => Boolean(item));
  const planningGaps = [...new Set([...(result.planning?.missingInputs ?? []), ...(result.planning?.evidenceGaps ?? []).map(gapLabel)])];
  const firstFailure = result.firstFailure ? `<section class="failure" aria-labelledby="first-failure"><div class="section-label">First failure · ${html(result.firstFailure.kind)}</div><h2 id="first-failure">${html(result.firstFailure.message)}</h2><p class="meta">${html([result.firstFailure.charterId, result.firstFailure.surface, result.firstFailure.oracleName].filter(Boolean).join(" · "))}</p><div class="links">${evidence(result.firstFailure.evidence)}</div></section>` : "";
  const comparison = result.comparison ? `<section class="comparison"><div><div class="section-label">Repair replay · current check</div><h2>${html(comparisonLabel(result.comparison.status))}</h2><p>${html(result.comparison.reason)}</p>${result.comparison.historicalStatus ? `<p class="meta">Saved comparison before current source recheck: ${html(comparisonLabel(result.comparison.historicalStatus))}.</p>` : ""}${comparisonEvidenceUnavailable ? '<p class="unavailable">Current evidence cannot verify this saved comparison. Rerun comparison before claiming the repair is verified.</p>' : ""}</div><details><summary>Comparison evidence and limits</summary><p>Source change: ${html(result.comparison.sourceChange)} · Baseline source: ${html(result.comparison.baselineSourceStability ?? "unknown")} · Candidate source during replay: ${html(result.comparison.candidateSourceStability)} · Candidate source now: ${html(result.comparison.candidateSourceFreshness ?? "unverified")}</p><ul>${result.comparison.gaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul>${result.comparison.defects.map((defect) => `<p>${html(defect.oracleName)} · ${html(defect.surface)} · ${html(defect.outcome)}<br>Before: ${evidence(defect.baselineEvidence, defect.baselineRunId)}<br>Replay: ${evidence(defect.candidateEvidence, defect.candidateRunId ?? "")}</p>`).join("")}${result.comparison.omittedRuns || result.comparison.omittedDefects ? `<p class="meta">${result.comparison.omittedRuns} comparison runs and ${result.comparison.omittedDefects} defects omitted.</p>` : ""}<p class="meta">This comparison does not establish which source change caused the result.</p></details></section>`
    : result.comparisonUnavailable ? `<section class="comparison"><h2>Repair comparison unavailable</h2><p>${html(result.comparisonUnavailable)}</p></section>` : "";
  const replayConsistency = result.replayConsistency ? `<section class="comparison"><div class="section-label">Release replay · saved observations</div><h2>${html(result.replayConsistency.status === "diverge" ? "Primary and replay verdicts differ" : result.replayConsistency.status === "agree" ? "Observed replay verdicts agree" : "Replay comparison incomplete")}</h2><p>${result.replayConsistency.comparedPairs}/${result.replayConsistency.expectedPairs} pair(s) compared · ${result.replayConsistency.divergentPairs} divergent · ${result.replayConsistency.unverifiedPairs} unverified. Verdict divergence is a signal to investigate; two runs alone do not establish flakiness.</p><details><summary>Scenario replay pairs</summary><ul>${result.replayConsistency.pairs.map((pair) => `<li>${html([pair.charterId, pair.surface].filter(Boolean).join(" / "))}: ${html(pair.primaryVerdict ?? "missing")} → ${html(pair.replayVerdict ?? "missing")} (${html(pair.agreement)}) · Runs ${html(pair.primaryRunId ?? "missing")} / ${html(pair.replayRunId ?? "missing")}</li>`).join("")}</ul>${result.replayConsistency.omittedPairs ? `<p class="meta">${result.replayConsistency.omittedPairs} pair(s) omitted.</p>` : ""}<p class="meta">Review the Run evidence links below and the current evidence integrity before relying on saved observations.</p></details></section>` : "";
  const rows = result.runs.map((run) => `<tr><td><strong>${html(run.title)}</strong>${run.charterId ? `<small>${html(run.charterId)}</small>` : ""}${run.issue ? `<p class="row-issue">${html(run.issue)}</p>` : ""}</td><td>${html(run.surface ?? "unknown")}<small>${html(run.runKind)}${run.negativeCaseId ? ` · ${html(run.negativeCaseId)}` : ""}</small></td><td>${runOutcome(run)}<small>Task: ${html(run.taskStatus ?? "unassociated")}</small></td><td><small>UI: ${countLabel(run.assertions)}<br>Business checks: ${countLabel(run.oracles)}<br>Business facts: ${run.businessFacts ?? "not recorded"}</small><small>Target: ${html(run.targetBinding?.status ?? "not inspected")}${run.targetContinuity ? `<br>Target continuity: ${html(run.targetContinuity)}` : ""}${run.surface === "electron" ? `<br>Electron process: ${html(run.applicationBinding?.status ?? "not inspected")}${run.applicationContinuity ? `<br>Electron continuity: ${html(run.applicationContinuity)}` : ""}` : ""}<br>Cleanup: ${html(run.integrationCleanup?.status ?? "not recorded")}${run.integrationCleanup ? ` (${run.integrationCleanup.verifiedResources}/${run.integrationCleanup.declaredResources})` : ""}</small></td><td><div class="links">${evidence(run.evidence) || "No saved evidence"}</div>${run.omittedEvidence ? `<small>${run.omittedEvidence} more reference(s) in Run report</small>` : ""}</td></tr>`).join("");
  const findings = result.findings.map((finding) => `<article class="finding"><div class="section-label">${html(finding.category)} · ${finding.category === "product" && finding.status === "confirmed" && !hasCompleteEvidence(finding.evidence, links) ? "saved confirmed · evidence currently unverified" : html(finding.status)} · ${html(finding.severity)}</div><h3>${html(finding.title)}</h3><p>${html(finding.message)}</p><div class="links">${evidence(finding.evidence)}</div></article>`);
  const findingsSection = findings.length ? `<section><div class="section-heading"><h2>Findings</h2><span class="meta">${currentlyVerified} / ${savedConfirmed.length} visible saved confirmed product finding(s) have all cited evidence</span></div>${findings.slice(0, 3).join("")}${findings.length > 3 ? `<details><summary>${findings.length - 3} more findings</summary>${findings.slice(3).join("")}</details>` : ""}${result.omittedFindings ? `<p class="meta">${result.omittedFindings} finding(s) omitted. The full audit is retained in the Mission store.</p>` : ""}</section>` : "";
  const diagnosticSupport = result.evidenceIntegrity?.diagnosticSupport;
  const findingLabel = (findingId?: string) => findingId
    ? `<p class="meta">For finding: ${html(result.findings.find((finding) => finding.findingId === findingId)?.title ?? "Finding link unavailable")}</p>`
    : "";
  const visibleDiagnoses = result.diagnoses.length ? result.diagnoses : result.diagnosis ? [result.diagnosis] : [];
  const diagnosisCards = visibleDiagnoses.map((diagnosis, index) => {
    const support = diagnosticSupport?.diagnoses[index]
      ?? (diagnosis.diagnosisId === result.diagnosis?.diagnosisId ? diagnosticSupport?.diagnosis : undefined);
    const headline = diagnosis.diagnosisId === result.diagnosis?.diagnosisId ? " · Mission headline" : "";
    return `<h3>Diagnosis ${index + 1}${headline}</h3>${findingLabel(diagnosis.findingId)}<p>${html(diagnosis.summary)}</p><p class="meta">Current diagnosis support: ${html(diagnosticSupportLabel(support))}. Evidence support does not establish the source-level cause.</p>${diagnosis.sourceLocations.length ? `<p>Source hints (not root-cause evidence): ${diagnosis.sourceLocations.map(html).join(", ")}</p>` : ""}<div class="links">${evidence(diagnosis.evidence)}</div>`;
  }).join("");
  const hypothesisDetails = (suggestion: MissionResult["repairSuggestions"][number]) => {
    if (!suggestion.hypothesis) return "";
    const audit = result.repairSourceAudits?.find((item) => item.suggestionId === suggestion.suggestionId);
    return `<p class="meta">Host hypothesis · source scope: current checkout · cause unverified</p><ul>${suggestion.hypothesis.sourceReferences.map((ref, index) => `<li>${html(ref.path)}:${ref.startLine}–${ref.endLine} · ${html(audit?.references[index]?.status ?? "not audited")}<br>${html(ref.explanation)}<br><small>SHA-256: ${html(ref.sha256)}</small></li>`).join("")}</ul><p><strong>Regression check:</strong> ${html(suggestion.hypothesis.regressionCheck)}</p>`;
  };
  const proposalCards = result.repairSuggestions.map((suggestion, index) => `<h3>${html(suggestion.title)} · saved ${html(suggestion.status)}</h3>${findingLabel(suggestion.findingId)}<p class="meta">Current proposal support: ${html(diagnosticSupportLabel(diagnosticSupport?.repairSuggestions[index]))}. Current evidence support does not independently verify a code repair.</p><p>${html(suggestion.rationale)}</p><ul>${suggestion.changes.map((change) => `<li>${html(change)}</li>`).join("")}</ul>${hypothesisDetails(suggestion)}<div class="links">${evidence(suggestion.evidence)}</div>`).join("");
  const proposed = result.repairSuggestions.find((suggestion) => suggestion.hypothesis);
  const proposalSupport = proposed ? diagnosticSupport?.repairSuggestions.find((item) => item.suggestionId === proposed.suggestionId) : undefined;
  const proposalAudit = proposed ? result.repairSourceAudits?.find((item) => item.suggestionId === proposed.suggestionId) : undefined;
  const proposalReady = proposalSupport?.status === "supported" && proposalAudit?.references.every((ref) => ref.status === "matching");
  const proposalPreview = proposed ? `<section><div class="section-label">Host repair hypothesis · cause unverified</div><h2>${html(proposed.title)}</h2><p class="meta">${proposalReady ? "Failure evidence linked; current source references match. Review the hypothesis before editing." : "Proposal references require review. Read the evidence and source checks below before editing."}</p>${findingLabel(proposed.findingId)}<p>${html(proposed.rationale)}</p><p><strong>Next change:</strong> ${html(proposed.changes[0] ?? "")}</p><p><strong>Regression check:</strong> ${html(proposed.hypothesis!.regressionCheck)}</p><div class="links">${evidence(proposed.evidence)}</div></section>` : "";
  const repair = visibleDiagnoses.length || result.repairSuggestions.length || result.omittedDiagnoses
    ? `${proposalPreview}<section><details><summary>Saved diagnoses and repair suggestions</summary>${diagnosisCards}${result.omittedDiagnoses ? `<p class="meta">${result.omittedDiagnoses} diagnosis record(s) omitted. Inspect the saved Mission for the complete list.</p>` : ""}${proposalCards}${result.omittedRepairSuggestions ? `<p class="meta">${result.omittedRepairSuggestions} proposal(s) omitted.</p>` : ""}</details></section>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ProofKit · ${html(result.intent)}</title><style>
:root{color-scheme:light;--ink:#1c302e;--muted:#5d706c;--line:#d9e2df;--paper:#fff;--canvas:#f4f7f5;--accent:#17685a}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 28px 48px}header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}header{margin-bottom:22px}.brand{font-weight:750;letter-spacing:-.5px;font-size:21px}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:20px}h1,h2,h3,p{margin:0}h1{font-size:clamp(25px,3.8vw,40px);line-height:1.2;letter-spacing:-1px;margin:12px 0}h2{font-size:19px;line-height:1.4}h3{font-size:16px}p{margin-top:8px;overflow-wrap:anywhere}.meta,small{color:var(--muted);font-size:13px}.section-label{font-size:12px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;color:var(--muted)}.hero{background:var(--paper);border:1px solid var(--line);border-top:4px solid var(--accent);padding:24px 28px}.hero[data-verdict=failed]{border-top-color:#a42d37}.hero[data-verdict=inconclusive],.hero[data-verdict=blocked]{border-top-color:#9a6716}.hero-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.badge{display:inline-block;font-size:12px;line-height:1.5;padding:3px 9px;border:1px solid var(--line);border-radius:4px}.status-passed{color:#146247;background:#edf6f0}.status-failed{color:#9f2733;background:#fff0f1}.status-blocked,.status-inconclusive{color:#83580d;background:#fff6e7}.metrics{display:flex;flex-wrap:wrap;gap:26px;border-top:1px solid var(--line);margin-top:22px;padding-top:16px}.metrics strong{font-size:21px;font-weight:650;margin-right:6px}.scope{padding:20px 0;border-bottom:1px solid var(--line)}.scope ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--muted)}section{margin-top:24px}.failure{padding:18px 22px;background:#fff5f2;border-left:3px solid #a42d37}.failure h2{margin-top:6px;overflow-wrap:anywhere}.links{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px}.evidence-link,.unavailable{font-size:13px}.unavailable{color:#83580d}.comparison{border:1px solid var(--line);background:var(--paper);padding:18px 22px}.comparison p{font-size:14px}.table-wrap{overflow-x:auto;margin-top:12px;border:1px solid var(--line);background:var(--paper)}table{width:100%;border-collapse:collapse;min-width:760px;table-layout:fixed}th{font-size:12px;color:var(--muted);font-weight:650;background:#eef3f0}th,td{padding:14px 16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th:nth-child(1){width:25%}th:nth-child(2){width:12%}th:nth-child(3){width:19%}th:nth-child(4){width:20%}th:nth-child(5){width:24%}tbody tr:last-child td{border-bottom:0}td{font-size:14px;overflow-wrap:anywhere}small{display:block;margin-top:4px}.row-issue{font-size:12px;color:#83580d}.finding{padding:18px 0;border-bottom:1px solid var(--line)}.finding h3{margin-top:5px}.finding p{font-size:14px}details{margin-top:14px}summary{cursor:pointer;color:var(--accent);font-weight:600;overflow-wrap:anywhere}details p,details li{font-size:14px}footer{margin-top:30px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media(max-width:600px){main{padding:16px 16px 32px}.hero{padding:18px}.metrics{gap:14px}.metrics strong{font-size:18px}header{align-items:flex-start}nav{gap:12px;font-size:13px}.section-heading{align-items:flex-start;flex-direction:column;gap:4px}.failure,.comparison{padding:16px}.table-wrap{margin-right:0}th,td{padding:12px}}
</style></head><body><main><header><div class="brand">ProofKit <span class="meta">/ Mission result</span></div><nav aria-label="Report navigation"><a href="#execution">Executions</a><a href="summary.json">Result JSON</a></nav></header>
<section class="hero" data-verdict="${html(result.testVerdict ?? result.verdict ?? "pending")}" aria-labelledby="outcome"><div class="hero-top"><span class="badge">${html(result.level)}</span><span class="badge">${html(scopeLabel)}</span>${result.evidenceIntegrity ? `<span class="badge">Evidence ${html(result.evidenceIntegrity.status)}</span>` : ""}${businessPassUnverified || businessFailureUnverified ? '<span class="badge">Business proof unverified</span>' : ""}${result.testVerdict === "inconclusive" && (result.verdict === "passed" || result.verdict === "failed") ? '<span class="badge status-inconclusive">Current acceptance inconclusive</span>' : ""}<span class="meta">${html(result.status)}${result.running ? " · execution owner active" : ""}</span></div><h1 id="outcome">${html(currentOutcomeLabel)}</h1><p>${html(result.intent)}</p><div class="metrics"><div><strong>${result.scope.charterCount}</strong> saved scenario(s)</div><div><strong>${result.observedRuns} / ${result.expectedRuns}</strong> run observations / planned runs</div><div><strong>${result.confirmedProductFindings}</strong> saved confirmed product finding(s)</div></div></section>
<section class="scope" aria-labelledby="scope"><h2 id="scope">Acceptance scope</h2><p class="meta">${html(result.scope.surfaces.join(" · "))}${result.scope.suiteId ? ` · Suite ${html(result.scope.suiteId)}` : ""}</p><ul>${limits.map((limit) => `<li>${html(limit)}</li>`).join("")}</ul>${planningGaps.length ? `<details open><summary>Missing test requirements</summary><ul>${planningGaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul></details>` : ""}</section>
${firstFailure}${comparison}${replayConsistency}<section id="execution" aria-labelledby="execution-title"><div class="section-heading"><h2 id="execution-title">Scenario executions</h2><span class="meta">${result.tasks.settled} / ${result.tasks.total} tasks settled · ${result.tasks.skipped} skipped</span></div><div class="table-wrap" role="region" aria-label="Scenario execution matrix" tabindex="0"><table><thead><tr><th>Scenario</th><th>Surface / kind</th><th>Observed outcome</th><th>Verification facts</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No execution tasks recorded.</td></tr>'}</tbody></table></div><p class="meta">Task counts describe execution progress. The Mission verdict is the saved acceptance result.</p></section>${findingsSection}${repair}
<section><details><summary>Audit details</summary><p>Mission: ${html(result.missionId)}${result.replayOfMissionId ? `<br>Replay of: ${html(result.replayOfMissionId)}` : ""}<br>Project: ${html(result.projectRoot)}<br>Workspace: ${html(result.workspaceRoot)}<br>Source inventory: ${html(coverage?.inventory ?? "not recorded")}<br>Workflow coverage: ${html(coverage?.workflowCoverage ?? "not recorded")}<br>Level selection: ${html(result.levelSelection?.reason ?? "not recorded")}</p>${result.planning?.assumptions.length ? `<ul>${result.planning.assumptions.map((assumption) => `<li>${html(assumption)}</li>`).join("")}</ul>` : ""}</details></section>
<footer>Snapshot of saved Mission revision ${result.revision} · Updated ${html(result.updatedAt)} · Report generated ${html(result.generatedAt)}<br>This static report does not refresh while a Mission is running. Regenerate it to read the latest saved state.</footer></main></body></html>`;
}

function evidenceKey(ref: EvidenceRef): string {
  return JSON.stringify([ref.path, ref.sha256 ?? null]);
}

function hasCompleteEvidence(refs: EvidenceRef[], links: Map<string, EvidenceLink>, expectedRunId?: string): boolean {
  return refs.length > 0 && refs.every((ref) => {
    const link = links.get(evidenceKey(ref));
    return Boolean(link?.href) && (expectedRunId === undefined || link?.runId === expectedRunId);
  });
}

type DiagnosticClaimSupport = Omit<NonNullable<MissionEvidenceIntegrity["diagnosticSupport"]>["repairSuggestions"][number], "suggestionId">;

function diagnosticClaimSupport(result: MissionResult, refs: EvidenceRef[], links: Map<string, EvidenceLink>, findingId?: string): DiagnosticClaimSupport {
  if (!refs.length) return { status: "unsupported", reason: "missing-evidence" };
  if (!hasCompleteEvidence(refs, links)) return { status: "unsupported", reason: "unavailable-evidence" };
  const runIds = new Set(refs.map((ref) => links.get(evidenceKey(ref))!.runId));
  if (runIds.size !== 1) return { status: "unsupported", reason: "cross-run-evidence" };
  const runId = [...runIds][0]!;
  if (!result.runs.some((run) => run.runId === runId)) return { status: "unsupported", reason: "run-not-present" };
  if (findingId) {
    const finding = result.findings.find((item) => item.findingId === findingId && item.status === "confirmed");
    const linked = finding && hasCompleteEvidence(finding.evidence, links, runId)
      && refs.every((ref) => finding.evidence.some((item) => evidenceKey(item) === evidenceKey(ref)));
    return linked ? { status: "supported" } : { status: "unsupported", reason: "unlinked-failure" };
  }
  const anchors = [result.firstFailure, ...result.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed")];
  const linked = anchors.some((anchor) => anchor && hasCompleteEvidence(anchor.evidence, links, runId)
    && refs.every((ref) => anchor.evidence.some((item) => evidenceKey(item) === evidenceKey(ref))));
  return linked ? { status: "supported" } : { status: "unsupported", reason: "unlinked-failure" };
}

function diagnosticSupportLabel(claim: DiagnosticClaimSupport | { status: "not-present" } | undefined): string {
  if (claim?.status === "supported") return "evidence linked to this Mission's observed failure";
  if (claim?.status === "unsupported") {
    const reason = "reason" in claim ? claim.reason : undefined;
    const label = reason === "missing-evidence" ? "no cited evidence"
      : reason === "unavailable-evidence" ? "cited evidence is missing, changed or unverifiable"
        : reason === "cross-run-evidence" ? "cites evidence from multiple Runs"
          : reason === "run-not-present" ? "cited Run is outside this Mission result"
            : reason === "unlinked-failure" ? "evidence is not linked to the saved failure" : "reason unavailable";
    return `unsupported: ${label}`;
  }
  return "not audited";
}

function comparisonEvidenceStatus(result: MissionResult, links: Map<string, EvidenceLink>): MissionEvidenceIntegrity["comparison"] {
  const comparison = result.comparison;
  if (!comparison) return "not-present";
  const rowsValid = comparison.runs.every((run) =>
    (!run.baselineEvidence.length || Boolean(run.baselineRunId) && hasCompleteEvidence(run.baselineEvidence, links, run.baselineRunId))
    && (!run.candidateEvidence.length || Boolean(run.candidateRunId) && hasCompleteEvidence(run.candidateEvidence, links, run.candidateRunId)));
  const defectsValid = comparison.defects.every((defect) =>
    hasCompleteEvidence(defect.baselineEvidence, links, defect.baselineRunId)
    && Boolean(defect.candidateRunId) && hasCompleteEvidence(defect.candidateEvidence, links, defect.candidateRunId));
  if (!rowsValid || !defectsValid) return "degraded";
  return comparison.runs.some((run) => run.baselineEvidence.length || run.candidateEvidence.length)
    || comparison.defects.length ? "intact" : "not-present";
}

function referencedRunIds(result: MissionResult): Set<string> {
  const ids = new Set(result.runs.flatMap((run) => run.runId ? [run.runId] : []));
  for (const run of result.comparison?.runs ?? []) {
    if (run.baselineRunId) ids.add(run.baselineRunId);
    if (run.candidateRunId) ids.add(run.candidateRunId);
  }
  for (const defect of result.comparison?.defects ?? []) {
    ids.add(defect.baselineRunId);
    if (defect.candidateRunId) ids.add(defect.candidateRunId);
  }
  return ids;
}

function uniqueEvidence(result: MissionResult): EvidenceRef[] {
  return [...new Map(collectEvidence(result).map((ref) => [evidenceKey(ref), ref])).values()];
}

function summarizeIntegrity(result: MissionResult, links: Map<string, EvidenceLink>): MissionEvidenceIntegrity {
  const refs = uniqueEvidence(result);
  const available = (ref: EvidenceRef) => Boolean(links.get(evidenceKey(ref))?.href);
  const intact = refs.filter(available).length;
  const legacy = refs.filter((ref) => !ref.sha256).length;
  const unavailable = refs.length - intact - legacy;
  const savedConfirmed = result.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed");
  const unsupportedFindingIds = savedConfirmed.filter((finding) => !hasCompleteEvidence(finding.evidence, links)).map((finding) => finding.findingId);
  const diagnosticSupport = {
    diagnosis: result.diagnosis ? diagnosticClaimSupport(result, result.diagnosis.evidence, links, result.diagnosis.findingId) : { status: "not-present" as const },
    diagnoses: (result.diagnoses.length ? result.diagnoses : result.diagnosis ? [result.diagnosis] : [])
      .map((diagnosis) => ({ diagnosisId: diagnosis.diagnosisId,
        ...diagnosticClaimSupport(result, diagnosis.evidence, links, diagnosis.findingId) })),
    repairSuggestions: result.repairSuggestions.map((suggestion) => ({ suggestionId: suggestion.suggestionId,
      ...diagnosticClaimSupport(result, suggestion.evidence, links, suggestion.findingId) })),
  };
  const unsupportedDiagnostic = diagnosticSupport.diagnosis.status === "unsupported"
    || diagnosticSupport.diagnoses.some((diagnosis) => diagnosis.status === "unsupported")
    || diagnosticSupport.repairSuggestions.some((suggestion) => suggestion.status === "unsupported");
  const comparison = comparisonEvidenceStatus(result, links);
  const omittedEvidenceReferences = result.runs.reduce((count, run) => count + run.omittedEvidence, 0);
  const omittedComparisonRuns = result.comparison?.omittedRuns ?? 0;
  const omittedComparisonDefects = result.comparison?.omittedDefects ?? 0;
  const omitted = omittedEvidenceReferences + result.omittedRunResults + result.omittedFindings + result.omittedDiagnoses
    + result.omittedRepairSuggestions + omittedComparisonRuns + omittedComparisonDefects;
  const status = unavailable || legacy || unsupportedFindingIds.length || unsupportedDiagnostic || comparison === "degraded" ? "degraded"
    : omitted ? "partial" : refs.length === 0 ? "no-evidence" : "intact";
  return MissionEvidenceIntegritySchema.parse({
    status, scope: "presented-result", checkedAt: new Date().toISOString(),
    references: { total: refs.length, intact, unavailable, legacy },
    visibleConfirmedFindings: { saved: savedConfirmed.length, supported: savedConfirmed.length - unsupportedFindingIds.length,
      unsupportedFindingIds },
    diagnosticSupport,
    comparison,
    omittedEvidenceReferences,
    omittedRunResults: result.omittedRunResults,
    omittedFindings: result.omittedFindings,
    omittedDiagnoses: result.omittedDiagnoses,
    omittedRepairSuggestions: result.omittedRepairSuggestions,
    omittedComparisonRuns,
    omittedComparisonDefects,
  });
}

function runOutcome(run: MissionRunResult): string {
  const raw = run.verdict ? `<span class="badge status-${run.verdict}">${html(run.verdict)}</span>` : '<span class="badge">No saved verdict</span>';
  if (run.runKind !== "negative") return raw;
  return `${run.outcomeMatched === true ? '<span class="badge status-passed">Expected outcome matched</span>' : run.outcomeMatched === false ? '<span class="badge status-failed">Unexpected outcome</span>' : '<span class="badge">Expectation not evaluated</span>'}<small>Raw: ${html(run.verdict ?? "not recorded")} · Expected: ${html(run.expectedVerdict ?? "not recorded")}</small>`;
}

function collectEvidence(result: MissionResult): EvidenceRef[] {
  return [...result.runs.flatMap((run) => run.evidence), ...(result.firstFailure?.evidence ?? []),
    ...result.findings.flatMap((finding) => finding.evidence), ...(result.diagnosis?.evidence ?? []),
    ...result.diagnoses.flatMap((diagnosis) => diagnosis.evidence),
    ...result.repairSuggestions.flatMap((suggestion) => suggestion.evidence),
    ...(result.comparison?.runs.flatMap((run) => [...run.baselineEvidence, ...run.candidateEvidence]) ?? []),
    ...(result.comparison?.defects.flatMap((defect) => [...defect.baselineEvidence, ...defect.candidateEvidence]) ?? [])];
}

function allowedRunFile(parts: string[]): boolean {
  return (parts.length === 1 && ["report.html", "events.jsonl", "run.json"].includes(parts[0]!))
    || (parts.length > 1 && parts[0] === "artifacts" && parts.every((part) => part !== ".." && part !== "." && part.length > 0));
}

async function existingAncestor(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return existingAncestor(dirname(path));
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function countLabel(counts: MissionRunResult["assertions"]): string {
  return counts ? `${counts.passed} / ${counts.total}` : "not recorded";
}

function evidenceLabel(kind: EvidenceRef["kind"]): string {
  return ({ report: "Run report", business: "Business fact", screenshot: "Screenshot", snapshot: "Snapshot", network: "Network log", console: "Console", process: "Process", api: "API fact", runtime: "Runtime", log: "Log", other: "Artifact" })[kind];
}

function outcomeLabel(value: string): string {
  return ({ passed: "Passed", failed: "Test failed", blocked: "Test blocked", cancelled: "Test cancelled", inconclusive: "Acceptance inconclusive" } as Record<string, string>)[value] ?? "Not evaluated yet";
}

function comparisonLabel(value: string): string {
  return ({ "verified-in-scope": "Original defect not reproduced in tested scope", "defect-reproduced": "Original defect reproduced", inconclusive: "Repair verification inconclusive" } as Record<string, string>)[value] ?? value;
}

function gapLabel(value: string): string {
  return ({ "surface-assertion": "A positive observable surface assertion is required.", "business-oracle": "An independent business check is required.", "negative-case": "Explicit negative or recovery scenarios are required.", "project-workflow-coverage": "Whole-project workflow inventory and execution coverage proof are required.", "project-map-truncated": "The source inventory is partial.", "project-map-unavailable": "The source inventory is unavailable." } as Record<string, string>)[value] ?? `Unresolved saved planning requirement: ${value}`;
}

function workflowInventoryIssueLabel(value: string): string {
  return ({
    "workflow-inventory-missing": "No workflow inventory is registered.",
    "workflow-inventory-invalid": "The workspace inventory file is invalid or outside its boundary.",
    "workflow-inventory-source-changed": "The tested source differs from the inventory fingerprint.",
    "workflow-inventory-source-unverified": "The tested source fingerprint is unavailable or incomplete.",
    "workflow-inventory-review-missing": "No review declaration is recorded.",
    "workflow-inventory-charter-mapping-incomplete": "Some workflows lack a registered Charter for a required surface.",
    "workflow-inventory-source-path-missing": "A declared source path is missing or points outside the project.",
    "workflow-inventory-has-exclusions": "The inventory contains explicitly excluded workflows.",
    "workflow-inventory-candidates-unclaimed": "Some discovered source candidates have no workflow owner or exclusion.",
    "workflow-inventory-routes-unlinked": "Some owned routes lack a matching Charter route declaration.",
    "workflow-inventory-exclusion-overlap": "Some source candidates are both workflow-owned and excluded.",
    "workflow-inventory-candidate-scan-partial": "The static candidate review is partial.",
    "workflow-inventory-route-targets-unresolved": "Some Charter route targets do not resolve uniquely to scanned candidates.",
    "workflow-inventory-completeness-unverified": "The declaration alone cannot prove every business workflow is listed or executed.",
  } as Record<string, string>)[value] ?? value;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
