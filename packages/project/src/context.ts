import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ProjectContextOptions = {
  workspaceRoot?: string;
  /** Parent directory for automatically selected workspaces. */
  workspaceHome?: string;
};

export type ProjectContext = {
  projectRoot: string;
  workspaceRoot: string;
  metadataDir: string;
  configPath: string;
  legacy: boolean;
};

/** Resolve existing ancestors too, so a not-yet-created path has a stable identity. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

function pathIdentity(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sameProjectPath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

export function defaultWorkspaceRoot(projectRoot: string, workspaceHome?: string): string {
  const root = canonicalPath(projectRoot);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
  const hash = createHash("sha256").update(pathIdentity(root)).digest("hex").slice(0, 12);
  return canonicalPath(join(workspaceHome ?? process.env.PROOFKIT_WORKSPACE_HOME ?? join(homedir(), ".proofkit", "workspaces"), `${name}-${hash}`));
}

/** This resolver never creates files or directories in the tested project. */
export function resolveProjectContext(projectRoot = process.cwd(), options: ProjectContextOptions = {}): ProjectContext {
  const root = canonicalPath(projectRoot);
  const workspaceRoot = options.workspaceRoot !== undefined
    ? canonicalPath(options.workspaceRoot)
    : existsSync(join(root, ".proofkit")) ? root : defaultWorkspaceRoot(root, options.workspaceHome);
  const metadataDir = join(workspaceRoot, ".proofkit");
  return { projectRoot: root, workspaceRoot, metadataDir, configPath: join(metadataDir, "config.yaml"), legacy: sameProjectPath(root, workspaceRoot) };
}

export function resolveWithinWorkspace(workspaceRoot: string, candidate: string): string {
  const root = canonicalPath(workspaceRoot);
  const absolute = canonicalPath(resolve(root, candidate));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must stay within the ProofKit workspace");
  return absolute;
}
