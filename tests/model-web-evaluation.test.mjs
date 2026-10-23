import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidExternalTrialReceipt, summarizeAttempts } from "./model-web-evaluation.mjs";
import { loadExternalSuite } from "./external-web-suite.mjs";

const execute = promisify(execFile);

test("model evaluation keeps failures, false passes and missing receipts outside the success count", () => {
  assert.deepEqual(summarizeAttempts([
    { receiptStatus: "valid", status: "passed", verdict: "passed", independentBusinessPassed: true, manifest: "intact" },
    { receiptStatus: "valid", status: "failed", verdict: "failed", independentBusinessPassed: false },
    { receiptStatus: "valid", status: "failed", verdict: "passed", independentBusinessPassed: false },
    { receiptStatus: "valid", status: "failed", verdict: "inconclusive", independentBusinessPassed: true },
    { receiptStatus: "invalid" },
  ]), { scheduled: 5, valid: 4, invalid: 1, completed: 1, claimedPassed: 2, falsePasses: 1, unverified: 1, unavailableBusiness: 0, completionRate: 0.25, falsePassRate: 0.5 });
  assert.deepEqual(summarizeAttempts([{ receiptStatus: "invalid" }]), {
    scheduled: 1, valid: 0, invalid: 1, completed: 0, claimedPassed: 0, falsePasses: 0, unverified: 0, unavailableBusiness: 0, completionRate: null, falsePassRate: null,
  });
});

test("generic model mode fails fast without provider configuration", async () => {
  await assert.rejects(() => execute(process.execPath, ["tests/generic-web-acceptance-smoke.mjs", "--case", "catalog-crud", "--require-model"], {
    env: { ...process.env, PROOFKIT_PLANNER_BASE_URL: undefined, PROOFKIT_PLANNER_MODEL: undefined },
  }), /--require-model requires PROOFKIT_PLANNER_BASE_URL and PROOFKIT_PLANNER_MODEL/);
});

test("an unavailable independent reader never becomes a confirmed false pass", () => {
  const summary = summarizeAttempts([{ receiptStatus: "valid", status: "failed", verdict: "passed", independentBusinessPassed: null }]);
  assert.equal(summary.completed, 0);
  assert.equal(summary.falsePasses, 0);
  assert.equal(summary.unavailableBusiness, 1);
  assert.equal(summary.falsePassRate, null);
});

test("external model completion requires a model-sourced, gap-free planning receipt", () => {
  const base = { status: "passed", verdict: "passed", independentBusinessPassed: true, manifest: "intact", receiptStatus: "valid" };
  const summary = {
    source: "model", confidence: 0.8, actions: 3, assertions: 1, oracles: 1, negativeCases: 0,
    evidenceGaps: [], missingInputs: [], plannedCharterSha256: "a".repeat(64),
  };
  const receipt = { schemaVersion: 1, project: "notes", status: "passed", verdict: "passed", independentBusinessPassed: true,
    manifest: "intact", phase: "completed", durationMs: 12, workspaceRoot: join("/eval", "notes-tests"), planningSummary: summary };
  assert.equal(isValidExternalTrialReceipt({ ...receipt, evaluationScope: "reviewed-external" }, "notes", "/eval", true, "a".repeat(64), "reviewed-external"), true);
  assert.equal(isValidExternalTrialReceipt({ ...receipt, evaluationScope: "fixture" }, "notes", "/eval", true, "a".repeat(64), "reviewed-external"), false);
  assert.equal(isValidExternalTrialReceipt({ ...receipt, evaluationScope: "reviewed-external", planningSummary: { ...summary, source: "submitted" } }, "notes", "/eval", true, "a".repeat(64), "reviewed-external"), false);
  assert.equal(isValidExternalTrialReceipt({ ...receipt, evaluationScope: "reviewed-external", planningSummary: { ...summary, evidenceGaps: ["business-oracle"] } }, "notes", "/eval", true, "a".repeat(64), "reviewed-external"), false);
  assert.equal(isValidExternalTrialReceipt({ schemaVersion: 1, project: "notes", status: "failed", phase: "setup",
    evaluationScope: "reviewed-external", independentBusinessPassed: null, workspaceRoot: join("/eval", "notes-tests"), durationMs: 2 }, "notes", "/eval", false, undefined, "reviewed-external"), true);
  assert.equal(isValidExternalTrialReceipt({ ...receipt, evaluationScope: "reviewed-external" }, "notes", "/eval", true, "b".repeat(64), "reviewed-external"), false);
  assert.equal(isValidExternalTrialReceipt(receipt, "notes", "/eval", true, "a".repeat(64)), false);
  assert.deepEqual(summarizeAttempts([{ ...base, planningSummary: summary }]).completed, 1);
});

test("attempt records retain the same evaluation scope as the aggregate", () => {
  const attempts = [{ receiptStatus: "valid", evaluationScope: "fixture", status: "failed", verdict: "inconclusive", independentBusinessPassed: null }];
  assert.equal(attempts[0].evaluationScope, "fixture");
  assert.equal(summarizeAttempts(attempts).unavailableBusiness, 1);
});

test("external suites require an operator pin before any module code is loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-suite-pin-"));
  try {
    const path = join(root, "suite.mjs");
    const marker = join(root, "loaded.txt");
    const source = `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)},'loaded'); export const cases=[{id:'notes',intent:'Save note',expect:['Saved']}]; export async function prepare(){}`;
    await writeFile(path, source);
    await assert.rejects(() => loadExternalSuite(path, "a".repeat(64)), /digest changed/);
    await assert.rejects(() => access(marker));
    const suite = await loadExternalSuite(path, createHash("sha256").update(source).digest("hex"));
    assert.deepEqual(suite.cases, [{ id: "notes", intent: "Save note", expect: ["Saved"] }]);
    await access(marker);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("holdout suites require explicit attestation and preserve their scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-suite-scope-"));
  try {
    const source = `export const evaluationScope='unseen-holdout'; export const cases=[{id:'holdout',intent:'Observe',expect:['Ready']}]; export async function prepare(){}`;
    const path = join(root, "holdout.mjs"); await writeFile(path, source);
    const digest = createHash("sha256").update(source).digest("hex");
    await assert.rejects(() => loadExternalSuite(path, digest), /holdoutAttestation/);
    const attested = source.replace("export const cases", "export const holdoutAttestation=true; export const cases");
    await writeFile(path, attested);
    const loaded = await loadExternalSuite(path, createHash("sha256").update(attested).digest("hex"));
    assert.equal(loaded.evaluationScope, "unseen-holdout");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("external case ids and expected outcomes are bounded and unique", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-suite-contract-"));
  try {
    for (const [index, cases] of [[], [{ id: "../escape", intent: "Save", expect: ["Saved"] }],
      [{ id: "notes", intent: "Save", expect: [] }], [{ id: "notes", intent: "Save", expect: ["Saved"] }, { id: "notes", intent: "Save", expect: ["Saved"] }]].entries()) {
      const source = `export const cases=${JSON.stringify(cases)}; export async function prepare(){}`;
      const path = join(root, `suite-${index}.mjs`); await writeFile(path, source);
      await assert.rejects(() => loadExternalSuite(path, createHash("sha256").update(source).digest("hex")));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
