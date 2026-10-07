import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { RunSummarySchema, type RunEvent, type RunSummary } from "@proofkit/contracts";

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
    const links = (items: string[]) => items.filter((item) => item.startsWith(`${summary.runId}/artifacts/`)).map((item) => `<a href="${escapeHtml(item.slice(summary.runId.length + 1))}">${escapeHtml(item.split("/").at(-1) ?? "evidence")}</a>`).join(" ");
    const rows = summary.steps.map((step) => `<tr><td>${escapeHtml(step.stepId)}</td><td>${escapeHtml(step.action.kind)}</td><td>${escapeHtml(step.status)}</td><td>${links(step.artifacts)}</td><td>${escapeHtml(step.error ?? "")}</td></tr>`).join("");
    const assertions = summary.assertions.map((item) => `<li class="${item.passed ? "pass" : "fail"}">${escapeHtml(item.message)}</li>`).join("");
    const oracles = summary.oracles.map((item) => `<li class="${item.passed === true ? "pass" : item.passed === false ? "fail" : "meta"}">${escapeHtml(item.name)}: ${escapeHtml(item.message)} ${links(item.evidence)}</li>`).join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ProofKit ${escapeHtml(summary.runId)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:40px auto;color:#172033}h1{margin-bottom:4px}.meta{color:#637083}.verdict{display:inline-block;padding:6px 10px;border-radius:5px;background:#edf1f7;font-weight:700}.pass{color:#087443}.fail{color:#b42318}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{border-bottom:1px solid #dce2ea;padding:9px;text-align:left}</style></head>
<body><h1>ProofKit run</h1><p class="meta">${escapeHtml(summary.charter.intent)}<br>${escapeHtml(summary.runId)}</p><p class="verdict">${escapeHtml(verdict)}</p>
<h2>Steps</h2><table><thead><tr><th>Step</th><th>Action</th><th>Status</th><th>Evidence</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Assertions</h2><ul>${assertions || "<li>No surface assertions declared.</li>"}</ul>
<h2>Business oracles</h2><ul>${oracles || "<li>None registered.</li>"}</ul>
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

  private async recordArtifact(runId: string, path: string, bytes: number): Promise<void> {
    await this.appendEvent({
      runId,
      timestamp: new Date().toISOString(),
      type: "artifact.created",
      payload: {
        path: this.relativePath(path),
        bytes,
        sha256: sha256(await readFile(path)),
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
