import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Trusted benchmark callers only; raw HAR includes headers, cookies and bodies. */
export type BenchmarkHarOptions = { directory: string; runId: string; contextOwner?: "adapter-owned" | "task-owned" };

export type BenchmarkHarManifest = {
  schemaVersion: 1;
  runId: string;
  purpose: "benchmark-raw-har";
  context: "adapter-owned" | "task-owned";
  recording: { mode: "full"; content: "embed"; serviceWorkers: "block" };
  status: "recorded" | "unavailable";
  startedAt: string;
  endedAt: string;
  reason?: "context-close-failed" | "browser-close-failed" | "empty-trace" | "invalid-trace" | "trace-too-large" | "trace-unavailable";
  file?: "network.har";
  sha256?: string;
  bytes?: number;
  entries?: number;
};

// Keep exports compatible with the benchmark controller's bounded import.
const MAX_HAR_BYTES = 128 * 1024 * 1024;

export class BenchmarkHarRecorder {
  readonly path: string;
  private startedAt?: string;
  private finalization?: Promise<BenchmarkHarManifest>;

  constructor(private readonly options: BenchmarkHarOptions) {
    if (!isAbsolute(options.directory) || !/^[a-zA-Z0-9_-]+$/.test(options.runId)) {
      throw new Error("Benchmark HAR requires an absolute new directory and a valid Run ID");
    }
    this.path = join(options.directory, "network.har");
  }

  async prepare(): Promise<void> {
    await mkdir(this.options.directory); // Never reuse or overwrite another capture.
    this.startedAt = new Date().toISOString();
    await writeFile(join(this.options.directory, "capture-start.json"), JSON.stringify({
      schemaVersion: 1, runId: this.options.runId, purpose: "benchmark-raw-har",
      context: this.options.contextOwner ?? "adapter-owned", recording: { mode: "full", content: "embed", serviceWorkers: "block" },
      status: "not-finalized", startedAt: this.startedAt,
    }, null, 2) + "\n", { flag: "wx" });
  }

  finish(closeFailure?: "context-close-failed" | "browser-close-failed"): Promise<BenchmarkHarManifest> {
    this.finalization ??= this.finalize(closeFailure);
    return this.finalization;
  }

  private async finalize(closeFailure?: BenchmarkHarManifest["reason"]): Promise<BenchmarkHarManifest> {
    if (!this.startedAt) throw new Error("Benchmark HAR capture was not prepared");
    const manifest: BenchmarkHarManifest = { schemaVersion: 1, runId: this.options.runId,
      purpose: "benchmark-raw-har", context: this.options.contextOwner ?? "adapter-owned", status: "unavailable",
      recording: { mode: "full", content: "embed", serviceWorkers: "block" },
      startedAt: this.startedAt, endedAt: new Date().toISOString() };
    if (closeFailure) manifest.reason = closeFailure;
    else {
      let file;
      try {
        file = await open(this.path, "r");
        const stat = await file.stat();
        if (!stat.isFile()) manifest.reason = "invalid-trace";
        else if (stat.size > MAX_HAR_BYTES) manifest.reason = "trace-too-large";
        else {
          const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_HAR_BYTES + 1));
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== stat.size) manifest.reason = "invalid-trace";
          else {
            const bytes = buffer.subarray(0, length);
            const data = JSON.parse(bytes.toString("utf8")) as { log?: { entries?: unknown[] } };
            const entries = data?.log?.entries;
            if (!Array.isArray(entries)) manifest.reason = "invalid-trace";
            else if (!entries.length) manifest.reason = "empty-trace";
            else if (entries.some((entry) => !validEntry(entry))) manifest.reason = "invalid-trace";
            else Object.assign(manifest, { status: "recorded", file: "network.har",
              sha256: createHash("sha256").update(bytes).digest("hex"), bytes: length, entries: entries.length });
          }
        }
      } catch (error) {
        manifest.reason = error instanceof SyntaxError ? "invalid-trace" : "trace-unavailable";
      } finally { await file?.close(); }
    }
    await writeFile(join(this.options.directory, "capture.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return manifest;
  }
}

function validEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as { request?: { url?: unknown; method?: unknown; headers?: unknown }; response?: { status?: unknown } };
  return typeof entry.request?.url === "string" && typeof entry.request.method === "string"
    && Array.isArray(entry.request.headers) && Number.isInteger(entry.response?.status);
}
