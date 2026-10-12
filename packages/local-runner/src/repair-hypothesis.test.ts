import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RepairHypothesisInput, RunSummary, TestCharter } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { LocalRunnerService } from "./index.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-repair-")); roots.push(base);
  const root = join(base, "source"), workspaceRoot = join(base, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  const source = 'export const jobId = "wrong-job";\nexport const state = "done";\n';
  const path = join(root, "src", "binding.ts"); await writeFile(path, source);
  const service = new LocalRunnerService({ root, workspaceRoot });
  const charter: TestCharter = { intent: "verify resume binding", level: "core", mode: "deterministic",
    preconditions: [], actions: [], assertions: [{ kind: "text-visible", text: "Resume" }],
    oracles: ["resume-binding"], sideEffectPolicy: "deny", metadata: {} };
  const now = new Date().toISOString(), runId = "repair-run";
  const artifact = `${runId}/artifacts/oracle-1-source.json`;
  const summary: RunSummary = { runId, projectRoot: root, workspaceRoot, execution: { adapter: "web" }, startedAt: now, endedAt: now,
    status: "completed", verdict: "failed", charter, steps: [],
    assertions: [{ assertion: charter.assertions[0]!, passed: true, message: "Resume visible", evidence: [] }],
    oracles: [{ name: "resume-binding", passed: false, verificationKind: "business", message: "wrong job",
      observedAt: now, evidence: [artifact], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [artifact] }],
    artifacts: [artifact], findings: [] };
  service.start = async () => ({ runId, status: "completed", verdict: "failed", summary });
  service.wait = async () => summary; installMockRunEvidence(service);
  const mission = await service.createMission({ intent: charter.intent, surface: "web", charter });
  await service.startMission(mission.missionId, { approve: true }); await service.waitMission(mission.missionId);
  const result = await service.missionEvidence(mission.missionId);
  expect(result.testVerdict, JSON.stringify(result.summary.executionAudit)).toBe("failed");
  const finding = result.findings.find((item) => item.category === "product")!;
  const input: RepairHypothesisInput = { missionId: mission.missionId, expectedRevision: result.summary.revision,
    findingId: finding.findingId, title: "Use the current job binding", rationale: "The source selects a different job from the independently observed expected job.",
    changes: ["Resolve the job from the current resume task rather than a fixed job."], confidence: 0.7,
    evidenceIds: [finding.evidence[0]!.evidenceId],
    sourceReferences: [{ path: "src/binding.ts", sha256: sha256(source), startLine: 1, endLine: 1,
      explanation: "This declaration supplies the wrong job ID at the failed boundary." }],
    regressionCheck: "Replay the resume binding scenario and verify both job ID and terminal state." };
  return { service, input, root, workspaceRoot, path, source, result, base };
}

it("persists a source-referenced hypothesis and refreshes a compact report without editing source or verdict", async () => {
  const f = await fixture();
  const saved = await f.service.submitRepairHypothesis(f.input);
  expect(saved).toMatchObject({ revision: f.input.expectedRevision + 1, testVerdict: "not-asserted",
    suggestion: { status: "proposed", findingId: f.input.findingId, hypothesis: { origin: "host-agent", causeStatus: "hypothesis" } },
    sourceAudit: { sourceScope: "current-checkout", references: [{ status: "matching" }] } });
  const reopened = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  const evidence = await reopened.missionEvidence(f.input.missionId);
  expect(evidence).toMatchObject({ verdict: "failed", testVerdict: "failed", repairSourceAudits: [expect.objectContaining({ suggestionId: saved.suggestion.suggestionId })] });
  expect(evidence.repairSuggestions[0]).toEqual(saved.suggestion);
  expect(evidence.diagnosticSupport?.repairSuggestions[0]?.status).toBe("supported");
  const html = await readFile(evidence.report!, "utf8");
  expect(html).toContain("Next change:"); expect(html).toContain("Regression check:");
  expect(html).toContain("cause unverified"); expect(html).toContain("src/binding.ts:1–1 · matching");
  expect(await readFile(f.path, "utf8")).toBe(f.source);
  const duplicate = await reopened.submitRepairHypothesis({ ...f.input, expectedRevision: saved.revision });
  expect(duplicate.revision).toBe(saved.revision);
  expect((await reopened.missionStatus(f.input.missionId)).mission.repairSuggestions).toHaveLength(2);
});

it("marks changed source references stale without withdrawing independently intact failure evidence", async () => {
  const f = await fixture(); await f.service.submitRepairHypothesis(f.input);
  await writeFile(f.path, f.source.replace("wrong-job", "expected-job"));
  const result = await f.service.missionEvidence(f.input.missionId);
  expect(result).toMatchObject({ verdict: "failed", testVerdict: "failed",
    repairSourceAudits: [{ causeStatus: "hypothesis", references: [{ status: "changed" }] }] });
  expect(await readFile(result.report!, "utf8")).toContain("Proposal references require review");
  expect(result.repairSuggestions[0]?.status).toBe("proposed");
});

it.each(["revision", "evidence", "hash", "range", "missing", "duplicate", "escape", "verified"])("rejects an invalid %s submission without a new proposal", async (kind) => {
  const f = await fixture(), input = structuredClone(f.input);
  if (kind === "revision") input.expectedRevision -= 1;
  if (kind === "evidence") input.evidenceIds = ["another-finding-evidence"];
  if (kind === "hash") input.sourceReferences[0]!.sha256 = "a".repeat(64);
  if (kind === "range") input.sourceReferences[0]!.endLine = 3;
  if (kind === "missing") input.sourceReferences[0]!.path = "src/missing.ts";
  if (kind === "duplicate") input.evidenceIds.push(input.evidenceIds[0]!);
  if (kind === "escape") input.sourceReferences[0]!.path = "../outside.ts";
  if (kind === "verified") Object.assign(input, { status: "verified" });
  await expect(f.service.submitRepairHypothesis(input)).rejects.toThrow();
  expect((await f.service.missionStatus(input.missionId)).mission.revision).toBe(f.input.expectedRevision);
});

it("rejects changed failure evidence and a source symlink outside the selected checkout", async () => {
  const f = await fixture();
  const outside = join(f.base, "outside"); await mkdir(outside); await writeFile(join(outside, "binding.ts"), f.source);
  await symlink(outside, join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.service.submitRepairHypothesis({ ...f.input, sourceReferences: [{ ...f.input.sourceReferences[0]!, path: "escape/binding.ts" }] })).rejects.toThrow("Source references");
  const business = f.result.findings.find((item) => item.findingId === f.input.findingId)!.evidence[0]!;
  await writeFile(business.path, "changed");
  await expect(f.service.submitRepairHypothesis(f.input)).rejects.toThrow("does not support");
  expect((await f.service.missionStatus(f.input.missionId)).mission.repairSuggestions).toHaveLength(1);
});

it("serializes two writers through Mission ownership and preserves the first coherent revision", async () => {
  const f = await fixture(), other = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  const results = await Promise.allSettled([f.service.submitRepairHypothesis(f.input), other.submitRepairHypothesis({ ...f.input, title: "A different proposal" })]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const saved = (await f.service.missionStatus(f.input.missionId)).mission;
  expect(saved.revision).toBe(f.input.expectedRevision + 1);
  expect(saved.repairSuggestions).toHaveLength(2); expect(saved.verdict).toBe("failed");
});
