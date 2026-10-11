import { describe, expect, it } from "vitest";
import type { MissionResult, RunSummary, SourceState, TestMission } from "@proofkit/contracts";
import { analyzeMissionStability } from "./mission-stability.js";

const source: SourceState = { method: "git", complete: true, headSha: "a".repeat(40), worktreeSha256: "b".repeat(64),
  trackedDiffBytes: 0, untrackedFiles: 0, capturedAt: "2026-10-11T00:00:00.000Z" };
const fact = { fixture: ".proofkit/fixtures/resume.pdf", name: "resume.pdf", sizeBytes: 4,
  sha256: "c".repeat(64), mimeType: "application/pdf" };

function chain(verdicts: Array<"passed" | "failed">, withFile = false) {
  return verdicts.map((verdict, index) => {
    const missionId = `mission-${index}`;
    const runId = `run-${index}`;
    const evidence = { evidenceId: `${runId}:business.json`, kind: "business" as const, path: `${runId}/business.json`,
      sha256: "d".repeat(64), capturedAt: "2026-10-11T00:00:00.000Z" };
    const mission = { missionId, ...(index ? { replayOfMissionId: `mission-${index - 1}` } : {}),
      intent: "verify resume", projectRoot: "/source", workspaceRoot: "/workspace", surface: "web", level: "core",
      policy: { environment: "test", sideEffectPolicy: withFile ? "allow" : "deny" },
      charter: { intent: "verify resume", actions: withFile ? [{ kind: "setInputFiles", selector: "#file", files: [fact.fixture] }] : [{ kind: "observe" }],
        assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["terminal"], sideEffectPolicy: withFile ? "allow" : "deny" },
      plan: { executionProfile: { surfaceMatrix: ["web"], requireReplay: false } }, verdict,
    } as TestMission;
    const result = { missionId, testVerdict: verdict, expectedRuns: 1, observedRuns: 1, omittedRunResults: 0,
      executionAudit: { status: "complete" }, agentTraceAudit: { status: "complete" },
      acceptanceEvidenceIntegrity: { status: "intact" },
      scope: { sourceStability: "stable", sourceFreshness: "matching" },
      proofClassification: { status: "explicit", requiredBusinessRuns: 1, requiredRunsWithPassingBusiness: 1,
        confirmedProductFindings: verdict === "failed" ? 1 : 0, findingsLinkedToFailingBusiness: verdict === "failed" ? 1 : 0 },
      confirmedProductFindings: verdict === "failed" ? 1 : 0,
      findings: verdict === "failed" ? [{ category: "product", status: "confirmed", evidence: [evidence] }] : [],
      runs: [{ runId, surface: "web", runKind: "primary", verdict, targetBinding: {
        status: "matching-process-path", method: "windows-listener-process", expectedProjectRoot: "/source",
        targetOrigin: "http://127.0.0.1:5274", observedProjectRoot: "/source", reason: "fixture", observedAt: "2026-10-11T00:00:00.000Z" },
        targetContinuity: "stable", integrationCleanup: { status: "not-required", declaredResources: 0, verifiedResources: 0 }, evidence: [evidence] }],
    } as unknown as MissionResult;
    return { mission, result, sourceState: source, finalSourceState: source };
  });
}

const loadRun = async (runId: string) => ({ runId, steps: [{ stepId: "step-001", inputFiles: [fact] }] }) as RunSummary;

describe("Mission stability evidence", () => {
  it("reports three evidenced passes without claiming a flaky-test diagnosis", async () => {
    const result = await analyzeMissionStability(chain(["passed", "passed", "passed"]), loadRun);
    expect(result).toMatchObject({ status: "uniform-pass", passes: 3, failures: 0, gaps: [], missionIds: ["mission-0", "mission-1", "mission-2"] });
    expect(result.samples.every((sample) => sample.evidence.length === 1)).toBe(true);
  });

  it("reports a variable business outcome only after three matching evidenced samples", async () => {
    const result = await analyzeMissionStability(chain(["passed", "failed", "passed"]), loadRun);
    expect(result).toMatchObject({ status: "variable-outcome", passes: 2, failures: 1, gaps: [] });
    expect(result.samples[1]?.evidence[0]?.kind).toBe("business");
  });

  it("withholds classification when a replay, source or target does not match", async () => {
    const samples = chain(["passed", "failed", "passed"]);
    samples[1]!.mission.replayOfMissionId = "another-mission";
    samples[2]!.sourceState = { ...source, worktreeSha256: "e".repeat(64) };
    samples[2]!.result.runs[0]!.targetBinding!.targetOrigin = "http://127.0.0.1:5999";
    const result = await analyzeMissionStability(samples, loadRun);
    expect(result.status).toBe("inconclusive");
    expect(result.gaps).toEqual(expect.arrayContaining([expect.stringContaining("direct replay"),
      expect.stringContaining("stable Git source"), expect.stringContaining("target origin changed")]));
  });

  it("requires the same selected file bytes and a business-linked failure", async () => {
    const samples = chain(["passed", "failed", "passed"], true);
    samples[1]!.result.proofClassification!.findingsLinkedToFailingBusiness = 0;
    const result = await analyzeMissionStability(samples, async (runId) => ({ runId, steps: [{ stepId: "step-001",
      inputFiles: [{ ...fact, sha256: runId === "run-2" ? "f".repeat(64) : fact.sha256 }] }] }) as RunSummary);
    expect(result.status).toBe("inconclusive");
    expect(result.gaps).toEqual(expect.arrayContaining([expect.stringContaining("failure lacks a confirmed business fact"),
      expect.stringContaining("input file bytes differ")]));
  });

  it("rejects reused Run artifacts masquerading as independent samples", async () => {
    const samples = chain(["passed", "passed", "passed"]);
    samples[2]!.result.runs[0]!.runId = samples[0]!.result.runs[0]!.runId;
    expect((await analyzeMissionStability(samples, loadRun)).gaps).toContain("mission-2: Run run-0 was reused across samples");
  });
});
