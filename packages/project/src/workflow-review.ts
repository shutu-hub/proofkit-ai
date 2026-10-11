import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import {
  ProjectMapSchema, TestCharterSchema, WorkflowCandidateAuditSchema, WorkflowInventorySchema, WorkflowReviewAttestationSchema,
  WorkflowReviewAuthenticationSchema,
  workflowChecks, type ProofkitConfig, type ProjectMap, type TestCharter, type WorkflowCandidateAudit,
  type WorkflowInventory, type WorkflowReviewAttestation, type WorkflowReviewMaterials,
  type WorkflowReviewAuthentication,
} from "@proofkit/contracts";
import { resolveWithinWorkspace } from "./context.js";

const DOMAIN = "proofkit.workflow-review.v2\nreviewed inventory claims the complete business workflow scope for its source fingerprint\n";
const MAX_CHARTER_BYTES = 1024 * 1024;

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

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Ignore planning and catalog bookkeeping, retaining all fields that can affect a Run. */
export function workflowCharterExecutionSha256(charter: TestCharter): string {
  const normalized = TestCharterSchema.parse(charter);
  const { planning: _planning, levelSelection: _levelSelection, metadata, ...execution } = normalized;
  const { catalogId: _catalogId, suiteId: _suiteId, matchedAlias: _matchedAlias, ...declaredMetadata } = metadata;
  return hash({ ...execution, metadata: declaredMetadata });
}

export function workflowCandidateSetSha256(project: ProjectMap): string {
  const sourceInventory = ProjectMapSchema.parse(project).inventory;
  return hash({ ...sourceInventory,
    entryPoints: [...sourceInventory.entryPoints].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0),
    routeHints: [...sourceInventory.routeHints].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0),
  });
}

/** Bind the complete discovered candidate set and the exact workspace Charter files, not only summary counts. */
export async function collectWorkflowReviewMaterials(inventory: WorkflowInventory, config: ProofkitConfig,
  project: ProjectMap, workspaceRoot: string): Promise<WorkflowReviewMaterials> {
  const candidateSetSha256 = workflowCandidateSetSha256(project);
  const catalog = new Map(config.charters.map((entry) => [entry.id, entry]));
  const ids = [...new Set(inventory.workflows.flatMap((workflow) => workflowChecks(workflow).map((check) => check.charterId)))].sort();
  if (ids.length === 0 || ids.length > 256) throw new Error("Workflow review Charter manifest is empty or too large");
  const charters: WorkflowReviewMaterials["charterManifest"] = [];
  for (const id of ids) {
    const entry = catalog.get(id);
    if (!entry) throw new Error("Workflow review Charter is not registered");
    const path = resolveWithinWorkspace(workspaceRoot, entry.path);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CHARTER_BYTES) throw new Error("Workflow review Charter file is unavailable or too large");
    const bytes = await readFile(path);
    if (bytes.length > MAX_CHARTER_BYTES) throw new Error("Workflow review Charter changed during read");
    let charter: TestCharter;
    try { charter = TestCharterSchema.parse(parse(bytes.toString("utf8"))); }
    catch { throw new Error("Workflow review Charter is invalid"); }
    if (charter.level !== entry.level) throw new Error("Workflow review Charter level does not match its catalog entry");
    charters.push({ id, catalog: entry,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      executionSha256: workflowCharterExecutionSha256(charter) });
  }
  return { candidateSetSha256, charterManifest: charters };
}

export function workflowReviewDigests(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit,
  materials: WorkflowReviewMaterials): {
  inventorySha256: string; candidateSha256: string; candidateSetSha256: string; charterManifestSha256: string;
} {
  const normalizedInventory = WorkflowInventorySchema.parse(inventory);
  const normalizedCandidate = WorkflowCandidateAuditSchema.parse(candidate);
  if (!/^[a-f0-9]{64}$/.test(materials.candidateSetSha256)
    || materials.charterManifest.length === 0 || materials.charterManifest.length > 256
    || materials.charterManifest.some((item) => !/^[a-f0-9]{64}$/.test(item.fileSha256)
      || !/^[a-f0-9]{64}$/.test(item.executionSha256))) {
    throw new Error("Invalid workflow review material digest");
  }
  return { inventorySha256: hash(normalizedInventory), candidateSha256: hash(normalizedCandidate),
    candidateSetSha256: materials.candidateSetSha256, charterManifestSha256: hash(materials.charterManifest) };
}

function statement(digests: ReturnType<typeof workflowReviewDigests>, keyId: string): Buffer {
  return Buffer.from(`${DOMAIN}${keyId}\n${digests.inventorySha256}\n${digests.candidateSha256}\n${digests.candidateSetSha256}\n${digests.charterManifestSha256}\n`, "utf8");
}

/** Operator-side helper. The private key must be controlled outside the agent's project and test workspace. */
export function signWorkflowReview(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit, materials: WorkflowReviewMaterials,
  keyId: string, privateKeyPem: string): WorkflowReviewAttestation {
  const digests = workflowReviewDigests(inventory, candidate, materials);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Workflow review requires an Ed25519 private key");
  return WorkflowReviewAttestationSchema.parse({
    schemaVersion: 2, algorithm: "Ed25519", keyId, ...digests,
    signature: sign(null, statement(digests, keyId), key).toString("base64"),
  });
}

/** Verify a signed declaration against operator-supplied trust, never against a key stored in the test workspace. */
export function authenticateWorkflowReview(inventory: WorkflowInventory, candidate: WorkflowCandidateAudit, materials: WorkflowReviewMaterials,
  attestation: unknown, trustedPublicKeys: Readonly<Record<string, string>>): WorkflowReviewAuthentication {
  const parsed = WorkflowReviewAttestationSchema.safeParse(attestation);
  if (!parsed.success) return WorkflowReviewAuthenticationSchema.parse({ status: "invalid" });
  const signed = parsed.data;
  const digests = workflowReviewDigests(inventory, candidate, materials);
  if (signed.inventorySha256 !== digests.inventorySha256 || signed.candidateSha256 !== digests.candidateSha256
    || signed.candidateSetSha256 !== digests.candidateSetSha256 || signed.charterManifestSha256 !== digests.charterManifestSha256) {
    return { status: "invalid", keyId: signed.keyId };
  }
  const trusted = Object.hasOwn(trustedPublicKeys, signed.keyId) ? trustedPublicKeys[signed.keyId] : undefined;
  if (!trusted) return { status: "untrusted", keyId: signed.keyId };
  try {
    const key = createPublicKey(trusted);
    if (key.asymmetricKeyType !== "ed25519") return { status: "invalid", keyId: signed.keyId };
    const valid = verify(null, statement(digests, signed.keyId), key, Buffer.from(signed.signature, "base64"));
    return valid ? { status: "verified", keyId: signed.keyId, candidateSha256: digests.candidateSha256,
      candidateSetSha256: digests.candidateSetSha256, charterManifestSha256: digests.charterManifestSha256 }
      : { status: "invalid", keyId: signed.keyId };
  } catch {
    return { status: "invalid", keyId: signed.keyId };
  }
}
