import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RunSummary, TestCharter } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";
import { installMockRunEvidence } from "./mock-run-evidence.test-helper.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps the business defect confirmed while admitting only checked source hints to the Mission diagnosis", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-mission-source-hints-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "related.ts"), "export const related = true;\n");

  const service = new LocalRunnerService({ root, workspaceRoot: root });
  const charter: TestCharter = {
    intent: "verify current resume binding", level: "core", mode: "deterministic", preconditions: [], actions: [],
    assertions: [{ kind: "text-visible", text: "Resume" }], oracles: ["resume-terminal"],
    sideEffectPolicy: "deny", metadata: {},
  };
  const now = new Date().toISOString();
  const summary: RunSummary = {
    runId: "source-hint-run", execution: { adapter: "web" }, startedAt: now, endedAt: now, status: "completed", verdict: "failed", charter,
    steps: [], assertions: [{ assertion: charter.assertions[0]!, passed: true, message: "Resume visible", evidence: [] }],
    oracles: [{ name: "resume-terminal", passed: false, message: "stale binding", observedAt: now, verificationKind: "business",
      evidence: ["source-hint-run/artifacts/oracle-1-source.json", "source-hint-run/artifacts/oracle-1.json"],
      sourceEvidenceCount: 1, sourceEvidenceArtifacts: ["source-hint-run/artifacts/oracle-1-source.json"],
      sourceLocations: ["src/related.ts", "../outside.ts", "src/missing.ts"] }],
    artifacts: ["source-hint-run/artifacts/oracle-1-source.json", "source-hint-run/artifacts/oracle-1.json"], findings: [],
  };
  service.start = async () => ({ runId: summary.runId, status: "completed", verdict: summary.verdict, summary });
  service.wait = async () => summary;
  installMockRunEvidence(service);

  const mission = await service.createMission({ intent: charter.intent, surface: "web", charter });
  await service.startMission(mission.missionId, { approve: true });
  const completed = await service.waitMission(mission.missionId);

  expect(completed.findings).toEqual(expect.arrayContaining([expect.objectContaining({ category: "product", status: "confirmed" })]));
  expect(completed.diagnosis?.sourceLocations).toEqual(["src/related.ts"]);
  expect(completed.diagnosis?.confidence).toBe(0.82);
  expect(completed.repairSuggestions[0]?.changes[0]).toContain("source hints");
  expect(completed.repairSuggestions[0]?.changes[0]).not.toContain("outside.ts");
  const result = await service.missionEvidence(mission.missionId);
  expect(result).toMatchObject({ verdict: "failed", testVerdict: "failed",
    acceptanceEvidenceIntegrity: { status: "intact" }, proofClassification: { status: "explicit" } });
  expect(result.summary.diagnosis?.sourceLocations).toEqual(["src/related.ts"]);
  expect(await readFile(result.report!, "utf8")).toContain("Source hints (not root-cause evidence): src/related.ts");
  const business = result.evidence.find((item) => item.kind === "business");
  expect(business).toBeDefined();
  await writeFile(business!.path, "changed after the finding");
  const degraded = await service.missionEvidence(mission.missionId);
  expect(degraded).toMatchObject({ verdict: "failed", testVerdict: "inconclusive",
    acceptanceEvidenceIntegrity: { status: "degraded" },
    evidenceIntegrity: { visibleConfirmedFindings: { saved: 1, supported: 0 } } });
  expect(await readFile(degraded.report!, "utf8")).toContain("Saved failure · current evidence unverified");
});
