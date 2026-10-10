import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema, type IntegrationResourceCleanup } from "@proofkit/contracts";
import { EvidenceStore, LocalExecutionOwnership, sha256 } from "@proofkit/evidence";
import { ExecutionRunner, type ProjectIntegration, type SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const charter = TestCharterSchema.parse({ intent: "verify scoped resources", level: "quick", actions: [],
  assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "allow" });
const surface: SurfaceAdapter = {
  name: "fixture", connect: async () => {}, close: async () => {}, subscribeEvents: async () => () => {},
  discover: async () => ({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} }),
  snapshot: async () => ({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} }),
  act: async () => { throw new Error("Recovery must not perform surface actions"); },
  assert: async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }), capture: async () => undefined,
};

async function fixture(cleanupTimeoutMs = 1000, cleaned = false) {
  const base = await mkdtemp(join(tmpdir(), "proofkit-resource-recovery-")); roots.push(base);
  const root = join(base, "source"), workspaceRoot = join(base, "workspace"), evidenceDir = join(workspaceRoot, ".proofkit/runs");
  await mkdir(root); await writeFile(join(root, "package.json"), '{"name":"unchanged-source"}');
  const records = new Set<string>();
  const removed = (scope: string): IntegrationResourceCleanup[] => [{ resourceId: "tenant", status: "removed", evidence: { statusCode: 404 },
    readback: { reader: "fixture.get", scope, exists: records.has(scope), observedAt: new Date().toISOString() } }];
  const recover = vi.fn(async ({ resources }: Parameters<NonNullable<ProjectIntegration["recover"]>>[0]) => {
    records.delete(resources[0]!.scope); return removed(resources[0]!.scope);
  });
  const integration: ProjectIntegration = {
    name: "scoped-fixture", version: "1.0.0", recover,
    setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs },
    setup: async ({ runId }) => {
      records.add(runId);
      return { resources: [{ resourceId: "tenant", kind: "test-tenant", scope: runId, evidence: { owner: runId } }],
        cleanup: async () => {
          if (cleaned) { records.delete(runId); return removed(runId); }
          return [{ resourceId: "tenant", status: "retained", evidence: {},
            readback: { reader: "fixture.get", scope: runId, exists: true, observedAt: new Date().toISOString() } }];
        } };
    },
  };
  const config = ProofkitConfigSchema.parse({ project: { root }, policies: { environment: "test", sideEffects: "allow" } });
  const runner = new LocalRunnerService({ root, workspaceRoot, config, integration, allowCapabilityWrites: true });
  const summary = await new ExecutionRunner(surface, { projectRoot: root, workspaceRoot, evidenceDir, integration,
    setup: integration.setup, setupPolicy: integration.setupPolicy, allowSetupWrites: true }).run(charter, "original-run");
  const service = (overrides: Record<string, unknown> = {}) => new LocalRunnerService({ root, workspaceRoot, config, integration, allowCapabilityWrites: true, ...overrides });
  const journalPath = join(evidenceDir, summary.runId, "artifacts/integration-setup.json");
  return { root, workspaceRoot, evidenceDir, config, integration, recover, records, runner, summary, service, removed, journalPath };
}

