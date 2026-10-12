import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RunSummarySchema, TestMissionSchema, type RunSummary, type TestMission } from "@proofkit/contracts";
import { benchmarkHash, benchmarkWithin, canonicalFuturePath, readBenchmarkArtifact } from "./benchmark-artifacts.js";
import { auditMissionAgentTrace } from "./mission-agent-trace-audit.js";
import { auditMissionExecution, auditMissionRunFacts } from "./mission-execution-audit.js";

const RUN_ID = /^[a-zA-Z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RUNS = 256;
type Json = Record<string, unknown>;

export type PersistedBenchmarkTaskAudit = {
  status: "consistent" | "incomplete";
  taskId: number;
  runIds: string[];
  issues: string[];
  taskTrajectory: "persistent-task-context";
  hostExecution: "not-verified";
  proofkitEffectiveness: "not-measured";
};

/** Independent post-process file audit. This does not attest who drove the tools. */
export async function auditPersistedBenchmarkTask(options: {
  directory: string; projectRoot: string; workspaceRoot: string; taskId: number; publicInputSha256: string;
}): Promise<PersistedBenchmarkTaskAudit> {
  if (![options.directory, options.projectRoot, options.workspaceRoot].every((path) => isAbsolute(path))
    || !Number.isSafeInteger(options.taskId) || options.taskId < 0 || !SHA256.test(options.publicInputSha256)) {
    throw new Error("Invalid persisted benchmark audit context");
  }
  const directory = canonicalFuturePath(options.directory);
  const projectRoot = canonicalFuturePath(options.projectRoot);
  const workspaceRoot = canonicalFuturePath(options.workspaceRoot);
  if ([projectRoot, workspaceRoot].some((root) => benchmarkWithin(root, directory) || benchmarkWithin(directory, root))) {
    throw new Error("Benchmark audit requires external capture storage");
  }
  const evidenceDir = join(workspaceRoot, ".proofkit", "runs");
  const issues: string[] = [];
  const issue = (code: string) => { if (issues.length < 256) issues.push(code); };
  const result = (runIds: string[]): PersistedBenchmarkTaskAudit => ({
    status: issues.length ? "incomplete" : "consistent", taskId: options.taskId, runIds, issues,
    taskTrajectory: "persistent-task-context", hostExecution: "not-verified", proofkitEffectiveness: "not-measured",
  });
  let session: Json, task: Json;
  try {
    session = await json(directory, "session.json", 1024 * 1024);
    task = await json(directory, "task.finished.json", 1024 * 1024);
  } catch { issue("task-record-unavailable"); return result([]); }
  for (const record of [session, task]) {
    if (record.schemaVersion !== 1 || record.taskId !== options.taskId
      || record.publicInputSha256 !== options.publicInputSha256
      || record.taskTrajectory !== "persistent-task-context") issue("task-identity-mismatch");
  }
  if (typeof session.contextId !== "string" || session.contextId !== task.contextId) issue("task-context-mismatch");
  if (task.reason !== undefined) issue("task-context-interrupted");
  const runIds = stringIds(task.runIds);
  if (!runIds || runIds.length === 0 || runIds.length > MAX_RUNS || new Set(runIds).size !== runIds.length) {
    issue("task-run-list-invalid"); return result([]);
  }
  if (!isDeepStrictEqual(task.browserRunIds, runIds)) issue("task-browser-run-gap");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const started = entries.filter((item) => item.name.endsWith(".started.json"));
    const finished = entries.filter((item) => item.name.endsWith(".finished.json") && item.name !== "task.finished.json");
    if (started.length > MAX_RUNS || finished.length > MAX_RUNS) issue("capture-run-limit-exceeded");
    if (!sameFileSet(started, runIds, ".started.json")) issue("task-started-run-gap");
    if (!sameFileSet(finished, runIds, ".finished.json")) issue("task-finished-run-gap");
  } catch { issue("capture-run-inventory-unavailable"); }
  try {
    const bytes = await readBenchmarkArtifact(directory, "agent_response.json", 1024 * 1024);
    if (benchmarkHash(bytes) !== task.submissionSha256) issue("task-submission-changed");
    const answer = parseJson(bytes);
    if (!validAnswer(answer)) issue("task-submission-invalid");
  } catch { issue("task-submission-unavailable"); }

  const capture = isRecord(task.capture) ? task.capture : undefined;
  if (!capture || capture.context !== "task-owned" || capture.runId !== `task-${options.taskId}`
    || capture.purpose !== "benchmark-raw-har" || capture.status !== "recorded"
    || !SHA256.test(String(capture.sha256)) || typeof capture.bytes !== "number"
    || !Number.isSafeInteger(capture.entries) || Number(capture.entries) < 1) issue("task-capture-unavailable");
  try {
    const start = await json(directory, "task/capture-start.json", 1024 * 1024);
    const manifest = await json(directory, "task/capture.json", 1024 * 1024);
    if (!isDeepStrictEqual(manifest, capture) || start.context !== "task-owned"
      || start.runId !== `task-${options.taskId}` || start.startedAt !== capture?.startedAt
      || start.status !== "not-finalized") issue("task-capture-manifest-mismatch");
    const har = await readBenchmarkArtifact(directory, "task/network.har", 128 * 1024 * 1024);
    if (benchmarkHash(har) !== capture?.sha256 || har.length !== capture?.bytes) issue("task-network-trace-changed");
    const entries = (parseJson(har).log as Json | undefined)?.entries;
    if (!Array.isArray(entries) || entries.length !== capture?.entries
      || entries.some((entry) => !validHarEntry(entry))) issue("task-network-trace-invalid");
  } catch { issue("task-capture-artifact-unavailable"); }
  if (!chronological(session.createdAt, task.endedAt)
    || !chronological(session.createdAt, capture?.startedAt)
    || !chronological(capture?.startedAt, capture?.endedAt)
    || !chronological(capture?.endedAt, task.endedAt)) issue("task-timestamps-invalid");

  const missions = new Map<string, TestMission>();
  let previousEnd: unknown;
  for (const runId of runIds) {
    try {
      const start = await json(directory, `${runId}.started.json`, 1024 * 1024);
      const end = await json(directory, `${runId}.finished.json`, 1024 * 1024);
      if (start.schemaVersion !== 1 || start.taskId !== options.taskId || start.publicInputSha256 !== options.publicInputSha256
        || start.runId !== runId || end.runId !== runId || end.taskId !== options.taskId
        || end.publicInputSha256 !== options.publicInputSha256 || end.status !== "joined-task"
        || end.reason !== undefined || !isDeepStrictEqual(end.binding, start.binding)
        || end.runKind !== start.runKind) issue(`${runId}:capture-run-mismatch`);
      if (!chronological(start.startedAt, end.endedAt) || previousEnd && !chronological(previousEnd, start.startedAt)
        || !chronological(end.endedAt, capture?.endedAt)) issue(`${runId}:run-timestamps-invalid`);
      previousEnd = end.endedAt;
      const runBytes = await readBenchmarkArtifact(evidenceDir, `${runId}/run.json`, 16 * 1024 * 1024);
      if (benchmarkHash(runBytes) !== end.runSha256) issue(`${runId}:saved-run-changed`);
      const run = RunSummarySchema.parse(parseJson(runBytes));
      if (run.runId !== runId || run.status !== "completed" || run.execution?.adapter !== "web"
        || !run.projectRoot || !run.workspaceRoot
        || !sameCanonicalPath(run.projectRoot, projectRoot) || !sameCanonicalPath(run.workspaceRoot, workspaceRoot)
        || run.verdict !== end.verdict || benchmarkHash(Buffer.from(JSON.stringify(run.charter))) !== end.charterSha256) {
        issue(`${runId}:saved-run-context-mismatch`);
      }
      if (start.binding === undefined) {
        if (start.runKind !== "standalone") issue(`${runId}:standalone-kind-mismatch`);
      } else {
        await auditMissionBinding(start.binding, start.runKind, run, runId,
          { projectRoot, workspaceRoot }, evidenceDir, missions, issue);
      }
    } catch { issue(`${runId}:run-artifact-unavailable`); }
  }
  const recorded = new Set(runIds);
  for (const mission of missions.values()) {
    for (const observation of mission.observations) {
      if (observation.kind !== "surface.run" && observation.kind !== "surface.inspected") continue;
      const id = observation.kind === "surface.run" ? observation.data.runId : observation.data.inspectionId;
      if (observation.data.surface === "web" && (typeof id !== "string" || !recorded.has(id))) {
        issue(`${mission.missionId}:mission-run-not-captured`);
      }
    }
  }
  return result(runIds);
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;
  return normalize(canonicalFuturePath(left)) === normalize(right);
}

