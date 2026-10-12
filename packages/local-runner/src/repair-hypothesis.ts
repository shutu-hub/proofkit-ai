import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "@proofkit/evidence";
import type { RepairSourceAudit, RepairSourceReference, RepairSuggestion } from "@proofkit/contracts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Hash and line checks retain no source text. Matching references do not verify causality. */
export async function auditRepairSources(root: string, suggestions: RepairSuggestion[]): Promise<RepairSourceAudit[]> {
  const audits: RepairSourceAudit[] = [];
  for (const suggestion of suggestions.slice(0, 10)) {
    if (!suggestion.hypothesis) continue;
    audits.push({ suggestionId: suggestion.suggestionId, checkedAt: new Date().toISOString(),
      sourceScope: "current-checkout", causeStatus: "hypothesis",
      references: await Promise.all(suggestion.hypothesis.sourceReferences.map(async (ref) => ({
        path: ref.path, startLine: ref.startLine, endLine: ref.endLine,
        status: await inspectSourceReference(root, ref),
      }))),
    });
  }
  return audits;
}

async function inspectSourceReference(root: string, ref: RepairSourceReference): Promise<RepairSourceAudit["references"][number]["status"]> {
  try {
    const canonicalRoot = await realpath(root);
    const requested = resolve(canonicalRoot, ref.path);
    const canonical = await realpath(requested);
    const location = relative(canonicalRoot, canonical);
    if (!location || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) return "unavailable";
    const file = await open(canonical, "r");
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return "unavailable";
      // Read at most the admitted size plus one byte, even if the file grows.
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length !== info.size || canonical !== await realpath(requested)) return "unavailable";
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
    if (sha256(bytes) !== ref.sha256) return "changed";
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) return "unavailable";
    const lines = source.length === 0 ? 0 : source.split("\n").length - Number(source.endsWith("\n"));
    return ref.endLine <= lines ? "matching" : "invalid-range";
  } catch {
    return "unavailable";
  }
}
