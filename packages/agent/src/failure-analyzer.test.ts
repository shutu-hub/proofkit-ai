import { describe, expect, it } from "vitest";
import { analyzeRun } from "./failure-analyzer.js";
import { CaptureResponseActionSchema, type EvidenceRef, type RunSummary } from "@proofkit/contracts";

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
    runtimeHealth: "passed",
    runtimeFindings: [],
    artifacts: [],
    findings: [],
    ...overrides,
  };
}

describe("analyzeRun", () => {
  it("reports a status-only HTTP mismatch without claiming a business product defect", () => {
    const source = "run-fixture/artifacts/oracle-1-source.json";
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "access-negative", verificationKind: "http-contract", passed: false,
        message: "Expected status 403, observed 500", evidence: [source], sourceEvidenceCount: 1,
        sourceEvidenceArtifacts: [source], observedAt: capturedAt }] }),
      evidence: [evidence(source, "other")],
    });
    expect(result.boundary?.kind).toBe("evidence");
    expect(result.finding).toMatchObject({ category: "unknown", status: "confirmed", title: "HTTP contract mismatch observed" });
    expect(result.diagnosis).toBeUndefined();
    expect(result.repairSuggestion).toBeUndefined();
  });

  it("keeps ambiguous action response evidence unverified without a product diagnosis", () => {
    const path = "run-fixture/artifacts/step-001-response-gap.json";
    const action = CaptureResponseActionSchema.parse({ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
      response: { url: "http://127.0.0.1/api/intakes", method: "POST", fields: { id: { pointer: "/data/id", type: "id" } } } });
    const result = analyzeRun({ summary: summary({ verdict: "inconclusive", steps: [{ stepId: "step-001", action,
      status: "failed", error: "The page closed during response capture", artifacts: [path] }] }), evidence: [evidence(path, "report")] });
    expect(result.boundary?.kind).toBe("evidence"); expect(result.finding?.category).toBe("test");
    expect(result.finding?.status).toBe("unverified"); expect(result.finding?.evidence).toHaveLength(1);
    expect(result.diagnosis).toBeUndefined(); expect(result.repairSuggestion).toBeUndefined();
  });
  it("confirms a business failure only when the oracle links evidence", () => {
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "resume failed", evidence: ["run-fixture/artifacts/oracle-1-source.json", "run-fixture/artifacts/oracle-1.json"], sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"], observedAt: capturedAt }] }),
      evidence: [evidence("run-fixture/artifacts/oracle-1-source.json", "business"), evidence("run-fixture/artifacts/oracle-1.json", "report")],
    });

    expect(result.finding?.status).toBe("confirmed");
    expect(result.finding?.category).toBe("product");
    expect(result.diagnosis).toBeDefined();
    expect(result.repairSuggestion?.status).toBe("proposed");
    expect(result.diagnosis?.findingId).toBe(result.finding?.findingId);
    expect(result.repairSuggestion?.findingId).toBe(result.finding?.findingId);
  });

  it("does not diagnose a product defect when gateway continuity invalidates its source", () => {
    const source = "run-fixture/artifacts/oracle-1-source.json";
    const continuity = "run-fixture/artifacts/post-run-check.json";
    const result = analyzeRun({ summary: summary({ verdict: "inconclusive",
      integrationPostRunCheck: { passed: false, message: "Gateway process changed.", evidence: { gatewayContinuity: "changed" } },
      artifacts: [source, continuity],
      oracles: [{ name: "resume-terminal", passed: false, message: "wrong job binding",
        evidence: [source], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [source], observedAt: capturedAt }],
    }), evidence: [evidence(source, "business"), evidence(continuity, "report")] });
    expect(result.boundary?.kind).toBe("environment");
    expect(result.finding).toMatchObject({ category: "environment", status: "unverified",
      evidence: [expect.objectContaining({ path: continuity })] });
    expect(result.diagnosis).toBeUndefined();
    expect(result.repairSuggestion).toBeUndefined();
  });

  it("keeps an earlier UI mismatch as first failure while diagnosing a later evidenced business defect", () => {
    const snapshot = "run-fixture/artifacts/assertion-001-snapshot.json";
    const source = "run-fixture/artifacts/oracle-1-source.json";
    const result = analyzeRun({
      summary: summary({
        assertions: [{ assertion: { kind: "text-visible", text: "Submitted" }, passed: false,
          message: "Submitted was not visible", evidence: [snapshot], recordedAt: "2026-10-08T00:00:01.000Z" }],
        oracles: [{ name: "resume-terminal", passed: false, message: "wrong job binding", evidence: [source],
          sourceEvidenceCount: 1, sourceEvidenceArtifacts: [source],
          observedAt: capturedAt, recordedAt: "2026-10-08T00:00:02.000Z" }],
      }),
      evidence: [evidence(snapshot), evidence(source, "business")],
    });
    expect(result.boundary).toMatchObject({ kind: "assertion", observedAt: "2026-10-08T00:00:01.000Z",
      evidence: [expect.objectContaining({ path: snapshot })] });
    expect(result.finding).toMatchObject({ category: "product", status: "confirmed",
      evidence: [expect.objectContaining({ path: source })] });
    expect(result.diagnosis?.evidence).toEqual([evidence(source, "business")]);
    expect(result.repairSuggestion?.evidence).toEqual([evidence(source, "business")]);
  });

  it("retains the first Oracle gap but uses a later independently evidenced failure for the product Finding", () => {
    const source = "run-fixture/artifacts/oracle-2-source.json";
    const result = analyzeRun({
      summary: summary({ oracles: [
        { name: "unproven-reader", passed: false, message: "reader claimed failure", evidence: [],
          recordedAt: "2026-10-08T00:00:01.000Z" },
        { name: "binding-reader", passed: false, message: "wrong candidate relation", evidence: [source],
          sourceEvidenceCount: 1, sourceEvidenceArtifacts: [source], recordedAt: "2026-10-08T00:00:02.000Z" },
      ] }), evidence: [evidence(source, "business")],
    });
    expect(result.boundary).toMatchObject({ kind: "business-oracle", oracleName: "unproven-reader",
      observedAt: "2026-10-08T00:00:01.000Z", evidence: [] });
    expect(result.finding).toMatchObject({ category: "product", status: "confirmed",
      title: "Business oracle failed: binding-reader", evidence: [expect.objectContaining({ path: source })] });
    expect(result.diagnosis?.evidence).toEqual([evidence(source, "business")]);
  });

  it("uses only caller-verified source hints without treating them as causal proof", () => {
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
      verifiedSourceLocations: ["services/resume-collection-service/internal/service/resume_post_processor.go"],
    });

    expect(result.diagnosis?.sourceLocations).toEqual([
      "services/resume-collection-service/internal/service/resume_post_processor.go",
    ]);
    expect(result.repairSuggestion?.changes[0]).toContain("resume_post_processor.go");
    expect(result.repairSuggestion?.changes[0]).toContain("source hints");
    expect(result.diagnosis?.confidence).toBe(0.82);
    expect(result.repairSuggestion?.confidence).toBeLessThan(result.diagnosis!.confidence);
  });

  it("does not promote unchecked Oracle paths into a diagnosis", () => {
    const sourcePath = "services/resume-collection-service/internal/service/resume_post_processor.go";
    const result = analyzeRun({
      summary: summary({ oracles: [{ name: "resume-terminal", passed: false, message: "stale binding",
        evidence: ["run-fixture/artifacts/oracle-1-source.json"], sourceEvidenceCount: 1,
        sourceEvidenceArtifacts: ["run-fixture/artifacts/oracle-1-source.json"], sourceLocations: [sourcePath] }] }),
      evidence: [evidence("run-fixture/artifacts/oracle-1-source.json", "business")],
    });
    expect(result.finding).toMatchObject({ category: "product", status: "confirmed" });
    expect(result.diagnosis?.sourceLocations).toEqual([]);
    expect(result.repairSuggestion?.rationale).toContain("source-level cause is unverified");
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

  it("keeps an authentication blocker ahead of a downstream assertion failure", () => {
    const result = analyzeRun({
      summary: summary({
        verdict: "blocked",
        assertions: [{ assertion: { kind: "text-not-visible", text: "Page configuration failed" }, passed: false, message: "error visible", evidence: [] }],
        runtimeFindings: [{
          findingId: "runtime-auth", kind: "console", category: "environment", status: "confirmed", severity: "high",
          message: "AuthRequiredError: login expired", eventType: "console", affectsVerdict: true,
          evidence: ["run-fixture/events.jsonl"], observedAt: capturedAt,
        }],
      }),
      evidence: [evidence("run-fixture/events.jsonl", "network"), evidence("run-fixture/after.json")],
    });
    expect(result.boundary?.kind).toBe("environment");
    expect(result.boundary?.message).toContain("Configured environment blocker");
    expect(result.boundary?.message).not.toContain("login expired");
    expect(result.finding).toMatchObject({ category: "environment", status: "confirmed" });
    expect(result.finding?.evidence).toHaveLength(1);
    expect(result.diagnosis).toBeUndefined();
    expect(result.repairSuggestion).toBeUndefined();
  });

  it("returns no failure analysis for a passed run", () => {
    expect(analyzeRun({ summary: summary({ verdict: "passed" }), evidence: [] })).toEqual({});
  });

  it("keeps a recorded runtime warning visible without inventing a first failure for a passed run", () => {
    const result = analyzeRun({
      summary: summary({
        verdict: "passed",
        runtimeHealth: "failed",
        runtimeFindings: [{
          findingId: "runtime-warning", kind: "pageerror", category: "environment", status: "suspected",
          severity: "high", message: "background page error", eventType: "pageerror",
          affectsVerdict: false, evidence: ["run-fixture/events.jsonl"], observedAt: capturedAt,
        }],
      }),
      evidence: [evidence("run-fixture/events.jsonl", "network")],
    });
    expect(result.boundary).toBeUndefined();
    expect(result.finding).toMatchObject({ status: "suspected", category: "environment", evidence: [expect.any(Object)] });
  });

  it("confirms a surface mismatch without claiming a product defect from its snapshot", () => {
    const path = "run-fixture/artifacts/assertion-001-snapshot.json";
    const result = analyzeRun({
      summary: summary({
        assertions: [{ assertion: { kind: "text-visible", text: "Resume ready" }, passed: false, message: "text missing", evidence: [path] }],
      }),
      evidence: [evidence(path)],
    });

    expect(result.boundary?.kind).toBe("assertion");
    expect(result.finding?.status).toBe("confirmed");
    expect(result.finding?.category).toBe("unknown");
    expect(result.diagnosis?.likelyOwner).toContain("undetermined");
    expect(result.repairSuggestion?.title).toContain("Investigate");
    expect(result.diagnosis?.findingId).toBe(result.finding?.findingId);
    expect(result.repairSuggestion?.findingId).toBe(result.finding?.findingId);
  });

  it("does not promote an observed error page to a product defect when an auth signal is only suspected", () => {
    const path = "run-fixture/artifacts/assertion-001-snapshot.json";
    const result = analyzeRun({
      summary: summary({
        verdict: "failed",
        assertions: [{ assertion: { kind: "text-not-visible", text: "Page configuration failed" }, passed: false,
          message: "Page configuration failed is visible", evidence: [path] }],
        runtimeFindings: [{ findingId: "runtime-auth", kind: "console", category: "environment", status: "suspected",
          severity: "high", message: "AuthRequiredError", eventType: "console", affectsVerdict: false,
          evidence: ["run-fixture/events.jsonl"], observedAt: capturedAt }],
      }),
      evidence: [evidence(path), evidence("run-fixture/events.jsonl", "network")],
    });
    expect(result.boundary?.kind).toBe("assertion");
    expect(result.finding).toMatchObject({ category: "unknown", status: "confirmed" });
    expect(result.repairSuggestion?.rationale).toContain("authentication");
  });

  it("does not confirm a failed assertion from an earlier successful step's snapshot", () => {
    const path = "run-fixture/artifacts/step-001-after.json";
    const result = analyzeRun({ summary: summary({
      steps: [{ stepId: "step-001", action: { kind: "observe" }, status: "passed", artifacts: [path] }],
      assertions: [{ assertion: { kind: "text-visible", text: "Resume ready" }, passed: false, message: "text missing", evidence: [] }],
    }), evidence: [evidence(path)] });
    expect(result.boundary?.kind).toBe("assertion");
    expect(result.finding).toMatchObject({ category: "unknown", status: "unverified", evidence: [] });
    expect(result.diagnosis).toBeUndefined();
    expect(result.repairSuggestion).toBeUndefined();
  });

  it("rejects a stale step artifact even if the assertion claims it as evidence", () => {
    const path = "run-fixture/artifacts/step-001-after.json";
    const result = analyzeRun({ summary: summary({
      assertions: [{ assertion: { kind: "text-visible", text: "Resume ready" }, passed: false, message: "text missing", evidence: [path] }],
    }), evidence: [evidence(path)] });
    expect(result.finding).toMatchObject({ category: "unknown", status: "unverified", evidence: [] });
  });
});
