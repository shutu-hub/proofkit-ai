import { resolve } from "node:path";
import { changedSurfaceTargetFields, PlanningInspectionPinSchema, SurfaceSnapshotSchema, type Action, type EvidenceRef, type PlanningInspectionPin, type PlanningSurfaceObservation, type SurfaceSnapshot } from "@proofkit/contracts";
import type { EvidenceStore } from "./index.js";
import { actionSurfaceTargets } from "@proofkit/contracts";

export type PlanningObservationAudit = { status: "verified" | "unverified" | "caller-supplied"; reason: string; evidence: EvidenceRef[] };
type InspectionStore = Pick<EvidenceStore, "rootDir" | "loadSummary" | "verifyManifest">;
type AuditOptions = { projectRoot?: string; workspaceRoot?: string; adapter?: string; sessionId?: string; actions?: Action[] };

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

export async function auditPlanningObservation(store: InspectionStore, observation: PlanningSurfaceObservation, options: AuditOptions = {}): Promise<PlanningObservationAudit> {
  if (!observation.sources) return auditSinglePlanningObservation(store, observation, options);
  const unavailable: PlanningObservationAudit = { status: "unverified", reason: "The multi-state plan lacks consistently bound original observations.", evidence: [] };
  const sources = observation.sources;
  const ids = new Set(sources.map((state) => state.source.runId));
  if (!sources.length || sources.length > 10 || ids.size !== sources.length || observation.source || observation.capturedAt !== sources[0]?.capturedAt
    || observation.controlsTruncated !== sources.some((state) => state.controlsTruncated)) return unavailable;
  const targets = (options.actions ?? []).flatMap(actionSurfaceTargets);
  if (targets.some((target) => target.expectedTarget && (!target.expectedTarget.observationId || target.observationId !== target.expectedTarget.observationId
    || !ids.has(target.expectedTarget.observationId)))) return unavailable;
  const evidence: EvidenceRef[] = [];
  for (const state of sources) {
    const audit = await auditSinglePlanningObservation(store, { ...state, ...(observation.sessionId ? { sessionId: observation.sessionId } : {}) }, options, ids);
    if (audit.status !== "verified") return audit;
    evidence.push(...audit.evidence);
  }
  return { status: "verified", reason: `${sources.length} observed states verify against their original local manifests. These planning states do not establish workflow completeness or business acceptance.`, evidence };
}

async function auditSinglePlanningObservation(store: InspectionStore, observation: PlanningSurfaceObservation, options: AuditOptions, sourceIds?: Set<string>): Promise<PlanningObservationAudit> {
  const unavailable: PlanningObservationAudit = { status: "unverified", reason: "The original planning observation or its project, surface and session binding cannot be verified.", evidence: [] };
  if (observation.sessionId && observation.sessionId !== options.sessionId) return { ...unavailable, reason: "The selected execution session differs from the session used to observe this plan." };
  const source = observation.source;
  if (!source) return { status: "caller-supplied", reason: "This observation was supplied by the caller; no independently saved inspection source is attached.", evidence: [] };
  try {
    if (!source.snapshotPath.startsWith(`${source.runId}/artifacts/`)) return unavailable;
    const verified = await store.verifyManifest(source.runId, source.manifestSha256);
    if (verified.status !== "intact" || !verified.manifestVerified) return { ...unavailable, reason: "The planning inspection bundle no longer matches its original pinned manifest. Reobserve the target before executing this plan." };
    const expected = new Map(verified.files.map((file) => [file.path, file.expectedSha256]));
    if (expected.get(source.snapshotPath) !== source.snapshotSha256) return unavailable;
    const summaryDigest = expected.get(`${source.runId}/run.json`);
    if (!summaryDigest) return unavailable;
    const summary = await store.loadSummary(source.runId, summaryDigest);
    if (summary.status !== "completed" || summary.execution?.kind === "session-network-capture" || summary.charter.metadata.purpose !== "surface-inspection"
      || summary.charter.sideEffectPolicy !== "deny" || summary.charter.actions.some((action) => !["observe", "waitForText"].includes(action.kind))
      || summary.execution?.sessionId !== observation.sessionId || (options.adapter && summary.execution?.adapter !== options.adapter)
      || !samePath(summary.projectRoot, options.projectRoot) || !samePath(summary.workspaceRoot, options.workspaceRoot)) return unavailable;
    const step = summary.steps.find((step) => step.action.kind === "observe" && step.status === "passed" && step.artifacts.includes(source.snapshotPath));
    if (!step?.afterSnapshot || source.snapshotPath !== `${source.runId}/artifacts/${step.stepId}-after.json`) return unavailable;
    const snapshot = SurfaceSnapshotSchema.parse(step.afterSnapshot);
    if (snapshot.capturedAt !== observation.capturedAt || Boolean(snapshot.controlsTruncated) !== observation.controlsTruncated) return unavailable;
    if (!bindingsMatchSnapshot(options.actions ?? [], snapshot, source.runId, sourceIds)) return { ...unavailable, reason: "The plan's control identities do not match the original saved planning observation." };
    const paths = [source.snapshotPath, `${source.runId}/report.html`, `${source.runId}/manifest.json`];
    const evidence: EvidenceRef[] = paths.map((path) => ({ evidenceId: `planning:${path}`, path: resolve(store.rootDir, path),
      sha256: path.endsWith("manifest.json") ? source.manifestSha256 : expected.get(path), capturedAt: observation.capturedAt,
      kind: path.endsWith(".html") ? "report" : "snapshot", description: "Planning context; not independent business acceptance evidence" }));
    if (evidence.some((ref) => !ref.sha256)) return unavailable;
    return { status: "verified", reason: "The read-only inspection and its control identities verify against their original local manifest; this is planning context, not business proof.", evidence };
  } catch { return unavailable; }
}

