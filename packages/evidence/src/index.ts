import { appendFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { FieldValueObservationSchema, HttpFieldCheckSchema, OracleResponseBindingSchema, ResponseErrorObservationSchema, ResponseProjectionSchema, RunEventSchema, RunSummarySchema, type HttpFieldExpectation, type RunEvent, type RunSummary } from "@proofkit/contracts";
import { buildRunManifest, verifyRunManifest, type ManifestVerification } from "./manifest.js";
import { auditPlanningObservation } from "./planning-observation.js";
import { planningObservationSources } from "@proofkit/contracts";

export { MissionReportStore, auditMissionVerdict } from "./mission-report.js";
export { exportMissionArchive, verifyMissionArchive, type MissionArchive, type ArchiveVerification, type SavedEvidenceScope } from "./mission-archive.js";
export { LocalExecutionOwnership, type LocalExecutionLease } from "./local-ownership.js";
export type { ManifestVerification } from "./manifest.js";
export { auditPlanningObservation, loadPinnedPlanningObservation, type PlanningObservationAudit } from "./planning-observation.js";

/** Commit a complete, flushed JSON snapshot with one atomic replacement. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(`${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

const REDACT_KEYS = /authorization|cookie|password|secret|token|access[_-]?key|phone|mobile/i;
const MAX_RUN_SUMMARY_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_PREVIEW_CHARS = 100_000;
const MAX_REPORT_INTEGRITY_ARTIFACTS = 512;
const MAX_REPORT_INTEGRITY_BYTES = 256 * 1024 * 1024;

export function sanitizeEvidence(value: unknown): unknown {
  return sanitizeValue(value);
}

function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const projection = key === "fields" || key === "requestFields" || key === "errorFields" ? ResponseProjectionSchema.safeParse(item) : undefined;
    const binding = parentKey === "query" ? OracleResponseBindingSchema.safeParse(item) : undefined;
    output[key] = projection?.success ? projection.data : binding?.success ? binding.data
      : REDACT_KEYS.test(key) ? "[REDACTED]" : sanitizeValue(item, key);
  }
  return output;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function reportAction(action: RunSummary["charter"]["actions"][number]): unknown {
  if (action.kind === "fill" || action.kind === "waitForValue") return { ...action, value: "[REDACTED]" };
  if (action.kind === "capability") return { ...action, input: "[REDACTED]" };
  if (action.kind === "setInputFiles") return { ...action, files: action.files.map(() => "[FIXTURE]") };
  if (action.kind === "goto") return { ...action, url: reportUrl(action.url) };
  if (action.kind === "captureResponse") return { ...action, response: { ...action.response, url: reportUrl(action.response.url) } };
  return action;
}

function reportUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[URL REDACTED]";
  }
}

async function readVerifiedOracleSource(rootDir: string, runId: string, path: string, expected: { bytes: number; sha256: string }): Promise<unknown> {
  if (expected.bytes < 1 || expected.bytes > 64 * 1024 || !/^oracle-[1-8]-source\.json$/.test(path.split("/").at(-1) ?? "")) return;
  const root = await realpath(rootDir);
  const runPath = join(root, runId);
  const artifactDir = join(runPath, "artifacts");
  const target = join(artifactDir, path.split("/").at(-1)!);
  if (path !== `${runId}/artifacts/${target.split(/[\\/]/).at(-1)}` || !samePath(await realpath(runPath), runPath)
    || !samePath(await realpath(artifactDir), artifactDir)) return;
  const direct = await lstat(target);
  if (!direct.isFile() || direct.size !== expected.bytes || !samePath(await realpath(target), target)) return;
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== direct.dev || info.ino !== direct.ino || info.size !== expected.bytes) return;
    const output = Buffer.alloc(expected.bytes + 1);
    let length = 0;
    while (length < output.length) {
      const { bytesRead } = await file.read(output, length, output.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = output.subarray(0, length);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) return;
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally { await file.close(); }
}

function renderOracleSource(source: unknown, oracleName: string, queryNames: string[], expectFields: HttpFieldExpectation[] = []): string | undefined {
  if (!source || typeof source !== "object") return;
  const saved = source as { oracle?: unknown; facts?: unknown };
  if (saved.oracle !== oracleName || !Array.isArray(saved.facts) || saved.facts.length !== 1) return;
  const trace = saved.facts[0] as { attempts?: unknown; omittedObservations?: unknown; observations?: unknown } | undefined;
  if (!trace || !Array.isArray(trace.observations) || trace.observations.length > 100) return;
  const latest = trace.observations.at(-1) as { at?: unknown; status?: unknown; state?: unknown; bodySha256?: unknown; facts?: unknown } | undefined;
  if (!latest || typeof latest !== "object") return;
  const observed = typeof latest.at === "string" && latest.at.length <= 64 ? `<time>${escapeHtml(latest.at)}</time> · ` : "";
  const status = typeof latest.status === "number" && latest.status >= 100 && latest.status <= 599 ? `HTTP ${latest.status}` : "Reader response unavailable";
  const state = ["passed", "failed", "pending"].includes(String(latest.state)) ? String(latest.state) : "not established";
  const facts = latest.facts && typeof latest.facts === "object" && !Array.isArray(latest.facts)
    ? sanitizeEvidence(latest.facts) as Record<string, unknown> : {};
  const scope = typeof facts.scopeMatches === "boolean" ? String(facts.scopeMatches) : "unverified";
  const selected = queryNames.slice(0, 8).flatMap((name) => {
    const expected = facts[`expected_${name}`];
    const actual = facts[`observed_${name}`];
    if (!["string", "number", "boolean"].includes(typeof expected) || !["string", "number", "boolean"].includes(typeof actual)) return [];
    if (String(expected).length > 256 || String(actual).length > 256) return [];
    return [`<li>${escapeHtml(name)}: expected <code>${escapeHtml(String(expected))}</code> · observed <code>${escapeHtml(String(actual))}</code></li>`];
  }).join("");
  let fieldDetails = "";
  if (expectFields.length) {
    const checks = HttpFieldCheckSchema.array().min(1).max(16).safeParse(facts.fieldChecks);
    const complete = checks.success && checks.data.length === expectFields.length && new Set(checks.data.map((field) => field.name)).size === checks.data.length
      && expectFields.every((expected) => checks.data.some((field) => field.name === expected.name && field.pointer === expected.pointer
        && (expected.retainValue || !Object.hasOwn(field, "observed"))
        && (!(expected.retainValue && ["matched", "mismatch"].includes(field.result)) || Object.hasOwn(field, "observed"))
        && (field.result !== "matched" || !Object.hasOwn(field, "observed") || field.observed === expected.expected)));
    fieldDetails = complete && checks.success
      ? '<h4>Required field checks (' + checks.data.filter((field) => field.result === "matched").length + '/' + expectFields.length + ' matched)</h4><ul class="field-checks">'
        + checks.data.map((field) => { const declaration = expectFields.find((expected) => expected.name === field.name)!; return '<li><strong>' + escapeHtml(field.name) + '</strong> · <code>' + escapeHtml(field.pointer) + '</code> · ' + escapeHtml(field.result) + (declaration.retainValue ? ' · expected <code>' + escapeHtml(JSON.stringify(declaration.expected)) + '</code> · observed <code>' + escapeHtml(Object.hasOwn(field, 'observed') ? JSON.stringify(field.observed) : '[not retained or unavailable]') + '</code>' : '') + '</li>'; }).join("")
        + '</ul><p class="meta">Only the declared fields are checked. Values are shown only when retainValue was explicitly declared; matching fields alone do not establish terminal state or current-record identity.</p>'
      : '<p class="meta">Declared required field evidence is unavailable or incomplete.</p>';
  }
  const omitted = typeof trace.omittedObservations === "number" && Number.isSafeInteger(trace.omittedObservations) && trace.omittedObservations > 0 ? trace.omittedObservations : 0;
  const omission = omitted ? '<p class="meta">Earlier polling observations omitted: ' + omitted + '.</p>' : "";
  const bodyHash = typeof latest.bodySha256 === "string" && /^[a-f0-9]{64}$/.test(latest.bodySha256) ? ` · Body SHA-256 ${escapeHtml(latest.bodySha256)}` : "";
  return `<details><summary>Independent HTTP read · ${escapeHtml(state)}</summary><p>${observed}${status} · Current-record match: ${scope}${bodyHash}</p>${fieldDetails}${omission}${selected ? `<ul>${selected}</ul>` : ""}<p class="meta">This reader uses the captured current response identity; UI success alone is not business proof. Its saved source facts and verdict are checked separately.</p></details>`;
}

async function verifyArtifact(rootDir: string, runId: string, relativePath: string, expected: { bytes: number; sha256: string }): Promise<"verified" | "missing" | "changed" | "unverified"> {
  const parts = relativePath.split("/");
  if (parts.length < 3 || parts[0] !== runId || parts[1] !== "artifacts" || parts.some((part) => !part || part === "." || part === "..")) return "unverified";
  try {
    const root = await realpath(rootDir);
    const runPath = join(root, runId);
    const artifactsPath = join(runPath, "artifacts");
    const target = resolve(root, ...parts);
    if (!samePath(await realpath(runPath), runPath) || !samePath(await realpath(artifactsPath), artifactsPath)) return "unverified";
    const direct = await lstat(target);
    if (!direct.isFile() || !samePath(await realpath(target), target)) return "missing";
    if (direct.size !== expected.bytes || direct.size > 64 * 1024 * 1024) return "changed";
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const digest = createHash("sha256");
    let size = 0;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== direct.dev || info.ino !== direct.ino) return "changed";
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (size <= 64 * 1024 * 1024) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
        if (!bytesRead) break;
        digest.update(chunk.subarray(0, bytesRead));
        size += bytesRead;
      }
    } finally { await file.close(); }
    return size === expected.bytes && digest.digest("hex") === expected.sha256 ? "verified" : "changed";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified";
  }
}

export class EvidenceStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async startRun(summary: RunSummary): Promise<void> {
    await mkdir(this.runDir(summary.runId), { recursive: true });
    await mkdir(join(this.runDir(summary.runId), "artifacts"), { recursive: true });
    await this.writeSummary(summary);
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const path = join(this.runDir(event.runId), "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(sanitizeEvidence(event))}\n`, "utf8");
  }

  /** Stream a completed run's audit log without loading an unbounded file. */
  async *readEvents(runId: string, expected?: { bytes: number; sha256: string }): AsyncGenerator<RunEvent> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    const input = createReadStream(join(this.runDir(runId), "events.jsonl"));
    const digest = createHash("sha256");
    let bytes = 0;
    input.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      digest.update(chunk);
      if (bytes > 64 * 1024 * 1024) input.destroy(new Error("Event log exceeds its byte budget"));
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = RunEventSchema.parse(JSON.parse(line));
        if (event.runId !== runId) throw new Error(`Event log contains another run: ${event.runId}`);
        yield event;
      }
      if (expected && (bytes !== expected.bytes || digest.digest("hex") !== expected.sha256)) throw new Error("Event log changed while reading");
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async pinEventLog(runId: string): Promise<{ status: "sealed"; bytes: number; sha256: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    const root = await realpath(this.rootDir);
    const runPath = this.runDir(runId);
    const path = join(runPath, "events.jsonl");
    if (!(await lstat(runPath)).isDirectory() || !samePath(await realpath(runPath), join(root, runId))) throw new Error("Run evidence directory is redirected");
    const direct = await lstat(path);
    if (!direct.isFile() || direct.size > 64 * 1024 * 1024 || !samePath(await realpath(path), path)) throw new Error("Event log is unavailable or exceeds its byte budget");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.dev !== direct.dev || before.ino !== direct.ino || before.size !== direct.size) throw new Error("Event log changed during opening");
      const digest = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      while (bytes <= 64 * 1024 * 1024) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > 64 * 1024 * 1024) throw new Error("Event log exceeds its byte budget");
        digest.update(chunk.subarray(0, bytesRead));
      }
      const after = await file.stat();
      const current = await lstat(path);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size
        || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error("Event log changed while hashing");
      return { status: "sealed", bytes, sha256: digest.digest("hex") };
    } finally { await file.close(); }
  }

  async writeSummary(summary: RunSummary): Promise<void> {
    await mkdir(this.runDir(summary.runId), { recursive: true });
    await writeFile(
      join(this.runDir(summary.runId), "run.json"),
      `${JSON.stringify(sanitizeEvidence(summary), null, 2)}\n`,
      "utf8",
    );
  }

  async writeJson(runId: string, name: string, value: unknown): Promise<string> {
    const path = join(this.runDir(runId), "artifacts", `${safeName(name)}.json`);
    await mkdir(dirname(path), { recursive: true });
    const content = `${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`;
    await writeFile(path, content, "utf8");
    await this.recordArtifact(runId, path, Buffer.byteLength(content));
    return this.relativePath(path);
  }

  async writeJsonAtomic(runId: string, name: string, value: unknown): Promise<string> {
    const path = join(this.runDir(runId), "artifacts", `${safeName(name)}.json`);
    await atomicWriteJson(path, value);
    const bytes = await readFile(path);
    await this.recordArtifact(runId, path, bytes.length, sha256(bytes));
    return this.relativePath(path);
  }

  async writeText(runId: string, name: string, value: string): Promise<string> {
    const path = join(this.runDir(runId), "artifacts", safeName(name));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, "utf8");
    await this.recordArtifact(runId, path, Buffer.byteLength(value));
    return this.relativePath(path);
  }

  async writeBuffer(runId: string, name: string, value: Uint8Array): Promise<string> {
    const path = join(this.runDir(runId), "artifacts", safeName(name));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
    await this.recordArtifact(runId, path, value.byteLength);
    return this.relativePath(path);
  }

  async recordExistingFile(runId: string, name: string, maxBytes = 64 * 1024 * 1024): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId) || safeName(name) !== name) throw new Error("Invalid existing artifact identity");
    const root = await realpath(this.rootDir);
    const runPath = this.runDir(runId);
    if (!(await lstat(runPath)).isDirectory() || !samePath(await realpath(runPath), join(root, runId))) {
      throw new Error("Run evidence directory is redirected");
    }
    const path = join(runPath, "artifacts", name);
    const direct = await lstat(path);
    if (!direct.isFile() || !samePath(await realpath(path), join(root, runId, "artifacts", name))
      || direct.size <= 0 || direct.size > maxBytes) throw new Error("Existing artifact is missing, redirected or oversized");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes = 0;
    const digest = createHash("sha256");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== direct.dev || info.ino !== direct.ino) throw new Error("Existing artifact changed during opening");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (bytes <= maxBytes) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, bytes);
        if (!bytesRead) break;
        digest.update(chunk.subarray(0, bytesRead));
        bytes += bytesRead;
      }
      if (bytes !== info.size || bytes > maxBytes) throw new Error("Existing artifact changed or exceeded its size limit");
    } finally { await file.close(); }
    await this.recordArtifact(runId, path, bytes, digest.digest("hex"));
    return this.relativePath(path);
  }

  async discardUnsealedFile(runId: string, name: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId) || safeName(name) !== name) throw new Error("Invalid existing artifact identity");
    const root = await realpath(this.rootDir);
    const runPath = this.runDir(runId);
    const artifacts = join(runPath, "artifacts");
    if (!samePath(await realpath(runPath), join(root, runId))
      || !samePath(await realpath(artifacts), join(root, runId, "artifacts"))) {
      throw new Error("Run artifact directory is redirected");
    }
    await unlink(join(artifacts, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async loadSummary(runId: string, expectedSha256?: string): Promise<RunSummary> {
    const { bytes, truncated } = await this.readRunFilePrefix(runId, "run.json", MAX_RUN_SUMMARY_BYTES);
    if (truncated) throw new Error("Run summary exceeds its read limit");
    if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(expectedSha256) || sha256(bytes) !== expectedSha256.toLowerCase())) throw new Error("Run summary does not match its pinned digest");
    const summary = RunSummarySchema.parse(JSON.parse(bytes.toString("utf8")));
    if (summary.runId !== runId) throw new Error("Run summary identity mismatch");
    return summary;
  }

  /** Read only a bounded prefix of an allowlisted Run file for CLI/MCP display. */
  async readPreview(runId: string, section: "summary" | "events" | "report" | "manifest", maxChars = 20_000): Promise<{ content: string; truncated: boolean }> {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_EVIDENCE_PREVIEW_CHARS) {
      throw new Error(`Evidence preview must be 1–${MAX_EVIDENCE_PREVIEW_CHARS} characters`);
    }
    if (!["summary", "events", "report", "manifest"].includes(section)) throw new Error("Invalid evidence section");
    const name = section === "summary" ? "run.json" : section === "events" ? "events.jsonl" : section === "report" ? "report.html" : "manifest.json";
    // Four UTF-8 bytes per UTF-16 code unit is a conservative prefix bound.
    const { bytes, truncated } = await this.readRunFilePrefix(runId, name, maxChars * 4);
    const content = bytes.toString("utf8");
    let preview = content.slice(0, maxChars);
    if (preview.length === maxChars && /[\uD800-\uDBFF]$/.test(preview) && /[\uDC00-\uDFFF]/.test(content.charAt(maxChars))) {
      preview = preview.slice(0, -1);
    }
    return { content: preview, truncated: truncated || content.length > preview.length };
  }

  /** Create a bounded, local integrity manifest without including the manifest itself. */
  async writeManifest(runId: string): Promise<{ path: string; bytes: number; sha256: string; files: number }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    await this.loadSummary(runId);
    const root = await realpath(this.rootDir);
    const manifest = await buildRunManifest(root, runId);
    const manifestPath = join(root, runId, "manifest.json");
    const bytes = Buffer.from(`${JSON.stringify(sanitizeEvidence(manifest), null, 2)}\n`, "utf8");
    await atomicWriteJson(manifestPath, manifest);
    return { path: relative(root, manifestPath).split(sep).join("/"), bytes: bytes.length, sha256: sha256(bytes), files: manifest.files.length };
  }

  /** Verify a previously exported manifest without rewriting it. */
  async verifyManifest(runId: string, expectedManifestSha256?: string): Promise<ManifestVerification> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    return verifyRunManifest(this.rootDir, runId, expectedManifestSha256);
  }

  async writeReport(summary: RunSummary): Promise<string> {
    const path = join(this.runDir(summary.runId), "report.html");
    const verdict = summary.verdict ?? "inconclusive";
    const sessionCapture = summary.execution?.kind === "session-network-capture";
    const sessionEvents: Array<{ timestamp: string; type: string; requestId: string; method: string; url: string; status: string; initiatingRunId: string; observedDuringRunId: string }> = [];
    let sessionEventsOmitted = 0;
    const artifactDigests = new Map<string, { bytes: number; sha256: string }>();
    const networkByStep = new Map<string, Array<{ timestamp: string; type: string; requestId: string; method: string; url: string; status?: number }>>();
    const stepTimes = new Map<string, { startedAt?: string; endedAt?: string }>();
    const omittedByStep = new Map<string, number>();
    let networkLogUnavailable = false;
    let eventLogIntegrity: "verified" | "changed" | "unavailable" | "unverified" = summary.eventLog?.status === "unavailable" ? "unavailable" : "unverified";
    if (summary.eventLog?.status === "sealed") {
      try {
        const current = await this.pinEventLog(summary.runId);
        eventLogIntegrity = current.bytes === summary.eventLog.bytes && current.sha256 === summary.eventLog.sha256 ? "verified" : "changed";
      } catch { eventLogIntegrity = "changed"; }
    }
    if (eventLogIntegrity === "changed" || eventLogIntegrity === "unavailable") networkLogUnavailable = true;
    try {
      if (!networkLogUnavailable) {
        for await (const event of this.readEvents(summary.runId, summary.eventLog?.status === "sealed" && summary.eventLog.bytes !== undefined && summary.eventLog.sha256
          ? { bytes: summary.eventLog.bytes, sha256: summary.eventLog.sha256 } : undefined)) {
          if (event.stepId && (event.type === "step.started" || event.type === "step.completed")) {
            const times = stepTimes.get(event.stepId) ?? {};
            if (event.type === "step.started") times.startedAt = event.timestamp;
            else times.endedAt = event.timestamp;
            stepTimes.set(event.stepId, times);
          }
          if (event.type === "artifact.created" && typeof event.payload.path === "string"
            && typeof event.payload.bytes === "number" && Number.isSafeInteger(event.payload.bytes) && event.payload.bytes > 0
            && typeof event.payload.sha256 === "string" && /^[a-f0-9]{64}$/i.test(event.payload.sha256)) {
            artifactDigests.set(event.payload.path, { bytes: event.payload.bytes, sha256: event.payload.sha256.toLowerCase() });
          }
          if (sessionCapture && event.type === "adapter.event" && ["request", "response", "requestfailed"].includes(String(event.payload.eventType))) {
            if (sessionEvents.length >= 100) sessionEventsOmitted++;
            else sessionEvents.push({ timestamp: event.timestamp, type: String(event.payload.eventType),
              requestId: String(event.payload.requestId ?? "unlinked"), method: String(event.payload.method ?? "unknown"),
              url: String(event.payload.url ?? "unavailable"), status: String(event.payload.status ?? ""),
              initiatingRunId: String(event.payload.initiatingRunId ?? "Unattributed"),
              observedDuringRunId: String(event.payload.observedDuringRunId ?? "Between Runs") });
          }
          if (event.type !== "adapter.event" || !event.stepId || !["request", "response", "requestfailed"].includes(String(event.payload.eventType))) continue;
          const events = networkByStep.get(event.stepId) ?? [];
          if (events.length >= 20) {
            omittedByStep.set(event.stepId, (omittedByStep.get(event.stepId) ?? 0) + 1);
            continue;
          }
          events.push({ timestamp: event.timestamp, type: String(event.payload.eventType), requestId: String(event.payload.requestId ?? "unlinked"),
            method: String(event.payload.method ?? "unknown"), url: String(event.payload.url ?? "unavailable"),
            ...(typeof event.payload.status === "number" ? { status: event.payload.status } : {}) });
          networkByStep.set(event.stepId, events);
        }
      }
    } catch {
      networkLogUnavailable = true;
      eventLogIntegrity = summary.eventLog?.status === "sealed" ? "changed" : "unavailable";
      artifactDigests.clear(); networkByStep.clear(); stepTimes.clear(); omittedByStep.clear();
      sessionEvents.length = 0; sessionEventsOmitted = 0;
    }
    const artifactIntegrity = new Map<string, "verified" | "missing" | "changed" | "unverified">();
    let integrityBudget = MAX_REPORT_INTEGRITY_BYTES;
    let integrityOmitted = 0;
    for (const item of new Set(summary.artifacts)) {
      if (!item.startsWith(`${summary.runId}/artifacts/`)) continue;
      const expected = artifactDigests.get(item);
      if (artifactIntegrity.size >= MAX_REPORT_INTEGRITY_ARTIFACTS || !expected || expected.bytes > integrityBudget) {
        artifactIntegrity.set(item, "unverified");
        integrityOmitted++;
        continue;
      }
      integrityBudget -= expected.bytes;
      artifactIntegrity.set(item, await verifyArtifact(this.rootDir, summary.runId, item, expected));
    }
    const links = (items: string[]) => items.filter((item) => item.startsWith(`${summary.runId}/artifacts/`) || item === `${summary.runId}/events.jsonl` || item === `${summary.runId}/run.json`).map((item) => {
      const label = escapeHtml(item.split("/").at(-1) ?? "evidence");
      const href = escapeHtml(item.slice(summary.runId.length + 1));
      const integrity = artifactIntegrity.get(item);
      return `<a href="${href}">${label}</a>${integrity ? ` <small class="integrity-${integrity}">${integrity}</small>` : ""}`;
    }).join(" ");
    const integrityCounts = [...artifactIntegrity.values()].reduce((counts, status) => {
      counts[status]++;
      return counts;
    }, { verified: 0, missing: 0, changed: 0, unverified: 0 });
    const executedSteps = new Map(summary.steps.map((step) => [step.stepId, step]));
    const rows = summary.charter.actions.map((plannedAction, index) => {
      const stepId = `step-${String(index + 1).padStart(3, "0")}`;
      const step = executedSteps.get(stepId);
      const status = step?.status ?? "not-run";
      const screenshotName = status === "passed" ? `${stepId}.png` : `${stepId}-failure.png`;
      const screenshotPath = `${summary.runId}/artifacts/${screenshotName}`;
      const screenshot = status === "not-run" ? `<span class="meta">Not run</span>`
        : step!.artifacts.includes(screenshotPath) && artifactIntegrity.get(screenshotPath) === "verified"
          ? `<figure><a href="artifacts/${screenshotName}"><img src="artifacts/${screenshotName}" alt="${escapeHtml(stepId)} ${escapeHtml(status)} screenshot" loading="lazy"></a><figcaption>${escapeHtml(status === "passed" ? "After action" : "At failure")}</figcaption></figure>`
          : `<span class="meta">${status === "passed" ? "Screenshot unavailable" : "Failure screenshot unavailable"}</span>`;
      const network = networkByStep.get(stepId) ?? [];
      const omitted = omittedByStep.get(stepId) ?? 0;
      const networkRequests = new Map<string, typeof network>();
      for (const item of network) {
        const related = networkRequests.get(item.requestId) ?? [];
        related.push(item);
        networkRequests.set(item.requestId, related);
      }
      const networkDetails = network.length || omitted
        ? `<details><summary>Network requests (${networkRequests.size}${omitted ? `, ${omitted} events omitted` : ""})</summary><ul>${[...networkRequests].map(([requestId, events]) => {
          const request = events.find((item) => item.type === "request");
          const response = events.find((item) => item.type === "response");
          const failure = events.find((item) => item.type === "requestfailed");
          const first = request ?? events[0]!;
          const outcome = response ? `response ${response.status ?? "unknown"} at ${response.timestamp}`
            : failure ? `request failed at ${failure.timestamp}` : "response not observed";
          return `<li><time>${escapeHtml(first.timestamp)}</time> · ${escapeHtml(requestId)} · ${escapeHtml(first.method)} ${escapeHtml(first.url)} · ${escapeHtml(outcome)}</li>`;
        }).join("")}</ul></details>`
        : "";
      const times = stepTimes.get(stepId);
      const timeline = times?.startedAt || times?.endedAt
        ? `<small class="meta">${times.startedAt ? `Started ${escapeHtml(times.startedAt)}` : "Start time unavailable"}${times.endedAt ? ` · Ended ${escapeHtml(times.endedAt)}` : " · End time unavailable"}</small>`
        : "";
      const response = step?.response;
      const responseError = ResponseErrorObservationSchema.safeParse(sanitizeEvidence(step?.responseError));
      const responseErrorPath = summary.runId + "/artifacts/" + stepId + "-response-error.json";
      const responseErrorDigest = responseError.success ? sha256(JSON.stringify(sanitizeEvidence(step?.responseError), null, 2) + "\n") : undefined;
      const responseErrorVerified = responseError.success && step?.artifacts.includes(responseErrorPath) && summary.artifacts.includes(responseErrorPath)
        && artifactIntegrity.get(responseErrorPath) === "verified" && artifactDigests.get(responseErrorPath)?.sha256 === responseErrorDigest;
      const responseErrorDetails = !step?.responseError ? "" : responseErrorVerified && responseError.success
        ? '<details><summary>' + (responseError.data.kind === "unexpected-status" ? 'Unexpected response diagnostics' : 'Incomplete response diagnostics')
          + '</summary><p>One request observed in this action window. This does not establish action causality or business acceptance.</p><dl><dt>Endpoint and status</dt><dd>'
          + escapeHtml(responseError.data.method) + ' ' + escapeHtml(responseError.data.url) + ' · ' + responseError.data.status
          + '</dd><dt>Declared statuses</dt><dd>' + escapeHtml(JSON.stringify(responseError.data.expectedStatuses))
          + '</dd><dt>Selected request fields</dt><dd><code>' + escapeHtml(JSON.stringify(responseError.data.requestFields ?? {}))
          + '</code></dd><dt>Selected query fields</dt><dd><code>' + escapeHtml(JSON.stringify(sanitizeEvidence(responseError.data.queryFields ?? {})))
          + '</code></dd><dt>Selected diagnostic fields</dt><dd><code>' + escapeHtml(JSON.stringify(responseError.data.fields))
          + '</code></dd><dt>Capture gaps</dt><dd>' + escapeHtml(JSON.stringify({ body: responseError.data.bodyGap, request: responseError.data.requestGap, fields: responseError.data.fieldGaps }))
          + '</dd></dl></details>'
        : '<p class="meta">' + (step?.responseError?.kind === "incomplete-fields" ? 'Incomplete' : 'Unexpected') + ' response diagnostics unavailable or changed.</p>';
      const formValue = FieldValueObservationSchema.safeParse(step?.receipt?.metadata.formValue);
      const formValuePath = summary.runId + "/artifacts/" + stepId + "-form-value.json";
      const formValueDigest = formValue.success ? sha256(JSON.stringify(sanitizeEvidence(formValue.data), null, 2) + "\n") : undefined;
      const formValueVerified = formValue.success && step?.artifacts.includes(formValuePath) && summary.artifacts.includes(formValuePath)
        && artifactIntegrity.get(formValuePath) === "verified" && artifactDigests.get(formValuePath)?.sha256 === formValueDigest;
      const formValueDetails = plannedAction.kind !== "waitForValue" ? "" : formValueVerified && formValue.success
        ? '<p><strong>Field value checkpoint:</strong> sampled matches for ' + formValue.data.stableForMs + ' ms over ' + formValue.data.polls + ' checks. Actual value not retained. This does not prove future stability or independent business acceptance.</p>'
        : '<p class="meta">Field value observation unavailable or changed.</p>';
      const responsePath = `${summary.runId}/artifacts/${stepId}-response.json`;
      const responseDigest = response ? sha256(`${JSON.stringify(sanitizeEvidence(response), null, 2)}\n`) : undefined;
      const responseVerified = Boolean(response && step?.artifacts.includes(responsePath) && summary.artifacts.includes(responsePath)
        && artifactIntegrity.get(responsePath) === "verified" && artifactDigests.get(responsePath)?.sha256 === responseDigest);
      const responseDetails = responseVerified && response
        ? `<details><summary>Captured API facts</summary><dl><dt>Endpoint</dt><dd>${escapeHtml(response.method)} ${escapeHtml(response.url)} · ${response.status}</dd><dt>Response body</dt><dd>${response.bodyBytes} bytes · SHA-256 ${escapeHtml(response.bodySha256)}</dd>${response.requestBodyBytes === undefined ? "" : `<dt>Request body</dt><dd>${response.requestBodyBytes} bytes · SHA-256 ${escapeHtml(response.requestBodySha256 ?? "unavailable")}</dd>`}${response.requestFields ? `<dt>Request fields</dt><dd><code>${escapeHtml(JSON.stringify(sanitizeEvidence(response.requestFields)))}</code></dd>` : ""}${response.queryFields ? `<dt>Selected query fields</dt><dd><code>${escapeHtml(JSON.stringify(sanitizeEvidence(response.queryFields)))}</code></dd>` : ""}<dt>Response fields</dt><dd><code>${escapeHtml(JSON.stringify(sanitizeEvidence(response.fields)))}</code></dd></dl></details>`
        : response ? '<p class="meta">Selected API facts unavailable or changed; inspect the original response evidence.</p>' : "";
      const evidenceFiles = step ? `<details><summary>Evidence files</summary>${links(step.artifacts)}</details>` : "";
      const snapshotPath = `${summary.runId}/artifacts/${stepId}-after.json`;
      const snapshotDigest = step?.afterSnapshot ? sha256(`${JSON.stringify(sanitizeEvidence(step.afterSnapshot), null, 2)}\n`) : undefined;
      const pages = step?.afterSnapshot?.pages;
      const pageDetails = pages && artifactIntegrity.get(snapshotPath) === "verified" && artifactDigests.get(snapshotPath)?.sha256 === snapshotDigest
        ? `<details><summary>Page inventory (${pages.length}${step?.afterSnapshot?.pagesTruncated ? ", truncated" : ""})</summary><ul>${pages.map((page) => `<li>${page.active ? "Selected" : "Open"}: ${escapeHtml(page.title)} · ${escapeHtml(page.url)} · ${page.eligibleForSwitch ? "Unique same-origin target" : "Not eligible for title selection"}</li>`).join("")}</ul><p class="meta">Screenshots follow the selected page. A requested recording covers the initial primary page only; other windows are outside that clip.</p></details>`
        : pages ? '<p class="meta">Page inventory unavailable or changed; inspect the saved snapshot.</p>' : "";
      const targetChecks = (step?.targetChecks ?? []).map((check, checkIndex) => {
        const path = `${summary.runId}/artifacts/${stepId}-${checkIndex === 0 ? "target-check" : "follow-up-target-check"}.json`;
        const expectedDigest = sha256(`${JSON.stringify(sanitizeEvidence(check), null, 2)}\n`);
        if (artifactIntegrity.get(path) !== "verified" || artifactDigests.get(path)?.sha256 !== expectedDigest) {
          return '<p class="meta">Target identity check unavailable or changed; inspect the saved evidence.</p>';
        }
        return `<details><summary>Target identity: ${escapeHtml(check.status)}</summary><p>Selector: <code>${escapeHtml(check.selector)}</code><br>Plan observation: ${escapeHtml(check.expected.observedAt)}<br>${check.expected.observationId ? `Observed state: <code>${escapeHtml(check.expected.observationId)}</code><br>` : ""}Checked before action: ${escapeHtml(check.observedAt)}</p><p>Expected ${escapeHtml(check.expected.role)} “${escapeHtml(check.expected.name)}” · observed ${escapeHtml(check.actual.role)} “${escapeHtml(check.actual.name)}”.</p>${check.changedFields.length ? `<p>Changed fields: ${escapeHtml(check.changedFields.join(", "))}. No mutation was performed on this target.</p>` : ""}<p>This comparison covers the declared control identity; it does not prove business correctness or detect every change to the page.</p></details>`;
      }).join("");
      const error = step?.error ?? (status === "not-run" ? "Not reached because an earlier step did not complete" : "");
      const errorDetails = step?.failureCode ? `Failure code: ${step.failureCode} · ${error}` : error;
      return `<tr id="${stepId}"><td data-label="Step">${escapeHtml(stepId)}${timeline}</td><td data-label="Planned action"><strong>${escapeHtml(plannedAction.kind)}</strong><details><summary>Planned action</summary><code>${escapeHtml(JSON.stringify(reportAction(plannedAction)))}</code></details></td><td data-label="Status">${escapeHtml(status)}</td><td data-label="Evidence">${screenshot}${pageDetails}${targetChecks}${evidenceFiles}${networkDetails}${responseDetails}${responseErrorDetails}${formValueDetails}</td><td data-label="Error">${escapeHtml(errorDetails)}</td></tr>`;
    }).join("");
    const unrunSteps = Math.max(0, summary.charter.actions.length - summary.steps.length);
    const assertions = summary.assertions.map((item) => `<li class="${item.passed ? "pass" : "fail"}">${escapeHtml(item.message)} ${links(item.evidence)}</li>`).join("");
    const oracles = (await Promise.all(summary.oracles.map(async (item, index) => {
      const definition = summary.charter.httpOracles?.find((oracle) => oracle.name === item.name);
      let details = "";
      if (definition) {
        const sourcePath = `${summary.runId}/artifacts/oracle-${index + 1}-source.json`;
        const reportPath = `${summary.runId}/artifacts/oracle-${index + 1}.json`;
        const sourceDigest = artifactDigests.get(sourcePath);
        const reportDigest = artifactDigests.get(reportPath);
        const reportContent = { ...item, evidence: item.sourceEvidenceArtifacts ?? [] };
        const reportExpected = sha256(`${JSON.stringify(sanitizeEvidence(reportContent), null, 2)}\n`);
        if (item.sourceEvidenceArtifacts?.includes(sourcePath) && item.evidence.includes(sourcePath) && item.evidence.includes(reportPath)
          && summary.artifacts.includes(sourcePath) && summary.artifacts.includes(reportPath)
          && sourceDigest && artifactIntegrity.get(sourcePath) === "verified"
          && artifactIntegrity.get(reportPath) === "verified" && reportDigest?.sha256 === reportExpected) {
          try {
            const saved = await readVerifiedOracleSource(this.rootDir, summary.runId, sourcePath, sourceDigest);
            details = renderOracleSource(saved, item.name, Object.keys(definition.query), definition.expectFields) ?? "";
          } catch {}
        }
        if (!details) details = '<p class="meta">Independent reader facts unavailable or changed; inspect original Oracle evidence.</p>';
      }
      return `<li class="${item.passed === true ? "pass" : item.passed === false ? "fail" : "meta"}">${item.verificationKind === "http-contract" ? "HTTP contract" : "Business"} — ${escapeHtml(item.name)}: ${escapeHtml(item.message)} ${links(item.evidence)}${details}</li>`;
    }))).join("");
    const runtimeFindings = (summary.runtimeFindings ?? []).map((finding) => `<tr><td>${escapeHtml(finding.kind)}</td><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.status)}</td><td>${escapeHtml(finding.message)}</td><td>${escapeHtml(finding.url ?? "")}${finding.statusCode === undefined ? "" : ` (${finding.statusCode})`}${finding.consoleLevel ? ` [${escapeHtml(finding.consoleLevel)}]` : ""}</td><td>${links(finding.evidence)}</td></tr>`).join("");
    const recordingPath = `${summary.runId}/artifacts/recording.webm`;
    const recordingDetails = `${summary.recording?.stopReason ? `<p class="meta">Recording stopped: ${escapeHtml(summary.recording.stopReason)}. Requested evidence is incomplete.</p>` : ""}${summary.recording?.status === "partial" ? '<p class="meta">Partial footage only; the complete requested recording interval is not covered.</p>' : ""}${summary.recording?.budget ? `<p class="meta">Recording budget: ${summary.recording.budget.maxDurationMs} ms · ${summary.recording.budget.maxBytes} temporary bytes. The disk monitor polls every 250 ms; browser shutdown may add bytes before the final size check.</p>` : ""}`;
    const recording = ((summary.recording?.status === "recorded" || summary.recording?.status === "partial") && summary.recording.artifact === recordingPath && summary.artifacts.includes(recordingPath) && artifactIntegrity.get(recordingPath) === "verified"
      ? '<video controls preload="metadata" src="artifacts/recording.webm" aria-label="Run recording"></video><p><a href="artifacts/recording.webm">Download recording</a></p><p class="meta">Initial primary page only; switching pages does not change this clip to another window. Selected-page screenshots and snapshots document other pages.</p>'
      : `<p class="meta">${summary.recording ? "Requested recording unavailable" : "Recording not requested"}</p>`) + recordingDetails;
    const selectedRecording = summary.recording?.selectedPages ? `<h3>Selected-page video</h3><p class="meta">${summary.recording.selectedPages.artifacts.length}/${summary.recording.selectedPages.observed} distinct selected window(s) saved; ${summary.recording.selectedPages.omitted} omitted. These clips begin when their pages opened, not necessarily at Mission start.</p>${summary.recording.selectedPages.artifacts.map((artifact) => {
      const filename = artifact.split("/").at(-1) ?? "";
      return summary.artifacts.includes(artifact) && artifactIntegrity.get(artifact) === "verified"
        ? `<p>Selected window ${escapeHtml(filename)}</p><video controls preload="metadata" src="artifacts/${escapeHtml(filename)}" aria-label="Selected-page recording ${escapeHtml(filename)}"></video><p><a href="artifacts/${escapeHtml(filename)}">Download selected-page recording</a></p>`
        : `<p class="meta">Selected-page recording ${escapeHtml(filename)} unavailable or changed.</p>`;
    }).join("")}${summary.recording.selectedPages.omitted ? '<p class="meta">Some selected windows have no saved recording.</p>' : ""}` : "";
    const observation = summary.charter.surfaceObservation;
    const planningAudit = observation ? await auditPlanningObservation(this, observation, { projectRoot: summary.projectRoot, workspaceRoot: summary.workspaceRoot,
      adapter: summary.execution?.adapter, sessionId: summary.execution?.sessionId, actions: [...summary.charter.actions, ...(summary.charter.negativeCases ?? []).flatMap((negative) => negative.actions)] }) : undefined;
    const planningStates = observation ? planningObservationSources(observation) : [];
    const planningLinks = (runId?: string) => planningAudit?.evidence.filter((ref) => !runId || ref.evidenceId.startsWith(`planning:${runId}/`))
      .map((ref) => `<a href="${escapeHtml(relative(this.runDir(summary.runId), ref.path).split(sep).map(encodeURIComponent).join("/"))}">${escapeHtml(ref.path.split(/[\\/]/).at(-1) ?? "Planning evidence")}</a>`).join(" · ") ?? "";
    const planningContext = planningAudit ? `<section><h2>Planning observation</h2><p>${escapeHtml(planningAudit.status)} · ${planningStates.length || 1} observed state(s)${observation?.sessionId ? ` · Session ${escapeHtml(observation.sessionId)}` : ""}</p><p>${escapeHtml(planningAudit.reason)}</p>${planningStates.length ? `<ol>${planningStates.map((state) => `<li><p>Observed state ${escapeHtml(state.source.runId)} · ${escapeHtml(state.capturedAt)}${state.controlsTruncated ? " · Controls truncated" : ""}</p><p>${planningLinks(state.source.runId)}</p></li>`).join("")}</ol>` : planningLinks()}<p class="meta">These observations are planning context; they do not establish complete workflow coverage and are separate from execution and independent business acceptance evidence.</p></section>` : "";
    const metadata = summary.charter.metadata;
    const replanSource = typeof metadata.replanOfRunId === "string" ? metadata.replanOfRunId : undefined;
    const replanLineage = replanSource
      ? `<h2>Replan lineage</h2><p>This Run is an explicitly approved replacement for source Run <code>${escapeHtml(replanSource)}</code>. Original step <code>${escapeHtml(String(metadata.replanSourceStepId ?? "unknown"))}</code> changed selector <code>${escapeHtml(String(metadata.replanOriginalSelector ?? "unknown"))}</code> to approved selector <code>${escapeHtml(String(metadata.replanApprovedSelector ?? "unknown"))}</code>. This verdict applies to the replacement Charter only; it does not rewrite or pass the source Run.</p>`
      : "";
    const bindingEvidence = summary.artifacts.filter((item) => /\/target-binding(?:-after-(?:setup|run))?\.json$/.test(item));
    const sessionTimeline = sessionCapture ? `<h2>Session network timeline</h2><p>Context metadata only; no product verdict. Matching request IDs associate responses across Run boundaries. Observation during a Run does not establish which action caused a request. This segment excludes process downtime.</p><p class="meta">Event log: ${eventLogIntegrity}. ${networkLogUnavailable ? "Saved timeline withdrawn; its original log is missing, changed or unavailable." : `${sessionEvents.length} event(s) shown · ${sessionEventsOmitted} omitted from this view. ${eventLogIntegrity === "unverified" ? "Historical log has no original pin. " : ""}<a href="events.jsonl">Full saved event log</a>`}</p>${networkLogUnavailable ? "" : `<table><thead><tr><th>Time / request ID</th><th>Event</th><th>Endpoint</th><th>Initiating Run</th><th>Observed during</th></tr></thead><tbody>${sessionEvents.map((event) => `<tr><td>${escapeHtml(event.timestamp)}<br>${escapeHtml(event.requestId)}</td><td>${escapeHtml(event.type)} ${escapeHtml(event.status)}</td><td>${escapeHtml(event.method)} ${escapeHtml(event.url)}</td><td>${escapeHtml(event.initiatingRunId)}</td><td>${escapeHtml(event.observedDuringRunId)}</td></tr>`).join("") || '<tr><td colspan="5">No saved network events.</td></tr>'}</tbody></table>`}` : "";
    if (sessionCapture) {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProofKit session evidence capture</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#172033}h1{font-size:28px;margin-bottom:8px}h2{font-size:20px;margin-top:24px}.meta{color:#637083;overflow-wrap:anywhere}.scope{padding:12px 16px;background:#edf1f7;border-radius:5px}.table-wrap{overflow-x:auto}table{width:100%;min-width:850px;table-layout:fixed;border-collapse:collapse}td,th{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #dce2ea;overflow-wrap:anywhere;font-size:13px}th{background:#edf1f7}video{display:block;max-width:100%;max-height:480px}a{color:#17685a}.integrity-missing,.integrity-changed{color:#b42318}.integrity-unverified{color:#8a5a00}li{margin-bottom:6px;overflow-wrap:anywhere}</style></head><body><h1>Session evidence capture</h1><p class="scope"><strong>Context only · no product verdict</strong><br>${escapeHtml(summary.findings[0] ?? "Capture completeness not recorded")}</p><p class="meta">Session: ${escapeHtml(summary.execution?.sessionId ?? "not recorded")}<br>Capture Run: ${escapeHtml(summary.runId)}<br>${escapeHtml(summary.startedAt)} → ${escapeHtml(summary.endedAt ?? "still recording")}</p>${summary.recording ? `<h2>Session recording</h2>${artifactIntegrity.get(recordingPath) === "verified" ? recording : `<p class="meta">Requested recording unavailable or changed.</p>${recordingDetails}`}<p class="meta">Initial primary page; includes the live interval between calls. Other windows require separate selected-page clips; process downtime is outside all clips. Video frames are not redacted and may contain sensitive data.</p>${selectedRecording}` : ""}<div class="table-wrap">${sessionTimeline}</div><h2>Evidence integrity</h2><p>${integrityCounts.verified} verified · ${integrityCounts.changed} changed · ${integrityCounts.missing} missing · ${integrityCounts.unverified} unverified${integrityOmitted ? ` · ${integrityOmitted} beyond the audit bound` : ""}. Digests check local file consistency, not external attestation.</p><p>${links(summary.artifacts)} · <a href="run.json">Capture summary</a></p><h2>Capture notes</h2><ul>${summary.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul></body></html>`;
      await writeFile(path, html, "utf8");
      return path;
    }
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProofKit ${escapeHtml(summary.runId)}</title>
<style>@media(max-width:700px){.steps-table{display:block!important;min-width:0!important}.steps-table thead{display:none}.steps-table tbody,.steps-table tr,.steps-table td{display:block;width:100%}.steps-table tr{border:1px solid #dce2ea;border-radius:6px;margin:16px 0;padding:8px}.steps-table td{border:0;padding:6px 4px}.steps-table td:before{content:attr(data-label);display:block;font-size:12px;font-weight:700;color:#637083;margin-bottom:4px}.steps-table td:empty{display:none}.steps-table figure img{max-width:100%}.steps-table details{max-width:100%}}</style>
<style>*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#172033;overflow-wrap:anywhere}h1{margin-bottom:4px}.meta{color:#637083}.verdict{display:inline-block;padding:6px 10px;border-radius:5px;background:#edf1f7;font-weight:700}.pass,.integrity-verified{color:#087443}.fail,.integrity-missing,.integrity-changed{color:#b42318}.integrity-unverified{color:#8a5a00}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:800px;margin-top:20px}td,th{border-bottom:1px solid #dce2ea;padding:9px;text-align:left;vertical-align:top}th{white-space:nowrap}figure{margin:0 0 8px}figure img{display:block;max-width:240px;max-height:160px;object-fit:contain;border:1px solid #dce2ea;border-radius:4px}figcaption{color:#637083;font-size:12px;margin-top:4px}details{max-width:300px}details a{display:inline-block;margin:4px 8px 0 0}video{display:block;max-width:100%;max-height:480px}</style></head>
<body><h1>ProofKit run</h1><p class="meta">${escapeHtml(summary.charter.intent)}<br>${escapeHtml(summary.runId)}</p><p class="verdict">${escapeHtml(verdict)}</p>
<h2>Execution</h2><p>Adapter: ${escapeHtml(summary.execution?.adapter ?? "not recorded")} · Visibility: ${escapeHtml(summary.execution?.visibility ?? "not recorded")}${summary.execution?.replayOfRunId ? ` · Replay of: ${escapeHtml(summary.execution.replayOfRunId)}` : ""}</p>
<h2>Target association</h2><p>${summary.targetBinding ? `${escapeHtml(summary.targetBinding.status)}: ${escapeHtml(summary.targetBinding.reason)}${summary.targetBinding.observedProjectRoot ? ` (${escapeHtml(summary.targetBinding.observedProjectRoot)})` : ""}` : "Not inspected by this runner."}</p>
<p>Continuity: ${escapeHtml(summary.targetContinuity ?? "not checked")}${summary.targetBindingAfterRun ? ` · Final: ${escapeHtml(summary.targetBindingAfterRun.status)}` : ""} ${links(bindingEvidence)}</p>
${replanLineage}
${planningContext}
<h2>Run recording</h2>${recording}
<h2>Resource cleanup</h2><p>${escapeHtml(summary.integrationCleanup?.status ?? "not recorded")}${summary.integrationCleanup ? ` (${summary.integrationCleanup.verifiedResources}/${summary.integrationCleanup.declaredResources} resources verified)` : ""} ${links(summary.integrationCleanup?.artifact ? [summary.integrationCleanup.artifact] : [])}</p>
<h2>Artifact integrity</h2><p>${integrityCounts.verified} verified · ${integrityCounts.changed} changed · ${integrityCounts.missing} missing · ${integrityCounts.unverified} unverified${integrityOmitted ? ` (${integrityOmitted} skipped by the integrity audit bound)` : ""}. Verified means current bytes match the Run artifact-creation digest; it is local integrity checking, not tamper-proof external attestation.</p>
<h2>Plan execution</h2><p class="meta">${summary.steps.length} / ${summary.charter.actions.length} planned action(s) reached execution; ${unrunSteps} not run. A not-run action is a plan gap, not a pass.</p>
<h2>Steps</h2>${summary.execution?.adapter === "web" ? '<p class="meta">New Web captures mask top-level password, one-time-code and card-number/security-code inputs plus elements marked data-proofkit-mask and any configured Web screenshotMaskSelectors. Historical screenshots, other text, iframes, canvas and all video frames may contain sensitive data. Review pixels before sharing evidence.</p>' : ""}<p class="meta">Event log: ${eventLogIntegrity}. Network entries show redacted method, URL and status only; request and response bodies are not captured here. ${networkLogUnavailable ? "The original event log is missing, changed or unavailable; step timing, network facts and artifact previews are withdrawn." : `${eventLogIntegrity === "unverified" ? "Historical event log has no original pin. " : ""}<a href="events.jsonl">Full event log</a>`}</p><div class="table-wrap"><table class="steps-table"><thead><tr><th>Step</th><th>Planned action</th><th>Status</th><th>Evidence</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Assertions</h2><ul>${assertions || "<li>No surface assertions declared.</li>"}</ul>
<h2>Oracle checks</h2><ul>${oracles || "<li>None registered.</li>"}</ul>
<h2>Runtime health</h2><p class="${(summary.runtimeHealth ?? "passed") === "passed" ? "pass" : (summary.runtimeHealth ?? "passed") === "failed" ? "fail" : "meta"}">${escapeHtml(summary.runtimeHealth ?? "passed")} (${(summary.runtimeFindings ?? []).length} finding(s))</p><div class="table-wrap"><table><thead><tr><th>Type</th><th>Severity</th><th>Status</th><th>Message</th><th>URL</th><th>Evidence</th></tr></thead><tbody>${runtimeFindings || "<tr><td colspan=\"6\">No runtime findings.</td></tr>"}</tbody></table></div>
<h2>Findings</h2><ul>${summary.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul></body></html>`;
    await writeFile(path, html, "utf8");
    return path;
  }

  private runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  private async readRunFilePrefix(runId: string, name: "run.json" | "events.jsonl" | "report.html" | "manifest.json", limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    const root = await realpath(this.rootDir);
    const runPath = this.runDir(runId);
    if (!(await lstat(runPath)).isDirectory() || !samePath(await realpath(runPath), join(root, runId))) {
      throw new Error("Run evidence directory is redirected");
    }
    const path = join(runPath, name);
    const direct = await lstat(path);
    if (!direct.isFile() || !samePath(await realpath(path), join(root, runId, name))) {
      throw new Error("Run evidence file is redirected");
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== direct.dev || info.ino !== direct.ino) {
        throw new Error("Run evidence file changed during opening");
      }
      const capacity = Math.min(limit + 1, Math.max(4_096, info.size + 1));
      const output = Buffer.allocUnsafe(capacity);
      let length = 0;
      while (length < output.length) {
        const result = await file.read(output, length, output.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      return { bytes: output.subarray(0, Math.min(length, limit)),
        truncated: length > limit || info.size > limit || length === capacity };
    } finally { await file.close(); }
  }

  private relativePath(path: string): string {
    return relative(this.rootDir, path).replaceAll("\\", "/");
  }

  private async recordArtifact(runId: string, path: string, bytes: number, digest?: string): Promise<void> {
    await this.appendEvent({
      runId,
      timestamp: new Date().toISOString(),
      type: "artifact.created",
      payload: {
        path: this.relativePath(path),
        bytes,
        sha256: digest ?? sha256(await readFile(path)),
      },
    });
  }
}

export function createRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
