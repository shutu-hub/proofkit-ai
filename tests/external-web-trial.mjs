import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProofkitConfigSchema } from "../packages/contracts/dist/index.js";
import { LocalRunnerService } from "../packages/local-runner/dist/index.js";
import { sanitizeEvidence } from "../packages/evidence/dist/index.js";
import { loadExternalSuite } from "./external-web-suite.mjs";

const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const root = argument("--evaluation-root");
const resultPath = argument("--result-json");
const caseId = argument("--case");
const suitePath = argument("--suite");
const suiteSha256 = argument("--suite-sha256");
if (!root || !resultPath || !caseId || !suitePath || !suiteSha256) throw new Error("External trial requires its reviewed suite, case and isolated evidence paths");
if (!process.env.PROOFKIT_PLANNER_BASE_URL || !process.env.PROOFKIT_PLANNER_MODEL) throw new Error("External trial requires an explicit model provider");
const workspaceRoot = join(resolve(root), `${caseId}-tests`);
const startedAt = Date.now();
let runner, prepared, run, manifest, missionId, missionReport, sessionId, verdict, phase = "setup", independentBusinessPassed = null;
let captureStatus, captureIntegrity;
let status = "failed", failureKind, planningSummary, evaluationScope;
try {
  const suite = await loadExternalSuite(suitePath, suiteSha256);
  evaluationScope = suite.evaluationScope;
  const task = suite.cases.find((item) => item.id === caseId);
  if (!task) throw new Error("External case is not in the pinned suite");
  await mkdir(resolve(root));
  prepared = await suite.prepare({ caseId, root: resolve(root), trial: Number(argument("--trial") ?? 1) });
  if (!prepared || typeof prepared.projectRoot !== "string" || typeof prepared.verify !== "function" || typeof prepared.dispose !== "function") {
    throw new Error("External preparation must return projectRoot, url, verify and dispose");
  }
  const url = new URL(prepared.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("External case needs an approved HTTP target without embedded credentials");
  const check = async () => {
    const observation = await prepared.verify();
    if (!observation || ![true, false, null].includes(observation.passed) || !observation.facts || typeof observation.facts !== "object"
      || Array.isArray(observation.facts) || Object.keys(observation.facts).length > 16
      || Object.keys(observation.facts).some((name) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
      || Object.values(observation.facts).some((value) => !["string", "number", "boolean"].includes(typeof value)
        || (typeof value === "string" && value.length > 256) || (typeof value === "number" && !Number.isFinite(value)))) {
      throw new Error("Independent verification requires passed=true/false/null and bounded scalar facts");
    }
    return observation;
  };
  const baseline = await check();
  await writeFile(join(resolve(root), "independent-baseline.json"), JSON.stringify(sanitizeEvidence(baseline), null, 2), { flag: "wx" });
  if (baseline.passed !== false) throw new Error("External trial requires an independently observed unmet initial outcome");
  const oracleName = "reviewed-external-business";
  const config = ProofkitConfigSchema.parse({ ...(prepared.config ?? {}), project: { root: prepared.projectRoot },
    planning: { provider: "openai-compatible", baseUrl: process.env.PROOFKIT_PLANNER_BASE_URL, model: process.env.PROOFKIT_PLANNER_MODEL,
      ...(process.env.PROOFKIT_PLANNER_API_KEY ? { apiKeyEnv: "PROOFKIT_PLANNER_API_KEY" } : {}), timeoutMs: 30_000 },
    surfaces: { ...(prepared.config?.surfaces ?? {}), web: { ...(prepared.config?.surfaces?.web ?? {}), baseUrl: url.href } },
    policies: { ...(prepared.config?.policies ?? {}), sideEffects: "allow" }, run: { ...(prepared.config?.run ?? {}), timeoutMs: 30_000 } });
  if (config.run.recordVideo) throw new Error("External session workflows use sessions.recordVideo, not per-Run recording");
  runner = await LocalRunnerService.create({ root: prepared.projectRoot, workspaceRoot, config, restrictWebOrigins: true,
    integration: { name: "reviewed-external-acceptance", oracles: [{ name: oracleName, async check() {
      const observed = await check();
      return { name: oracleName, ...(observed.passed === null ? {} : { passed: observed.passed }), verificationKind: "business",
        message: "Operator-reviewed independent application observation", evidence: [JSON.stringify(observed.facts)], observedAt: new Date().toISOString() };
    } }] } });
  phase = "inspection";
  const opened = await runner.interactSurface({ adapter: "web", url: url.href, keepSession: true, headful: process.argv.includes("--headful"),
    action: { kind: "goto", url: url.href } });
  if (opened.status !== "observed" || !opened.sessionId) throw new Error("External target inspection did not establish a retained session");
  sessionId = opened.sessionId;
  phase = "planning";
  const charter = await runner.plan(task.intent, { url: url.href, adapter: "web", sessionId, expect: task.expect, oracleNames: [oracleName],
    sideEffectPolicy: "allow", headful: process.argv.includes("--headful") });
  const plannedCharter = JSON.stringify(sanitizeEvidence(charter), null, 2) + "\n";
  const plannedCharterSha256 = createHash("sha256").update(plannedCharter).digest("hex");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "planned-charter.json"), plannedCharter, { flag: "wx" });
  planningSummary = {
    source: charter.planning?.source ?? "unassessed",
    confidence: charter.planning?.confidence ?? 0,
    actions: charter.actions.length,
    assertions: charter.assertions.length,
    oracles: charter.oracles?.length ?? 0,
    negativeCases: charter.negativeCases?.length ?? 0,
    evidenceGaps: charter.planning?.evidenceGaps ?? [],
    missingInputs: charter.planning?.missingInputs ?? [],
    plannedCharterSha256,
  };
  await writeFile(join(workspaceRoot, "planning-receipt.json"), JSON.stringify(planningSummary, null, 2) + "\n", { flag: "wx" });
  if (planningSummary.source !== "model") throw new Error("External model trial did not persist a model-sourced Charter");
  if (charter.planning?.evidenceGaps?.length || charter.planning?.missingInputs?.length) throw new Error("Planned workflow has unresolved acceptance gaps");
  if (createHash("sha256").update(await readFile(suite.path)).digest("hex") !== suite.sha256) throw new Error("Suite changed before execution");
  phase = "execution";
  const mission = await runner.createMission({ intent: task.intent, charter, surface: "web", sessionId, headful: process.argv.includes("--headful") });
  missionId = mission.missionId;
  await runner.startMission(missionId, { approve: true });
  await runner.waitMission(missionId);
  const evidence = await runner.missionEvidence(missionId);
  const primary = evidence.summary.runs.find((item) => item.runKind === "primary");
  if (!primary) throw new Error("Mission did not produce a primary Run");
  run = await runner.wait(primary.runId);
  verdict = evidence.testVerdict === "not-asserted" ? "inconclusive" : evidence.testVerdict;
  phase = "verification";
  const observed = await check();
  independentBusinessPassed = observed.passed;
  await writeFile(join(resolve(root), "independent-outcome.json"), JSON.stringify(sanitizeEvidence(observed), null, 2), { flag: "wx" });
  phase = "evidence";
  const closed = await runner.closeSurfaceSession(sessionId);
  sessionId = undefined;
  const final = await runner.missionEvidence(missionId);
  verdict = final.testVerdict === "not-asserted" ? "inconclusive" : final.testVerdict;
  missionReport = final.report;
  captureStatus = closed.networkCapture?.status ?? "disabled";
  captureIntegrity = final.summary.sessionCaptures?.segments.find((segment) => segment.runId === closed.networkCapture?.runId)?.integrity;
  const original = await runner.evidenceManifest(run.runId);
  const audit = await runner.verifyEvidenceManifest(run.runId, original.sha256);
  manifest = audit.status;
  await writeFile(join(resolve(root), "run-manifest-pin.json"), JSON.stringify({ runId: run.runId, sha256: original.sha256 }, null, 2), { flag: "wx" });
  if (createHash("sha256").update(await readFile(suite.path)).digest("hex") !== suite.sha256) throw new Error("Suite changed during execution");
  if ((config.sessions?.recordNetwork !== false || config.sessions?.recordVideo) && (captureStatus !== "sealed" || captureIntegrity !== "intact")) {
    throw new Error("Requested session evidence is incomplete or cannot be verified");
  }
  if (verdict === "passed" && independentBusinessPassed === true && manifest === "intact") { status = "passed"; phase = "completed"; }
} catch (error) { failureKind = error instanceof Error ? error.name : "unknown"; }
finally {
  for (const cleanup of [() => runner?.closeAllSurfaceSessions(), () => typeof prepared?.dispose === "function" ? prepared.dispose() : undefined]) {
    try { await cleanup(); }
    catch { status = "failed"; phase = "cleanup"; failureKind = "cleanup-unavailable"; }
  }
  await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, project: caseId, evaluationScope, status, phase, runId: run?.runId, verdict,
    independentBusinessPassed, manifest, workspaceRoot, missionId, missionReport, planningSummary, captureStatus, captureIntegrity, durationMs: Date.now() - startedAt,
    ...(failureKind ? { failureKind } : {}) }, null, 2), { flag: "wx" });
  if (status !== "passed") process.exitCode = 1;
}
