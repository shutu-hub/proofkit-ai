import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WebTaskSession, type BenchmarkHarManifest, type BenchmarkHarOptions } from "@proofkit/adapters";
import { RunSummarySchema, TestMissionSchema, type RunSummary } from "@proofkit/contracts";
import { auditMissionAgentTrace } from "./mission-agent-trace-audit.js";
import { auditMissionExecution, auditMissionRunFacts } from "./mission-execution-audit.js";
import { benchmarkHash as hash, benchmarkWithin as within, canonicalFuturePath,
  readBenchmarkArtifact as readOwned } from "./benchmark-artifacts.js";

export type BenchmarkMissionBinding = {
  missionId: string;
  missionTaskId: string;
  tool: string;
  runKind: "inspection" | "primary" | "replay" | "negative";
};

type CaptureStart = {
  schemaVersion: 1;
  taskId: number;
  publicInputSha256: string;
  runId: string;
  startedAt: string;
  binding?: BenchmarkMissionBinding;
  runKind: BenchmarkMissionBinding["runKind"] | "standalone";
};
type CaptureResult = CaptureStart & {
  endedAt: string;
  status: "recorded" | "joined-task" | "unavailable";
  reason?: string;
  capture?: BenchmarkHarManifest;
  runSha256?: string;
  charterSha256?: string;
  verdict?: RunSummary["verdict"];
};

type TaskCaptureAudit = { status: "captured" | "incomplete"; taskId: number; runIds: string[];
  issues: string[]; taskTrajectory: "persistent-task-context"; proofkitEffectiveness: "not-measured" };

/** Trusted controller API only. Never construct this from an agent's tool arguments. */
export class BenchmarkCaptureSession {
  private context?: { root: string; workspaceRoot: string; evidenceDir: string };
  private initialization?: Promise<void>;
  private sessionRecord?: Record<string, unknown>;
  private readonly starts = new Map<string, CaptureStart>();
  private readonly results = new Map<string, CaptureResult>();
  readonly directory: string;
  readonly webTask?: WebTaskSession;
  private sealed = false;
  private taskRecord?: Record<string, unknown>;

  private readonly options: { taskId: number; publicInputSha256: string };

  constructor(options: { directory: string; taskId: number; publicInputSha256: string;
    browser?: { startUrl: string; executablePath?: string; headless?: boolean;
      extraHTTPHeaders?: Record<string, string> } }) {
    if (!isAbsolute(options.directory) || !Number.isSafeInteger(options.taskId) || options.taskId < 0
      || !/^[a-f0-9]{64}$/.test(options.publicInputSha256)) throw new Error("Invalid benchmark capture session");
    this.directory = resolve(options.directory);
    this.options = { taskId: options.taskId, publicInputSha256: options.publicInputSha256 };
    if (options.browser) this.webTask = new WebTaskSession({ ...options.browser,
      benchmarkHar: { directory: join(this.directory, "task"), runId: `task-${options.taskId}` } });
  }

  /** A session belongs to one runner and one task; portable Mission recovery is disabled. */
  bind(context: { root: string; workspaceRoot: string; evidenceDir: string }): void {
    if (this.context) throw new Error("Benchmark capture session is already attached");
    const directory = canonicalFuturePath(this.directory);
    for (const path of [context.root, context.workspaceRoot, context.evidenceDir]) {
      const forbidden = canonicalFuturePath(path);
      if (within(forbidden, directory) || within(directory, forbidden)) {
        throw new Error("Benchmark captures require a separate external directory");
      }
    }
    this.context = { ...context };
  }

