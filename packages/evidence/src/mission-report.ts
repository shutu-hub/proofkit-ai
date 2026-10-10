import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MissionEvidenceIntegritySchema, MissionResultSchema, type EvidenceRef, type MissionEvidenceIntegrity, type MissionResult, type MissionRunResult } from "@proofkit/contracts";

type EvidenceLink = { href?: string; runId?: string };

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
    const snapshot = MissionResultSchema.parse({ ...result, evidenceIntegrity: integrity });
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

  private async buildLinks(result: MissionResult, workspace: string, reportDir: string): Promise<Map<string, EvidenceLink>> {
    const runIds = referencedRunIds(result);
    const links = new Map<string, EvidenceLink>();
    await Promise.all(uniqueEvidence(result).map(async (ref) => {
      links.set(evidenceKey(ref), await this.evidenceLink(ref, workspace, reportDir, runIds));
    }));
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
  const scopeLabel = coverage?.requested === "project" ? "Whole project requested" : coverage?.requested === "declared" ? "Declared scenarios" : "Acceptance scope not recorded";
  const outcome = result.verdict ?? "not evaluated";
  const route = result.scope.routeCoverage;
  const workflowInventory = result.scope.workflowInventory;
  const workflowExecution = result.scope.workflowExecution;
  const unavailable = [...links.values()].filter((link) => !link.href).length;
  const unverified = [...new Map(collectEvidence(result).map((ref) => [evidenceKey(ref), ref])).values()].filter((ref) => !ref.sha256).length;
  const savedConfirmed = result.findings.filter((finding) => finding.category === "product" && finding.status === "confirmed");
  const currentlyVerified = savedConfirmed.filter((finding) => hasCompleteEvidence(finding.evidence, links)).length;
  const staleFindings = savedConfirmed.length - currentlyVerified;
  const comparisonEvidenceUnavailable = comparisonEvidenceStatus(result, links) === "degraded";
  const proofUnverified = result.proofClassification?.status === "unverified";
  const limits = [
    result.evidenceIntegrity ? `Current presented evidence integrity: ${result.evidenceIntegrity.status}; ${result.evidenceIntegrity.references.intact}/${result.evidenceIntegrity.references.total} reference(s) verified at ${result.evidenceIntegrity.checkedAt}. This does not change the saved acceptance verdict.` : undefined,
    proofUnverified ? `Current business proof classification is unverified: ${result.proofClassification!.legacyOracles} saved Oracle result(s) lack a verification kind, ${result.proofClassification!.unavailableRuns} Run(s) could not be read, and ${result.proofClassification!.omittedRuns} Run(s) exceeded the audit bound. Rerun affected scenarios before treating the saved business verdict or finding as current proof.` : undefined,
    coverage?.requested === "project" ? "Whole-project workflow coverage has not been proven." : "Acceptance applies to the saved scenarios. Whole-project workflow coverage has not been measured.",
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
    workflowExecution ? `Declared workflow execution: ${workflowExecution.evidencedChecks}/${workflowExecution.requiredChecks} Charter/platform checks and ${workflowExecution.evidencedWorkflowCount}/${workflowExecution.workflowCount} workflows evidenced; source binding ${workflowExecution.sourceBinding}. This does not prove the inventory is complete.` : undefined,
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
  const comparison = result.comparison ? `<section class="comparison"><div><div class="section-label">Repair replay · saved result</div><h2>${html(comparisonLabel(result.comparison.status))}</h2><p>${html(result.comparison.reason)}</p>${comparisonEvidenceUnavailable ? '<p class="unavailable">Current evidence cannot verify this saved comparison. Rerun comparison before claiming the repair is verified.</p>' : ""}</div><details><summary>Comparison evidence and limits</summary><p>Source change: ${html(result.comparison.sourceChange)} · Candidate source: ${html(result.comparison.candidateSourceStability)}</p><ul>${result.comparison.gaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul>${result.comparison.defects.map((defect) => `<p>${html(defect.oracleName)} · ${html(defect.surface)} · ${html(defect.outcome)}<br>Before: ${evidence(defect.baselineEvidence, defect.baselineRunId)}<br>Replay: ${evidence(defect.candidateEvidence, defect.candidateRunId ?? "")}</p>`).join("")}${result.comparison.omittedRuns || result.comparison.omittedDefects ? `<p class="meta">${result.comparison.omittedRuns} comparison runs and ${result.comparison.omittedDefects} defects omitted.</p>` : ""}<p class="meta">This comparison does not establish which source change caused the result.</p></details></section>`
    : result.comparisonUnavailable ? `<section class="comparison"><h2>Repair comparison unavailable</h2><p>${html(result.comparisonUnavailable)}</p></section>` : "";
  const rows = result.runs.map((run) => `<tr><td><strong>${html(run.title)}</strong>${run.charterId ? `<small>${html(run.charterId)}</small>` : ""}${run.issue ? `<p class="row-issue">${html(run.issue)}</p>` : ""}</td><td>${html(run.surface ?? "unknown")}<small>${html(run.runKind)}${run.negativeCaseId ? ` · ${html(run.negativeCaseId)}` : ""}</small></td><td>${runOutcome(run)}<small>Task: ${html(run.taskStatus ?? "unassociated")}</small></td><td><small>UI: ${countLabel(run.assertions)}<br>Business checks: ${countLabel(run.oracles)}<br>Business facts: ${run.businessFacts ?? "not recorded"}</small><small>Target: ${html(run.targetBinding?.status ?? "not inspected")}<br>Cleanup: ${html(run.integrationCleanup?.status ?? "not recorded")}${run.integrationCleanup ? ` (${run.integrationCleanup.verifiedResources}/${run.integrationCleanup.declaredResources})` : ""}</small></td><td><div class="links">${evidence(run.evidence) || "No saved evidence"}</div>${run.omittedEvidence ? `<small>${run.omittedEvidence} more reference(s) in Run report</small>` : ""}</td></tr>`).join("");
  const findings = result.findings.map((finding) => `<article class="finding"><div class="section-label">${html(finding.category)} · ${finding.category === "product" && finding.status === "confirmed" && !hasCompleteEvidence(finding.evidence, links) ? "saved confirmed · evidence currently unverified" : html(finding.status)} · ${html(finding.severity)}</div><h3>${html(finding.title)}</h3><p>${html(finding.message)}</p><div class="links">${evidence(finding.evidence)}</div></article>`);
  const findingsSection = findings.length ? `<section><div class="section-heading"><h2>Findings</h2><span class="meta">${currentlyVerified} / ${savedConfirmed.length} visible saved confirmed product finding(s) have all cited evidence</span></div>${findings.slice(0, 3).join("")}${findings.length > 3 ? `<details><summary>${findings.length - 3} more findings</summary>${findings.slice(3).join("")}</details>` : ""}${result.omittedFindings ? `<p class="meta">${result.omittedFindings} finding(s) omitted. The full audit is retained in the Mission store.</p>` : ""}</section>` : "";
  const repair = result.repairSuggestions.length || result.diagnosis ? `<section><details><summary>Diagnosis and proposed repair</summary>${result.diagnosis ? `<p>${html(result.diagnosis.summary)}</p>${result.diagnosis.sourceLocations.length ? `<p>Source hints (not root-cause evidence): ${result.diagnosis.sourceLocations.map(html).join(", ")}</p>` : ""}<div class="links">${evidence(result.diagnosis.evidence)}</div>` : ""}${result.repairSuggestions.map((suggestion) => `<h3>${html(suggestion.title)} · ${html(suggestion.status)}</h3><p>${html(suggestion.rationale)}</p><ul>${suggestion.changes.map((change) => `<li>${html(change)}</li>`).join("")}</ul><div class="links">${evidence(suggestion.evidence)}</div>`).join("")}${result.omittedRepairSuggestions ? `<p class="meta">${result.omittedRepairSuggestions} proposal(s) omitted.</p>` : ""}</details></section>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ProofKit · ${html(result.intent)}</title><style>
:root{color-scheme:light;--ink:#1c302e;--muted:#5d706c;--line:#d9e2df;--paper:#fff;--canvas:#f4f7f5;--accent:#17685a}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 28px 48px}header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}header{margin-bottom:22px}.brand{font-weight:750;letter-spacing:-.5px;font-size:21px}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:20px}h1,h2,h3,p{margin:0}h1{font-size:clamp(25px,3.8vw,40px);line-height:1.2;letter-spacing:-1px;margin:12px 0}h2{font-size:19px;line-height:1.4}h3{font-size:16px}p{margin-top:8px;overflow-wrap:anywhere}.meta,small{color:var(--muted);font-size:13px}.section-label{font-size:12px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;color:var(--muted)}.hero{background:var(--paper);border:1px solid var(--line);border-top:4px solid var(--accent);padding:24px 28px}.hero[data-verdict=failed]{border-top-color:#a42d37}.hero[data-verdict=inconclusive],.hero[data-verdict=blocked]{border-top-color:#9a6716}.hero-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.badge{display:inline-block;font-size:12px;line-height:1.5;padding:3px 9px;border:1px solid var(--line);border-radius:4px}.status-passed{color:#146247;background:#edf6f0}.status-failed{color:#9f2733;background:#fff0f1}.status-blocked,.status-inconclusive{color:#83580d;background:#fff6e7}.metrics{display:flex;flex-wrap:wrap;gap:26px;border-top:1px solid var(--line);margin-top:22px;padding-top:16px}.metrics strong{font-size:21px;font-weight:650;margin-right:6px}.scope{padding:20px 0;border-bottom:1px solid var(--line)}.scope ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--muted)}section{margin-top:24px}.failure{padding:18px 22px;background:#fff5f2;border-left:3px solid #a42d37}.failure h2{margin-top:6px;overflow-wrap:anywhere}.links{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px}.evidence-link,.unavailable{font-size:13px}.unavailable{color:#83580d}.comparison{border:1px solid var(--line);background:var(--paper);padding:18px 22px}.comparison p{font-size:14px}.table-wrap{overflow-x:auto;margin-top:12px;border:1px solid var(--line);background:var(--paper)}table{width:100%;border-collapse:collapse;min-width:760px;table-layout:fixed}th{font-size:12px;color:var(--muted);font-weight:650;background:#eef3f0}th,td{padding:14px 16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th:nth-child(1){width:25%}th:nth-child(2){width:12%}th:nth-child(3){width:19%}th:nth-child(4){width:20%}th:nth-child(5){width:24%}tbody tr:last-child td{border-bottom:0}td{font-size:14px;overflow-wrap:anywhere}small{display:block;margin-top:4px}.row-issue{font-size:12px;color:#83580d}.finding{padding:18px 0;border-bottom:1px solid var(--line)}.finding h3{margin-top:5px}.finding p{font-size:14px}details{margin-top:14px}summary{cursor:pointer;color:var(--accent);font-weight:600;overflow-wrap:anywhere}details p,details li{font-size:14px}footer{margin-top:30px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media(max-width:600px){main{padding:16px 16px 32px}.hero{padding:18px}.metrics{gap:14px}.metrics strong{font-size:18px}header{align-items:flex-start}nav{gap:12px;font-size:13px}.section-heading{align-items:flex-start;flex-direction:column;gap:4px}.failure,.comparison{padding:16px}.table-wrap{margin-right:0}th,td{padding:12px}}
</style></head><body><main><header><div class="brand">ProofKit <span class="meta">/ Mission result</span></div><nav aria-label="Report navigation"><a href="#execution">Executions</a><a href="summary.json">Result JSON</a></nav></header>
<section class="hero" data-verdict="${html(result.verdict ?? "pending")}" aria-labelledby="outcome"><div class="hero-top"><span class="badge">${html(result.level)}</span><span class="badge">${html(scopeLabel)}</span>${result.evidenceIntegrity ? `<span class="badge">Evidence ${html(result.evidenceIntegrity.status)}</span>` : ""}${proofUnverified ? '<span class="badge">Business proof unverified</span>' : ""}<span class="meta">${html(result.status)}${result.running ? " · execution owner active" : ""}</span></div><h1 id="outcome">${html(proofUnverified && result.verdict === "passed" ? "Saved pass · current business proof unverified" : outcomeLabel(outcome))}</h1><p>${html(result.intent)}</p><div class="metrics"><div><strong>${result.scope.charterCount}</strong> saved scenario(s)</div><div><strong>${result.observedRuns} / ${result.expectedRuns}</strong> run observations / planned runs</div><div><strong>${result.confirmedProductFindings}</strong> saved confirmed product finding(s)</div></div></section>
<section class="scope" aria-labelledby="scope"><h2 id="scope">Acceptance scope</h2><p class="meta">${html(result.scope.surfaces.join(" · "))}${result.scope.suiteId ? ` · Suite ${html(result.scope.suiteId)}` : ""}</p><ul>${limits.map((limit) => `<li>${html(limit)}</li>`).join("")}</ul>${planningGaps.length ? `<details open><summary>Missing test requirements</summary><ul>${planningGaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul></details>` : ""}</section>
${firstFailure}${comparison}<section id="execution" aria-labelledby="execution-title"><div class="section-heading"><h2 id="execution-title">Scenario executions</h2><span class="meta">${result.tasks.settled} / ${result.tasks.total} tasks settled · ${result.tasks.skipped} skipped</span></div><div class="table-wrap" role="region" aria-label="Scenario execution matrix" tabindex="0"><table><thead><tr><th>Scenario</th><th>Surface / kind</th><th>Observed outcome</th><th>Verification facts</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No execution tasks recorded.</td></tr>'}</tbody></table></div><p class="meta">Task counts describe execution progress. The Mission verdict is the saved acceptance result.</p></section>${findingsSection}${repair}
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
  const comparison = comparisonEvidenceStatus(result, links);
  const omittedEvidenceReferences = result.runs.reduce((count, run) => count + run.omittedEvidence, 0);
  const omittedComparisonRuns = result.comparison?.omittedRuns ?? 0;
  const omittedComparisonDefects = result.comparison?.omittedDefects ?? 0;
  const omitted = omittedEvidenceReferences + result.omittedRunResults + result.omittedFindings
    + result.omittedRepairSuggestions + omittedComparisonRuns + omittedComparisonDefects;
  const status = unavailable || legacy || unsupportedFindingIds.length || comparison === "degraded" ? "degraded"
    : omitted ? "partial" : refs.length === 0 ? "no-evidence" : "intact";
  return MissionEvidenceIntegritySchema.parse({
    status, scope: "presented-result", checkedAt: new Date().toISOString(),
    references: { total: refs.length, intact, unavailable, legacy },
    visibleConfirmedFindings: { saved: savedConfirmed.length, supported: savedConfirmed.length - unsupportedFindingIds.length,
      unsupportedFindingIds },
    comparison,
    omittedEvidenceReferences,
    omittedRunResults: result.omittedRunResults,
    omittedFindings: result.omittedFindings,
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
