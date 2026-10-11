import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { TestCharter } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import { IntentPlanner } from "@proofkit/planner";
import { resolveWithinWorkspace } from "@proofkit/project";

export const MAX_CANDIDATE_BYTES = 128 * 1024;
const CANDIDATE_PATH = /^(?:\.proofkit\/)?charters\/[^/\\:\x00-\x1f]+\.ya?ml$/i;

export type WorkspaceCharterFileIssue = "invalid-path" | "unavailable" | "oversized" | "invalid-charter" | "changed";

export class WorkspaceCharterFileError extends Error {
  constructor(readonly issue: WorkspaceCharterFileIssue) {
    super({
      "invalid-path": "Candidate Charter path must name a direct YAML file in the external workspace Charter directory",
      unavailable: "Candidate Charter file is unavailable or redirected",
      oversized: "Candidate Charter file exceeds the read limit",
      "invalid-charter": "Candidate Charter YAML or schema is invalid",
      changed: "Candidate Charter digest changed since scope inspection; inspect it again",
    }[issue]);
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

  const actualSha256 = sha256(content);
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new WorkspaceCharterFileError("changed");
  try { return { charter: new IntentPlanner().fromYaml(content.toString("utf8")), sha256: actualSha256 }; }
  catch { throw new WorkspaceCharterFileError("invalid-charter"); }
}
