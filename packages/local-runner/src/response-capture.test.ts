import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureResponseActionSchema, InlineHttpOracleSchema, ProofkitConfigSchema, RunSummarySchema, TestCharterSchema, type RunSummary, type Verdict } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const capture = CaptureResponseActionSchema.parse({ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
  response: { url: "http://127.0.0.1/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } });
async function fixture(sideEffects: "allow" | "deny" = "allow") {
  const root = await mkdtemp(join(tmpdir(), "proofkit-response-mission-")); roots.push(root);
  return { root, service: new LocalRunnerService({ root, workspaceRoot: root, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ project: { root }, surfaces: { web: { baseUrl: "https://app.example.test" } },
      policies: { environment: "test", sideEffects } }),
    oracles: [{ name: "intake", check: async () => { throw new Error("Stub supplies independent facts"); } }],
  }) };
}
const plan = TestCharterSchema.parse({ intent: "verify intake", level: "core", sideEffectPolicy: "allow",
  actions: [capture], assertions: [{ kind: "text-visible", text: "Submitted" }], oracles: ["intake"] });

describe("MCP response capture policy and Mission evidence", () => {
  it.each(["web", "electron"] as const)("checks response origins on primary and negative %s scenarios", async (surface) => {
    const { service } = await fixture();
    const external = { ...capture, response: { ...capture.response, url: "https://outside.example.test/api/v1/intakes" } };
    await expect(service.createMission({ intent: plan.intent, surface, charter: { ...plan, actions: [external] } })).rejects.toThrow("outside the configured origin");
    await expect(service.createMission({ intent: plan.intent, surface, charter: { ...plan, negativeCases: [{ caseId: "invalid", title: "invalid", actions: [external],
      assertions: [], oracles: [], expectedVerdict: "failed", sideEffectPolicy: "allow", metadata: {} }] } })).rejects.toThrow("outside the configured origin");
    const accepted = await service.createMission({ intent: plan.intent, surface, charter: { ...plan, actions: [{ ...capture,
      response: { ...capture.response, url: "https://app.example.test/api/v1/intakes" } }] } });
    expect(accepted.charter?.actions[0]?.kind).toBe("captureResponse");
  });

  it("requires both scenario and workspace permission before Mission creation", async () => {
    const { service } = await fixture();
    await expect(service.createMission({ intent: plan.intent, charter: { ...plan, sideEffectPolicy: "deny" } })).rejects.toThrow("captureResponse requires sideEffectPolicy=allow");
    const denied = await fixture("deny");
    await expect(denied.service.createMission({ intent: plan.intent, charter: plan })).rejects.toThrow("policies.sideEffects=allow");
  });
  it("validates an inline business Oracle against its current-response field before Mission persistence", async () => {
    const { root } = await fixture();
    const service = new LocalRunnerService({ root, workspaceRoot: root, restrictWebOrigins: true,
      config: ProofkitConfigSchema.parse({ project: { root }, surfaces: { web: { baseUrl: "http://127.0.0.1:8080/" } },
        policies: { sideEffects: "allow" } }) });
    const responseAction = { ...capture, response: { ...capture.response, url: "http://127.0.0.1:8080/api/v1/intakes" } };
    const inline = InlineHttpOracleSchema.parse({ name: "current-intake", url: "http://127.0.0.1:8080/api/v1/intakes/status",
      query: { fileId: { source: "response" as const, stepId: "step-001", field: "fileId", matchPointer: "/data/file_id" } },
      statusPointer: "/data/state", successValues: ["complete"] });
    const charter = { ...plan, actions: [responseAction], oracles: ["current-intake"], httpOracles: [inline] };
    const accepted = await service.createMission({ intent: charter.intent, charter });
    expect(accepted.charter?.httpOracles?.[0]?.query.fileId).toMatchObject(inline.query.fileId!);
    await expect(service.createMission({ intent: charter.intent, charter: { ...charter,
      httpOracles: [{ ...inline, query: { fileId: { ...inline.query.fileId!, stepId: "step-002" } } }] } }))
      .rejects.toThrow("must bind a captured field");
    await expect(service.createMission({ intent: charter.intent, charter: { ...charter,
      httpOracles: [{ ...inline, url: "https://remote.example.test/status" }] } }))
      .rejects.toThrow("loopback");
    await expect(service.createMission({ intent: charter.intent, charter: { ...charter,
      httpOracles: [inline, inline] } })).rejects.toThrow("duplicate inline Oracle names");
    await expect(service.createMission({ intent: charter.intent, charter: { ...charter,
      actions: [{ ...responseAction, response: { ...responseAction.response,
        fields: { fileId: { pointer: "/data/file_id", type: "string" as const } } } }] } })).rejects.toThrow("needs a captured current ID");
    expect((await readFile(join(root, ".proofkit/missions", `${accepted.missionId}.json`), "utf8"))).toContain("current-intake");
  });

  it("applies capture permission to direct runs as well as Mission requests", async () => {
    const { service, root } = await fixture();
    const started = await service.start({ charter: { ...plan, sideEffectPolicy: "deny" } });
    await expect(service.wait(started.runId)).rejects.toThrow("captureResponse requires sideEffectPolicy=allow");
    await expect(readFile(join(root, ".proofkit/runs", started.runId, "run.json"))).rejects.toThrow();
  });

  it.each(["inconclusive", "blocked", "failed"] as const)("cannot normalize missing response facts to an expected %s", async (expected) => {
    const { service, root } = await fixture();
    const summaries = stubRuns(service, root, expected, false);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan(expected) });
    await service.startMission(mission.missionId, { approve: true });
    const result = await service.waitMission(mission.missionId);
    expect(result.verdict).not.toBe("passed");
    expect(result.observations.find((item) => item.data.runKind === "negative")?.data).toMatchObject({
      verdict: expected, expectedVerdict: expected, outcomeMatched: false,
    });
    expect(result.findings.some((item) => item.message.includes("response was not observed"))).toBe(true);
    expect(result.findings.some((item) => item.category === "product" && item.status === "confirmed")).toBe(false);
    expect(summaries.size).toBe(2);
  });

  it.each([
    ["failed", { targetContinuity: "changed" }],
    ["failed", { applicationContinuity: "unverified" }],
    ["failed", { integrationPostRunCheck: { passed: false, message: "gateway changed", evidence: {} } }],
    ["blocked", {}],
    ["inconclusive", {}],
  ] as const)("rejects an uncertifiable negative outcome for expected %s case %#", async (expected, facts) => {
    const { service, root } = await fixture();
    stubRuns(service, root, expected, true, facts);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan(expected) });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).not.toBe("passed");
    expect(completed.observations.find((item) => item.data.runKind === "negative")?.data).toMatchObject({
      verdict: expected, expectedVerdict: expected, outcomeMatched: false,
    });
    expect(completed.findings.some((item) => item.category === "product" && item.status === "confirmed")).toBe(false);
    if (Object.keys(facts).length > 0) {
      expect(completed.findings.some((item) => item.category === "environment" && item.status === "confirmed")).toBe(true);
    }
    const audited = await service.missionEvidence(mission.missionId);
    expect(audited.summary.executionAudit?.status).toBe("incomplete");
    expect(audited.summary.executionAudit?.issues.some((issue) => issue.includes("negative outcome"))).toBe(true);
  });

  it("accepts an evidenced expected rejection and captures fresh IDs on replay", async () => {
    const { service, root } = await fixture(); const summaries = stubRuns(service, root, "failed", true);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan("failed") });
    await service.startMission(mission.missionId, { approve: true });
    expect((await service.waitMission(mission.missionId)).verdict).toBe("passed");
    const replay = await service.replayMission(mission.missionId);
    expect((await service.waitMission(replay.mission.missionId)).verdict).toBe("passed");
    const facts = [...summaries.values()].map((run) => run.steps[0]?.response?.fields.fileId);
    expect(facts).toEqual(["1", "2", "3", "4"]);
  });

  it.each([
    ["action error", (run: RunSummary) => { run.steps[0]!.status = "failed"; }],
    ["unobserved business failure", (run: RunSummary) => { run.oracles[0]!.passed = true; }],
    ["missing Oracle source", (run: RunSummary) => { run.oracles[0]!.sourceEvidenceArtifacts = []; run.oracles[0]!.sourceEvidenceCount = 0; }],
  ] as const)("does not treat %s as an expected business rejection", async (_case, mutate) => {
    const { service, root } = await fixture();
    stubRuns(service, root, "failed", true, {}, mutate);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan("failed") });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).not.toBe("passed");
    expect(completed.observations.find((item) => item.data.runKind === "negative")?.data.outcomeMatched).toBe(false);
    expect(completed.findings.some((item) => item.category === "product" && item.status === "confirmed")).toBe(false);
    const audited = await service.missionEvidence(mission.missionId);
    expect(audited.summary.executionAudit?.status).toBe("incomplete");
  });

  it.each(["failed", "missing-evidence"] as const)("does not accept a %s negative surface assertion as the expected rejection", async (mode) => {
    const { service, root } = await fixture();
    stubRuns(service, root, "failed", true, {}, (run) => {
      if (mode === "failed") run.assertions[0]!.passed = false;
      else run.assertions[0]!.evidence = [];
    });
    const declared = TestCharterSchema.parse(negativePlan("failed"));
    declared.negativeCases![0]!.assertions = [{ kind: "text-visible", text: "Rejected" }];
    const mission = await service.createMission({ intent: plan.intent, charter: declared });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).not.toBe("passed");
    expect(completed.findings.some((item) => item.message.includes("surface assertion failed"))).toBe(true);
  });

  it("withdraws a saved negative pass when its Run summary later shows a listener change", async () => {
    const { service, root } = await fixture(); stubRuns(service, root, "failed", true);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan("failed") });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).toBe("passed");
    const runId = completed.observations.find((item) => item.data.runKind === "negative")?.data.runId;
    expect(typeof runId).toBe("string");
    const path = join(root, ".proofkit/runs", String(runId), "run.json");
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    saved.targetContinuity = "changed";
    await writeFile(path, JSON.stringify(saved));
    const audited = await service.missionEvidence(mission.missionId);
    expect(audited.verdict).toBe("passed");
    expect(audited.testVerdict).toBe("inconclusive");
    expect(audited.summary.executionAudit?.issues.some((issue) => issue.includes("target listener changed"))).toBe(true);
  });

  it("withdraws a saved negative pass when the failing Oracle loses its source binding", async () => {
    const { service, root } = await fixture(); stubRuns(service, root, "failed", true);
    const mission = await service.createMission({ intent: plan.intent, charter: negativePlan("failed") });
    await service.startMission(mission.missionId, { approve: true });
    const completed = await service.waitMission(mission.missionId);
    expect(completed.verdict).toBe("passed");
    const runId = completed.observations.find((item) => item.data.runKind === "negative")?.data.runId;
    const path = join(root, ".proofkit/runs", String(runId), "run.json");
    const saved = JSON.parse(await readFile(path, "utf8")) as RunSummary;
    saved.oracles[0]!.sourceEvidenceArtifacts = [];
    await writeFile(path, JSON.stringify(saved));
    const audited = await service.missionEvidence(mission.missionId);
    expect(audited.verdict).toBe("passed");
    expect(audited.testVerdict).toBe("inconclusive");
    expect(audited.summary.executionAudit?.issues.some((issue) => issue.includes("independent source evidence"))).toBe(true);
  });
});

