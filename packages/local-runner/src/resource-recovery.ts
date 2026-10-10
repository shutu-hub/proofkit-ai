import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  IntegrationCleanupArtifactSchema, IntegrationResourceJournalSchema, ResourceRecoveryInspectionSchema,
  ResourceRecoveryResultSchema, RunEventSchema, RunSummarySchema,
  type EvidenceRef, type IntegrationResourceJournal, type ProofkitConfig,
  type ResourceRecoveryInspection, type ResourceRecoveryResult, type RunSummary,
} from "@proofkit/contracts";
import { atomicWriteJson, createRunId, EvidenceStore, LocalExecutionOwnership, sha256 } from "@proofkit/evidence";
import { resolveWithinWorkspace, sameProjectPath } from "@proofkit/project";
import { IntegrationLifecycle, type ProjectIntegration } from "@proofkit/runner";
import { hasCompleteCleanupEvidence } from "./cleanup-evidence.js";
import { materializedRunArtifact } from "./run-evidence.js";

type Options = {
  projectRoot: string; workspaceRoot: string; evidenceDir: string;
  config: ProofkitConfig; integration?: ProjectIntegration; allowWrites: boolean;
};
type Registration = { journal: IntegrationResourceJournal; digest: string; summary: RunSummary };
const validId = (id: string) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
};

/** Recovery is a separate cleanup operation; it never executes a Charter or updates its verdict. */
export class ResourceRecoveryService {
  private readonly ownership: LocalExecutionOwnership;
  constructor(private readonly options: Options) {
    this.ownership = new LocalExecutionOwnership(options.evidenceDir, "run");
  }

  async inspect(runId: string): Promise<ResourceRecoveryInspection> {
    validId(runId);
    const active = await this.ownership.isActive(runId);
    const inspection: ResourceRecoveryInspection = {
      runId, status: active ? "active" : "unverified", testVerdict: "not-asserted", resources: [], issues: [],
    };
    try {
      const registration = await this.loadRegistration(runId);
      inspection.resources = registration.journal.resources;
      const latest = await this.loadLatest(runId, registration);
      if (latest) inspection.latestRecovery = latest;
      if (active) inspection.issues.push("A live or unverifiable owner holds this Run; recovery is unavailable.");
      else if (latest?.status === "verified" || await this.originalCleanupVerified(registration)) inspection.status = "cleaned";
      else if (registration.journal.resources.length === 0) inspection.status = "not-required";
      else {
        this.assertRecoveryPolicy(registration.journal);
        inspection.status = "recoverable";
      }
    } catch (error) {
      inspection.issues.push(error instanceof Error ? error.message.slice(0, 256) : "Resource evidence could not be verified.");
    }
    return ResourceRecoveryInspectionSchema.parse(inspection);
  }

  async recover(runId: string): Promise<ResourceRecoveryResult> {
    validId(runId);
    const lease = await this.ownership.acquire(runId);
    if (!lease) throw new Error("Run is active; recovery cannot clean resources owned by another execution.");
    let lifecycle: IntegrationLifecycle | undefined;
    try {
      // Validate after ownership acquisition so concurrent executions cannot pass a stale check.
      const registration = await this.loadRegistration(runId);
      this.assertRecoveryPolicy(registration.journal);
      const latest = await this.loadLatest(runId, registration);
      if (latest?.status === "verified") return latest;
      if (await this.originalCleanupVerified(registration)) throw new Error("Original Run already has verified cleanup evidence.");
      if (registration.journal.resources.length === 0) throw new Error("No registered resources require recovery.");
      const attemptId = createRunId();
      const recoveryRoot = this.recoveryRoot(runId);
      const store = new EvidenceStore(recoveryRoot);
      const startedAt = new Date().toISOString();
      lifecycle = IntegrationLifecycle.forRecovery(attemptId, store, registration.journal.resources,
        ({ signal }) => this.options.integration!.recover!({
          runId, signal, projectRoot: this.options.projectRoot, workspaceRoot: this.options.workspaceRoot,
          environment: registration.journal.environment, resources: registration.journal.resources,
        }), Math.min(registration.journal.cleanupTimeoutMs, this.options.integration!.setupPolicy!.cleanupTimeoutMs));
      const cleanup = await lifecycle.finish();
      const evidence = cleanup.artifact ? [this.ref(attemptId, cleanup.artifact, recoveryRoot, cleanup.sha256)] : [];
      const result = ResourceRecoveryResultSchema.parse({
        attemptId, runId, projectRoot: this.options.projectRoot, workspaceRoot: this.options.workspaceRoot,
        journalSha256: registration.digest, startedAt, endedAt: new Date().toISOString(),
        status: hasCompleteCleanupEvidence(cleanup, attemptId, evidence, recoveryRoot) ? "verified" : "unverified",
        testVerdict: "not-asserted", cleanup, evidence,
      });
      const resultPath = resolve(recoveryRoot, attemptId, "result.json");
      await atomicWriteJson(resultPath, result);
      await atomicWriteJson(resolve(recoveryRoot, "latest.json"), { attemptId, sha256: sha256(await readFile(resultPath)) });
      return result;
    } finally {
      // An abort signal cannot forcibly stop trusted JavaScript. Keep ownership until it actually settles.
      if (lifecycle?.hasPendingCleanup) void lifecycle.whenCleanupSettles().then(() => lease.release()).catch(() => {});
      else await lease.release();
    }
  }