describe("registered integration resource recovery", () => {
  it("saves independent cleanup proof, preserves original evidence and reuses verified recovery", async () => {
    const f = await fixture();
    const original = await readFile(join(f.evidenceDir, f.summary.runId, "run.json"));
    const events = await readFile(join(f.evidenceDir, f.summary.runId, "events.jsonl"));
    expect(f.summary.verdict).toBe("blocked");
    expect(await f.runner.inspectRunResources(f.summary.runId)).toMatchObject({ status: "recoverable", testVerdict: "not-asserted" });
    const result = await f.runner.recoverRunResources(f.summary.runId);
    expect(result).toMatchObject({ runId: f.summary.runId, status: "verified", testVerdict: "not-asserted", cleanup: { verifiedResources: 1 } });
    expect(f.records.size).toBe(0);
    expect(f.recover.mock.calls[0]![0]).toMatchObject({ runId: f.summary.runId, projectRoot: f.root, workspaceRoot: f.workspaceRoot,
      environment: "test", resources: [{ resourceId: "tenant", scope: f.summary.runId }] });
    const proof = JSON.parse(await readFile(result.evidence[0]!.path, "utf8"));
    expect(proof.runId).toBe(result.attemptId);
    expect(sha256(await readFile(result.evidence[0]!.path))).toBe(result.cleanup.sha256);
    expect(await f.service({ allowCapabilityWrites: false }).inspectRunResources(f.summary.runId)).toMatchObject({ status: "cleaned", latestRecovery: { attemptId: result.attemptId } });
    expect(await f.runner.recoverRunResources(f.summary.runId)).toEqual(result);
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.evidenceDir, f.summary.runId, "run.json"))).toEqual(original);
    expect(await readFile(join(f.evidenceDir, f.summary.runId, "events.jsonl"))).toEqual(events);
    expect(await readdir(f.root)).toEqual(["package.json"]);
  });

  it("refuses a live owner before invoking a connector", async () => {
    const f = await fixture();
    const lease = await new LocalExecutionOwnership(f.evidenceDir, "run").acquire(f.summary.runId);
    try {
      expect(await f.runner.inspectRunResources(f.summary.runId)).toMatchObject({ status: "active" });
      await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow("active");
      expect(f.recover).not.toHaveBeenCalled(); expect(f.records.size).toBe(1);
    } finally { await lease!.release(); }
  });

  it("excludes concurrent recoveries and retains ownership after a cleanup timeout", async () => {
    const f = await fixture(100);
    let finish!: (value: IntegrationResourceCleanup[]) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.recover.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
    const recovering = f.runner.recoverRunResources(f.summary.runId);
    await started;
    await expect(f.service().recoverRunResources(f.summary.runId)).rejects.toThrow("active");
    const result = await recovering;
    expect(result.status).toBe("unverified");
    expect(await f.runner.inspectRunResources(f.summary.runId)).toMatchObject({ status: "active" });
    await expect(f.service().recoverRunResources(f.summary.runId)).rejects.toThrow("active");
    finish(f.removed(f.summary.runId));
    await vi.waitFor(async () => { expect(await new LocalExecutionOwnership(f.evidenceDir, "run").isActive(f.summary.runId)).toBe(false); });
    expect((await f.runner.recoverRunResources(f.summary.runId)).status).toBe("verified");
    const saved = JSON.parse(await readFile(join(f.workspaceRoot, ".proofkit/recoveries", f.summary.runId, result.attemptId, "result.json"), "utf8"));
    expect(saved.status).toBe("unverified");
  });

  it.each(["operator", "side-effects", "version", "name", "hook", "policy"])("blocks recovery without matching %s authorization", async (kind) => {
    const f = await fixture();
    const options = kind === "operator" ? { allowCapabilityWrites: false }
      : kind === "side-effects" ? { config: { ...f.config, policies: { ...f.config.policies, sideEffects: "deny" } } }
      : { integration: { ...f.integration, ...(kind === "version" ? { version: "2.0.0" } : kind === "name" ? { name: "foreign" }
        : kind === "hook" ? { recover: undefined } : { setupPolicy: { ...f.integration.setupPolicy, environments: ["local"] } }) } };
    const service = f.service(options);
    expect((await service.inspectRunResources(f.summary.runId)).status).toBe("unverified");
    await expect(service.recoverRunResources(f.summary.runId)).rejects.toThrow();
    expect(f.recover).not.toHaveBeenCalled();
  });

  it("keeps ownership when evidence persistence fails while cleanup is still running", async () => {
    const f = await fixture(100);
    let finish!: (value: IntegrationResourceCleanup[]) => void;
    f.recover.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(EvidenceStore.prototype, "writeJson").mockRejectedValueOnce(new Error("Evidence disk unavailable"));
    try {
      await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow("disk unavailable");
      expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("active");
      await expect(f.service().recoverRunResources(f.summary.runId)).rejects.toThrow("active");
      expect(f.recover).toHaveBeenCalledTimes(1);
    } finally { finish(f.removed(f.summary.runId)); }
    await vi.waitFor(async () => { expect(await new LocalExecutionOwnership(f.evidenceDir, "run").isActive(f.summary.runId)).toBe(false); });
  });

  it("finds setup provenance after a large log prefix without reading a malformed tail", async () => {
    const f = await fixture();
    const path = join(f.evidenceDir, f.summary.runId, "events.jsonl");
    const events = (await readFile(path, "utf8")).trim().split("\n");
    const progress = JSON.stringify({ runId: f.summary.runId, timestamp: new Date().toISOString(), type: "adapter.event", payload: { diagnostic: "进度".repeat(500) } }) + "\n";
    await writeFile(path, events[0] + "\n" + progress.repeat(100) + events.slice(1).join("\n") + "\nincomplete-tail");
    expect((await f.runner.recoverRunResources(f.summary.runId)).status).toBe("verified");
  });

  it.each(["cross-run", "oversized-event", "scan-limit", "missing-registration"])("rejects %s event provenance before cleanup", async (kind) => {
    const f = await fixture();
    const path = join(f.evidenceDir, f.summary.runId, "events.jsonl");
    const events = (await readFile(path, "utf8")).trim().split("\n");
    const progress = JSON.stringify({ runId: kind === "cross-run" ? "foreign-run" : f.summary.runId,
      timestamp: new Date().toISOString(), type: "adapter.event", payload: { diagnostic: "x".repeat(kind === "oversized-event" ? 256 * 1024 : 60 * 1024) } }) + "\n";
    await writeFile(path, events[0] + "\n" + (kind === "missing-registration" ? "" : progress.repeat(kind === "scan-limit" ? 274 : 1)));
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow();
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.records.size).toBe(1);
  });

  it.each(["scope", "project", "workspace", "environment", "legacy", "run-provenance"])("rejects %s registration mismatch before deletion", async (kind) => {
    const f = await fixture();
    const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
    if (kind === "scope") journal.resources[0].scope = "another-tenant";
    if (kind === "project") journal.projectRoot = f.workspaceRoot;
    if (kind === "workspace") journal.workspaceRoot = f.root;
    if (kind === "environment") journal.environment = "staging";
    if (kind === "legacy") delete journal.schemaVersion;
    if (kind === "run-provenance") journal.integration.name = "another-connector";
    await writeFile(f.journalPath, JSON.stringify(journal));
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow();
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("unverified");
    expect(f.recover).not.toHaveBeenCalled(); expect(f.records.size).toBe(1);
  });

  it.each(["wrong-scope", "stale", "retained", "ack-only"])("does not certify %s recovery readback", async (kind) => {
    const f = await fixture();
    f.recover.mockImplementationOnce(async () => {
      const observation = f.removed(f.summary.runId)[0]!;
      if (kind === "wrong-scope") observation.readback!.scope = "foreign";
      if (kind === "stale") observation.readback!.observedAt = "2000-01-01T00:00:00.000Z";
      if (kind === "ack-only") delete observation.readback;
      if (kind === "retained") observation.status = "retained";
      if (kind !== "retained" && observation.readback) observation.readback.exists = false;
      return [observation];
    });
    const result = await f.runner.recoverRunResources(f.summary.runId);
    expect(result.status).toBe("unverified"); expect(result.testVerdict).toBe("not-asserted");
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("recoverable");
  });

  it.each(["proof", "result", "journal"])("rejects modified %s after a verified recovery", async (kind) => {
    const f = await fixture();
    const result = await f.runner.recoverRunResources(f.summary.runId);
    const path = kind === "proof" ? result.evidence[0]!.path : kind === "journal" ? f.journalPath
      : join(f.workspaceRoot, ".proofkit/recoveries", f.summary.runId, result.attemptId, "result.json");
    await writeFile(path, "{}");
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("unverified");
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow();
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it("rejects a replacement proof for another resource even when its saved digests are consistent", async () => {
    const f = await fixture();
    const result = await f.runner.recoverRunResources(f.summary.runId);
    const proof = JSON.parse(await readFile(result.evidence[0]!.path, "utf8"));
    proof.resources[0].scope = "foreign"; proof.observations[0].readback.scope = "foreign";
    await writeFile(result.evidence[0]!.path, JSON.stringify(proof));
    result.cleanup.sha256 = sha256(await readFile(result.evidence[0]!.path)); result.evidence[0]!.sha256 = result.cleanup.sha256;
    const root = join(f.workspaceRoot, ".proofkit/recoveries", f.summary.runId);
    const path = join(root, result.attemptId, "result.json");
    await writeFile(path, JSON.stringify(result));
    await writeFile(join(root, "latest.json"), JSON.stringify({ attemptId: result.attemptId, sha256: sha256(await readFile(path)) }));
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("unverified");
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow("different resources");
  });

  it("recognizes original verified cleanup without invoking recovery", async () => {
    const f = await fixture(1000, true);
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("cleaned");
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow("already has verified");
    expect(f.recover).not.toHaveBeenCalled();
  });

  it.each(["pointer", "result-binding", "result-directory", "recovery-directory", "run-directory"])("rejects %s redirection or substitution", async (kind) => {
    const f = await fixture();
    const result = await f.runner.recoverRunResources(f.summary.runId);
    const root = join(f.workspaceRoot, ".proofkit/recoveries", f.summary.runId);
    const resultPath = join(root, result.attemptId, "result.json");
    if (kind === "pointer") await writeFile(join(root, "latest.json"), JSON.stringify({ attemptId: "../foreign", sha256: "0".repeat(64) }));
    else if (kind === "result-binding") {
      await writeFile(resultPath, JSON.stringify({ ...result, runId: "foreign-run" }));
      await writeFile(join(root, "latest.json"), JSON.stringify({ attemptId: result.attemptId, sha256: sha256(await readFile(resultPath)) }));
    } else {
      const foreign = join(f.workspaceRoot, `foreign-${kind}`); await mkdir(foreign);
      const target = kind === "run-directory" ? join(f.evidenceDir, f.summary.runId)
        : kind === "recovery-directory" ? root : join(root, result.attemptId);
      await rm(target, { recursive: true });
      await symlink(foreign, target, process.platform === "win32" ? "junction" : "dir");
    }
    expect((await f.runner.inspectRunResources(f.summary.runId)).status).toBe("unverified");
    await expect(f.runner.recoverRunResources(f.summary.runId)).rejects.toThrow();
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown, missing and invalid Runs unverified", async () => {
    const f = await fixture();
    expect(await f.runner.inspectRunResources("missing-run")).toMatchObject({ status: "unverified", resources: [] });
    await expect(f.runner.recoverRunResources("missing-run")).rejects.toThrow("missing");
    await expect(f.runner.recoverRunResources("../foreign")).rejects.toThrow("Invalid run id");
    expect(f.recover).not.toHaveBeenCalled();
  });
});
