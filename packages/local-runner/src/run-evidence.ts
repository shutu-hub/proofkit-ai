import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceRef } from "@proofkit/contracts";

/** Resolve only an existing, non-empty artifact belonging to this Run. */
export function materializedRunArtifact(ref: EvidenceRef, runId: string, path: string, evidenceDir: string): string | undefined {
  if (!path.startsWith(`${runId}/`) || path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return;
  const root = resolve(evidenceDir);
  const target = resolve(root, path);
  const within = relative(root, target);
  if (!within || outside(within) || resolve(ref.path) !== target) return;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalRun = realpathSync(resolve(root, runId));
    const actual = realpathSync(target);
    const stat = statSync(actual);
    if (!relative(resolve(canonicalRoot, runId), canonicalRun)
      && !outside(relative(canonicalRun, actual)) && stat.isFile() && stat.size > 0) return actual;
  } catch { /* Missing or inaccessible evidence cannot establish a fact. */ }
}

function outside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}
