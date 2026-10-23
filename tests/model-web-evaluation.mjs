import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadExternalSuite } from "./external-web-suite.mjs";

const execute = promisify(execFile);
const cases = ["catalog-crud", "account-portal", "job-console"];

export function summarizeAttempts(attempts) {
  const valid = attempts.filter((attempt) => attempt.receiptStatus === "valid");
  const completed = valid.filter((attempt) => attempt.status === "passed" && attempt.verdict === "passed"
    && attempt.independentBusinessPassed && attempt.manifest === "intact").length;
  const claimedPassed = valid.filter((attempt) => attempt.verdict === "passed").length;
  const falsePasses = valid.filter((attempt) => attempt.verdict === "passed" && attempt.independentBusinessPassed === false).length;
  const unavailableBusiness = valid.filter((attempt) => attempt.independentBusinessPassed === null).length;
  const assessedPasses = valid.filter((attempt) => attempt.verdict === "passed" && typeof attempt.independentBusinessPassed === "boolean").length;
  const unverified = valid.filter((attempt) => attempt.independentBusinessPassed && attempt.verdict !== "passed").length;
  return { scheduled: attempts.length, valid: valid.length, invalid: attempts.length - valid.length, completed, claimedPassed, falsePasses, unverified, unavailableBusiness,
    completionRate: valid.length ? completed / valid.length : null,
    falsePassRate: assessedPasses ? falsePasses / assessedPasses : null };
}

export function isValidExternalTrialReceipt(receipt, project, workspaceRoot, exitedSuccessfully, plannedCharterSha256, evaluationScope) {
  if (!["fixture", "reviewed-external", "unseen-holdout"].includes(evaluationScope)) return false;
  const planning = receipt?.planningSummary;
  const validPreplanningSetupFailure = !exitedSuccessfully && receipt?.status === "failed" && ["setup", "inspection", "planning"].includes(receipt.phase)
    && receipt.verdict === undefined && receipt.planningSummary === undefined && receipt.missionId === undefined && receipt.runId === undefined
    && receipt.evaluationScope === evaluationScope;
  const planningReceiptValid = planning && planning.source === "model"
    && Number.isFinite(planning.confidence) && planning.confidence >= 0 && planning.confidence <= 1
    && Number.isInteger(planning.actions) && planning.actions >= 0
    && Number.isInteger(planning.assertions) && planning.assertions >= 1
    && Number.isInteger(planning.oracles) && planning.oracles >= 1
    && Number.isInteger(planning.negativeCases) && planning.negativeCases >= 0
    && Array.isArray(planning.evidenceGaps) && planning.evidenceGaps.length === 0
    && Array.isArray(planning.missingInputs) && planning.missingInputs.length === 0
    && /^[a-f0-9]{64}$/.test(planning.plannedCharterSha256 ?? "")
    && planning.plannedCharterSha256 === plannedCharterSha256;
  return receipt?.schemaVersion === 1 && receipt.project === project && receipt.evaluationScope === evaluationScope
    && receipt.workspaceRoot === join(workspaceRoot, `${project}-tests`)
    && (receipt.status === "passed" || receipt.status === "failed")
    && (receipt.status === "passed") === exitedSuccessfully
    && (typeof receipt.independentBusinessPassed === "boolean" || receipt.independentBusinessPassed === null)
    && (planningReceiptValid || validPreplanningSetupFailure)
    && (receipt.verdict === undefined || ["passed", "failed", "inconclusive", "blocked", "cancelled"].includes(receipt.verdict))
    && typeof receipt.phase === "string" && typeof receipt.durationMs === "number" && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0;
}

