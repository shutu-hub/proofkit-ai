import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rmdir, stat } from "node:fs/promises";
import type { SessionNetworkEvent, WebVideoRecordingOptions } from "@proofkit/adapters";
import { TestCharterSchema, VideoRecordingBudgetSchema, type RunSummary, type VideoRecordingBudget, type VideoRecordingStopReason } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { writeCaptureSeal } from "./session-capture-audit.js";

export type SessionNetworkCapture = {
  runId: string;
  status: "recording" | "sealed" | "partial" | "unavailable";
  closed: boolean;
  events: number;
  omittedEvents: number;
  unresolvedRequests: number;
  networkEnabled: boolean;
  recording?: { status: "recording" | "recorded" | "partial" | "unavailable"; artifact?: string; stopReason?: VideoRecordingStopReason; budget?: VideoRecordingBudget;
    selectedPages?: { observed: number; artifacts: string[]; omitted: number } };
  report?: string;
  manifest?: { path: string; sha256: string };
};

export class SessionNetworkEvidence {
  readonly runId = `session-network-${randomUUID()}`;
  private readonly store: EvidenceStore;
  private readonly summary: RunSummary;
  private pending: Promise<void>;
  private finalizing?: Promise<SessionNetworkCapture>;
  private failed = false;
  private closed = false;
  private events = 0;
  private accepted = 0;
  private queued = 0;
  private bytes = 0;
  private omittedEvents = 0;
  private readonly unresolvedRequests = new Set<string>();
  private final?: SessionNetworkCapture;
  private readonly maxEvents: number;
  private readonly networkEnabled: boolean;
  private readonly recordVideo: boolean;
  private readonly videoBudget?: VideoRecordingBudget;

