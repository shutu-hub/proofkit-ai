import { lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MissionAcceptanceIntegritySchema, MissionEvidenceIntegritySchema, MissionResultSchema, RunSummarySchema, type Action, type Assertion, type EvidenceRef, type MissionAcceptanceIntegrity, type MissionEvidenceIntegrity, type MissionResult, type MissionRunResult, type RunSummary } from "@proofkit/contracts";

type EvidenceLink = { href?: string; runId?: string };
import { planningObservationSources } from "@proofkit/contracts";
import { projectMissionChecks } from "./mission-checks.js";
const MAX_MISSION_AUDIT_REFERENCES = 2048;
const MISSION_AUDIT_CONCURRENCY = 8;
const MAX_MISSION_AUDIT_MS = 15_000;
const MAX_WORKFLOW_ACTIONS = 200;

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
    const runDetails = await this.readRunDetails(result, links);
    const checkOverview = projectMissionChecks(result.runs.map((run) => {
      const summary = run.runId ? runDetails.get(run.runId) : undefined;
      const linkedFile = (name: string) => run.evidence.find((ref) => run.runId && links.get(evidenceKey(ref))?.runId === run.runId
        && links.get(evidenceKey(ref))?.href && samePath(isAbsolute(ref.path) ? resolve(ref.path) : resolve(this.runRoot, ref.path), resolve(this.runRoot, run.runId, name)));
      return { run, summary, summaryEvidence: linkedFile("run.json"), reportEvidence: linkedFile("report.html"),
        checkEvidence: run.evidence.filter((ref) => links.get(evidenceKey(ref))?.href && links.get(evidenceKey(ref))?.runId === run.runId) };
    }), result.omittedRunResults, reportSnippet);
    const integrity = summarizeIntegrity(result, links);
    const planningSources = result.planningObservation ? planningObservationSources(result.planningObservation.observation) : [];
    const planningObservation = result.planningObservation?.status === "verified" && (!planningSources.length
      || result.planningObservation.evidence.length !== 3 * planningSources.length || result.planningObservation.evidence.some((ref) => !links.get(planningObservationKey(ref))?.href))
      ? { ...result.planningObservation, status: "unverified", evidence: [], reason: "Planning context changed or became unavailable while this report was prepared." } : result.planningObservation;
    const snapshot = MissionResultSchema.parse({ ...result, checkOverview, planningObservation, sessionCaptures: auditCaptureLinks(result, links), evidenceIntegrity: integrity, ...auditMissionVerdict(result, integrity) });
    await atomicWrite(join(reportDir, "summary.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    const path = join(reportDir, "report.html");
    await atomicWrite(path, renderMissionReport(snapshot, links, runDetails));
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
    for (const run of result.sessionContext?.runs ?? []) {
      await Promise.all(run.evidence.map(async (ref) => {
        links.set(sessionContextEvidenceKey(run.runId, ref), await this.evidenceLink(ref, workspace, reportDir, new Set([run.runId])));
      }));
    }
    for (const segment of result.sessionCaptures?.segments ?? []) {
      if (segment.integrity !== "intact") continue;
      await Promise.all(segment.evidence.map(async (ref) => {
        links.set(sessionCaptureEvidenceKey(segment.runId, ref), await this.evidenceLink(ref, workspace, reportDir, new Set([segment.runId])));
      }));
    }
    const sources = result.planningObservation ? planningObservationSources(result.planningObservation.observation) : [];
    if (sources.length && result.planningObservation?.status === "verified") {
      const sourceIds = new Set(sources.map((state) => state.source.runId));
      await Promise.all(result.planningObservation.evidence.map(async (ref) => {
        links.set(planningObservationKey(ref), await this.evidenceLink(ref, workspace, reportDir, sourceIds));
      }));
    }
    return links;
  }

  private async readRunDetails(result: MissionResult, links: Map<string, EvidenceLink>): Promise<Map<string, RunSummary | undefined>> {
    const details = new Map<string, RunSummary | undefined>();
    let remaining = 16 * 1024 * 1024;
    for (const run of result.runs) {
      if (!run.runId || details.has(run.runId)) continue;
      const path = resolve(this.runRoot, run.runId, "run.json");
      const source = run.evidence.find((ref) => samePath(isAbsolute(ref.path) ? resolve(ref.path) : resolve(this.runRoot, ref.path), path));
      if (!source) continue;
      details.set(run.runId, undefined);
      if (!source.sha256 || !links.get(evidenceKey(source))?.href || links.get(evidenceKey(source))?.runId !== run.runId) continue;
      try {
        const direct = await lstat(path);
        if (!direct.isFile() || direct.size <= 0 || !samePath(await realpath(path), path)) throw new Error("Run details unavailable");
        if (direct.size > Math.min(remaining, 4 * 1024 * 1024)) continue;
        remaining -= direct.size;
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await file.stat();
          if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size !== direct.size) throw new Error("Run details changed");
          const bytes = Buffer.alloc(before.size + 1);
          let length = 0;
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          const after = await file.stat();
          const current = await lstat(path);
          if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
            || createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== source.sha256) throw new Error("Run details changed");
          const summary = RunSummarySchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
          if (summary.runId !== run.runId || !summary.workspaceRoot || !samePath(resolve(summary.workspaceRoot), resolve(result.workspaceRoot))
            || !summary.projectRoot || !samePath(resolve(summary.projectRoot), resolve(result.projectRoot))) throw new Error("Run details belong to another execution");
          details.set(run.runId, summary);
        } finally { await file.close(); }
      } catch { links.set(evidenceKey(source), {}); }
    }
    return details;
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
      let bytes = 0;
      for await (const chunk of createReadStream(canonicalTarget)) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) return {};
        digest.update(chunk);
      }
      const after = await stat(canonicalTarget);
      if (bytes !== file.size || after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs) return {};
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