async function auditMissionBinding(binding: unknown, runKind: unknown, run: RunSummary, runId: string,
  options: { projectRoot: string; workspaceRoot: string }, evidenceDir: string,
  missions: Map<string, TestMission>, issue: (code: string) => void): Promise<void> {
  if (!isRecord(binding) || typeof binding.missionId !== "string" || !RUN_ID.test(binding.missionId)
    || typeof binding.missionTaskId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(binding.missionTaskId)
    || typeof binding.tool !== "string" || !["inspection", "primary", "replay", "negative"].includes(String(runKind))
    || binding.runKind !== runKind) { issue(`${runId}:mission-binding-invalid`); return; }
  const mission = TestMissionSchema.parse(parseJson(await readBenchmarkArtifact(options.workspaceRoot,
    `.proofkit/missions/${binding.missionId}.json`, 16 * 1024 * 1024)));
  missions.set(mission.missionId, mission);
  if (mission.missionId !== binding.missionId || mission.projectRoot !== options.projectRoot
    || mission.workspaceRoot !== options.workspaceRoot || !["completed", "failed", "blocked", "cancelled"].includes(mission.status)) {
    issue(`${runId}:mission-context-mismatch`);
  }
  const task = mission.plan.graph.tasks.find((item) => item.taskId === binding.missionTaskId);
  if (task?.tool !== binding.tool) issue(`${runId}:mission-task-mismatch`);
  const observations = mission.observations.filter((item) => runKind === "inspection"
    ? item.kind === "surface.inspected" && item.data.inspectionId === runId
    : item.kind === "surface.run" && item.data.runId === runId && item.data.runKind === runKind);
  if (observations.length !== 1) issue(`${runId}:mission-observation-mismatch`);
  else {
    const observation = observations[0]!;
    const owners = mission.agentSteps.filter((step) => step.taskId === binding.missionTaskId
      && step.tool === binding.tool && step.observationIds.includes(observation.observationId));
    if (owners.length !== 1 || observation.data.surface !== "web"
      || runKind !== "inspection" && (observation.data.verdict !== run.verdict
        || observation.data.sourceRunId !== run.execution?.replayOfRunId)) issue(`${runId}:mission-run-facts-mismatch`);
  }
  if (auditMissionAgentTrace(mission).status !== "complete") issue(`${runId}:mission-agent-trace-incomplete`);
  const facts = await auditMissionRunFacts(mission,
    auditMissionExecution(mission, evidenceDir, "observed-failure"), async (id) => {
      const bytes = await readBenchmarkArtifact(evidenceDir, `${id}/run.json`, 16 * 1024 * 1024);
      return RunSummarySchema.parse(parseJson(bytes));
    });
  if (facts.status !== "complete") issue(`${runId}:mission-run-audit-incomplete`);
}

function stringIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && RUN_ID.test(id)) ? value : undefined;
}
function sameFileSet(entries: Array<{ name: string; isFile(): boolean }>, ids: string[], suffix: string): boolean {
  return entries.length === ids.length && entries.every((entry) => entry.isFile() && ids.includes(entry.name.slice(0, -suffix.length)!)
    && entry.name === `${entry.name.slice(0, -suffix.length)}${suffix}`);
}
function isRecord(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parseJson(bytes: Buffer): Json {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value)) throw new Error("Expected JSON object");
  return value;
}
async function json(root: string, path: string, limit: number): Promise<Json> {
  return parseJson(await readBenchmarkArtifact(root, path, limit));
}
function chronological(first: unknown, second: unknown): boolean {
  return typeof first === "string" && typeof second === "string" && Number.isFinite(Date.parse(first))
    && Number.isFinite(Date.parse(second)) && Date.parse(first) <= Date.parse(second);
}
function validAnswer(value: Json): boolean {
  return Object.keys(value).length === 4 && ["RETRIEVE", "NAVIGATE", "MUTATE"].includes(String(value.task_type))
    && ["SUCCESS", "ACTION_NOT_ALLOWED_ERROR", "PERMISSION_DENIED_ERROR", "NOT_FOUND_ERROR", "DATA_VALIDATION_ERROR", "UNKNOWN_ERROR"].includes(String(value.status))
    && (value.retrieved_data === null || Array.isArray(value.retrieved_data))
    && (value.error_details === null || typeof value.error_details === "string");
}
function validHarEntry(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.response)) return false;
  return typeof value.request.url === "string" && typeof value.request.method === "string"
    && Array.isArray(value.request.headers) && Number.isInteger(value.response.status);
}
