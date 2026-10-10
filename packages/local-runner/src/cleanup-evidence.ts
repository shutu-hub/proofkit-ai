import { readFileSync, statSync } from "node:fs";
import { IntegrationCleanupArtifactSchema, IntegrationCleanupSchema, hasIncompleteIntegrationCleanup, type EvidenceRef } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { materializedRunArtifact } from "./run-evidence.js";

/** Legacy Runs have no cleanup protocol; new claims require their exact saved artifact. */
export function hasCompleteCleanupEvidence(cleanup: unknown, runId: string, evidence: EvidenceRef[], evidenceDir?: string): boolean {
  if (cleanup === undefined) return true;
  const parsed = IntegrationCleanupSchema.safeParse(cleanup);
  if (!parsed.success || hasIncompleteIntegrationCleanup(cleanup)) return false;
  const summary = parsed.data;
  if (summary.status === "not-required" && !summary.artifact) return true;
  if (!summary.artifact || !summary.sha256 || !evidenceDir) return false;
  const refs = evidence.filter((ref) => ref.kind === "runtime" && ref.evidenceId === `${runId}:${summary.artifact}`);
  if (refs.length !== 1) return false;
  const path = materializedRunArtifact(refs[0]!, runId, summary.artifact, evidenceDir);
  if (!path) return false;
  try {
    // Bounded facts can still occupy several MiB at their allowed schema limits.
    if (statSync(path).size > 16 * 1024 * 1024) return false;
    const bytes = readFileSync(path);
    if (sha256(bytes) !== summary.sha256.toLowerCase() || refs[0]!.sha256 && refs[0]!.sha256 !== summary.sha256) return false;
    const proof = IntegrationCleanupArtifactSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!proof.success) return false;
    const data = proof.data;
    if (data.runId !== runId || data.status !== summary.status || data.declaredResources !== summary.declaredResources
      || data.verifiedResources !== summary.verifiedResources || data.issues.length > 0) return false;
    if (data.resources.length !== summary.declaredResources || data.observations.length !== data.resources.length) return false;
    const ids = new Set(data.resources.map((resource) => resource.resourceId));
    if (ids.size !== data.resources.length || new Set(data.observations.map((item) => item.resourceId)).size !== ids.size) return false;
    const startedAt = Date.parse(data.startedAt), endedAt = Date.parse(data.endedAt);
    if (endedAt < startedAt || endedAt > Date.now()) return false;
    return data.resources.every((resource) => {
      const observation = data.observations.find((item) => item.resourceId === resource.resourceId);
      const readback = observation?.readback;
      const releaseStartedAt = Date.parse(observation?.releaseStartedAt ?? "");
      return observation?.status === "removed" && readback?.exists === false && readback.scope === resource.scope
        && releaseStartedAt >= startedAt && releaseStartedAt <= endedAt
        && Date.parse(readback.observedAt) >= releaseStartedAt && Date.parse(readback.observedAt) <= endedAt;
    });
  } catch { return false; }
}