function reportSnippet(value: string): string {
  return value.replace(/\b(?:https?:\/\/|file:|data:|blob:)[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|cookie|password|secret|token|access[_-]?key|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]").slice(0, 180);
}

function actionDescription(action: Action): string {
  const labels: Record<Action["kind"], string> = { goto: "Open page", switchPage: "Switch window", click: "Click", fill: "Fill input",
    press: "Press key", selectOption: "Select option", selectOptions: "Replace selected options", setChecked: "Set checked state",
    setInputFiles: "Select fixture files", waitForText: "Wait for expected text", waitForValue: "Verify stable expected field value", screenshot: "Capture screenshot", observe: "Observe page",
    capability: "Run declared integration action", captureResponse: "Submit and capture selected API facts" };
  const target = action.kind === "captureResponse" ? action.trigger.expectedTarget?.name
    : "expectedTarget" in action ? action.expectedTarget?.name : undefined;
  return `${labels[action.kind]}${target ? ` · ${reportSnippet(target)}` : ""}`;
}

function assertionDescription(assertion: Assertion): string {
  if (assertion.kind === "url-matches") return "URL matches the declared pattern";
  return `${assertion.kind === "text-visible" ? "Expected visible text" : assertion.kind === "text-not-visible" ? "Expected absent text" : "Expected title text"}: ${reportSnippet(assertion.text)}`;
}

function renderRunDetails(result: MissionResult, links: Map<string, EvidenceLink>, details: Map<string, RunSummary | undefined>): string {
  if (!details.size) return "";
  const shown = result.runs.slice(0, 10).filter((run) => run.runId && details.has(run.runId));
  return `<section id="workflow-detail" aria-labelledby="workflow-detail-title"><h2 id="workflow-detail-title">Workflow actions and checks</h2><p class="meta">Saved action and check results from the original Run summary. A successful action alone does not prove business acceptance. Only currently verified selected screenshots are embedded; open the Run report for its full timeline and API facts.</p>${shown.map((run) => {
    const summary = details.get(run.runId!);
    if (!summary) return `<article class="workflow-card"><h3>${html(run.title)}</h3><p class="unavailable">Original Run summary unavailable, changed or outside the bounded detail view. Workflow details are withheld.</p></article>`;
    const reportRef = run.evidence.find((ref) => ref.kind === "report" && links.get(evidenceKey(ref))?.runId === run.runId
      && (ref.path.replaceAll("\\", "/") === `${run.runId}/report.html` || ref.path.replaceAll("\\", "/").endsWith(`/${run.runId}/report.html`)));
    const reportLink = reportRef ? links.get(evidenceKey(reportRef))?.href : undefined;
    const steps = new Map(summary.steps.map((step) => [step.stepId, step]));
    const actions = summary.charter.actions.slice(0, MAX_WORKFLOW_ACTIONS).map((action, index) => {
      const stepId = `step-${String(index + 1).padStart(3, "0")}`;
      const step = steps.get(stepId);
      const name = `${stepId}${step?.status === "passed" ? "" : "-failure"}.png`;
      const expected = `${summary.runId}/artifacts/${name}`;
      const image = run.evidence.find((ref) => ref.kind === "screenshot" && (ref.path.replaceAll("\\", "/") === expected || ref.path.replaceAll("\\", "/").endsWith(`/${expected}`)));
      const imageLink = image ? links.get(evidenceKey(image)) : undefined;
      return `<li><p><strong>${html(actionDescription(action))}</strong> <span class="badge status-${html(step?.status ?? "not-run")}">${html(step?.status ?? "not-run")}</span></p>${reportLink ? `<a href="${html(reportLink)}#${stepId}">Open ${stepId} evidence</a>` : `<small>${stepId}</small>`}${imageLink?.href && imageLink.runId === summary.runId ? `<figure><a href="${html(imageLink.href)}"><img class="workflow-image" loading="lazy" src="${html(imageLink.href)}" alt="${stepId} saved screenshot"></a><figcaption>Saved ${step?.status === "passed" ? "after-action" : "failure-time"} screenshot</figcaption></figure>` : ""}</li>`;
    }).join("");
    const checks = summary.assertions.slice(0, 10).map((check) => `<li>${html(assertionDescription(check.assertion))} · <strong>${check.passed ? "passed" : "failed"}</strong></li>`).join("");
    const oracles = summary.oracles.slice(0, 8).map((check) => `<li>${html(reportSnippet(check.name))} · ${check.verificationKind === "business" ? "Business" : check.verificationKind === "http-contract" ? "HTTP contract" : "Unclassified"}: <strong>${check.passed === true ? "passed" : check.passed === false ? "failed" : "inconclusive"}</strong></li>`).join("");
    return `<article class="workflow-card"><h3>${html(run.title)}</h3><p class="meta">${html(run.surface ?? "unknown")} · ${html(run.runKind)} · ${summary.steps.length}/${summary.charter.actions.length} planned action(s) reached execution</p><ol>${actions || "<li>No surface actions declared.</li>"}</ol>${summary.charter.actions.length > MAX_WORKFLOW_ACTIONS ? `<p class="meta">${summary.charter.actions.length - MAX_WORKFLOW_ACTIONS} later planned action(s) omitted from this overview.</p>` : ""}<h4>Surface checks</h4><ul>${checks || "<li>No saved surface checks.</li>"}</ul>${summary.assertions.length > 10 ? `<p class="meta">${summary.assertions.length - 10} additional surface check(s) omitted.</p>` : ""}<h4>Independent checks</h4><ul>${oracles || "<li>No independent checks recorded.</li>"}</ul>${summary.oracles.length > 8 ? `<p class="meta">${summary.oracles.length - 8} additional independent check(s) omitted.</p>` : ""}</article>`;
  }).join("")}${result.runs.length > 10 ? `<p class="meta">Details are bounded to the first ten execution rows; ${result.runs.length - 10} later row(s) remain in the execution matrix.</p>` : ""}</section>`;
}

function renderCheckOverview(result: MissionResult, links: Map<string, EvidenceLink>): string {
  const overview = result.checkOverview;
  if (!overview) return "";
  const labels = { surface: "Page check", business: "Independent business check", "http-contract": "HTTP contract only", unclassified: "Independent check · classification unavailable" };
  const evidence = (ref: EvidenceRef | undefined, runId: string, label: string) => {
    const link = ref ? links.get(evidenceKey(ref)) : undefined;
    return link?.href && link.runId === runId ? '<a href="' + html(link.href) + '">' + label + '</a>' : "";
  };
  const rows = overview.items.map((check) => '<tr data-check-status="' + check.status + '"><td><strong>' + html(check.expected) + '</strong><small>' + html(check.title) + ' · ' + html(check.runKind) + '</small></td><td>' + labels[check.kind] + '</td><td><span class="badge status-' + check.status + '">' + check.status + '</span></td><td>' + html(check.observed) + (check.fieldMismatches?.length ? '<small>Oracle-declared different fields: ' + check.fieldMismatches.map(html).join(', ') + '</small>' : '') + '</td><td>' + evidence(check.summary, check.runId, "Saved result") + '<br>' + evidence(check.report, check.runId, "Run evidence") + check.evidence.map((ref) => '<br>' + evidence(ref, check.runId, ref.kind === 'business' ? 'Observed source' : 'Check artifact')).join('') + (check.unlinkedEvidence ? '<small>' + check.unlinkedEvidence + ' supporting artifact(s) not linked in this overview</small>' : '') + '</td></tr>').join("");
  const attention = overview.items.filter((check) => check.status === "failed" || check.status === "inconclusive");
  const highlights = attention.slice(0, 4).map((check) => '<article class="check-highlight status-' + check.status + '"><span class="badge status-' + check.status + '">' + check.status + '</span> '
    + '<strong>' + html(check.expected) + '</strong><small>' + html(check.runKind) + ' · ' + labels[check.kind] + '</small><p>' + html(check.observed) + '</p>'
    + (check.fieldMismatches?.length ? '<p>Oracle-declared different fields: <strong>' + check.fieldMismatches.map(html).join(', ') + '</strong></p>' : '')
    + '<div class="links">' + check.evidence.map((ref) => evidence(ref, check.runId, ref.kind === "business" ? "Observed source" : "Check artifact")).filter(Boolean).join(" · ")
    + (check.report ? ' · ' + evidence(check.report, check.runId, "Run details") : '') + '</div></article>').join("");
  const highlightSection = attention.length ? '<div class="check-highlights" aria-label="Failed and inconclusive checks">' + highlights
    + (attention.length > 4 ? '<p class="meta">' + (attention.length - 4) + ' more failed or inconclusive check(s) in the table.</p>' : '') + '</div>' : '';
  const counts = Object.entries(overview.counts).map(([status, count]) => count + " " + status).join(" · ");
  return '<section id="checks" aria-labelledby="checks-title"><h2 id="checks-title">Expected outcomes and recorded checks</h2><p>' + counts + '</p><p class="meta">Declared checks compared with results in currently hash-verified Run summaries. Failed and incomplete checks appear first. A saved result is not a fresh business read or proof that every supporting artifact is intact; use the current Mission verdict and evidence audit above. Successful actions and HTTP contracts do not establish independent business acceptance.</p>' + highlightSection + '<div class="table-wrap" role="region" aria-label="Expected outcomes and recorded checks" tabindex="0"><table><thead><tr><th>Expected outcome / scenario</th><th>Verification source</th><th>Recorded result</th><th>Recorded observation</th><th>Evidence</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5">No declared or recorded checks available in the inspected Run summaries.</td></tr>') + '</tbody></table></div><p class="meta">' + overview.inspectedRuns + ' Run summary/summaries inspected · ' + overview.unavailableRuns.length + ' unavailable · ' + overview.omittedRuns + ' other Run(s) omitted from this saved result · ' + overview.omittedChecks + ' additional check(s) omitted from this table. Counts cover inspected summaries only and do not measure intent or project coverage.</p>' + (overview.unavailableRuns.length ? '<details open><summary>Check details unavailable</summary><ul>' + overview.unavailableRuns.map((run) => '<li>' + html(run.title) + (run.runId ? ' · ' + html(run.runId) : '') + ': no currently verified Run summary within the bounded read; check results are withheld.</li>').join("") + '</ul></details>' : '') + '</section>';
}

