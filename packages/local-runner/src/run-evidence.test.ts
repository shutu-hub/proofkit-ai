import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunSummarySchema } from "@proofkit/contracts";
import { EvidenceStore, sha256 } from "@proofkit/evidence";
import { analyzeRun } from "@proofkit/agent";
import { captureRunEvidence, materializedRunArtifact } from "./run-evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Run evidence provenance", () => {
  it("anchors business facts to their creation event and rejects later file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-run-evidence-")); roots.push(root);
    const evidenceDir = join(root, ".proofkit", "runs");
    const store = new EvidenceStore(evidenceDir);
    const now = new Date().toISOString();
    const summary = RunSummarySchema.parse({ runId: "run-1", startedAt: now, endedAt: now, status: "completed", verdict: "passed",
      charter: { intent: "test business binding", level: "core", mode: "deterministic", actions: [], assertions: [{ kind: "text-visible", text: "Ready" }], oracles: ["binding"], sideEffectPolicy: "deny" },
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await store.startRun(summary);
    const source = await store.writeJson(summary.runId, "oracle-source", { candidateId: "candidate-1", status: "done" });
    const oracleReport = await store.writeJson(summary.runId, "oracle", { passed: true });
    await store.appendEvent({ runId: summary.runId, timestamp: now, type: "artifact.created",
      payload: { path: source, kind: "business-fact", passed: true } });
    summary.artifacts = [source, oracleReport];
    summary.oracles = [{ name: "binding", passed: true, message: "bound", evidence: [source], sourceEvidenceCount: 1,
      sourceEvidenceArtifacts: [source], observedAt: now }];
    summary.oracles[0]!.evidence.push(oracleReport);
    await store.writeSummary(summary);
    await store.writeReport(summary);

    const refs = captureRunEvidence(summary, evidenceDir);
    const fact = refs.find((ref) => ref.kind === "business");
    expect(fact).toMatchObject({ evidenceId: `run-1:${source}`, sha256: sha256(await readFile(resolve(evidenceDir, source))) });
    expect(refs.every((ref) => /^[a-f0-9]{64}$/.test(ref.sha256 ?? ""))).toBe(true);
    expect(materializedRunArtifact(fact!, summary.runId, source, evidenceDir)).toBe(resolve(evidenceDir, source));

    await writeFile(resolve(evidenceDir, source), JSON.stringify({ candidateId: "candidate-2", status: "done" }));
    expect(materializedRunArtifact(fact!, summary.runId, source, evidenceDir)).toBeUndefined();
    expect(captureRunEvidence(summary, evidenceDir).some((ref) => ref.kind === "business")).toBe(false);
  });

  it("does not derive a new trusted digest from an artifact whose creation event is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-run-evidence-")); roots.push(root);
    const evidenceDir = join(root, ".proofkit", "runs");
    const now = new Date().toISOString();
    const summary = RunSummarySchema.parse({ runId: "run-2", startedAt: now, endedAt: now, status: "completed", verdict: "failed",
      charter: { intent: "test missing provenance", level: "quick", mode: "deterministic", actions: [], assertions: [], sideEffectPolicy: "deny" },
      steps: [], assertions: [], oracles: [], artifacts: ["run-2/artifacts/assertion-001-snapshot.json"], findings: [] });
    const runDir = join(evidenceDir, "run-2");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify(summary));
    await writeFile(join(runDir, "artifacts", "assertion-001-snapshot.json"), "snapshot");
    expect(captureRunEvidence(summary, evidenceDir).map((ref) => ref.evidenceId)).toEqual(["run-2:run-2/run.json"]);
  });

  it("downgrades an assertion defect when its direct observation file is rewritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-run-evidence-")); roots.push(root);
    const evidenceDir = join(root, ".proofkit", "runs");
    const store = new EvidenceStore(evidenceDir);
    const now = new Date().toISOString();
    const assertion = { kind: "text-visible" as const, text: "Ready" };
    const summary = RunSummarySchema.parse({ runId: "run-3", startedAt: now, endedAt: now, status: "completed", verdict: "failed",
      charter: { intent: "test assertion", level: "quick", mode: "deterministic", actions: [], assertions: [assertion], sideEffectPolicy: "deny" },
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
    await store.startRun(summary);
    const snapshot = await store.writeJson(summary.runId, "assertion-001-snapshot", { text: "Loading" });
    summary.assertions = [{ assertion, passed: false, message: "Ready is not visible", evidence: [snapshot] }];
    summary.artifacts = [snapshot];
    await store.writeSummary(summary);
    await store.writeReport(summary);
    expect(analyzeRun({ summary, evidence: captureRunEvidence(summary, evidenceDir) }).finding).toMatchObject({ category: "product", status: "confirmed" });
    await writeFile(resolve(evidenceDir, snapshot), '{"text":"Error"}');
    expect(analyzeRun({ summary, evidence: captureRunEvidence(summary, evidenceDir) }).finding).toMatchObject({ category: "unknown", status: "unverified" });
  });
});
