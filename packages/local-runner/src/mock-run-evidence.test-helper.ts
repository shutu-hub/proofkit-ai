import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EvidenceRef, RunSummary } from "@proofkit/contracts";
import type { LocalRunnerService } from "./index.js";

/** Give orchestration stubs the file and provenance facts a real EvidenceStore would have written. */
export function installMockRunEvidence(service: LocalRunnerService): LocalRunnerService {
  const internal = service as unknown as { runEvidence(summary: RunSummary): EvidenceRef[] };
  const capture = internal.runEvidence.bind(service);
  const prepared = new Set<string>();
  internal.runEvidence = (summary) => {
    if (!prepared.has(summary.runId)) {
      materialize(summary, service.evidenceDir);
      prepared.add(summary.runId);
    }
    return capture(summary);
  };
  return service;
}

function materialize(summary: RunSummary, evidenceDir: string): void {
  const runDir = resolve(evidenceDir, summary.runId);
  mkdirSync(runDir, { recursive: true });
  const summaryPath = resolve(runDir, "run.json");
  if (!existsSync(summaryPath)) writeFileSync(summaryPath, JSON.stringify(summary));
  const reportPath = resolve(runDir, "report.html");
  if (!existsSync(reportPath)) writeFileSync(reportPath, `<html><body>${summary.runId}</body></html>`);
  const eventsPath = resolve(runDir, "events.jsonl");
  for (const artifact of summary.artifacts) {
    if (!artifact.startsWith(`${summary.runId}/`) || artifact.split(/[\\/]/).some((part) => part === "." || part === "..")) continue;
    const path = resolve(evidenceDir, artifact);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, JSON.stringify({ runId: summary.runId, artifact }));
    const bytes = readFileSync(path);
    appendFileSync(eventsPath, `${JSON.stringify({ runId: summary.runId, timestamp: summary.endedAt ?? summary.startedAt,
      type: "artifact.created", payload: { path: artifact, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } })}\n`);
  }
  if (!existsSync(eventsPath)) writeFileSync(eventsPath, `${JSON.stringify({ runId: summary.runId, timestamp: summary.startedAt,
    type: "run.started", payload: {} })}\n`);
}