function renderMissionReport(result: MissionResult, links: Map<string, EvidenceLink>, runDetails: Map<string, RunSummary | undefined>): string {
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
  const planSummary = result.planSummary;
  const planningSummary = result.planning;
  const planningMeta = planningSummary
    ? `Planning source: ${html(planningSummary.source)} · confidence: ${html(String(planningSummary.confidence))} · ${planningSummary.evidenceGaps.length ? `${planningSummary.evidenceGaps.length} evidence gap(s)` : "no evidence gaps recorded"}`
    : "Planning quality was not recorded; this report cannot establish how the plan was produced.";
  const planningBoundary = planningGaps.length
    ? `<details open><summary>Planning boundary</summary><ul>${planningGaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul></details>`
    : "";
  const planSection = planSummary ? `<section aria-labelledby="plan-title"><div class="section-heading"><h2 id="plan-title">Test plan</h2><span class="meta">${html(planSummary.generatedBy)} · ${planSummary.tasks.length} planned step(s)</span></div><p>${html(result.intent)}</p><p class="meta">${html(planningMeta)}</p>${planningBoundary}${planSummary.successCriteria.length ? `<h3>Success criteria</h3><ul>${planSummary.successCriteria.map((criterion) => `<li>${html(criterion)}</li>`).join("")}</ul>` : ""}${planSummary.assumptions.length ? `<details><summary>Planning assumptions</summary><ul>${planSummary.assumptions.map((assumption) => `<li>${html(assumption)}</li>`).join("")}</ul></details>` : ""}<div class="table-wrap" role="region" aria-label="Mission plan steps" tabindex="0"><table><thead><tr><th>Step</th><th>Purpose</th><th>Tool</th><th>Status</th></tr></thead><tbody>${planSummary.tasks.map((task) => `<tr><td><strong>${html(task.title)}</strong><small>${html(task.taskId)}${task.dependsOn.length ? ` · after ${html(task.dependsOn.join(", "))}` : ""}</small></td><td>${html(task.objective)}${task.error ? `<p class="row-issue">${html(task.error)}</p>` : ""}</td><td>${html(task.tool)}</td><td>${html(task.status)}</td></tr>`).join("")}</tbody></table></div></section>` : "";
  const firstFailure = result.firstFailure ? `<section class="failure" aria-labelledby="first-failure"><div class="section-label">First failure · ${html(result.firstFailure.kind)}</div><h2 id="first-failure">${html(result.firstFailure.message)}</h2><p class="meta">${html([result.firstFailure.charterId, result.firstFailure.surface, result.firstFailure.oracleName].filter(Boolean).join(" · "))}</p><div class="links">${evidence(result.firstFailure.evidence)}</div></section>` : "";
  const comparison = result.comparison ? `<section class="comparison"><div><div class="section-label">Repair replay · current check</div><h2>${html(comparisonLabel(result.comparison.status))}</h2><p>${html(result.comparison.reason)}</p>${result.comparison.historicalStatus ? `<p class="meta">Saved comparison before current source recheck: ${html(comparisonLabel(result.comparison.historicalStatus))}.</p>` : ""}${comparisonEvidenceUnavailable ? '<p class="unavailable">Current evidence cannot verify this saved comparison. Rerun comparison before claiming the repair is verified.</p>' : ""}</div><details><summary>Comparison evidence and limits</summary><p>Source change: ${html(result.comparison.sourceChange)} · Baseline source: ${html(result.comparison.baselineSourceStability ?? "unknown")} · Candidate source during replay: ${html(result.comparison.candidateSourceStability)} · Candidate source now: ${html(result.comparison.candidateSourceFreshness ?? "unverified")}</p><ul>${result.comparison.gaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul>${result.comparison.defects.map((defect) => `<p>${html(defect.oracleName)} · ${html(defect.surface)} · ${html(defect.outcome)}<br>Before: ${evidence(defect.baselineEvidence, defect.baselineRunId)}<br>Replay: ${evidence(defect.candidateEvidence, defect.candidateRunId ?? "")}</p>`).join("")}${result.comparison.omittedRuns || result.comparison.omittedDefects ? `<p class="meta">${result.comparison.omittedRuns} comparison runs and ${result.comparison.omittedDefects} defects omitted.</p>` : ""}<p class="meta">This comparison does not establish which source change caused the result.</p></details></section>`
    : result.comparisonUnavailable ? `<section class="comparison"><h2>Repair comparison unavailable</h2><p>${html(result.comparisonUnavailable)}</p></section>` : "";
  const replayConsistency = result.replayConsistency ? `<section class="comparison"><div class="section-label">Release replay · saved observations</div><h2>${html(result.replayConsistency.status === "diverge" ? "Primary and replay verdicts differ" : result.replayConsistency.status === "agree" ? "Observed replay verdicts agree" : "Replay comparison incomplete")}</h2><p>${result.replayConsistency.comparedPairs}/${result.replayConsistency.expectedPairs} pair(s) compared · ${result.replayConsistency.divergentPairs} divergent · ${result.replayConsistency.unverifiedPairs} unverified. Verdict divergence is a signal to investigate; two runs alone do not establish flakiness.</p><details><summary>Scenario replay pairs</summary><ul>${result.replayConsistency.pairs.map((pair) => `<li>${html([pair.charterId, pair.surface].filter(Boolean).join(" / "))}: ${html(pair.primaryVerdict ?? "missing")} → ${html(pair.replayVerdict ?? "missing")} (${html(pair.agreement)}) · Runs ${html(pair.primaryRunId ?? "missing")} / ${html(pair.replayRunId ?? "missing")}</li>`).join("")}</ul>${result.replayConsistency.omittedPairs ? `<p class="meta">${result.replayConsistency.omittedPairs} pair(s) omitted.</p>` : ""}<p class="meta">Review the Run evidence links below and the current evidence integrity before relying on saved observations.</p></details></section>` : "";
  const rows = result.runs.map((run) => `<tr><td><strong>${html(run.title)}</strong>${run.charterId ? `<small>${html(run.charterId)}</small>` : ""}${run.issue ? `<p class="row-issue">${html(run.issue)}</p>` : ""}</td><td>${html(run.surface ?? "unknown")}<small>${html(run.runKind)}${run.negativeCaseId ? ` · ${html(run.negativeCaseId)}` : ""}</small></td><td>${runOutcome(run)}<small>Task: ${html(run.taskStatus ?? "unassociated")}</small></td><td><small>UI: ${countLabel(run.assertions)}<br>Business checks: ${countLabel(run.oracles)}<br>Business facts: ${run.businessFacts ?? "not recorded"}<br>Visibility: ${html(run.executionVisibility ?? "not recorded")}${run.executionSessionId ? `<br>Session: ${html(run.executionSessionId)}` : ""}</small><small>Target: ${html(run.targetBinding?.status ?? "not inspected")}${run.targetContinuity ? `<br>Target continuity: ${html(run.targetContinuity)}` : ""}${run.surface === "electron" ? `<br>Electron process: ${html(run.applicationBinding?.status ?? "not inspected")}${run.applicationContinuity ? `<br>Electron continuity: ${html(run.applicationContinuity)}` : ""}` : ""}<br>Cleanup: ${html(run.integrationCleanup?.status ?? "not recorded")}${run.integrationCleanup ? ` (${run.integrationCleanup.verifiedResources}/${run.integrationCleanup.declaredResources})` : ""}</small></td><td><div class="links">${evidence(run.evidence) || "No saved evidence"}</div>${run.omittedEvidence ? `<small>${run.omittedEvidence} more reference(s) in Run report</small>` : ""}</td></tr>`).join("");
  const findings = result.findings.map((finding) => `<article class="finding"><div class="section-label">${html(finding.category)} · ${finding.category === "product" && finding.status === "confirmed" && !hasCompleteEvidence(finding.evidence, links) ? "saved confirmed · evidence currently unverified" : html(finding.status)} · ${html(finding.severity)}</div><h3>${html(finding.title)}</h3><p>${html(finding.message)}</p><div class="links">${evidence(finding.evidence)}</div></article>`);
  const findingsSection = findings.length ? `<section><div class="section-heading"><h2>Findings</h2><span class="meta">${currentlyVerified} / ${savedConfirmed.length} visible saved confirmed product finding(s) have all cited evidence</span></div>${findings.slice(0, 3).join("")}${findings.length > 3 ? `<details><summary>${findings.length - 3} more findings</summary>${findings.slice(3).join("")}</details>` : ""}${result.omittedFindings ? `<p class="meta">${result.omittedFindings} finding(s) omitted. The full audit is retained in the Mission store.</p>` : ""}</section>` : "";
  const diagnosticSupport = result.evidenceIntegrity?.diagnosticSupport;
  const sessionContext = result.sessionContext ? `<section aria-labelledby="session-context-title"><h2 id="session-context-title">Prior session context</h2><p class="meta">Session ${html(result.sessionContext.sessionId)} · Frozen at ${html(result.sessionContext.capturedAt)}. These earlier Runs explain the starting context; they are not execution or business proof for this Mission.</p><div class="table-wrap"><table><thead><tr><th>Prior Run</th><th>Started</th><th>Context evidence</th></tr></thead><tbody>${result.sessionContext.runs.map((run) => `<tr><td>${html(run.runId)}</td><td>${html(run.startedAt)}</td><td>${run.evidence.map((ref) => {
    const link = links.get(sessionContextEvidenceKey(run.runId, ref));
    return link?.href ? `<a class="evidence" href="${html(link.href)}">${html(evidenceLabel(ref.kind))}</a>`
      : `<span class="unavailable">${html(evidenceLabel(ref.kind))} unavailable or changed</span>`;
  }).join(" ") || '<span class="unavailable">No saved context evidence</span>'}</td></tr>`).join("") || '<tr><td colspan="3">No prior Runs retained</td></tr>'}</tbody></table></div>${result.sessionContext.omittedRuns ? `<p class="meta">${result.sessionContext.omittedRuns} prior Run(s) omitted or unavailable.</p>` : ""}</section>` : "";
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src 'self' file:; img-src 'self' file:; base-uri 'none'; form-action 'none'"><title>ProofKit · ${html(result.intent)}</title><style>
:root{color-scheme:light;--ink:#1c302e;--muted:#5d706c;--line:#d9e2df;--paper:#fff;--canvas:#f4f7f5;--accent:#17685a}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 28px 48px}header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}header{margin-bottom:22px}.brand{font-weight:750;letter-spacing:-.5px;font-size:21px}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:20px}h1,h2,h3,p{margin:0}h1{font-size:clamp(25px,3.8vw,40px);line-height:1.2;letter-spacing:-1px;margin:12px 0}h2{font-size:19px;line-height:1.4}h3{font-size:16px}p{margin-top:8px;overflow-wrap:anywhere}.meta,small{color:var(--muted);font-size:13px}.section-label{font-size:12px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;color:var(--muted)}.hero{background:var(--paper);border:1px solid var(--line);border-top:4px solid var(--accent);padding:24px 28px}.hero[data-verdict=failed]{border-top-color:#a42d37}.hero[data-verdict=inconclusive],.hero[data-verdict=blocked]{border-top-color:#9a6716}.hero-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.badge{display:inline-block;font-size:12px;line-height:1.5;padding:3px 9px;border:1px solid var(--line);border-radius:4px}.status-passed{color:#146247;background:#edf6f0}.status-failed{color:#9f2733;background:#fff0f1}.status-blocked,.status-inconclusive{color:#83580d;background:#fff6e7}.metrics{display:flex;flex-wrap:wrap;gap:26px;border-top:1px solid var(--line);margin-top:22px;padding-top:16px}.metrics strong{font-size:21px;font-weight:650;margin-right:6px}.scope{padding:20px 0;border-bottom:1px solid var(--line)}.scope ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--muted)}section{margin-top:24px}.failure{padding:18px 22px;background:#fff5f2;border-left:3px solid #a42d37}.failure h2{margin-top:6px;overflow-wrap:anywhere}.links{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px}.evidence-link,.unavailable{font-size:13px}.unavailable{color:#83580d}.comparison{border:1px solid var(--line);background:var(--paper);padding:18px 22px}.comparison p{font-size:14px}.table-wrap{overflow-x:auto;margin-top:12px;border:1px solid var(--line);background:var(--paper)}table{width:100%;border-collapse:collapse;min-width:760px;table-layout:fixed}th{font-size:12px;color:var(--muted);font-weight:650;background:#eef3f0}th,td{padding:14px 16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th:nth-child(1){width:25%}th:nth-child(2){width:12%}th:nth-child(3){width:19%}th:nth-child(4){width:20%}th:nth-child(5){width:24%}tbody tr:last-child td{border-bottom:0}td{font-size:14px;overflow-wrap:anywhere}small{display:block;margin-top:4px}.row-issue{font-size:12px;color:#83580d}.finding{padding:18px 0;border-bottom:1px solid var(--line)}.finding h3{margin-top:5px}.finding p{font-size:14px}details{margin-top:14px}summary{cursor:pointer;color:var(--accent);font-weight:600;overflow-wrap:anywhere}details p,details li{font-size:14px}footer{margin-top:30px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media(max-width:600px){main{padding:16px 16px 32px}.hero{padding:18px}.metrics{gap:14px}.metrics strong{font-size:18px}header{align-items:flex-start;flex-direction:column}nav{gap:12px;font-size:13px;flex-wrap:wrap}.section-heading{align-items:flex-start;flex-direction:column;gap:4px}.failure,.comparison{padding:16px}.table-wrap{margin-right:0}th,td{padding:12px}}
.workflow-card{padding:18px 20px;border:1px solid var(--line);background:var(--paper);border-radius:6px;margin-top:16px;min-width:0}.workflow-card li{margin:10px 0;overflow-wrap:anywhere}.workflow-card h4{margin:18px 0 4px}.workflow-card figure{margin:10px 0}.workflow-image{display:block;max-width:100%;width:360px;max-height:230px;object-fit:contain;object-position:left;border:1px solid var(--line)}.workflow-card .status-not-run{color:var(--muted)}
.check-highlights{display:grid;gap:10px;margin-top:14px}.check-highlight{padding:14px 18px;border:1px solid var(--line);border-left:3px solid #a42d37;background:#fff5f2;overflow-wrap:anywhere}.check-highlight.status-inconclusive{border-left-color:#9a6716;background:#fff8ed}.check-highlight p{font-size:14px}.check-highlight .links{margin-top:10px}
</style></head><body><main><header><div class="brand">ProofKit <span class="meta">/ Mission result</span></div><nav aria-label="Report navigation"><a href="#checks">Checks</a>${runDetails.size ? '<a href="#workflow-detail">Workflow</a>' : ""}<a href="#execution">Executions</a>${result.sessionCaptures ? '<a href="#session-evidence">Session evidence</a>' : ""}<a href="summary.json">Result JSON</a></nav></header>
<section class="hero" data-verdict="${html(result.testVerdict ?? result.verdict ?? "pending")}" aria-labelledby="outcome"><div class="hero-top"><span class="badge">${html(result.level)}</span><span class="badge">${html(scopeLabel)}</span>${result.acceptanceEvidenceIntegrity ? `<span class="badge">Acceptance evidence ${html(result.acceptanceEvidenceIntegrity.status)}</span>` : ""}${result.evidenceIntegrity?.status === "partial" ? `<span class="badge">${html(String(result.evidenceIntegrity.omittedEvidenceReferences ?? 0))} detail reference(s) omitted from overview</span>` : result.evidenceIntegrity?.status === "degraded" ? '<span class="badge">Displayed evidence degraded</span>' : ""}${businessPassUnverified || businessFailureUnverified ? '<span class="badge">Business proof unverified</span>' : ""}${result.testVerdict === "inconclusive" && (result.verdict === "passed" || result.verdict === "failed") ? '<span class="badge status-inconclusive">Current acceptance inconclusive</span>' : ""}<span class="meta">${html(result.status)}${result.running ? " · execution owner active" : ""}</span></div><h1 id="outcome">${html(currentOutcomeLabel)}</h1><p>${html(result.intent)}</p><div class="metrics"><div><strong>${result.scope.charterCount}</strong> saved scenario(s)</div><div><strong>${result.observedRuns} / ${result.expectedRuns}</strong> run observations / planned runs</div><div><strong>${result.confirmedProductFindings}</strong> saved confirmed product finding occurrence(s)</div></div></section>
${renderCheckOverview(result, links)}
<section class="scope" aria-labelledby="scope"><h2 id="scope">Acceptance scope</h2><p class="meta">${html(result.scope.surfaces.join(" · "))}${result.scope.suiteId ? ` · Suite ${html(result.scope.suiteId)}` : ""}<br>Web execution: ${html(result.executionProfile?.webVisibility ?? "not recorded")}${result.scope.surfaces.includes("electron") ? " · Electron visibility is controlled by the attached app process" : ""}</p><ul>${limits.map((limit) => `<li>${html(limit)}</li>`).join("")}</ul>${planningGaps.length ? `<details open><summary>Missing test requirements</summary><ul>${planningGaps.map((gap) => `<li>${html(gap)}</li>`).join("")}</ul></details>` : ""}</section>
${planSection}${firstFailure}${comparison}${replayConsistency}<section id="execution" aria-labelledby="execution-title"><div class="section-heading"><h2 id="execution-title">Scenario executions</h2><span class="meta">${result.tasks.settled} / ${result.tasks.total} tasks settled · ${result.tasks.skipped} skipped</span></div><div class="table-wrap" role="region" aria-label="Scenario execution matrix" tabindex="0"><table><thead><tr><th>Scenario</th><th>Surface / kind</th><th>Observed outcome</th><th>Verification facts</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No execution tasks recorded.</td></tr>'}</tbody></table></div><p class="meta">Task counts describe execution progress. The Mission verdict is the saved acceptance result.</p></section>${findingsSection}${repair}
<section><details><summary>Audit details</summary><p>Mission: ${html(result.missionId)}${result.replayOfMissionId ? `<br>Replay of: ${html(result.replayOfMissionId)}` : ""}<br>Project: ${html(result.projectRoot)}<br>Workspace: ${html(result.workspaceRoot)}<br>Source inventory: ${html(coverage?.inventory ?? "not recorded")}<br>Workflow coverage: ${html(coverage?.workflowCoverage ?? "not recorded")}<br>Level selection: ${html(result.levelSelection?.reason ?? "not recorded")}<br>Web visibility: ${html(result.executionProfile?.webVisibility ?? "not recorded")}</p>${result.planning?.assumptions.length ? `<ul>${result.planning.assumptions.map((assumption) => `<li>${html(assumption)}</li>`).join("")}</ul>` : ""}</details></section>
${sessionContext}
${renderRunDetails(result, links, runDetails)}
${renderPlanningObservation(result, links)}
${renderSessionCaptures(result, links)}
<footer>Snapshot of saved Mission revision ${result.revision} · Updated ${html(result.updatedAt)} · Report generated ${html(result.generatedAt)}<br>This static report does not refresh while a Mission is running. Regenerate it to read the latest saved state.</footer></main></body></html>`;
}

function evidenceKey(ref: EvidenceRef): string {
  return JSON.stringify([ref.path, ref.sha256 ?? null]);
}

function sessionContextEvidenceKey(runId: string, ref: EvidenceRef): string {
  return `session-context:${runId}:${evidenceKey(ref)}`;
}

function sessionCaptureEvidenceKey(runId: string, ref: EvidenceRef): string {
  return `session-capture:${runId}:${evidenceKey(ref)}`;
}

function planningObservationKey(ref: EvidenceRef): string {
  return `planning-context:${evidenceKey(ref)}`;
}

function renderPlanningObservation(result: MissionResult, links: Map<string, EvidenceLink>): string {
  const context = result.planningObservation;
  if (!context) return "";
  const evidence = (runId?: string) => context.status === "verified" ? context.evidence.map((ref) => {
    const link = links.get(planningObservationKey(ref));
    if (runId && link?.runId !== runId) return "";
    return link?.href ? `<a class="evidence" href="${html(link.href)}">${html(ref.path.split(/[\\/]/).at(-1) ?? "Planning evidence")}</a>` : "";
  }).join(" ") : "";
  const states = planningObservationSources(context.observation);
  const stateList = states.length ? `<ol>${states.map((state) => `<li><p>Observed state <code>${html(state.source.runId)}</code> · ${html(state.capturedAt)}${state.controlsTruncated ? " · Controls truncated" : ""}</p><div class="links">${evidence(state.source.runId)}</div></li>`).join("")}</ol>` : evidence();
  return `<section aria-labelledby="planning-observation-title"><h2 id="planning-observation-title">Planning observation</h2><p>${html(context.status)} · ${states.length || 1} observed state(s)${context.observation.sessionId ? ` · Session ${html(context.observation.sessionId)}` : ""}</p><p>${html(context.reason)}</p><p class="meta">These page observations are planning context; they do not establish complete workflow coverage and are separate from execution and independent business acceptance evidence.</p>${stateList}</section>`;
}

function auditCaptureLinks(result: MissionResult, links: Map<string, EvidenceLink>): MissionResult["sessionCaptures"] {
  if (!result.sessionCaptures) return;
  return { ...result.sessionCaptures, segments: result.sessionCaptures.segments.map((segment) => {
    if (segment.integrity !== "intact") return { ...segment, evidence: [] };
    if (segment.capture && segment.evidence.length >= 5 && segment.evidence.every((ref) => links.get(sessionCaptureEvidenceKey(segment.runId, ref))?.href)) return segment;
    return { ...segment, integrity: "unverified", evidence: [], reason: "Capture references changed or became unavailable while preparing this report. Playback and evidence links have been withdrawn." };
  }) };
}

function renderSessionCaptures(result: MissionResult, links: Map<string, EvidenceLink>): string {
  if (!result.sessionCaptures) return "";
  return `<section id="session-evidence" aria-labelledby="session-evidence-title"><h2 id="session-evidence-title">Session evidence</h2><p class="meta">Session context may include time before or after this Mission. A recording and network metadata explain observed execution; they do not independently prove business acceptance. Integrity uses a local seal, not an external signature. Video pixels are not redacted and may contain sensitive data.</p>${result.sessionCaptures.segments.map((segment) => {
    const capture = segment.capture;
    const verified = segment.integrity === "intact";
    const video = verified ? segment.evidence.find((ref) => ref.kind === "video" && ref.path.endsWith(`${sep}artifacts${sep}recording.webm`)) : undefined;
    const videoLink = video ? links.get(sessionCaptureEvidenceKey(segment.runId, video)) : undefined;
    const selectedPlayers = (capture?.recording?.selectedPages?.artifacts ?? []).map((artifact) => {
      const filename = artifact.split("/").at(-1) ?? "";
      const ref = verified ? segment.evidence.find((item) => item.kind === "video" && item.path.endsWith(`${sep}artifacts${sep}${filename}`)) : undefined;
      const link = ref ? links.get(sessionCaptureEvidenceKey(segment.runId, ref)) : undefined;
      return link?.href ? `<p>Selected window ${html(filename)} (begins when its page opened):</p><video controls preload="metadata" style="display:block;width:100%;max-height:70vh" src="${html(link.href)}" aria-label="Selected-page recording ${html(filename)}">Selected-page session recording</video>`
        : `<p class="unavailable">Selected-page recording ${html(filename)} unavailable or changed.</p>`;
    }).join("") || (capture?.recording?.selectedPages?.observed ? '<p class="unavailable">No verified playable selected-page recording is available.</p>' : "");
    const evidence = verified ? segment.evidence.map((ref) => {
      const link = links.get(sessionCaptureEvidenceKey(segment.runId, ref));
      return link?.href ? `<a class="evidence" href="${html(link.href)}">${html(ref.path.split(/[\\/]/).at(-1) ?? evidenceLabel(ref.kind))}</a>` : "";
    }).join(" ") : "";
    return `<article><h3>${html(segment.runId)}</h3><p>Integrity: <strong>${html(segment.integrity)}</strong> · Capture completeness: ${html(capture?.status ?? "not verified")}</p><p>${html(segment.reason)}</p>${capture ? `<p class="meta">${capture.events} event(s) · ${capture.omittedEvents} omitted · ${capture.unresolvedRequests} unresolved request(s) · Network metadata: ${capture.networkEnabled ? "enabled" : "disabled"} · Primary-page recording: ${html(capture.recording?.status ?? "not requested")}${capture.recording?.stopReason ? `<br>Recording stopped: ${html(capture.recording.stopReason)}. Requested evidence is incomplete.` : ""}${capture.recording?.budget ? `<br>Recording budget: ${capture.recording.budget.maxDurationMs} ms · ${capture.recording.budget.maxBytes} temporary bytes` : ""}${capture.recording?.selectedPages ? `<br>Selected-page clips: ${capture.recording.selectedPages.artifacts.length}/${capture.recording.selectedPages.observed} · ${capture.recording.selectedPages.omitted} omitted` : ""}</p>` : ""}${videoLink?.href ? `<video controls preload="metadata" style="display:block;width:100%;max-height:70vh" src="${html(videoLink.href)}" aria-label="Initial primary-page recording">Initial primary-page session recording</video>` : '<p class="unavailable">No verified playable primary-page recording is available.</p>'}${selectedPlayers}<div class="links">${evidence}</div></article>`;
  }).join("")}${result.sessionCaptures.omittedSegments ? `<p class="meta">${result.sessionCaptures.omittedSegments} associated segment(s) omitted from this bounded presentation.</p>` : ""}</section>`;
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
  return (parts.length === 1 && ["report.html", "events.jsonl", "run.json", "manifest.json"].includes(parts[0]!))
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
  return ({ report: "Run report", business: "Business fact", screenshot: "Screenshot", video: "Run video", snapshot: "Snapshot", network: "Network log", console: "Console", process: "Process", api: "API fact", runtime: "Runtime", log: "Log", other: "Artifact" })[kind];
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
