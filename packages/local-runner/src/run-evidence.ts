import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { EvidenceRefSchema, RunEventSchema, type EvidenceRef, type RunSummary } from "@proofkit/contracts";

const MAX_PROVENANCE_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

type ArtifactDigest = { sha256: string; bytes: number };

/** Resolve only an existing, non-empty file belonging to this Run. A supplied digest is checked against its current bytes. */
export function materializedRunArtifact(ref: EvidenceRef, runId: string, path: string, evidenceDir: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId) || !path.startsWith(`${runId}/`)
    || path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return;
  const root = resolve(evidenceDir);
  const target = resolve(root, path);
  const within = relative(root, target);
  if (!within || outside(within) || resolve(ref.path) !== target) return;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalRun = realpathSync(resolve(root, runId));
    const actual = realpathSync(target);
    const stat = statSync(actual);
    if (!relative(resolve(canonicalRoot, runId), canonicalRun)
      && !outside(relative(canonicalRun, actual)) && stat.isFile() && stat.size > 0
      && (!ref.sha256 || hashFile(actual).sha256 === ref.sha256.toLowerCase())) return actual;
  } catch { /* Missing, redirected or changed evidence cannot establish a fact. */ }
}

/** Capture Run-owned evidence using artifact digests written when each artifact was created. */
export function captureRunEvidence(summary: RunSummary, evidenceDir: string): EvidenceRef[] {
  const runId = summary.runId;
  const provenance = artifactDigests(runId, evidenceDir);
  const paths = new Set([`${runId}/run.json`, `${runId}/report.html`, `${runId}/events.jsonl`, ...summary.artifacts]);
  const oracleReports = new Set(summary.oracles.map((oracle) => oracle.evidence.at(-1)));
  const oracleSourceArtifacts = new Set(summary.oracles.filter((oracle) => oracle.verificationKind !== "http-contract")
    .flatMap((oracle) => oracle.sourceEvidenceArtifacts ?? []));
  const httpContractArtifacts = new Set(summary.oracles.filter((oracle) => oracle.verificationKind === "http-contract")
    .flatMap((oracle) => oracle.sourceEvidenceArtifacts ?? []));
  const refs: EvidenceRef[] = [];
  for (const path of paths) {
    const isArtifact = summary.artifacts.includes(path);
    if (!isArtifact && path !== `${runId}/run.json` && path !== `${runId}/report.html` && path !== `${runId}/events.jsonl`) continue;
    if (isArtifact && !provenance?.has(path)) continue;
    const target = resolve(evidenceDir, path);
    const base = { evidenceId: `${runId}:${path}`, kind: "other" as const, path: target, capturedAt: summary.endedAt ?? summary.startedAt };
    const actual = materializedRunArtifact(base, runId, path, evidenceDir);
    if (!actual) continue;
    let digest: ArtifactDigest;
    try { digest = hashFile(actual); } catch { continue; }
    const created = isArtifact ? provenance?.get(path) : undefined;
    if (isArtifact && (!created || created.sha256 !== digest.sha256 || created.bytes !== digest.bytes)) continue;
    refs.push(EvidenceRefSchema.parse({
      ...base,
      kind: path.endsWith("events.jsonl") ? "network" : path.endsWith(".png") ? "screenshot" : path.endsWith(".webm") ? "video" : oracleSourceArtifacts.has(path) ? "business"
        : httpContractArtifacts.has(path) ? "other"
        : path.endsWith("report.html") || oracleReports.has(path) ? "report"
          : path.endsWith("runtime-findings.json") || path.endsWith("integration-cleanup.json") || path.endsWith("integration-setup.json") ? "runtime" : path.includes("/artifacts/target-binding") ? "process" : "snapshot",
      sha256: digest.sha256,
      description: `Evidence captured by run ${runId}`,
    }));
  }
  return refs;
}

function artifactDigests(runId: string, evidenceDir: string): Map<string, ArtifactDigest> | undefined {
  try {
    const path = resolve(evidenceDir, runId, "events.jsonl");
    const ref: EvidenceRef = { evidenceId: `${runId}:events`, kind: "network", path, capturedAt: "" };
    const actual = materializedRunArtifact(ref, runId, `${runId}/events.jsonl`, evidenceDir);
    if (!actual) return;
    const size = statSync(actual).size;
    if (size > MAX_PROVENANCE_BYTES) return;
    const bytes = readBoundedFile(actual, MAX_PROVENANCE_BYTES);
    const digests = new Map<string, ArtifactDigest>();
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) return;
      const event = RunEventSchema.parse(JSON.parse(line));
      if (event.runId !== runId) return;
      if (event.type !== "artifact.created") continue;
      const { path: artifact, bytes: length, sha256 } = event.payload;
      // Connector lifecycle signals share this event name but do not attest bytes.
      if (length === undefined && sha256 === undefined) continue;
      if (typeof artifact !== "string" || !artifact.startsWith(`${runId}/`)
        || artifact === `${runId}/run.json` || artifact === `${runId}/report.html` || artifact === `${runId}/events.jsonl`
        || artifact.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
        || typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0
        || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return;
      digests.set(artifact, { bytes: length, sha256: sha256.toLowerCase() });
    }
    return digests;
  } catch { return; }
}

function hashFile(path: string): ArtifactDigest {
  const digest = createHash("sha256");
  const file = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const length = readSync(file, chunk, 0, chunk.length, null);
      if (!length) break;
      digest.update(chunk.subarray(0, length));
      bytes += length;
      if (bytes > MAX_EVIDENCE_BYTES) throw new Error("Run evidence exceeds its hash limit");
    }
  } finally { closeSync(file); }
  return { sha256: digest.digest("hex"), bytes };
}

function readBoundedFile(path: string, maximum: number): Buffer {
  const file = openSync(path, "r");
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let length = 0;
  try {
    while (length <= maximum) {
      const read = readSync(file, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
  } finally { closeSync(file); }
  if (length > maximum) throw new Error("Run provenance exceeds its size limit");
  return bytes.subarray(0, length);
}

function outside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}