  constructor(options: { evidenceDir: string; projectRoot: string; workspaceRoot: string; sessionId: string; headful: boolean; maxEvents?: number; networkEnabled?: boolean; recordVideo?: boolean; videoBudget?: Partial<VideoRecordingBudget> }) {
    const maxEvents = options.maxEvents ?? 10_000;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) throw new Error("Invalid session network event limit");
    this.maxEvents = maxEvents;
    this.networkEnabled = options.networkEnabled ?? true;
    this.recordVideo = options.recordVideo ?? false;
    this.videoBudget = this.recordVideo ? VideoRecordingBudgetSchema.parse(options.videoBudget ?? {}) : undefined;
    this.store = new EvidenceStore(options.evidenceDir);
    this.summary = { runId: this.runId, projectRoot: options.projectRoot, workspaceRoot: options.workspaceRoot,
      execution: { adapter: "web", kind: "session-network-capture", sessionId: options.sessionId, visibility: options.headful ? "headful" : "headless", sessionNetworkEnabled: this.networkEnabled, sessionRecordingRequested: this.recordVideo },
      startedAt: new Date().toISOString(), status: "running",
      charter: TestCharterSchema.parse({ intent: this.recordVideo ? "Retained Web session evidence with primary-page recording" : "Retained Web session network context", level: "quick", actions: [], assertions: [],
        sideEffectPolicy: "deny", metadata: { purpose: "session-network-capture" } }),
      steps: [], assertions: [], oracles: [], artifacts: [], findings: [],
    };
    this.pending = this.store.startRun(this.summary).then(() => this.store.appendEvent({ runId: this.runId,
      timestamp: this.summary.startedAt, type: "run.started", payload: { purpose: "session-network-capture" } }))
      .catch(() => { this.failed = true; });
  }

  record(event: SessionNetworkEvent): void {
    if (this.closed || !this.networkEnabled) return;
    if (!["request", "response", "requestfailed"].includes(event.type)) { this.omittedEvents++; return; }
    if (this.failed || this.accepted >= this.maxEvents || this.queued >= 256) { this.omittedEvents++; return; }
    let url = "[URL REDACTED]";
    try {
      const parsed = new URL(event.url);
      if (["http:", "https:"].includes(parsed.protocol)) url = `${parsed.origin}/__redacted__`;
    } catch {}
    const safeRunId = (value: string | undefined) => value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
    const payload = { eventType: event.type,
      requestId: /^[a-zA-Z0-9_-]{1,128}$/.test(event.requestId) ? event.requestId : "unlinked",
      method: /^[A-Z]{1,16}$/.test(event.method) ? event.method : "UNKNOWN", url,
      ...(typeof event.status === "number" && Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? { status: event.status } : {}),
      ...(safeRunId(event.initiatingRunId) ? { initiatingRunId: safeRunId(event.initiatingRunId) } : {}),
      ...(safeRunId(event.observedDuringRunId) ? { observedDuringRunId: safeRunId(event.observedDuringRunId) } : {}),
    };
    const observedAt = Date.parse(event.observedAt);
    const timestamp = new Date(Number.isFinite(observedAt) ? observedAt : Date.now()).toISOString();
    const recorded = { runId: this.runId, timestamp, type: "adapter.event" as const, payload };
    const size = Buffer.byteLength(JSON.stringify(recorded)) + 1;
    if (this.bytes + size > 8 * 1024 * 1024) { this.omittedEvents++; return; }
    this.accepted++; this.bytes += size; this.queued++;
    this.pending = this.pending.then(async () => {
      if (this.failed) { this.omittedEvents++; return; }
      await this.store.appendEvent(recorded);
      if (payload.eventType === "request") this.unresolvedRequests.add(payload.requestId);
      else this.unresolvedRequests.delete(payload.requestId);
      this.events++;
    }).catch(() => { this.failed = true; this.omittedEvents++; })
      .finally(() => { this.queued--; });
  }

  state(): SessionNetworkCapture {
    return this.final ?? { runId: this.runId, status: this.failed ? "unavailable" : this.omittedEvents ? "partial" : "recording",
      closed: this.closed, events: this.events, omittedEvents: this.omittedEvents, unresolvedRequests: this.unresolvedRequests.size,
      networkEnabled: this.networkEnabled, ...(this.recordVideo ? { recording: { status: this.failed ? "unavailable" : "recording", budget: this.videoBudget } as const } : {}) };
  }

  recordingOptions(): WebVideoRecordingOptions | undefined {
    return this.recordVideo ? { directory: resolve(this.store.rootDir, this.runId, "recording-tmp"),
      path: resolve(this.store.rootDir, this.runId, "artifacts", "recording.webm"), budget: this.videoBudget } : undefined;
  }

  finish(interrupted = false, recordingStatus?: "recorded" | "partial" | "unavailable", stopReason?: VideoRecordingStopReason,
    selectedPageRecording?: { observed: number; saved: number[] }): Promise<SessionNetworkCapture> {
    if (this.finalizing) return this.finalizing;
    this.closed = true;
    this.finalizing = this.finalize(interrupted, recordingStatus, stopReason, selectedPageRecording);
    return this.finalizing;
  }

  private async finalize(interrupted: boolean, recordingStatus?: "recorded" | "partial" | "unavailable", stopReason?: VideoRecordingStopReason,
    selectedPageRecording?: { observed: number; saved: number[] }): Promise<SessionNetworkCapture> {
    await this.pending;
    if (this.recordVideo) {
      this.summary.recording = { status: "unavailable", budget: this.videoBudget, ...(stopReason ? { stopReason } : {}) };
      if ((!interrupted && !stopReason && recordingStatus === "recorded")
        || (recordingStatus === "partial" && stopReason && stopReason !== "inspection-failed")) {
        try {
          const artifact = await this.store.recordExistingFile(this.runId, "recording.webm", this.videoBudget?.maxBytes);
          this.summary.recording = { status: recordingStatus, artifact, budget: this.videoBudget, ...(stopReason ? { stopReason } : {}) };
          this.summary.artifacts.push(artifact);
        } catch {}
      }
      if (selectedPageRecording?.observed && selectedPageRecording.observed <= 16) {
        const selectedArtifacts: string[] = [];
        let remaining = 0;
        if (this.summary.recording.status !== "unavailable") {
          try { remaining = (this.videoBudget?.maxBytes ?? 64 * 1024 * 1024) - (await stat(resolve(this.store.rootDir, this.runId, "artifacts", "recording.webm"))).size; }
          catch {}
        }
        for (let index = 1; index <= selectedPageRecording.observed; index++) {
          const name = `selected-page-${String(index).padStart(3, "0")}.webm`;
          if (remaining > 0 && selectedPageRecording.saved.includes(index)) {
            try {
              const size = (await stat(resolve(this.store.rootDir, this.runId, "artifacts", name))).size;
              if (size <= remaining) {
                selectedArtifacts.push(await this.store.recordExistingFile(this.runId, name, remaining));
                remaining -= size;
                continue;
              }
            } catch {}
          }
          await this.store.discardUnsealedFile(this.runId, name).catch(() => { this.failed = true; });
        }
        this.summary.artifacts.push(...selectedArtifacts);
        this.summary.recording.selectedPages = { observed: selectedPageRecording.observed, artifacts: selectedArtifacts,
          omitted: selectedPageRecording.observed - selectedArtifacts.length };
      }
      if (this.summary.recording.status === "unavailable") await this.store.discardUnsealedFile(this.runId, "recording.webm").catch(() => {});
    }
    const incompleteNetwork = this.networkEnabled && (this.omittedEvents > 0 || this.unresolvedRequests.size > 0 || !this.events);
    const incompleteVideo = this.recordVideo && this.summary.recording?.status !== "recorded";
    const missingVideo = this.recordVideo && !this.summary.recording?.artifact;
    const status = this.failed ? "unavailable" : interrupted || incompleteNetwork || incompleteVideo || (this.summary.recording?.selectedPages?.omitted ?? 0) > 0 ? "partial" : "sealed";
    const result: SessionNetworkCapture = { runId: this.runId, status, closed: true, events: this.events, omittedEvents: this.omittedEvents,
      unresolvedRequests: this.unresolvedRequests.size, networkEnabled: this.networkEnabled, ...(this.summary.recording ? { recording: this.summary.recording } : {}) };
    this.summary.status = "completed";
    this.summary.verdict = "inconclusive";
    this.summary.endedAt = new Date().toISOString();
    this.summary.findings = [`Capture status: ${status}; ${this.events} event(s), ${this.omittedEvents} omitted, ${this.unresolvedRequests.size} unresolved request(s).`,
      "Session evidence is context only; it does not establish product correctness or action causality.",
      ...(!this.networkEnabled ? ["Network metadata capture was disabled for this segment."] : []),
      ...(this.recordVideo ? ["Requested recording covers the retained initial primary page in this process segment, including time between calls; other windows require separate selected-page clips."] : []),
      ...(this.summary.recording?.selectedPages ? [`Selected-page video: ${this.summary.recording.selectedPages.artifacts.length}/${this.summary.recording.selectedPages.observed} distinct selected window(s) sealed; ${this.summary.recording.selectedPages.omitted} omitted. Clips start when their windows open, not necessarily at Mission start.`] : []),
      ...(missingVideo ? ["Requested session recording is unavailable or could not be sealed within its configured budget and finalization limits."] : []),
      ...(this.summary.recording?.status === "partial" ? ["Playable partial footage was sealed after recording stopped; it does not cover the complete requested recording interval."] : []),
      ...(stopReason ? [`Session recording stopped: ${stopReason}; configured maximum ${this.videoBudget?.maxDurationMs} ms and ${this.videoBudget?.maxBytes} temporary bytes. Requested evidence is incomplete.`] : []),
      "This capture segment does not cover process downtime; request and response bodies, headers and URL paths are not retained.",
      ...(this.unresolvedRequests.size ? [`${this.unresolvedRequests.size} request(s) have no saved response or failure event.`] : []),
      ...(status !== "sealed" ? ["Session network capture is incomplete or unavailable."] : [])];
    try {
      const videoDirectory = this.recordingOptions()?.directory;
      if (videoDirectory) await rmdir(videoDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      this.summary.artifacts.push(await this.store.writeJson(this.runId, "session-network-capture", result));
      await this.store.writeSummary(this.summary);
      await this.store.appendEvent({ runId: this.runId, timestamp: this.summary.endedAt, type: "run.completed", payload: { captureStatus: status, verdict: "inconclusive" } });
      this.summary.eventLog = await this.store.pinEventLog(this.runId);
      await this.store.writeSummary(this.summary);
      result.report = await this.store.writeReport(this.summary);
      const manifest = await this.store.writeManifest(this.runId);
      await writeCaptureSeal({ schemaVersion: 1, runId: this.runId, sessionId: this.summary.execution!.sessionId!,
        projectRoot: this.summary.projectRoot!, workspaceRoot: this.summary.workspaceRoot!, manifestSha256: manifest.sha256 });
      result.manifest = { path: resolve(this.store.rootDir, manifest.path), sha256: manifest.sha256 };
    } catch {
      result.status = "unavailable";
      delete result.manifest;
      this.summary.eventLog = { status: "unavailable" };
      this.summary.findings[0] = "Capture status: unavailable; evidence finalization could not be established.";
      try {
        await this.store.writeJson(this.runId, "session-network-capture", result);
        await this.store.writeSummary(this.summary);
        result.report = await this.store.writeReport(this.summary);
      } catch {}
    }
    this.final = result;
    return result;
  }
}
