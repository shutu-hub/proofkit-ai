import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowCandidateAuditSchema, WorkflowInventorySchema } from "@proofkit/contracts";
import { authenticateWorkflowReview, signWorkflowReview, workflowReviewDigests } from "./workflow-review.js";

const inventory = WorkflowInventorySchema.parse({
  schemaVersion: 1,
  source: { headSha: "a".repeat(40), worktreeSha256: "b".repeat(64) },
  review: { by: "operator", at: "2026-10-11T08:00:00Z", method: "Reviewed the complete product workflow list" },
  workflows: [{ id: "resume", title: "Resume acquisition", sourcePaths: ["src/resume.ts"],
    charterIds: ["resume-core"], surfaces: ["web"] }],
  exclusions: [],
});
const candidate = WorkflowCandidateAuditSchema.parse({
  status: "scanned", routeCandidates: 0, entryCandidates: 1, sourceOwned: 1, routeLinked: 0,
  excluded: 0, unclaimed: 0, unlinkedRoutes: 0, overlappingExclusions: 0,
  unresolvedRouteDeclarations: 0, skippedCandidates: 0, gaps: [], omittedGaps: 0,
  limitations: ["Static candidates cannot prove semantic completeness."],
});
const materials = { candidateSetSha256: "c".repeat(64), charterManifest: [{
  id: "resume-core", catalog: { id: "resume-core", path: "charters/resume.yaml", aliases: ["resume"], level: "core" as const, surfaces: ["web" as const] },
  fileSha256: "d".repeat(64), executionSha256: "e".repeat(64),
}] };

describe("workflow review attestation", () => {
  it("authenticates the exact reviewed inventory and candidate audit", () => {
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const attestation = signWorkflowReview(inventory, candidate, materials, "operator-1", privatePem);
    expect(authenticateWorkflowReview(inventory, candidate, materials, attestation, { "operator-1": publicPem }))
      .toMatchObject({ status: "verified", keyId: "operator-1", candidateSha256: attestation.candidateSha256 });
    expect(authenticateWorkflowReview(inventory, candidate, materials, attestation, {})).toMatchObject({ status: "untrusted" });
    const prototypeId = signWorkflowReview(inventory, candidate, materials, "__proto__", privatePem);
    expect(authenticateWorkflowReview(inventory, candidate, materials, prototypeId, {})).toMatchObject({ status: "untrusted" });
    expect(authenticateWorkflowReview(inventory, candidate, materials, { ...attestation, signature: "x".repeat(88) },
      { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview({ ...inventory, workflows: [{ ...inventory.workflows[0]!, title: "Different" }] },
      candidate, materials, attestation, { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview(inventory, { ...candidate, entryCandidates: 2 }, materials, attestation,
      { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview(inventory, candidate, { ...materials, candidateSetSha256: "e".repeat(64) },
      attestation, { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview(inventory, candidate, { ...materials, charterManifest: [{ ...materials.charterManifest[0]!, executionSha256: "f".repeat(64) }] },
      attestation, { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
  });

  it("normalizes key order and excludes no signed review field", () => {
    const reordered = WorkflowInventorySchema.parse({
      exclusions: [], workflows: inventory.workflows, review: inventory.review,
      source: { worktreeSha256: inventory.source.worktreeSha256, headSha: inventory.source.headSha }, schemaVersion: 1,
    });
    expect(workflowReviewDigests(reordered, candidate, materials)).toEqual(workflowReviewDigests(inventory, candidate, materials));
    expect(workflowReviewDigests({ ...inventory, review: { ...inventory.review!, by: "someone else" } }, candidate, materials).inventorySha256)
      .not.toBe(workflowReviewDigests(inventory, candidate, materials).inventorySha256);
  });
});
