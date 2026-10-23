import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { RunSummarySchema, TestCharterSchema } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { LocalRunnerService } from "./index.js";

let scratch: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });

it("requires explicit approval and preserves source linkage for a selector replan", async () => {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-replan-approval-"));
  const root = join(scratch, "source");
  const workspaceRoot = join(scratch, "workspace");
  const evidenceDir = join(workspaceRoot, ".proofkit", "runs");
  await Promise.all([mkdir(root), mkdir(evidenceDir, { recursive: true })]);
  await writeFile(join(root, "package.json"), "{}", "utf8");
  const charter = TestCharterSchema.parse({ intent: "repair selector", level: "quick", mode: "deterministic", preconditions: [],
    actions: [{ kind: "click", selector: "#removed" }, { kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "allow", metadata: {} });
  const store = new EvidenceStore(evidenceDir);
  const summary = RunSummarySchema.parse({ runId: "source-replan", execution: { adapter: "web" }, projectRoot: root, workspaceRoot,
    startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z", status: "completed", verdict: "inconclusive", charter,
    steps: [{ stepId: "step-001", action: charter.actions[0], status: "failed", failureCode: "surface-selector-drift", artifacts: [] }],
    assertions: [], oracles: [], artifacts: [], findings: [] });
  await store.startRun(summary);
  const proposal = { schemaVersion: 1 as const, status: "needs-approval" as const, requiresApproval: true as const,
    reason: "surface-selector-drift" as const, sourceStepId: "step-001", originalSelector: "#removed",
    observedAt: new Date().toISOString(), observedUrl: "http://fixture", candidates: [{ selector: "#new", role: "button", name: "Save" }],
    next: "inspect_surface" as const, message: "Review before execution" };
  const proposalPath = await store.writeJson(summary.runId, "step-001-replan-proposal", proposal);
  summary.steps[0]!.artifacts = [proposalPath]; summary.artifacts = [proposalPath];
  await store.writeSummary(summary); await store.writeReport(summary);

  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), url: "http://fixture", text: "Ready", controls: [], metadata: {} });
  vi.spyOn(WebAdapter.prototype, "discover").mockResolvedValue({ capturedAt: new Date().toISOString(), url: "http://fixture", text: "Ready", controls: [], metadata: {} });
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "act").mockImplementation(async (action) => ({ actionId: "approved", kind: action.kind, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, metadata: {} }));
  vi.spyOn(WebAdapter.prototype, "capture").mockResolvedValue(undefined);
  vi.spyOn(WebAdapter.prototype, "assert").mockResolvedValue({ assertion: { kind: "text-visible", text: "Ready" }, passed: true, message: "Ready", evidence: [] });
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();

  const service = new LocalRunnerService({ root, workspaceRoot });
  const pending = await service.approveSurfaceReplan({ runId: "source-replan", stepId: "step-001", selector: "#new" });
  expect(pending.status).toBe("awaiting-approval");
  await expect(service.approveSurfaceReplan({ runId: "source-replan", stepId: "step-001", selector: "#other", approve: true })).rejects.toThrow("observed proposal candidates");
  const approved = await service.approveSurfaceReplan({ runId: "source-replan", stepId: "step-001", selector: "#new", approve: true });
  expect(approved.status).toBe("approved");
  expect(approved.charter?.metadata).toMatchObject({ replanOfRunId: "source-replan", replanApprovedSelector: "#new" });
  const result = await service.wait(approved.run!.runId);
  expect(result.execution).toMatchObject({ adapter: "web", replayOfRunId: "source-replan" });
  expect(result.charter.actions[0]).toEqual({ kind: "click", selector: "#new" });
  const stability = await service.analyzeSurfaceReplanStability("source-replan", [approved.run!.runId]);
  expect(stability).toMatchObject({ status: "uniform-pass", total: 1, passed: 1, failed: 0, inconclusive: 0, approvedSelectors: ["#new"] });
});