  private async loadRegistration(runId: string): Promise<Registration> {
    const journalPath = this.runFile(runId, `${runId}/artifacts/integration-setup.json`);
    const bytes = await boundedRead(journalPath, 2 * 1024 * 1024);
    const parsed = IntegrationResourceJournalSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) throw new Error("Resource journal is invalid or uses an unsupported legacy format.");
    const journal = parsed.data;
    const summary = RunSummarySchema.parse(JSON.parse((await boundedRead(this.runFile(runId, `${runId}/run.json`), 8 * 1024 * 1024)).toString("utf8")));
    for (const record of [journal, summary]) {
      if (record.runId !== runId || !record.projectRoot || !record.workspaceRoot
        || !sameProjectPath(record.projectRoot, this.options.projectRoot) || !sameProjectPath(record.workspaceRoot, this.options.workspaceRoot)) {
        throw new Error("Resource journal and Run must belong to this project and workspace.");
      }
    }
    if (journal.environment !== this.options.config.policies.environment) throw new Error("Resource journal environment differs from the current workspace.");
    if (Date.parse(journal.registeredAt) < Date.parse(summary.startedAt) || Date.parse(journal.registeredAt) > Date.now()) {
      throw new Error("Resource registration time does not belong to this Run.");
    }
    const digest = sha256(bytes);
    await verifyRegistrationEvents(this.runFile(runId, `${runId}/events.jsonl`), journal, digest);
    return { journal, digest, summary };
  }

  private assertRecoveryPolicy(journal: IntegrationResourceJournal): void {
    const integration = this.options.integration;
    if (!integration?.recover || !integration.version || integration.name !== journal.integration?.name || integration.version !== journal.integration?.version) {
      throw new Error("Recovery requires the original connector name, explicit version and recovery hook.");
    }
    if (!this.options.allowWrites || this.options.config.policies.sideEffects !== "allow") {
      throw new Error("Resource recovery requires operator write permission and policies.sideEffects=allow.");
    }
    if (integration.setupPolicy?.sideEffect !== "write" || !integration.setupPolicy.environments.includes(journal.environment)) {
      throw new Error("Connector recovery requires a write setup policy allowing the registered environment.");
    }
  }

  private async originalCleanupVerified({ journal, summary }: Registration): Promise<boolean> {
    const cleanup = summary.integrationCleanup;
    if (cleanup?.status !== "verified" || !cleanup.artifact) return false;
    if (!hasCompleteCleanupEvidence(cleanup, journal.runId,
      [this.ref(journal.runId, cleanup.artifact, this.options.evidenceDir, cleanup.sha256)], this.options.evidenceDir)) return false;
    const proof = IntegrationCleanupArtifactSchema.parse(JSON.parse((await boundedRead(
      this.runFile(journal.runId, cleanup.artifact), 16 * 1024 * 1024)).toString("utf8")));
    return JSON.stringify(proof.resources) === JSON.stringify(journal.resources);
  }

  private async loadLatest(runId: string, registration: Registration): Promise<ResourceRecoveryResult | undefined> {
    const root = this.recoveryRoot(runId);
    let bytes: Buffer;
    try { bytes = await boundedRead(this.unredirectedRecoveryPath(resolve(root, "latest.json")), 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const pointer = JSON.parse(bytes.toString("utf8")) as { attemptId: string; sha256: string };
    if (!pointer || typeof pointer !== "object" || typeof pointer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
      throw new Error("Recovery pointer is invalid.");
    }
    validId(pointer.attemptId);
    const resultPath = materializedRunArtifact(this.ref(pointer.attemptId, `${pointer.attemptId}/result.json`, root),
      pointer.attemptId, `${pointer.attemptId}/result.json`, root);
    if (!resultPath) throw new Error("Recovery result evidence is missing or redirected.");
    const saved = await boundedRead(resultPath, 2 * 1024 * 1024);
    if (sha256(saved) !== pointer.sha256) throw new Error("Recovery result digest does not match its saved pointer.");
    const result = ResourceRecoveryResultSchema.parse(JSON.parse(saved.toString("utf8")));
    if (result.runId !== runId || result.attemptId !== pointer.attemptId || result.journalSha256 !== registration.digest
      || !sameProjectPath(result.projectRoot, this.options.projectRoot) || !sameProjectPath(result.workspaceRoot, this.options.workspaceRoot)
      || Date.parse(result.startedAt) < Date.parse(registration.journal.registeredAt)
      || Date.parse(result.endedAt) < Date.parse(result.startedAt) || Date.parse(result.endedAt) > Date.now()) {
      throw new Error("Recovery result does not match the original resource registration.");
    }
    if (result.status === "verified") {
      if (result.cleanup.status !== "verified" || !hasCompleteCleanupEvidence(result.cleanup, result.attemptId, result.evidence, root)) {
        throw new Error("Recovery cleanup proof is missing, changed or incomplete.");
      }
      const artifact = result.evidence.find((ref) => ref.evidenceId === `${result.attemptId}:${result.cleanup.artifact}`)!;
      const proof = IntegrationCleanupArtifactSchema.parse(JSON.parse((await boundedRead(artifact.path, 16 * 1024 * 1024)).toString("utf8")));
      if (JSON.stringify(proof.resources) !== JSON.stringify(registration.journal.resources)
        || Date.parse(proof.startedAt) < Date.parse(result.startedAt) || Date.parse(proof.endedAt) > Date.parse(result.endedAt)) {
        throw new Error("Recovery cleanup proof covers different resources or a different attempt window.");
      }
    }
    return result;
  }

  private recoveryRoot(runId: string): string {
    return this.unredirectedRecoveryPath(resolve(this.options.workspaceRoot, ".proofkit/recoveries", runId));
  }

  private unredirectedRecoveryPath(expected: string): string {
    const canonical = resolveWithinWorkspace(this.options.workspaceRoot, expected);
    const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    if (identity(expected) !== identity(canonical)) throw new Error("Recovery evidence must not be redirected.");
    return canonical;
  }

  private ref(runId: string, path: string, root: string, digest?: string): EvidenceRef {
    return { evidenceId: `${runId}:${path}`, kind: "runtime", path: resolve(root, path), sha256: digest, capturedAt: new Date().toISOString() };
  }

  private runFile(runId: string, path: string): string {
    const artifact = materializedRunArtifact(this.ref(runId, path, this.options.evidenceDir), runId, path, this.options.evidenceDir);
    if (!artifact) throw new Error("Run resource evidence is missing, empty or redirected; automatic recovery is unavailable.");
    return artifact;
  }
}

/** Stop at the matching registration, with bounded reads even if the log grows or lacks newlines. */
async function verifyRegistrationEvents(path: string, journal: IntegrationResourceJournal, digest: string): Promise<void> {
  const maximum = 16 * 1024 * 1024, lineMaximum = 256 * 1024;
  const file = await open(path, "r");
  let offset = 0, pending = Buffer.alloc(0), started = false;
  try {
    while (offset < maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > lineMaximum) throw new Error("Run provenance event exceeds its size limit.");
        const event = RunEventSchema.parse(JSON.parse(pending.subarray(0, newline).toString("utf8")));
        pending = pending.subarray(newline + 1);
        if (!started) {
          const provenance = event.payload.integration as { name?: unknown; version?: unknown } | undefined;
          if (event.runId !== journal.runId || event.type !== "run.started" || !journal.integration
            || provenance?.name !== journal.integration.name || provenance?.version !== journal.integration.version) {
            throw new Error("Resource connector identity differs from the original Run provenance.");
          }
          started = true;
        }
        if (event.runId !== journal.runId) throw new Error("Run provenance contains another Run's events.");
        if (event.type === "artifact.created" && event.payload.path === `${journal.runId}/artifacts/integration-setup.json`
          && event.payload.sha256 === digest) return;
      }
      if (pending.length > lineMaximum) throw new Error("Run provenance event exceeds its size limit.");
    }
    throw new Error("Resource journal lacks its matching registration digest within the Run's 16 MiB provenance limit.");
  } finally { await file.close(); }
}

async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error("Resource evidence must be a bounded, non-empty regular file.");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error("Resource evidence exceeds its size limit.");
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
