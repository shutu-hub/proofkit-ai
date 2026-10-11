import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, RunSummarySchema, TestCharterSchema, type RunSummary } from "@proofkit/contracts";
import { LocalRunnerService, type LocalRunInput } from "./index.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Mission file replay association", () => {
  it("pairs primary and negative inputs with their own baseline Run", async () => {
    const { service, calls, summaries, missionId } = await baseline();
    const firstCalls = [...calls];
    const replay = await service.replayMission(missionId);
    expect((await service.waitMission(replay.mission.missionId)).verdict).toBe("passed");
    expect(calls.slice(2).map((input) => input.replayOfRunId)).toEqual(["run-1", "run-2"]);
    expect(firstCalls.every((input) => input.replayOfRunId === undefined)).toBe(true);
    expect(summaries.get("run-3")?.charter.metadata.negativeCaseId).toBeUndefined();
    expect(summaries.get("run-4")?.charter.metadata.negativeCaseId).toBe("invalid");
  });

  it.each(["changed", "not-reached", "unverified"])("does not accept %s replay input for an expected failed negative case", async (kind) => {
    const { service, summaries, missionId } = await baseline({ failedNegative: true });
    const originalStart = service.start.bind(service);
    service.start = async (input = {}) => {
      const started = await originalStart(input);
      if (input.charter?.metadata.negativeCaseId) {
        const run = summaries.get(started.runId)!;
        if (kind === "not-reached") run.steps = [];
        else {
          run.steps[0]!.replayInputMatched = kind === "changed" ? false : undefined;
          run.steps[0]!.error = "Replay fixture facts are missing or unverified";
        }
      }
      return started;
    };
    const replay = await service.replayMission(missionId);
    const result = await service.waitMission(replay.mission.missionId);
    expect(result.verdict).toBe("failed");
    const negative = result.observations.find((item) => item.data.runKind === "negative");
    expect(negative?.data).toMatchObject({ verdict: "failed", expectedVerdict: "failed", outcomeMatched: false });
    expect(result.findings.some((item) => item.message.includes("different test inputs"))).toBe(true);
  });
});

async function baseline(options: { failedNegative?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-file-mission-")); roots.push(root);
  await mkdir(join(root, ".proofkit"), { recursive: true });
  const oracleName = "upload-terminal";
  const service = new LocalRunnerService({ root, workspaceRoot: root,
    config: ProofkitConfigSchema.parse({ project: { root }, policies: { environment: "test", sideEffects: "allow" } }),
    oracles: [{ name: oracleName, check: async () => { throw new Error("Stub runs supply independent facts"); } }],
  });
  installMockRunEvidence(service);
  const fileAction = { kind: "setInputFiles" as const, selector: "#resume", files: [".proofkit/fixtures/resume.pdf"] };
  const charter = TestCharterSchema.parse({ intent: "upload", level: "core", actions: [fileAction],
    assertions: [{ kind: "text-visible", text: "ready" }], oracles: [oracleName], sideEffectPolicy: "allow",
    negativeCases: [{ caseId: "invalid", title: "invalid input", actions: [{ ...fileAction, files: [".proofkit/fixtures/invalid.txt"] }],
      assertions: [{ kind: "text-visible", text: "rejected" }], oracles: [oracleName], sideEffectPolicy: "allow",
      ...(options.failedNegative ? { expectedVerdict: "failed" } : {}) }],
  });
  const calls: LocalRunInput[] = [];
  const summaries = new Map<string, RunSummary>();
  service.start = async (input = {}) => {
    calls.push(input);
    const runId = `run-${calls.length}`;
    const plan = input.charter!;
    const rejected = Boolean(options.failedNegative && plan.metadata.negativeCaseId);
    const sourceArtifact = `${runId}/artifacts/oracle-source.json`;
    const reportArtifact = `${runId}/artifacts/oracle.json`;
    const artifacts = [sourceArtifact, reportArtifact];
    await mkdir(join(root, ".proofkit/runs", runId, "artifacts"), { recursive: true });
    await writeFile(join(root, ".proofkit/runs", sourceArtifact), JSON.stringify({ state: rejected ? "rejected" : "accepted", runId }));
    await writeFile(join(root, ".proofkit/runs", reportArtifact), JSON.stringify({ passed: true }));
    const summary = RunSummarySchema.parse({ runId, status: "completed", verdict: rejected ? "failed" : "passed", charter: plan,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      steps: [{ stepId: "step-001", action: plan.actions[0], status: rejected ? "failed" : "passed", artifacts: [],
        inputFiles: [{ fixture: (plan.actions[0] as typeof fileAction).files[0], name: rejected ? "invalid.txt" : "resume.pdf",
          sizeBytes: 4, sha256: "a".repeat(64), mimeType: rejected ? "text/plain" : "application/pdf" }],
        ...(input.replayOfRunId ? { replayInputMatched: true } : {}) }],
      assertions: plan.assertions.map((assertion) => ({ assertion, passed: true, message: "fixture", evidence: [] })),
      oracles: [{ name: oracleName, passed: true, message: "fixture facts", observedAt: new Date().toISOString(),
        evidence: artifacts, sourceEvidenceArtifacts: [sourceArtifact], sourceEvidenceCount: 1 }], artifacts, findings: [],
    });
    summaries.set(runId, summary);
    return { runId, status: "completed", verdict: summary.verdict, summary };
  };
  service.wait = async (runId) => summaries.get(runId)!;
  const mission = await service.createMission({ intent: charter.intent, surface: "web", charter });
  await service.startMission(mission.missionId, { approve: true });
  expect((await service.waitMission(mission.missionId)).verdict).toBe("passed");
  return { service, calls, summaries, missionId: mission.missionId };
}
