import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IntegrationSetupPolicySchema, RunSummarySchema, TestCharterSchema, type IntegrationCleanup, type ProofkitConfig, type TestCharter, type RunSummary } from "@proofkit/contracts";
import { createRunId, EvidenceStore, LocalExecutionOwnership, sha256, type LocalExecutionLease } from "@proofkit/evidence";
import { IntegrationLifecycle, releaseLateIntegration, type IntegrationSetupHandle, type ProjectIntegration } from "@proofkit/runner";

export type SessionResourcePreparation = {
  runId: string;
  sessionId: string;
  registrationSha256: string;
  close(): Promise<IntegrationCleanup>;
};

export async function prepareSessionResources(input: {
  sessionId: string;
  projectRoot: string;
  workspaceRoot: string;
  evidenceDir: string;
  config: ProofkitConfig;
  integration: ProjectIntegration;
  charter: TestCharter;
  signal?: AbortSignal;
}): Promise<SessionResourcePreparation> {
  const policy = IntegrationSetupPolicySchema.parse(input.integration.setupPolicy);
  if (policy.sideEffect !== "write" || !policy.environments.includes(input.config.policies.environment) || !input.integration.setup
    || typeof input.integration.setup !== "function" || !input.integration.recover || !input.integration.version) {
    throw new Error("Session preparation requires one versioned write setup and recovery hook in the reviewed test environment");
  }
  const charter = TestCharterSchema.parse(input.charter);
  if (charter.sideEffectPolicy !== "allow" || !charter.surfaces?.includes("web")) {
    throw new Error("Session preparation requires a Web Charter with explicit write permission");
  }
  const runId = createRunId();
  const lease = await new LocalExecutionOwnership(input.evidenceDir, "run").acquire(runId);
  if (!lease) throw new Error("Preparation Run is already owned");
  const store = new EvidenceStore(input.evidenceDir);
  const startedAt = new Date().toISOString();
  const summary: RunSummary = RunSummarySchema.parse({ runId, projectRoot: input.projectRoot, workspaceRoot: input.workspaceRoot,
    execution: { adapter: "web", kind: "session-resource-preparation", sessionId: input.sessionId },
    startedAt, status: "running", charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
  const lifecycle = new IntegrationLifecycle(runId, store, { projectRoot: input.projectRoot, workspaceRoot: input.workspaceRoot,
    integration: { name: input.integration.name, version: input.integration.version }, environment: input.config.policies.environment });
  lifecycle.begin(policy);
  let registered: IntegrationSetupHandle | undefined;
  let registrationSha256: string | undefined;
  let registrationOpen = true;
  let closePromise: Promise<IntegrationCleanup> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      registrationOpen = false;
      try {
        const cleanup = await lifecycle.finish();
        summary.integrationCleanup = cleanup;
        if (cleanup.artifact) summary.artifacts.push(cleanup.artifact);
        summary.status = "completed"; summary.verdict = "inconclusive"; summary.endedAt = new Date().toISOString();
        await store.appendEvent({ runId, timestamp: summary.endedAt, type: "run.completed", payload: { verdict: "inconclusive", purpose: "session-resource-preparation" } });
        const eventLog = await store.pinEventLog(runId);
        summary.eventLog = eventLog;
        await store.writeSummary(summary);
        await store.writeReport(summary);
        await store.writeManifest(runId);
        return cleanup;
      } finally { await lease.release(); }
    })();
    return closePromise;
  };
  try {
    input.signal?.throwIfAborted();
    await store.startRun(summary);
    await store.appendEvent({ runId, timestamp: startedAt, type: "run.started", payload: {
      purpose: "session-resource-preparation", integration: { name: input.integration.name, version: input.integration.version } } });
    const deadline = AbortSignal.timeout(30_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const registration = async (handle: IntegrationSetupHandle) => {
      if (!registrationOpen || registered) throw new Error("Register the complete preparation resource handle exactly once before writing");
      signal.throwIfAborted();
      registered = handle;
      const artifact = await lifecycle.register(handle, policy);
      if (!artifact) throw new Error("Preparation resource registration did not persist");
      registrationSha256 = sha256(await readFile(resolve(input.evidenceDir, artifact)));
      summary.artifacts.push(artifact);
      await store.writeSummary(summary);
    };
    let retired = false;
    const pending = Promise.resolve().then(() => input.integration.setup!({ runId, charter, environment: input.config.policies.environment,
      projectRoot: input.projectRoot, workspaceRoot: input.workspaceRoot, signal,
      emit: (event) => store.appendEvent({ ...event, runId }), registerResources: registration }))
      .then(async (handle) => {
        registrationOpen = false;
        if (retired && handle && handle !== registered) await releaseLateIntegration(handle, runId);
        return handle;
      }, (error: unknown) => { registrationOpen = false; throw error; });
    let removeAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Preparation timed out"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    let handle: Awaited<typeof pending>;
    try { handle = await Promise.race([pending, aborted]); }
    catch (error) { retired = true; registrationOpen = false; void pending.catch(() => {}); throw error; }
    finally { removeAbort(); }
    if (!registered || !registrationSha256 || handle !== registered) {
      if (handle && handle !== registered) await releaseLateIntegration(handle, runId);
      throw new Error("Preparation must return its early-registered resource handle");
    }
    signal.throwIfAborted();
    return { runId, sessionId: input.sessionId, registrationSha256, close };
  } catch (error) {
    lifecycle.acquisitionFailed();
    await close().catch(() => {});
    throw error;
  }
}
