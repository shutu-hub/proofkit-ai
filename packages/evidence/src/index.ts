import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RunEventSchema, RunSummarySchema, type RunEvent, type RunSummary } from "@proofkit/contracts";

export { MissionReportStore } from "./mission-report.js";
export { LocalExecutionOwnership, type LocalExecutionLease } from "./local-ownership.js";

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

export function sanitizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = REDACT_KEYS.test(key) ? "[REDACTED]" : sanitizeEvidence(item);
  }
  return output;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
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
  async *readEvents(runId: string): AsyncGenerator<RunEvent> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
    const input = createReadStream(join(this.runDir(runId), "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = RunEventSchema.parse(JSON.parse(line));
        if (event.runId !== runId) throw new Error(`Event log contains another run: ${event.runId}`);
        yield event;
      }
    } finally {
      lines.close();
      input.destroy();
    }
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

  async loadSummary(runId: string): Promise<RunSummary> {
    const raw = await readFile(join(this.runDir(runId), "run.json"), "utf8");
    return RunSummarySchema.parse(JSON.parse(raw));
  }

  async writeReport(summary: RunSummary): Promise<string> {
    const path = join(this.runDir(summary.runId), "report.html");
    const verdict = summary.verdict ?? "inconclusive";
    const links = (items: string[]) => items.filter((item) => item.startsWith(`${summary.runId}/artifacts/`) || item === `${summary.runId}/events.jsonl` || item === `${summary.runId}/run.json`).map((item) => `<a href="${escapeHtml(item.slice(summary.runId.length + 1))}">${escapeHtml(item.split("/").at(-1) ?? "evidence")}</a>`).join(" ");
    const rows = summary.steps.map((step) => `<tr><td>${escapeHtml(step.stepId)}</td><td>${escapeHtml(step.action.kind)}</td><td>${escapeHtml(step.status)}</td><td>${links(step.artifacts)}</td><td>${escapeHtml(step.error ?? "")}</td></tr>`).join("");
    const assertions = summary.assertions.map((item) => `<li class="${item.passed ? "pass" : "fail"}">${escapeHtml(item.message)}</li>`).join("");
    const oracles = summary.oracles.map((item) => `<li class="${item.passed === true ? "pass" : item.passed === false ? "fail" : "meta"}">${escapeHtml(item.name)}: ${escapeHtml(item.message)} ${links(item.evidence)}</li>`).join("");
    const runtimeFindings = (summary.runtimeFindings ?? []).map((finding) => `<tr><td>${escapeHtml(finding.kind)}</td><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.status)}</td><td>${escapeHtml(finding.message)}</td><td>${escapeHtml(finding.url ?? "")}${finding.statusCode === undefined ? "" : ` (${finding.statusCode})`}${finding.consoleLevel ? ` [${escapeHtml(finding.consoleLevel)}]` : ""}</td><td>${links(finding.evidence)}</td></tr>`).join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ProofKit ${escapeHtml(summary.runId)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:40px auto;color:#172033}h1{margin-bottom:4px}.meta{color:#637083}.verdict{display:inline-block;padding:6px 10px;border-radius:5px;background:#edf1f7;font-weight:700}.pass{color:#087443}.fail{color:#b42318}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{border-bottom:1px solid #dce2ea;padding:9px;text-align:left}</style></head>
<body><h1>ProofKit run</h1><p class="meta">${escapeHtml(summary.charter.intent)}<br>${escapeHtml(summary.runId)}</p><p class="verdict">${escapeHtml(verdict)}</p>
<h2>Target association</h2><p>${summary.targetBinding ? `${escapeHtml(summary.targetBinding.status)}: ${escapeHtml(summary.targetBinding.reason)}${summary.targetBinding.observedProjectRoot ? ` (${escapeHtml(summary.targetBinding.observedProjectRoot)})` : ""}` : "Not inspected by this runner."}</p>
<h2>Resource cleanup</h2><p>${escapeHtml(summary.integrationCleanup?.status ?? "not recorded")}${summary.integrationCleanup ? ` (${summary.integrationCleanup.verifiedResources}/${summary.integrationCleanup.declaredResources} resources verified)` : ""} ${links(summary.integrationCleanup?.artifact ? [summary.integrationCleanup.artifact] : [])}</p>
<h2>Steps</h2><table><thead><tr><th>Step</th><th>Action</th><th>Status</th><th>Evidence</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Assertions</h2><ul>${assertions || "<li>No surface assertions declared.</li>"}</ul>
<h2>Business oracles</h2><ul>${oracles || "<li>None registered.</li>"}</ul>
<h2>Runtime health</h2><p class="${(summary.runtimeHealth ?? "passed") === "passed" ? "pass" : (summary.runtimeHealth ?? "passed") === "failed" ? "fail" : "meta"}">${escapeHtml(summary.runtimeHealth ?? "passed")} (${(summary.runtimeFindings ?? []).length} finding(s))</p><table><thead><tr><th>Type</th><th>Severity</th><th>Status</th><th>Message</th><th>URL</th><th>Evidence</th></tr></thead><tbody>${runtimeFindings || "<tr><td colspan=\"6\">No runtime findings.</td></tr>"}</tbody></table>
<h2>Findings</h2><ul>${summary.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul></body></html>`;
    await writeFile(path, html, "utf8");
    return path;
  }

  private runDir(runId: string): string {
    return join(this.rootDir, runId);
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
