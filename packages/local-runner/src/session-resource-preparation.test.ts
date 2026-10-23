import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofkitConfigSchema, TestCharterSchema, type IntegrationResourceCleanup } from "@proofkit/contracts";
import type { ProjectIntegration } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";
import { prepareSessionResources } from "./session-resource-preparation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sessionId = "00000000-0000-4000-8000-000000000001";
const charter = TestCharterSchema.parse({ intent: "Prepare isolated record state for a reviewed Web task", level: "core", surfaces: ["web"],
  actions: [], assertions: [], sideEffectPolicy: "allow" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-prepared-session-")); roots.push(root);
  const projectRoot = join(root, "source"), workspaceRoot = join(root, "workspace"), evidenceDir = join(workspaceRoot, ".proofkit", "runs");
  await mkdir(projectRoot); await mkdir(workspaceRoot);
  const config = ProofkitConfigSchema.parse({ policies: { environment: "test", sideEffects: "allow" } });
  const scopes = new Set(["foreign"]);
  const cleanup = async (scope: string): Promise<IntegrationResourceCleanup[]> => {
    const existed = scopes.delete(scope);
    return [{ resourceId: "scope", status: "removed", evidence: { owner: scope, existed },
      readback: { reader: "fixture.scope-get", scope, exists: scopes.has(scope), observedAt: new Date().toISOString() } }];
  };
  const integration: ProjectIntegration = { name: "session-prep-fixture", version: "1", setupPolicy: { sideEffect: "write", environments: ["test"], cleanupTimeoutMs: 3000 },
    recover: async ({ resources }) => cleanup(resources[0]!.scope),
    setup: async ({ runId, registerResources }) => {
      const handle = { resources: [{ resourceId: "scope", kind: "isolated-scope", scope: runId, evidence: { owner: runId } }],
        cleanup: async () => cleanup(runId) };
      await registerResources!(handle);
      scopes.add(runId);
      return handle;
    } };
  const runner = new LocalRunnerService({ root: projectRoot, workspaceRoot, config, integration, allowCapabilityWrites: true });
  return { projectRoot, workspaceRoot, evidenceDir, config, integration, scopes, runner };
}

describe("session resource preparation", () => {
  it("retains one registered resource until explicit close, then verifies original cleanup", async () => {
    const state = await fixture();
    const prepared = await prepareSessionResources({ ...state, sessionId, charter });
    expect(state.scopes.has(prepared.runId)).toBe(true);
    expect(await state.runner.inspectRunResources(prepared.runId)).toMatchObject({ status: "active", testVerdict: "not-asserted" });
    await expect(state.runner.recoverRunResources(prepared.runId)).rejects.toThrow("active");
    const cleanup = await prepared.close(); expect(cleanup.status).toBe("verified");
    expect(await prepared.close()).toEqual(cleanup);
    expect(state.scopes).toEqual(new Set(["foreign"]));
    expect(await state.runner.inspectRunResources(prepared.runId)).toMatchObject({ status: "cleaned" });
    const saved = JSON.parse(await readFile(join(state.evidenceDir, prepared.runId, "run.json"), "utf8"));
    expect(saved).toMatchObject({ status: "completed", verdict: "inconclusive", execution: { kind: "session-resource-preparation", sessionId },
      integrationCleanup: { status: "verified" } });
    expect((await state.runner.verifyEvidenceManifest(prepared.runId)).status).toBe("intact");
  });

  it("rejects an unregistered setup and attempts immediate cleanup without a false preparation receipt", async () => {
    const state = await fixture();
    state.integration.setup = async ({ runId }) => {
      state.scopes.add(runId);
      return { resources: [{ resourceId: "scope", kind: "isolated-scope", scope: runId, evidence: { owner: runId } }],
        cleanup: async () => [{ resourceId: "scope", status: "removed", evidence: {},
          readback: { reader: "fixture.scope-get", scope: runId, exists: (state.scopes.delete(runId), false), observedAt: new Date().toISOString() } }] };
    };
    await expect(prepareSessionResources({ ...state, sessionId, charter })).rejects.toThrow("early-registered");
    expect(state.scopes).toEqual(new Set(["foreign"]));
  });

  it("cleans the registered scope when the caller aborts before setup returns", async () => {
    const state = await fixture(); const controller = new AbortController();
    let entered!: (runId: string) => void;
    const registered = new Promise<string>((resolve) => { entered = resolve; });
    state.integration.setup = async ({ runId, registerResources }) => {
      const handle = { resources: [{ resourceId: "scope", kind: "isolated-scope", scope: runId, evidence: { owner: runId } }],
        cleanup: async () => {
          expect(state.scopes.delete(runId)).toBe(true);
          return [{ resourceId: "scope", status: "removed" as const, evidence: { owner: runId },
            readback: { reader: "fixture.scope-get", scope: runId, exists: state.scopes.has(runId), observedAt: new Date().toISOString() } }];
        } };
      await registerResources!(handle);
      state.scopes.add(runId); entered(runId);
      await new Promise(() => {});
      return handle;
    };
    const pending = prepareSessionResources({ ...state, sessionId, charter, signal: controller.signal });
    const runId = await registered;
    controller.abort(new Error("Caller stopped the preparation"));
    await expect(pending).rejects.toThrow("Caller stopped the preparation");
    expect(state.scopes).toEqual(new Set(["foreign"]));
    expect(await state.runner.inspectRunResources(runId)).toMatchObject({ status: "recoverable" });
    const recovered = await state.runner.recoverRunResources(runId);
    expect(recovered).toMatchObject({ status: "verified", testVerdict: "not-asserted" });
    expect(await state.runner.inspectRunResources(runId)).toMatchObject({ status: "cleaned" });
  });
});
