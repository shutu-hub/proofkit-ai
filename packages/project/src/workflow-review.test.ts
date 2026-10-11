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

describe("workflow review attestation", () => {
  it("authenticates the exact reviewed inventory and candidate audit", () => {
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const attestation = signWorkflowReview(inventory, candidate, "operator-1", privatePem);
    expect(authenticateWorkflowReview(inventory, candidate, attestation, { "operator-1": publicPem }))
      .toEqual({ status: "verified", keyId: "operator-1", candidateSha256: attestation.candidateSha256 });
    expect(authenticateWorkflowReview(inventory, candidate, attestation, {})).toMatchObject({ status: "untrusted" });
    const prototypeId = signWorkflowReview(inventory, candidate, "__proto__", privatePem);
    expect(authenticateWorkflowReview(inventory, candidate, prototypeId, {})).toMatchObject({ status: "untrusted" });
    expect(authenticateWorkflowReview(inventory, candidate, { ...attestation, signature: "x".repeat(88) },
      { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview({ ...inventory, workflows: [{ ...inventory.workflows[0]!, title: "Different" }] },
      candidate, attestation, { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
    expect(authenticateWorkflowReview(inventory, { ...candidate, entryCandidates: 2 }, attestation,
      { "operator-1": publicPem })).toMatchObject({ status: "invalid" });
  });

  it("normalizes key order and excludes no signed review field", () => {
    const reordered = WorkflowInventorySchema.parse({
      exclusions: [], workflows: inventory.workflows, review: inventory.review,
      source: { worktreeSha256: inventory.source.worktreeSha256, headSha: inventory.source.headSha }, schemaVersion: 1,
    });
    expect(workflowReviewDigests(reordered, candidate)).toEqual(workflowReviewDigests(inventory, candidate));
    expect(workflowReviewDigests({ ...inventory, review: { ...inventory.review!, by: "someone else" } }, candidate).inventorySha256)
      .not.toBe(workflowReviewDigests(inventory, candidate).inventorySha256);
  });
});
