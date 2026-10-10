import { execFile } from "node:child_process";
import { access, appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const actionRoot = resolve(process.env.GITHUB_ACTION_PATH ?? fileURLToPath(new URL("..", import.meta.url)));
const cli = join(actionRoot, "bundle", "main.js");
const checkoutRoot = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
let missionId = process.env.PROOFKIT_ACTION_MISSION_ID?.trim() ?? "";
const suppliedMissionId = Boolean(missionId);

try {
  const projectRoot = requiredPath("PROOFKIT_ACTION_PROJECT_ROOT");
  const workspaceRoot = requiredPath("PROOFKIT_ACTION_WORKSPACE_ROOT");
  const intent = process.env.PROOFKIT_ACTION_INTENT?.trim() ?? "";
  const mode = process.env.PROOFKIT_ACTION_MODE?.trim() || "run";
  if (mode !== "run" && mode !== "check") throw new Error("mode must be run or check");
  if (Boolean(missionId) === Boolean(intent)) throw new Error("Supply exactly one of mission-id or intent");
  if (mode === "check" && !missionId) throw new Error("check mode requires mission-id");
  const location = ["--root", projectRoot, "--workspace", workspaceRoot];

  if (!missionId) {
    const createArgs = ["mission", "create", intent];
    const level = process.env.PROOFKIT_ACTION_LEVEL?.trim();
    const surface = process.env.PROOFKIT_ACTION_SURFACE?.trim();
    if (level) createArgs.push("--level", level);
    if (surface) createArgs.push("--surface", surface);
    const charterId = process.env.PROOFKIT_ACTION_CHARTER_ID?.trim();
    const url = process.env.PROOFKIT_ACTION_URL?.trim();
    const expectText = process.env.PROOFKIT_ACTION_EXPECT_TEXT?.trim();
    const oracleName = process.env.PROOFKIT_ACTION_ORACLE_NAME?.trim();
    if (charterId && (url || expectText || oracleName)) {
      throw new Error("charter-id cannot be combined with ad-hoc URL, text, or Oracle inputs");
    }
    if (charterId) createArgs.push("--charter-id", charterId);
    if (url) createArgs.push("--url", url);
    if (expectText) createArgs.push("--expect", expectText);
    if (oracleName) createArgs.push("--oracle", oracleName);
    const created = await proofkit([...createArgs, ...location]);
    if (created.code !== 0) throw new Error("Mission creation failed; inspect the ProofKit CLI log");
    missionId = parsedJson(created.stdout).missionId;
    if (!validMissionId(missionId)) throw new Error("Mission creation returned an invalid ID");
  }
  if (!validMissionId(missionId)) throw new Error("Invalid mission-id");
  if (mode === "run" && suppliedMissionId) {
    const saved = await proofkit(["mission", "status", missionId, ...location]);
    if (saved.code !== 0) throw new Error("Existing Mission status could not be read before execution");
    const status = parsedJson(saved.stdout).mission?.status;
    if (["completed", "failed", "blocked", "cancelled"].includes(status)) {
      throw new Error("A terminal Mission cannot be run again; use mode check or create a new Mission");
    }
  }

  const command = mode === "check"
    ? ["mission", "check", missionId, ...location]
    : ["mission", "run", missionId, "--approve",
      ...(process.env.PROOFKIT_ACTION_ALLOW_CAPABILITY_WRITES === "true" ? ["--allow-capability-writes"] : []),
      ...location];
  const completed = await proofkit(command);
  const evidence = parsedJson(completed.stdout);
  const summary = evidence.summary;
  if (!summary || summary.schemaVersion !== "1" || summary.missionId !== missionId) {
    throw new Error("ProofKit did not return a versioned MissionResult for this Mission");
  }
  const testVerdict = evidence.testVerdict;
  if (!["passed", "failed", "blocked", "cancelled", "inconclusive", "not-asserted"].includes(testVerdict)
    || summary.testVerdict !== testVerdict) throw new Error("ProofKit returned inconsistent current verdicts");
  const expectedCode = testVerdict === "passed" ? 0 : testVerdict === "failed" ? 1 : 2;
  if (completed.code !== expectedCode) throw new Error("ProofKit exit code disagrees with its audited verdict");

  const summaryPath = join(workspaceRoot, ".proofkit", "missions", missionId, "summary.json");
  const availableSummary = await matchingSummary(summaryPath, summary) ? summaryPath : "";
  const reportPath = typeof evidence.report === "string" && await exists(evidence.report) ? evidence.report : "";
  await publish({ missionId, status: evidence.status ?? "unknown", savedVerdict: evidence.verdict ?? "",
    testVerdict, summaryPath: availableSummary, reportPath,
    reason: acceptanceReason(evidence, summary) });
  process.exitCode = expectedCode;
} catch (error) {
  const message = error instanceof Error ? error.message : "ProofKit Action could not inspect the Mission";
  console.error(message);
  try {
    await publish({ missionId, status: "unavailable", savedVerdict: "", testVerdict: "inconclusive",
      summaryPath: "", reportPath: "", reason: message });
  } catch {
    console.error("ProofKit Action could not write its GitHub output files");
  }
  process.exitCode = 2;
}

function requiredPath(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(checkoutRoot, value);
}

function validMissionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

function parsedJson(output) {
  try { return JSON.parse(output); }
  catch { throw new Error("ProofKit did not return parseable JSON"); }
}

async function proofkit(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: checkoutRoot, maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function matchingSummary(path, current) {
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    return saved.schemaVersion === "1" && saved.missionId === current.missionId
      && saved.generatedAt === current.generatedAt && saved.revision === current.revision
      && saved.testVerdict === current.testVerdict;
  } catch { return false; }
}

async function publish(result) {
  const outputs = {
    "mission-id": result.missionId,
    "test-verdict": result.testVerdict,
    "saved-verdict": result.savedVerdict,
    "summary-path": result.summaryPath,
    "report-path": result.reportPath,
  };
  if (process.env.GITHUB_OUTPUT) {
    for (const [name, value] of Object.entries(outputs)) {
      if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in Action output ${name}`);
      await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [
      ["Mission", result.missionId], ["Execution status", result.status],
      ["Saved verdict", result.savedVerdict], ["Current test verdict", result.testVerdict],
      ["Reason", result.reason], ["JSON summary", result.summaryPath], ["HTML report", result.reportPath],
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "### ProofKit Mission gate\n\n| Field | Value |\n| --- | --- |\n"
      + rows.map(([label, value]) => `| ${label} | ${markdownCell(value)} |`).join("\n") + "\n");
  }
  console.log(JSON.stringify({ schemaVersion: "1", ...result }));
}

function markdownCell(value) {
  return String(value || "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

function acceptanceReason(evidence, summary) {
  const candidate = evidence.testVerdictReason
    ?? summary.planning?.missingInputs?.[0]
    ?? summary.firstFailure?.message
    ?? summary.findings?.[0]?.message
    ?? "";
  return String(candidate).slice(0, 500);
}