async function main() {
  if (!process.env.PROOFKIT_PLANNER_BASE_URL || !process.env.PROOFKIT_PLANNER_MODEL) {
    throw new Error("Real model evaluation requires PROOFKIT_PLANNER_BASE_URL and PROOFKIT_PLANNER_MODEL; no fixture fallback is permitted");
  }
  const trialIndex = process.argv.indexOf("--trials");
  const trials = trialIndex < 0 ? 3 : Number(process.argv[trialIndex + 1]);
  if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error("--trials must be an integer from 1 to 5");
  const suiteIndex = process.argv.indexOf("--suite");
  const digestIndex = process.argv.indexOf("--suite-sha256");
  if ((suiteIndex >= 0 && (!process.argv[suiteIndex + 1] || digestIndex < 0)) || (digestIndex >= 0 && suiteIndex < 0)) throw new Error("--suite requires its reviewed --suite-sha256");
  const suite = suiteIndex < 0 ? undefined : await loadExternalSuite(process.argv[suiteIndex + 1], process.argv[digestIndex + 1]);
  const projects = suite ? suite.cases.map((item) => item.id) : cases;
  const outputIndex = process.argv.indexOf("--output-dir");
  if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--output-dir requires a directory");
  const directory = outputIndex < 0 ? await mkdtemp(join(tmpdir(), "proofkit-model-web-eval-")) : resolve(process.argv[outputIndex + 1]);
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, `evaluation-${randomUUID()}.json`);
  const runner = fileURLToPath(new URL(suite ? "./external-web-trial.mjs" : "./generic-web-acceptance-smoke.mjs", import.meta.url));
  const source = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], { cwd: dirname(runner) }).then(({ stdout }) => stdout.trim(), () => "unavailable"),
    execute("git", ["status", "--porcelain"], { cwd: dirname(runner) }).then(({ stdout }) => Boolean(stdout.trim()), () => null),
  ]);
  const attempts = [];
  const report = async () => {
    const plannedAttempts = trials * projects.length;
    const pendingAttempts = plannedAttempts - attempts.length;
    const evaluationScope = suite?.evaluationScope ?? "fixture";
    const document = { schemaVersion: 1, kind: suite ? "external-model-task-evaluation" : "model-fixture-evaluation", evaluationScope, certification: "not-production-certification",
      evaluationStatus: pendingAttempts ? "running" : summarizeAttempts(attempts).completed === plannedAttempts ? "passed" : "failed",
      plannedAttempts, pendingAttempts,
      generatedAt: new Date().toISOString(), model: process.env.PROOFKIT_PLANNER_MODEL,
      source: { gitHead: source[0], workingTreeDirty: source[1] }, ...(suite ? { suite: { path: suite.path, sha256: suite.sha256, evaluationScope: suite.evaluationScope } } : {}), trials, projects,
      metricDefinitions: { completed: "Runner passed, independently reviewed business state passed and manifest intact",
        claimedPassed: "Runner verdict was passed, even if subsequent evidence checks failed",
        falsePasses: "Runner passed while an independent business read was false; rate excludes unknown business reads",
        unavailableBusiness: "Independent business read unavailable; never counted as a false pass or completion",
        unverified: "Independent state passed but Runner did not pass",
        invalid: "Missing or inconsistent trial receipt; excluded from rates, never counted as success" },
      summary: summarizeAttempts(attempts), attempts };
    const temporary = `${reportPath}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { flag: "wx" });
    await rename(temporary, reportPath);
  };
  await report();
  for (let trial = 1; trial <= trials; trial++) {
    for (const project of projects) {
      const attemptId = `trial-${trial}-${project}-${randomUUID()}`;
      const receiptPath = join(directory, `${attemptId}.json`);
      const workspaceRoot = join(directory, `${attemptId}-workspace`);
      let exitedSuccessfully = false;
      try {
        await execute(process.execPath, [runner, "--require-model", "--case", project, "--result-json", receiptPath,
          "--evaluation-root", workspaceRoot, "--keep-artifacts", ...(suite ? ["--suite", suite.path, "--suite-sha256", suite.sha256, "--trial", String(trial)] : []),
          ...(process.argv.includes("--headful") ? ["--headful"] : [])],
          { timeout: 120_000, maxBuffer: 1024 * 1024 });
        exitedSuccessfully = true;
      } catch {}
      let receipt;
      try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch {}
      let plannedCharterSha256;
      try { plannedCharterSha256 = createHash("sha256").update(await readFile(join(workspaceRoot, `${project}-tests`, "planned-charter.json"))).digest("hex"); } catch {}
      const valid = isValidExternalTrialReceipt(receipt, project, workspaceRoot, exitedSuccessfully, plannedCharterSha256, suite?.evaluationScope ?? "fixture");
      const evaluationScope = suite?.evaluationScope ?? "fixture";
      const attempt = { trial, project, evaluationScope, receiptStatus: valid ? "valid" : "invalid",
        ...(valid ? { status: receipt.status, phase: receipt.phase, verdict: receipt.verdict ?? "not-run",
          independentBusinessPassed: receipt.independentBusinessPassed, manifest: receipt.manifest ?? "unavailable",
          runId: receipt.runId, workspaceRoot: receipt.workspaceRoot, durationMs: receipt.durationMs,
          ...(receipt.planningSummary ? { planningSummary: receipt.planningSummary } : {}),
          ...(suite ? { missionId: receipt.missionId, missionReport: receipt.missionReport, captureStatus: receipt.captureStatus, captureIntegrity: receipt.captureIntegrity } : {}),
          ...(receipt.failureKind ? { failureKind: receipt.failureKind } : {}) } : { reason: "missing-or-inconsistent-receipt" }),
        receiptPath, evaluationRoot: workspaceRoot };
      attempts.push(attempt);
      await report();
      console.log(`${project} trial ${trial}: ${attempt.receiptStatus === "valid" ? attempt.status : "invalid"}`);
    }
  }
  console.log(JSON.stringify({ reportPath, summary: summarizeAttempts(attempts), certification: "not-production-certification" }, null, 2));
  if (summarizeAttempts(attempts).completed !== attempts.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