  async begin(runId: string, binding?: BenchmarkMissionBinding): Promise<BenchmarkHarOptions> {
    if (!this.context || this.sealed || !/^[a-zA-Z0-9_-]+$/.test(runId) || this.starts.has(runId)
      || (this.webTask && (this.webTask.unavailableReason || this.starts.size !== this.results.size))) {
      throw new Error("Invalid benchmark capture lifecycle");
    }
    if (binding && (!/^[a-zA-Z0-9_-]+$/.test(binding.missionId) || !/^[a-zA-Z0-9._-]+$/.test(binding.missionTaskId))) {
      throw new Error("Invalid benchmark Mission identity");
    }
    this.initialization ??= this.initialize();
    try { await this.initialization; } catch { throw new Error("Benchmark capture initialization failed"); }
    if (this.sealed || (this.webTask && (this.webTask.unavailableReason || this.starts.size !== this.results.size))) {
      throw new Error("Persistent benchmark Runs must execute serially in an open task");
    }
    const start: CaptureStart = { schemaVersion: 1, taskId: this.options.taskId,
      publicInputSha256: this.options.publicInputSha256, runId, startedAt: new Date().toISOString(),
      ...(binding ? { binding: { ...binding } } : {}), runKind: binding?.runKind ?? "standalone" };
    this.starts.set(runId, start);
    try { await save(join(this.directory, `${runId}.started.json`), start); }
    catch { throw new Error("Benchmark capture start could not be saved"); }
    return { directory: join(this.directory, runId), runId };
  }

  async finish(runId: string, capture: BenchmarkHarManifest | undefined, summary?: RunSummary): Promise<void> {
    const start = this.starts.get(runId);
    if (!start || this.results.has(runId)) throw new Error("Invalid benchmark capture finalization");
    const result: CaptureResult = { ...start, endedAt: new Date().toISOString(), status: "unavailable",
      reason: "capture-or-run-unavailable", ...(capture ? { capture: structuredClone(capture) } : {}) };
    if (summary) {
      try {
        const bytes = await readOwned(this.context!.evidenceDir, `${runId}/run.json`, 16 * 1024 * 1024);
        const saved = RunSummarySchema.parse(JSON.parse(bytes.toString("utf8")));
        if (saved.runId === runId && saved.status === "completed" && saved.execution?.adapter === "web"
          && JSON.stringify(saved) === JSON.stringify(RunSummarySchema.parse(summary))) {
          result.runSha256 = hash(bytes);
          result.charterSha256 = hash(Buffer.from(JSON.stringify(saved.charter)));
          result.verdict = saved.verdict;
          if (this.webTask && this.webTask.borrowedRunIds().includes(runId)) {
            result.status = "joined-task";
            delete result.reason;
          } else if (capture?.runId === runId && capture.status === "recorded") {
            result.status = "recorded";
            delete result.reason;
          } else result.reason = capture?.reason ?? "capture-unavailable";
        }
      } catch { /* Preserve a gap; a saved verdict cannot substitute for the actual Run bytes. */ }
    }
    try { await save(join(this.directory, `${runId}.finished.json`), result); }
    catch { throw new Error("Benchmark capture result could not be saved"); }
    this.results.set(runId, result);
    // A completed inspection can be inconclusive because it makes no business
    // assertion. Verdicts describe test conclusions, not browser interruption.
    // Cancellation/timeouts or a missing terminal summary may leave an action
    // running after its adapter releases the page: retire that context entirely.
    if (this.webTask && (!summary || summary.verdict === "cancelled")) {
      this.webTask.invalidate("run-interrupted");
      await this.webTask.close(true);
    }
  }

  /** Seal the complete trajectory and submission once; never select a successful Run. */
  async finalizeTask(submission: Record<string, unknown>): Promise<TaskCaptureAudit> {
    if (!this.webTask || this.sealed || !this.starts.size || this.starts.size !== this.results.size || this.webTask.activeRunId) {
      throw new Error("Task submission requires finished Runs and an open persistent task session");
    }
    const bytes = Buffer.from(JSON.stringify(submission, null, 2) + "\n");
    if (bytes.length > 1024 * 1024) throw new Error("Task submission exceeds byte limit");
    this.sealed = true;
    const capture = await this.webTask.close();
    await writeFile(join(this.directory, "agent_response.json"), bytes, { flag: "wx" });
    this.taskRecord = { schemaVersion: 1, taskId: this.options.taskId, publicInputSha256: this.options.publicInputSha256,
      taskTrajectory: "persistent-task-context", contextId: this.webTask.contextId,
      runIds: [...this.starts.keys()], browserRunIds: this.webTask.borrowedRunIds(), endedAt: new Date().toISOString(),
      submissionSha256: hash(bytes), capture, ...(this.webTask.unavailableReason ? { reason: this.webTask.unavailableReason } : {}),
      proofkitEffectiveness: "not-measured" };
    await save(join(this.directory, "task.finished.json"), this.taskRecord);
    return this.auditTask();
  }

