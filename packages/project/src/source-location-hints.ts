import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_HINTS = 32;
const MAX_HINT_LENGTH = 1024;

/**
 * Check connector-provided source hints against the selected source checkout.
 * Existence establishes a place to investigate, never the cause of a failure.
 */
export async function verifySourceLocationHints(projectRoot: string, hints: readonly string[]): Promise<string[]> {
  const root = await realpath(projectRoot).catch(() => undefined);
  if (!root) return [];

  const verified: string[] = [];
  for (const hint of hints.slice(0, MAX_HINTS)) {
    if (!isRepositoryRelativeHint(hint)) continue;
    try {
      const target = await realpath(resolve(root, hint));
      const within = relative(root, target);
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
      if (!(await stat(target)).isFile()) continue;
      if (!verified.includes(hint)) verified.push(hint);
    } catch {
      // A missing or unreadable source file cannot support a location hint.
    }
  }
  return verified;
}

function isRepositoryRelativeHint(hint: string): boolean {
  if (!hint || hint.length > MAX_HINT_LENGTH || hint.includes("\\") || hint.includes("\0") || hint.includes(":")) return false;
  if (isAbsolute(hint) || hint.startsWith("/")) return false;
  return hint.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