function negativePlan(expected: Verdict) {
  return { ...plan, negativeCases: [{ caseId: "rejected", title: "reject invalid intake", actions: [capture], assertions: [], oracles: ["intake"],
    expectedVerdict: expected, sideEffectPolicy: "allow" as const, metadata: {} }] };
}
function stubRuns(service: LocalRunnerService, root: string, expected: Verdict, captureNegative: boolean,
  negativeFacts: Partial<Pick<RunSummary, "targetContinuity" | "applicationContinuity" | "integrationPostRunCheck">> = {},
  mutateNegative?: (run: RunSummary) => void) {
  installMockRunEvidence(service);
  const summaries = new Map<string, RunSummary>();
  service.start = async (input = {}) => {
    const charter = input.charter!; const negative = Boolean(charter.metadata.negativeCaseId);
    const index = summaries.size + 1; const runId = `run-${index}`; const now = new Date().toISOString();
    const source = `${runId}/artifacts/oracle-source.json`; const report = `${runId}/artifacts/oracle.json`;
    await mkdir(join(root, ".proofkit/runs", runId, "artifacts"), { recursive: true });
    await writeFile(join(root, ".proofkit/runs", source), JSON.stringify({ fileId: String(index), state: "completed" }));
    await writeFile(join(root, ".proofkit/runs", report), JSON.stringify({ passed: true }));
    const summary = RunSummarySchema.parse({ runId, charter, status: "completed", verdict: negative ? expected : "passed", startedAt: now, endedAt: now,
      execution: { adapter: "web" }, ...(negative ? negativeFacts : {}),
      steps: negative && !captureNegative ? [] : [{ stepId: "step-001", action: charter.actions[0], status: "passed", artifacts: [], response: {
        name: "intake", association: "action-window", url: capture.response.url, method: "POST", status: 201, requestCount: 1,
        windowStartedAt: now, windowEndedAt: now, capturedAt: now, bodyBytes: 30, bodySha256: "a".repeat(64), fields: { fileId: String(index) },
      } }],
      assertions: charter.assertions.map((assertion) => ({ assertion, passed: true, message: "Submitted", evidence: [source] })),
      oracles: [{ name: "intake", passed: !negative, verificationKind: "business", message: "independent facts", observedAt: now,
        evidence: [source, report], sourceEvidenceCount: 1, sourceEvidenceArtifacts: [source] }],
      artifacts: [source, report], findings: [],
    });
    if (negative) mutateNegative?.(summary);
    summaries.set(runId, summary); return { runId, status: "completed", verdict: summary.verdict, summary };
  };
  service.wait = async (runId) => summaries.get(runId)!;
  return summaries;
}
