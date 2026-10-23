import { describe, expect, it } from "vitest";
import type { EvidenceRef } from "@proofkit/contracts";
import type { LocalRunnerService } from "@proofkit/local-runner";
import { briefMissionEvidence } from "./mission-evidence-brief.js";

type MissionEvidence = Awaited<ReturnType<LocalRunnerService["missionEvidence"]>>;

describe("brief Mission evidence", () => {
  it("exposes bounded session sealing state without treating active footage as playable", () => {
    const evidence = { missionId: "mission-capture", status: "completed", running: false, testVerdict: "passed", evidence: [], findings: [],
      summary: { schemaVersion: "1", missionId: "mission-capture", sessionCaptures: { omittedSegments: 0, segments: [{
        runId: "session-network-pending", sessionId: "00000000-0000-4000-8000-000000000001", integrity: "not-sealed",
        reason: "No durable original seal is available", evidence: [],
      }] } } } as unknown as MissionEvidence;
    const brief = briefMissionEvidence(evidence);
    expect(brief.summary.sessionCaptures?.segments).toEqual([{ runId: "session-network-pending", sessionId: "00000000-0000-4000-8000-000000000001",
      integrity: "not-sealed", captureStatus: undefined, recordingStatus: undefined, reason: "No durable original seal is available" }]);
    expect(brief.testVerdict).toBe("passed");
    expect(JSON.stringify(brief)).not.toContain("recording.webm");
  });
  it("keeps the audited verdict and defect source while bounding duplicate traces", () => {
    const refs: EvidenceRef[] = Array.from({ length: 30 }, (_, index) => ({
      evidenceId: `snapshot-${index}`, kind: "snapshot", path: `runs/run-1/snapshot-${index}.json`,
      capturedAt: "2026-10-12T00:00:00.000Z",
    }));
    const business: EvidenceRef = { evidenceId: "business-1", kind: "business", path: "runs/run-1/oracle-source.json",
      sha256: "a".repeat(64), capturedAt: "2026-10-12T00:00:00.000Z" };
    const evidence = {
      missionId: "mission-1", status: "failed", running: false, verdict: "failed", testVerdict: "failed", level: "core",
      summary: { schemaVersion: "1", missionId: "mission-1", status: "failed", verdict: "failed", testVerdict: "failed",
        level: "core", expectedRuns: 1, observedRuns: 1, runs: Array.from({ length: 100 }, () => ({ repeated: "large" })) },
      evidence: [...refs, business], findings: [{ findingId: "finding-1", category: "product", status: "confirmed",
        severity: "high", title: "Wrong job", message: "The current resume belongs to another job",
        createdAt: "2026-10-12T00:00:00.000Z", evidence: [business] }],
      firstFailure: { kind: "business-oracle", message: "Wrong job", evidence: [business], observedAt: "2026-10-12T00:00:00.000Z" }, repairSuggestions: [],
      report: "workspace/report.html", agentSteps: Array.from({ length: 100 }, () => ({ repeated: "large" })),
    } as unknown as MissionEvidence;
    const brief = briefMissionEvidence(evidence);
    expect(brief).toMatchObject({ detail: "brief", testVerdict: "failed", summary: { verdict: "failed" },
      report: "workspace/report.html", answerReference: { missionId: "mission-1", verdict: "failed",
        reportPath: "workspace/report.html" } });
    expect(brief.answerReference?.evidencePaths).toHaveLength(3);
    expect(brief.answerReference?.evidencePaths[0]).toBe(business.path);
    expect(brief.evidence[0]).toEqual(business);
    expect(brief.evidence).toHaveLength(12);
    expect(brief.omittedEvidence).toBe(19);
    expect("agentSteps" in brief).toBe(false);
    expect("runs" in brief.summary).toBe(false);
    expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(evidence).length / 2);
  });

  it("preserves an unasserted result when no product Run exists", () => {
    const evidence = { missionId: "mission-2", status: "awaiting-approval", running: false,
      summary: { verdict: undefined }, evidence: [], findings: [] } as unknown as MissionEvidence;
    expect(briefMissionEvidence(evidence)).toMatchObject({
      testVerdict: "not-asserted", evidence: [], omittedEvidence: 0,
    });
    expect(briefMissionEvidence(evidence)).not.toHaveProperty("answerReference");
    expect(briefMissionEvidence({ ...evidence, verdict: "passed" })).toMatchObject({ testVerdict: "not-asserted" });
    expect(briefMissionEvidence({ ...evidence, status: "blocked" })).toMatchObject({
      answerReference: { missionId: "mission-2", verdict: "not-asserted", reportPath: null, evidencePaths: [] },
    });
  });

  it("keeps an independent business source ahead of many cited screen artifacts", () => {
    const screenshots: EvidenceRef[] = Array.from({ length: 20 }, (_, index) => ({
      evidenceId: `screen-${index}`, kind: "screenshot", path: `runs/run-1/screen-${index}.png`,
      capturedAt: "2026-10-12T00:00:00.000Z",
    }));
    const business: EvidenceRef = { evidenceId: "business", kind: "business", path: "runs/run-1/business.json",
      capturedAt: "2026-10-12T00:00:00.000Z" };
    const evidence = { missionId: "mission-3", status: "failed", running: false,
      verdict: "failed", testVerdict: "failed", summary: { verdict: "failed" },
      evidence: [...screenshots, business], findings: [{ findingId: "finding-2", category: "product", status: "confirmed",
        severity: "high", title: "Screen failure", message: "The expected page did not render".repeat(400),
        createdAt: "2026-10-12T00:00:00.000Z", evidence: screenshots }] } as unknown as MissionEvidence;
    const brief = briefMissionEvidence(evidence);
    expect(brief.evidence[0]).toEqual(business);
    expect(brief.omittedEvidence).toBe(9);
    const finding = brief.findings[0]!;
    expect(finding.evidence).toHaveLength(3);
    expect(finding.omittedEvidence).toBe(17);
    expect(finding.message.length).toBeLessThanOrEqual(501);
  });
});
