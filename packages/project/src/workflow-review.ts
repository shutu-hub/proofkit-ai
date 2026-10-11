import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  WorkflowCandidateAuditSchema, WorkflowInventorySchema, WorkflowReviewAttestationSchema,
  WorkflowReviewAuthenticationSchema,
  type WorkflowCandidateAudit, type WorkflowInventory, type WorkflowReviewAttestation,
  type WorkflowReviewAuthentication,
} from "@proofkit/contracts";

const DOMAIN = "proofkit.workflow-review.v1\n";

/** Keep YAML spelling and object-key order out of the signed identity. Arrays retain their declared order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Unsupported workflow review value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const fields = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function workflowReviewDigests(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit): {
  inventorySha256: string; candidateSha256: string;
} {
  const normalizedInventory = WorkflowInventorySchema.parse(inventory);
  const normalizedCandidate = WorkflowCandidateAuditSchema.parse(candidate);
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  return { inventorySha256: hash(normalizedInventory), candidateSha256: hash(normalizedCandidate) };
}

function statement(digests: ReturnType<typeof workflowReviewDigests>, keyId: string): Buffer {
  return Buffer.from(`${DOMAIN}${keyId}\n${digests.inventorySha256}\n${digests.candidateSha256}\n`, "utf8");
}

/** Operator-side helper. The private key must be controlled outside the agent's project and test workspace. */
export function signWorkflowReview(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit,
  keyId: string, privateKeyPem: string): WorkflowReviewAttestation {
  const digests = workflowReviewDigests(inventory, candidate);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Workflow review requires an Ed25519 private key");
  return WorkflowReviewAttestationSchema.parse({
    schemaVersion: 1, algorithm: "Ed25519", keyId, ...digests,
    signature: sign(null, statement(digests, keyId), key).toString("base64"),
  });
}

/** Verify a signed declaration against operator-supplied trust, never against a key stored in the test workspace. */
export function authenticateWorkflowReview(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit,
  attestation: unknown, trustedPublicKeys: Readonly<Record<string, string>>): WorkflowReviewAuthentication {
  const parsed = WorkflowReviewAttestationSchema.safeParse(attestation);
  if (!parsed.success) return WorkflowReviewAuthenticationSchema.parse({ status: "invalid" });
  const signed = parsed.data;
  const digests = workflowReviewDigests(inventory, candidate);
  if (signed.inventorySha256 !== digests.inventorySha256 || signed.candidateSha256 !== digests.candidateSha256) {
    return { status: "invalid", keyId: signed.keyId };
  }
  const trusted = Object.hasOwn(trustedPublicKeys, signed.keyId) ? trustedPublicKeys[signed.keyId] : undefined;
  if (!trusted) return { status: "untrusted", keyId: signed.keyId };
  try {
    const key = createPublicKey(trusted);
    if (key.asymmetricKeyType !== "ed25519") return { status: "invalid", keyId: signed.keyId };
    const valid = verify(null, statement(digests, signed.keyId), key, Buffer.from(signed.signature, "base64"));
    return valid ? { status: "verified", keyId: signed.keyId, candidateSha256: digests.candidateSha256 }
      : { status: "invalid", keyId: signed.keyId };
  } catch {
    return { status: "invalid", keyId: signed.keyId };
  }
}
