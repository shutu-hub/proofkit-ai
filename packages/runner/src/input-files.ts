import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { FixturePathSchema, type InputFileFact } from "@proofkit/contracts";
export type { InputFileFact } from "@proofkit/contracts";

/** One action may select at most 20 MiB in total, including all selected files. */
export const MAX_INPUT_FILE_BYTES = 20 * 1024 * 1024;

/** Transient bytes never belong in a Charter, receipt, event or persisted Run. */
export type ResolvedInputFile = InputFileFact & { buffer: Buffer };
export type SurfaceActionContext = { inputFiles?: readonly ResolvedInputFile[] };

export class InputFileError extends Error {}

export async function resolveInputFiles(workspaceRoot: string | undefined, references: readonly string[], signal: AbortSignal): Promise<ResolvedInputFile[]> {
  if (!workspaceRoot) throw new InputFileError("File selection requires an explicit test workspace");
  if (references.length < 1 || references.length > 10) throw new InputFileError("File selection requires 1-10 fixture references");
  let budget = MAX_INPUT_FILE_BYTES;
  const files: ResolvedInputFile[] = [];
  try {
    signal.throwIfAborted();
    const workspace = await realpath(workspaceRoot);
    const fixtureRoot = resolve(workspace, ".proofkit", "fixtures");
    // Do not allow the fixture directory itself to redirect into config or credentials.
    if (relative(fixtureRoot, await realpath(fixtureRoot)) !== "") throw new InputFileError("Fixture root must not redirect through a symlink");
    for (const fixture of references) {
      signal.throwIfAborted();
      if (!FixturePathSchema.safeParse(fixture).success) throw new InputFileError("Invalid fixture reference; use .proofkit/fixtures/<file>");
      const requested = resolve(workspace, fixture);
      const actual = await realpath(requested);
      if (!within(fixtureRoot, actual)) throw new InputFileError("Fixture resolves outside the test fixture directory");
      const before = await stat(actual);
      if (!before.isFile()) throw new InputFileError("Fixture must be a regular file");
      if (before.size > budget) throw new InputFileError("Selected fixtures exceed the 20 MiB action limit");
      const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new InputFileError("Fixture must be a regular file");
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size
          || before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) {
          throw new InputFileError("Fixture changed while opening; prepare a stable test file");
        }
        if (opened.size > budget) throw new InputFileError("Selected fixtures exceed the 20 MiB action limit");
        const current = await realpath(requested);
        if (!within(fixtureRoot, current) || relative(actual, current) !== "") throw new InputFileError("Fixture path changed while opening");
        const currentStat = await stat(current);
        if (opened.dev !== currentStat.dev || opened.ino !== currentStat.ino) throw new InputFileError("Fixture path changed while opening");
        // Read no more than the observed size plus one byte; growing files cannot exhaust memory.
        const bytes = Buffer.alloc(opened.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        signal.throwIfAborted();
        const after = await handle.stat();
        if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new InputFileError("Fixture changed while reading; prepare a stable test file");
        }
        const finalPath = await realpath(requested);
        const finalStat = await stat(finalPath);
        if (relative(fixtureRoot, await realpath(fixtureRoot)) !== "" || !within(fixtureRoot, finalPath)
          || relative(actual, finalPath) !== "" || opened.dev !== finalStat.dev || opened.ino !== finalStat.ino
          || opened.size !== finalStat.size || opened.mtimeMs !== finalStat.mtimeMs || opened.ctimeMs !== finalStat.ctimeMs) {
          throw new InputFileError("Fixture path changed while reading; prepare a stable test file");
        }
        signal.throwIfAborted();
        const buffer = bytes.subarray(0, offset);
        budget -= buffer.length;
        files.push({ fixture, name: basename(fixture), sizeBytes: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"), mimeType: mimeType(fixture), buffer });
      } finally {
        await handle.close();
      }
    }
    return files;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof InputFileError) throw error;
    // Filesystem diagnostics contain absolute paths. Keep those out of test evidence.
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new InputFileError(`Test fixture cannot be read${typeof code === "string" ? ` (${code})` : ""}`);
  }
}

export function inputFileFacts(files: readonly ResolvedInputFile[]): InputFileFact[] {
  return files.map(({ buffer: _buffer, ...fact }) => fact);
}

/** File order is significant, object property insertion order is not. */
export function sameInputFileFacts(expected: readonly InputFileFact[], actual: readonly InputFileFact[]): boolean {
  return expected.length === actual.length && expected.every((file, index) => {
    const other = actual[index]!;
    return file.fixture === other.fixture && file.name === other.name && file.sizeBytes === other.sizeBytes
      && file.sha256 === other.sha256 && file.mimeType === other.mimeType;
  });
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\") && !isAbsolute(value);
}

function mimeType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", json: "application/json", csv: "text/csv" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}
