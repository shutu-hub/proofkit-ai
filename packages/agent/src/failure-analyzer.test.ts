import { describe, expect, it } from "vitest";
import { analyzeRun } from "./failure-analyzer.js";
import type { EvidenceRef, RunSummary } from "@proofkit/contracts";

const capturedAt = "2026-10-08T00:00:00.000Z";

function evidence(path: string, kind: EvidenceRef["kind"] = "snapshot"): EvidenceRef {
  return { evidenceId: `evidence:${path}`, kind, path, capturedAt };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-fixture",
    startedAt: capturedAt,
    endedAt: capturedAt,
    status: "completed",
    verdict: "failed",
    charter: { intent: "verify resume", level: "core", mode: "deterministic", preconditions: [], actions: [], assertions: [], sideEffectPolicy: "deny", metadata: {} },
    steps: [],
    assertions: [],
    oracles: [],
    artifacts: [],
    findings: [],
    ...overrides,
  };
}

describe("analyzeRun", () => {
  it("confirms a business failure only when the oracle links evidence", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "resume failed", evidence: ["run-fixture/artifacts/oracle-1-source.json", "run-fixture/artifacts/oracle-1.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"], observedAt: capturedAt }] }),
      evidence: [evidence("run-fixture/artifacts/oracle-1-source.json", "business"), evidence("run-fixture/artifacts/oracle-1.json", "report")],
    });

    expect(result.finding?.status).toBe("confirmed");
    expect(result.finding?.category).toBe("product");
    expect(result.diagnosis).toBeDefined();
    expect(result.repairSuggestion?.status).toBe("proposed");
  });

  it("carries trusted Oracle source hints into the diagnosis and repair proposal", () => {
    const result = analyzeRun({
      summary: summary({
        oracles: [{
          name: "resume-terminal",
          passed: false,
          message: "stale binding",
          evidence: ["run-fixture/artifacts/oracle-1-source.json", "run-fixture/artifacts/oracle-1.json"],
          sourceEvidenceCount: 1,
          sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"],
          sourceLocations: ["services/resume-collection-service/internal/service/resume_post_processor.go"],
          observedAt: capturedAt,
        }],
      }),
      evidence: [evidence("run-fixture/artifacts/oracle-1-source.json", "business"), evidence("run-fixture/artifacts/oracle-1.json", "report")],
    });

    expect(result.diagnosis?.sourceLocations).toEqual([
      "services/resume-collection-service/internal/service/resume_post_processor.go",
    ]);
    expect(result.repairSuggestion?.changes[0]).toContain("resume_post_processor.go");
  });

  it("keeps an oracle failure unverified when evidence is missing", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "resume failed", evidence: [], observedAt: capturedAt }] }),
      evidence: [],
    });

    expect(result.finding?.status).toBe("unverified");
    expect(result.finding?.category).toBe("unknown");
    expect(result.diagnosis).toBeUndefined();
  });

  it("keeps an oracle failure unverified when only its own report exists", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "resume failed", evidence: ["run-fixture/artifacts/oracle-1.json"], sourceEvidenceCount: 1 }] }),
      evidence: [evidence("run-fixture/artifacts/oracle-1.json", "report")],
    });
    expect(result.finding?.status).toBe("unverified");
    expect(result.diagnosis).toBeUndefined();
  });

  it("does not treat a declared source path with report provenance as a business fact", () => {
    const path = "run-fixture/artifacts/oracle-1-source.json";
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "resume failed", evidence: [path], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [path] }] }),
      evidence: [evidence(path, "report")],
    });
    expect(result.finding?.status).toBe("unverified");
    expect(result.repairSuggestion).toBeUndefined();
  });

  it("links Windows evidence to the exact run-relative Oracle path", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "stale binding", evidence: ["run-fixture/artifacts/oracle-1-source.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"] }] }),
      evidence: [evidence("D:\\tests\\runs\\run-fixture\\artifacts\\oracle-1-source.json", "business")],
    });
    expect(result.finding?.status).toBe("confirmed");
    expect(result.finding?.evidence).toHaveLength(1);
  });

  it.each(["oracle-1-source.json", "artifacts/oracle-1-source.json", "other-run/artifacts/oracle-1-source.json", "run-fixture/../other-run/artifacts/oracle-1-source.json"])("rejects unscoped or unrelated Oracle evidence: %s", (path) => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "failed", evidence: [path], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [path] }] }),
      evidence: [evidence("/tests/runs/run-fixture/artifacts/oracle-1-source.json", "business")],
    });
    expect(result.finding?.status).toBe("unverified");
    expect(result.diagnosis).toBeUndefined();
  });

  it("keeps ambiguous Oracle artifact matches unverified", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "failed", evidence: ["run-fixture/artifacts/oracle-1-source.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"] }] }),
      evidence: [evidence("/one/run-fixture/artifacts/oracle-1-source.json", "business"), evidence("/two/run-fixture/artifacts/oracle-1-source.json", "business")],
    });
    expect(result.finding?.status).toBe("unverified");
  });

  it("marks a surface action as suspected instead of a confirmed product bug", () => {
    const result = analyzeRun({
      summary: summary({
        steps: [{ stepId: "step-001", action: { kind: "click", selector: "#submit" }, status: "failed", artifacts: [], error: "element not found" }],
      }),
      evidence: [],
    });

    expect(result.boundary?.kind).toBe("surface-action");
    expect(result.finding?.status).toBe("suspected");
    expect(result.diagnosis).toBeUndefined();
  });

  it("classifies a blocked run as an environment finding", () => {
    const result = analyzeRun({ summary: summary({ verdict: "blocked", findings: ["approval required"] }), evidence: [] });

    expect(result.boundary?.kind).toBe("environment");
    expect(result.finding?.category).toBe("environment");
    expect(result.finding?.status).toBe("confirmed");
  });

  it("returns no failure analysis for a passed run", () => {
    expect(analyzeRun({ summary: summary({ verdict: "passed" }), evidence: [] })).toEqual({});
  });

  it("confirms an assertion failure when the assertion points to evidence", () => {
    const result = analyzeRun({
      summary: summary({
        assertions: [{ assertion: { kind: "text-visible", text: "Resume ready" }, passed: false, message: "text missing", evidence: ["run-fixture/after.json"] }],
      }),
      evidence: [evidence("run-fixture/after.json")],
    });

    expect(result.boundary?.kind).toBe("assertion");
    expect(result.finding?.status).toBe("confirmed");
    expect(result.finding?.category).toBe("product");
  });
});
