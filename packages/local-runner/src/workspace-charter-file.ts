import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ResponseEndpointSchema, TestCharterSchema, type TestCharter } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { resolveWithinWorkspace } from "@proofkit/project";

export const MAX_CANDIDATE_BYTES = 128 * 1024;
const CANDIDATE_PATH = /^(?:\.proofkit\/)?charters\/[^/\\:\x00-\x1f]+\.ya?ml$/i;

export type WorkspaceCharterFileIssue = "invalid-path" | "unavailable" | "oversized" | "invalid-charter" | "endpoint-binding-unavailable" | "changed";

export class WorkspaceCharterFileError extends Error {
  readonly focusText?: string;
  constructor(readonly issue: WorkspaceCharterFileIssue, focusText?: string) {
    super({
      "invalid-path": "Candidate Charter path must name a direct YAML file in the external workspace Charter directory",
      unavailable: "Candidate Charter file is unavailable or redirected",
      oversized: "Candidate Charter file exceeds the read limit",
      "invalid-charter": "Candidate Charter YAML or schema is invalid",
      "endpoint-binding-unavailable": "Candidate Charter endpoint binding is unavailable or invalid; configure its ProofKit environment URL and inspect again",
      changed: "Candidate Charter digest changed since scope inspection; content or endpoint binding changed, inspect it again",
    }[issue]);
    // Search hints are internal only; serializing an error must not reveal UI text.
    Object.defineProperty(this, "focusText", { value: focusText, enumerable: false });
  }
}

/** One bounded reader for scope inspection and digest-pinned Mission creation. */
export async function readWorkspaceCharterFile(workspaceRoot: string, path: string, expectedSha256?: string): Promise<{ charter: TestCharter; sha256: string }> {
  if (path.length > 512 || !CANDIDATE_PATH.test(path)) throw new WorkspaceCharterFileError("invalid-path");
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new WorkspaceCharterFileError("invalid-path");
  const parts = path.split("/");
  const rawPath = join(workspaceRoot, ...parts);
  try {
    for (let depth = 1; depth < parts.length; depth++) {
      if (!(await lstat(join(workspaceRoot, ...parts.slice(0, depth)))).isDirectory()) throw new WorkspaceCharterFileError("unavailable");
    }
    if (!(await lstat(rawPath)).isFile()) throw new WorkspaceCharterFileError("unavailable");
    resolveWithinWorkspace(workspaceRoot, path);
  } catch { throw new WorkspaceCharterFileError("unavailable"); }

  let content: Buffer;
  try {
    const file = await open(rawPath, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new WorkspaceCharterFileError("unavailable");
      if (info.size > MAX_CANDIDATE_BYTES) throw new WorkspaceCharterFileError("oversized");
      const buffer = Buffer.alloc(MAX_CANDIDATE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_CANDIDATE_BYTES) throw new WorkspaceCharterFileError("oversized");
      content = buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof WorkspaceCharterFileError) throw error;
    throw new WorkspaceCharterFileError("unavailable");
  }

  const sourceSha256 = sha256(content);
  let parsed: unknown;
  try { parsed = parseYaml(content.toString("utf8")); }
  catch { throw new WorkspaceCharterFileError("invalid-charter"); }
  const focusText = candidateFocusText(parsed);
  let charter: TestCharter;
  let bindings: Array<{ location: string; url: string }>;
  try {
    bindings = bindEndpointUrls(parsed);
    charter = TestCharterSchema.parse(parsed);
  } catch (error) {
    if (error instanceof WorkspaceCharterFileError) throw new WorkspaceCharterFileError(error.issue, focusText);
    throw new WorkspaceCharterFileError("invalid-charter", focusText);
  }
  // A candidate digest pins both reviewed source bytes and the concrete URLs.
  // A changed environment URL must not silently redirect an approved Mission.
  const actualSha256 = bindings.length ? sha256(`${sourceSha256}\n${JSON.stringify(bindings)}`) : sourceSha256;
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new WorkspaceCharterFileError("changed");
  return { charter, sha256: actualSha256 };
}

type RecordValue = Record<string, unknown>;
const BINDING = /^\$env:((?:[A-Z][A-Z0-9]*_)?PROOFKIT_[A-Z0-9_]+)(\/[^?#]*)?$/;

function bindEndpointUrls(value: unknown): Array<{ location: string; url: string }> {
  if (!isRecord(value)) return [];
  const bindings: Array<{ location: string; url: string }> = [];
  const bind = (holder: RecordValue, location: string) => {
    const raw = holder.url;
    if (typeof raw !== "string" || !raw.startsWith("$env:")) return;
    const match = BINDING.exec(raw);
    if (!match) throw new WorkspaceCharterFileError("endpoint-binding-unavailable");
    const base = process.env[match[1]!]?.trim();
    if (!base || !ResponseEndpointSchema.safeParse(base).success) throw new WorkspaceCharterFileError("endpoint-binding-unavailable");
    const suffix = match[2] ?? "";
    if (suffix.split("/").some((part) => part === ".." || part === ".")) throw new WorkspaceCharterFileError("endpoint-binding-unavailable");
    const url = `${base.replace(/\/+$/, "")}${suffix}`;
    if (!ResponseEndpointSchema.safeParse(url).success) throw new WorkspaceCharterFileError("endpoint-binding-unavailable");
    const basePath = new URL(base).pathname.replace(/\/+$/, "");
    const endpoint = new URL(url);
    if (basePath && endpoint.pathname !== basePath && !endpoint.pathname.startsWith(`${basePath}/`)) {
      throw new WorkspaceCharterFileError("endpoint-binding-unavailable");
    }
    holder.url = url;
    bindings.push({ location, url });
  };
  const actions = (items: unknown, prefix: string) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      if (isRecord(item) && item.kind === "captureResponse" && isRecord(item.response)) {
        bind(item.response, `${prefix}[${index}].response.url`);
      }
    });
  };
  actions(value.actions, "actions");
  if (Array.isArray(value.negativeCases)) value.negativeCases.forEach((item, index) => {
    if (isRecord(item)) actions(item.actions, `negativeCases[${index}].actions`);
  });
  if (Array.isArray(value.httpOracles)) value.httpOracles.forEach((item, index) => {
    if (isRecord(item)) bind(item, `httpOracles[${index}].url`);
  });
  return bindings;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Search only declared UI words and intent; never values, URLs or metadata. */
export function candidateFocusText(value: unknown): string {
  if (!isRecord(value)) return "";
  const terms: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.length) terms.push(value.slice(0, 256)); };
  add(value.intent);
  const actions = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const action of items.slice(0, 100)) {
      if (isRecord(action) && action.kind === "waitForText") add(action.text);
      if (isRecord(action) && action.kind === "captureResponse") add(action.name);
    }
  };
  actions(value.actions);
  if (Array.isArray(value.negativeCases)) for (const item of value.negativeCases.slice(0, 20)) {
    if (isRecord(item)) { add(item.title); actions(item.actions); }
  }
  if (Array.isArray(value.assertions)) for (const assertion of value.assertions.slice(0, 100)) {
    if (isRecord(assertion)) add(assertion.text);
  }
  return terms.join(" ").slice(0, 4096);
}