function bindingsMatchSnapshot(actions: Action[], snapshot: SurfaceSnapshot, sourceId: string, sourceIds?: Set<string>): boolean {
  let origin: string | undefined;
  try { const url = new URL(snapshot.url ?? ""); if (["http:", "https:"].includes(url.protocol)) origin = url.origin; } catch {}
  return actions.flatMap(actionSurfaceTargets).every((target) => {
    if (!target.expectedTarget) return true;
    if (target.observationId !== target.expectedTarget.observationId) return false;
    if (target.expectedTarget.observationId && target.expectedTarget.observationId !== sourceId) return Boolean(sourceIds?.has(target.expectedTarget.observationId));
    const controls = snapshot.controls?.filter((control) => control.selector === target.selector || control.alternateSelectors?.includes(target.selector)) ?? [];
    if (controls.length !== 1) return false;
    const control = controls[0]!;
    return target.expectedTarget.observedAt === snapshot.capturedAt && changedSurfaceTargetFields(target.expectedTarget, {
      tag: control.tag, role: control.role, name: control.name ?? "", groupName: control.groupName ?? "", ...(control.inputType ? { inputType: control.inputType } : {}),
    }, origin).length === 0;
  });
}

export async function loadPinnedPlanningObservation(store: InspectionStore, input: PlanningInspectionPin, options: AuditOptions): Promise<{ observation: PlanningSurfaceObservation; snapshot: SurfaceSnapshot }> {
  const pin = PlanningInspectionPinSchema.parse(input);
  const verified = await store.verifyManifest(pin.runId, pin.manifestSha256);
  if (verified.status !== "intact" || !verified.manifestVerified) throw new Error("The requested inspection no longer matches its original manifest pin");
  const files = new Map(verified.files.map((file) => [file.path, file.expectedSha256]));
  const summaryDigest = files.get(`${pin.runId}/run.json`);
  if (!summaryDigest) throw new Error("The requested inspection has no pinned summary");
  const summary = await store.loadSummary(pin.runId, summaryDigest);
  if (summary.execution?.sessionId !== options.sessionId) throw new Error("The requested inspection belongs to a different retained-session scope");
  const step = summary.steps.find((step) => step.action.kind === "observe" && step.status === "passed" && step.afterSnapshot);
  const snapshotPath = step ? `${pin.runId}/artifacts/${step.stepId}-after.json` : undefined;
  const snapshotSha256 = snapshotPath ? files.get(snapshotPath) : undefined;
  if (!step?.afterSnapshot || !snapshotPath || !snapshotSha256) throw new Error("The requested inspection has no completed pinned observation");
  const snapshot = SurfaceSnapshotSchema.parse(step.afterSnapshot);
  const observation: PlanningSurfaceObservation = { capturedAt: snapshot.capturedAt, controlsTruncated: Boolean(snapshot.controlsTruncated),
    ...(summary.execution?.sessionId ? { sessionId: summary.execution.sessionId } : {}), source: { ...pin, snapshotPath, snapshotSha256 } };
  const audit = await auditPlanningObservation(store, observation, options);
  if (audit.status !== "verified") throw new Error(audit.reason);
  return { observation, snapshot: { ...snapshot, text: snapshot.textRead ? snapshot.text : snapshot.text?.slice(0, 2000) } };
}