  /** On transport loss, release browser resources but never invent a submission. */
  async abandonTask(): Promise<void> {
    this.sealed = true;
    await this.webTask?.close(true);
  }

  async auditTask(): Promise<TaskCaptureAudit> {
    const issues: string[] = [];
    if (!this.webTask || !this.taskRecord) issues.push("task-not-finalized");
    else {
      try {
        const record = await readOwned(this.directory, "task.finished.json", 1024 * 1024);
        if (JSON.stringify(JSON.parse(record.toString())) !== JSON.stringify(this.taskRecord)) issues.push("task-record-changed");
        const response = await readOwned(this.directory, "agent_response.json", 1024 * 1024);
        if (hash(response) !== this.taskRecord.submissionSha256) issues.push("task-submission-changed");
        if (this.webTask.unavailableReason) issues.push(this.webTask.unavailableReason);
        if (JSON.stringify([...this.starts.keys()]) !== JSON.stringify(this.webTask.borrowedRunIds())) issues.push("task-browser-run-gap");
        for (const runId of this.starts.keys()) {
          const audit = await this.auditRun(runId);
          // Reconnaissance through ordinary tools is still part of the trajectory,
          // but remains explicitly unassociated with a Mission.
          issues.push(...audit.issues.filter((issue) => issue !== "standalone-run-has-no-mission-binding").map((issue) => `${runId}:${issue}`));
        }
      } catch { issues.push("task-artifact-unavailable"); }
    }
    return { status: issues.length ? "incomplete" : "captured", taskId: this.options.taskId, runIds: [...this.starts.keys()], issues,
      taskTrajectory: "persistent-task-context", proofkitEffectiveness: "not-measured" };
  }

