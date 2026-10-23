import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema, type HttpFieldCheck, type RunSummary } from "@proofkit/contracts";
import { EvidenceStore } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(checks: HttpFieldCheck[], retainTotal = false) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-http-field-report-")); roots.push(root);
  const store = new EvidenceStore(root);
  const charter = TestCharterSchema.parse({ intent: "Verify declared independent record fields", actions: [], assertions: [], oracles: ["record"], httpOracles: [{
    name: "record", url: "http://127.0.0.1/status", query: { id: { source: "response", stepId: "step-001", field: "id", matchPointer: "/id" } },
    statusPointer: "/state", successValues: ["complete"], expectFields: [
      { name: "total", pointer: "/total", expected: 55.03, retainValue: retainTotal },
      { name: "city", pointer: "/billing/city", expected: "PRIVATE_EXPECTED_CITY" }] }] });
  const summary: RunSummary = { runId: "field-report", startedAt: "2026-10-21T00:00:00.000Z", status: "completed", verdict: "inconclusive",
    charter, steps: [], assertions: [], oracles: [], artifacts: [], findings: [] };
  await store.startRun(summary);
  const source = { oracle: "record", facts: [{ attempts: 8, omittedObservations: 7, observations: [{ at: "2026-10-21T00:00:01.000Z", status: 200,
    state: "passed", bodySha256: "a".repeat(64), facts: { state: "complete", scopeMatches: true, expected_id: "record-1", observed_id: "record-1", fieldChecks: checks } }] }] };
  const sourcePath = await store.writeJson(summary.runId, "oracle-1-source", source);
  const receipt = { name: "record", passed: true, verificationKind: "business" as const, message: "record: passed after 8 observations", evidence: [sourcePath],
    sourceEvidenceArtifacts: [sourcePath], sourceEvidenceCount: 1, recordedAt: "2026-10-21T00:00:01.000Z" };
  const reportPath = await store.writeJson(summary.runId, "oracle-1", receipt);
  summary.oracles.push({ ...receipt, evidence: [sourcePath, reportPath] }); summary.artifacts.push(sourcePath, reportPath);
  return { root, store, summary, sourcePath, render: async () => readFile(await store.writeReport(summary), "utf8") };
}
const matched: HttpFieldCheck[] = [{ name: "total", pointer: "/total", result: "matched" }, { name: "city", pointer: "/billing/city", result: "matched" }];
describe("required field evidence presentation", () => {
  it("shows only declared complete results without exposing unretained values and labels omitted polling history", async () => {
    const state = await fixture(matched); const html = await state.render();
    expect(html).toContain("Required field checks (2/2 matched)"); expect(html).toContain("/billing/city");
    expect(html).toContain("Earlier polling observations omitted: 7");
    expect(html).not.toContain("PRIVATE_EXPECTED_CITY");
    expect(await readFile(join(state.root, state.sourcePath), "utf8")).not.toContain("PRIVATE_EXPECTED_CITY");
  });
  it("displays reviewed values only when the plan explicitly requests retention", async () => {
    const state = await fixture([{ ...matched[0]!, observed: 55.03 }, matched[1]!], true);
    const html = await state.render(); expect(html).toContain("Required field checks (2/2 matched)");
    expect(html).toContain("expected <code>55.03</code> · observed <code>55.03</code>");
    expect(html).not.toContain("PRIVATE_EXPECTED_CITY");
  });
  it.each([
    [matched[0]!], [matched[0]!, matched[0]!], [matched[0]!, { ...matched[1]!, pointer: "/other" }],
    [{ ...matched[0]!, observed: 999 }, matched[1]!],
  ])("does not present partial, foreign or undeclared retained checks as complete: %j", async (...checks) => {
    const state = await fixture(checks); const html = await state.render();
    expect(html).not.toContain("Required field checks (2/2 matched)");
    expect(html).toContain("Declared required field evidence is unavailable or incomplete");
    expect(html).not.toContain("observed <code>999");
  });
  it("withdraws field facts after their separate original source bytes change", async () => {
    const state = await fixture(matched); expect(await state.render()).toContain("Required field checks (2/2 matched)");
    await writeFile(join(state.root, state.sourcePath), "changed independent field facts");
    const html = await state.render(); expect(html).not.toContain("Required field checks");
    expect(html).toContain("Independent reader facts unavailable or changed");
  });
});