  /** Local consistency audit, not a public benchmark score or proof that an AI solved the task. */
  async auditRun(runId: string): Promise<{
    status: "associated" | "incomplete";
    taskId: number;
    runId: string;
    runKind?: CaptureStart["runKind"];
    missionId?: string;
    issues: string[];
    proofkitEffectiveness: "not-measured";
    taskTrajectory: "separate-browser-contexts" | "persistent-task-context";
  }> {
    const issues: string[] = [];
    const result = this.results.get(runId);
    if (!result) issues.push("run-not-finalized-in-this-session");
    else {
      try {
        const session = await readOwned(this.directory, "session.json", 1024 * 1024);
        if (JSON.stringify(JSON.parse(session.toString())) !== JSON.stringify(this.sessionRecord)) issues.push("capture-session-changed");
        if (this.webTask) {
          const task = await readOwned(this.directory, "task.finished.json", 1024 * 1024);
          if (JSON.stringify(JSON.parse(task.toString())) !== JSON.stringify(this.taskRecord)) issues.push("task-record-changed");
          const submission = await readOwned(this.directory, "agent_response.json", 1024 * 1024);
          if (hash(submission) !== this.taskRecord?.submissionSha256) issues.push("task-submission-changed");
          if (this.webTask.unavailableReason) issues.push(this.webTask.unavailableReason);
        }
        const start = await readOwned(this.directory, `${runId}.started.json`, 1024 * 1024);
        const end = await readOwned(this.directory, `${runId}.finished.json`, 1024 * 1024);
        if (JSON.stringify(JSON.parse(start.toString())) !== JSON.stringify(this.starts.get(runId))
          || JSON.stringify(JSON.parse(end.toString())) !== JSON.stringify(result)) issues.push("capture-binding-changed");
        const manifest = this.webTask ? this.taskRecord?.capture as BenchmarkHarManifest | undefined : result.capture;
        const capturePath = this.webTask ? "task" : runId;
        const capture = await readOwned(this.directory, `${capturePath}/capture.json`, 1024 * 1024);
        if (JSON.stringify(JSON.parse(capture.toString())) !== JSON.stringify(manifest)) issues.push("capture-manifest-changed");
        const har = await readOwned(this.directory, `${capturePath}/network.har`, 32 * 1024 * 1024);
        if (hash(har) !== manifest?.sha256 || har.length !== manifest?.bytes) issues.push("network-trace-changed");
        if (manifest?.status !== "recorded") issues.push("capture-unavailable");
        const runBytes = await readOwned(this.context!.evidenceDir, `${runId}/run.json`, 16 * 1024 * 1024);
        if (hash(runBytes) !== result.runSha256) issues.push("saved-run-changed");
        const run = RunSummarySchema.parse(JSON.parse(runBytes.toString()));
        if (run.runId !== runId || run.status !== "completed" || run.execution?.adapter !== "web"
          || run.projectRoot !== this.context!.root || run.workspaceRoot !== this.context!.workspaceRoot) issues.push("saved-run-context-mismatch");
        if (result.status !== (this.webTask ? "joined-task" : "recorded")) issues.push(result.reason ?? "capture-unavailable");
        if (!result.binding) issues.push("standalone-run-has-no-mission-binding");
        else {
          const binding = result.binding;
          const missionBytes = await readOwned(this.context!.workspaceRoot, `.proofkit/missions/${binding.missionId}.json`, 16 * 1024 * 1024);
          const mission = TestMissionSchema.parse(JSON.parse(missionBytes.toString()));
          if (mission.missionId !== binding.missionId || mission.projectRoot !== this.context!.root
            || mission.workspaceRoot !== this.context!.workspaceRoot) issues.push("mission-context-mismatch");
          if (!["completed", "failed", "blocked", "cancelled"].includes(mission.status)) issues.push("mission-not-terminal");
          const task = mission.plan.graph.tasks.find((item) => item.taskId === binding.missionTaskId);
          if (task?.tool !== binding.tool) issues.push("mission-task-mismatch");
          const observations = mission.observations.filter((item) => binding.runKind === "inspection"
            ? item.kind === "surface.inspected" && item.data.inspectionId === runId
            : item.kind === "surface.run" && item.data.runId === runId && item.data.runKind === binding.runKind);
          if (observations.length !== 1) issues.push("mission-run-observation-missing-or-ambiguous");
          else {
            const observation = observations[0]!;
            const owners = mission.agentSteps.filter((step) => step.taskId === binding.missionTaskId
              && step.tool === binding.tool && step.observationIds.includes(observation.observationId));
            if (owners.length !== 1) issues.push("mission-run-step-mismatch");
            if (observation.data.surface !== "web") issues.push("mission-surface-mismatch");
            if (binding.runKind !== "inspection" && (observation.data.verdict !== run.verdict
              || observation.data.sourceRunId !== run.execution?.replayOfRunId)) issues.push("mission-run-facts-mismatch");
          }
          if (auditMissionAgentTrace(mission).status !== "complete") issues.push("mission-agent-trace-incomplete");
          const facts = await auditMissionRunFacts(mission,
            auditMissionExecution(mission, this.context!.evidenceDir, "observed-failure"), async (id) => {
              const bytes = await readOwned(this.context!.evidenceDir, `${id}/run.json`, 16 * 1024 * 1024);
              return RunSummarySchema.parse(JSON.parse(bytes.toString()));
            });
          if (facts.status !== "complete") issues.push("mission-run-audit-incomplete");
        }
      } catch { issues.push("capture-or-mission-artifact-unavailable"); }
    }
    return { status: issues.length ? "incomplete" : "associated", taskId: this.options.taskId, runId,
      ...(result ? { runKind: result.runKind, missionId: result.binding?.missionId } : {}), issues,
      proofkitEffectiveness: "not-measured", taskTrajectory: this.webTask ? "persistent-task-context" : "separate-browser-contexts" };
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory); // No reuse, overwrite or resume of a raw capture session.
    this.sessionRecord = { schemaVersion: 1, taskId: this.options.taskId,
      publicInputSha256: this.options.publicInputSha256, createdAt: new Date().toISOString(),
      taskTrajectory: this.webTask ? "persistent-task-context" : "separate-browser-contexts",
      ...(this.webTask ? { contextId: this.webTask.contextId } : {}), proofkitEffectiveness: "not-measured" };
    await save(join(this.directory, "session.json"), this.sessionRecord);
  }
}

async function save(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
