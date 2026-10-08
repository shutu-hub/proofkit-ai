import { access, link, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { ProjectMapSchema, ProofkitConfigSchema, type ProjectMap, type ProofkitConfig } from "@proofkit/contracts";
import { resolveProjectContext, sameProjectPath, type ProjectContext, type ProjectContextOptions } from "./context.js";

export { defaultWorkspaceRoot, resolveProjectContext, resolveWithinWorkspace, sameProjectPath, type ProjectContext, type ProjectContextOptions } from "./context.js";

type PackageJson = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const DEFAULT_CONFIG: ProofkitConfig = {
  project: { root: ".", health: [], startupTimeoutMs: 60_000 },
  surfaces: {},
  planning: { provider: "deterministic", timeoutMs: 30_000 },
  integration: {},
  run: { timeoutMs: 300_000 },
  oracles: [],
  policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
};

const DEFAULT_INTEGRATION = `// ProofKit capabilities and business oracles live in this test workspace.\n// Keep writes limited to test data and always return cleanup from setup.\nexport default {\n  name: "project-integration",\n  version: "1",\n  capabilities: [],\n  oracles: [],\n};\n`;

export async function scanProject(projectRoot = process.cwd()): Promise<ProjectMap> {
  const root = resolve(projectRoot);
  const packageJson = await readJson<PackageJson>(join(root, "package.json"));
  const packagePaths = await findPackageJsons(root);
  const packages = [];
  let packageHasElectron = false;
  let packageHasWeb = false;
  for (const packagePath of packagePaths) {
    const item = await readJson<PackageJson>(packagePath);
    const dependencies = { ...(item?.dependencies ?? {}), ...(item?.devDependencies ?? {}) };
    packageHasElectron ||= Boolean(dependencies.electron || dependencies["electron-builder"]);
    packageHasWeb ||= Boolean(dependencies.vite || dependencies.vue || dependencies.react);
    packages.push({
      path: packagePath.slice(root.length + 1).replaceAll("\\", "/").replace(/\/package\.json$/, ""),
      name: item?.name,
      scripts: item?.scripts ?? {},
    });
  }

  const workspaces = Array.isArray(packageJson?.workspaces)
    ? packageJson.workspaces
    : packageJson?.workspaces?.packages ?? (await readWorkspaceFile(root));
  const allDeps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const hasDir = async (name: string) => directoryExists(join(root, name));
  const detected = {
    electron: Boolean(allDeps.electron || allDeps["electron-builder"] || packageHasElectron || packages.some((item) => item.name?.includes("desktop-shell"))) || await hasDir("electron"),
    web: Boolean(allDeps.vite || allDeps.vue || allDeps.react || packageHasWeb || packages.some((item) => item.path.startsWith("apps/"))),
    backend: (await hasDir("services")) || Boolean(await firstMatchingFile(root, ["go.mod", "pom.xml", "build.gradle"])) || packages.some((item) => item.path.startsWith("services/")),
  };

  return ProjectMapSchema.parse({
    root,
    packageManager: packageJson?.packageManager ?? (await fileExists(join(root, "pnpm-lock.yaml")) ? "pnpm" : undefined),
    packageName: packageJson?.name,
    scripts: packageJson?.scripts ?? {},
    workspaces: workspaces ?? [],
    packages,
    detected,
    generatedAt: new Date().toISOString(),
  });
}

export async function initProject(projectRoot = process.cwd(), options: ProjectContextOptions = {}): Promise<string> {
  const context = resolveProjectContext(projectRoot, options);
  // Validate an existing binding before creating even the starter integration.
  loadConfigForContext(context);
  await mkdir(context.metadataDir, { recursive: true });
  await writeIfMissing(context.configPath, stringify({ ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, root: context.projectRoot } }));
  // Another initializer may have won the exclusive config creation.
  loadConfigForContext(context);
  await writeIfMissing(join(context.metadataDir, "integration.mjs"), DEFAULT_INTEGRATION);
  return context.configPath;
}

export async function loadConfig(projectRoot = process.cwd(), options: ProjectContextOptions = {}): Promise<ProofkitConfig> {
  return loadConfigForContext(resolveProjectContext(projectRoot, options));
}

export function loadConfigForContext(context: ProjectContext, override?: ProofkitConfig): ProofkitConfig {
  const stored = existsSync(context.configPath)
    ? ProofkitConfigSchema.parse(parse(readFileSync(context.configPath, "utf8")))
    : ProofkitConfigSchema.parse({ ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, root: context.projectRoot } });
  assertConfigBinding(context, stored);
  if (!override) return stored;
  // Programmatic defaults still use '.', meaning the supplied source root.
  const config = ProofkitConfigSchema.parse({ ...override, project: { ...override.project, root: override.project.root === "." ? context.projectRoot : override.project.root } });
  assertConfigBinding(context, config);
  return config;
}

function assertConfigBinding(context: ProjectContext, config: ProofkitConfig): void {
  const boundRoot = resolve(context.workspaceRoot, config.project.root);
  if (!sameProjectPath(boundRoot, context.projectRoot)) {
    throw new Error(`ProofKit workspace is bound to another project: ${boundRoot}; requested ${context.projectRoot}`);
  }
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  // Publish a complete file atomically without replacing another initializer's binding.
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
}

async function findPackageJsons(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const directory of ["apps", "packages", "services"]) {
    const parent = join(root, directory);
    if (!(await directoryExists(parent))) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const path = join(parent, entry.name, "package.json");
      if (await fileExists(path)) results.push(path);
    }
  }
  return results.sort();
}

async function readWorkspaceFile(root: string): Promise<string[] | undefined> {
  const path = join(root, "pnpm-workspace.yaml");
  if (!(await fileExists(path))) return undefined;
  const parsed = parse(await readFile(path, "utf8")) as { packages?: string[] };
  return parsed?.packages;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!(await fileExists(path))) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function firstMatchingFile(root: string, names: string[]): Promise<string | undefined> {
  for (const name of names) if (await fileExists(join(root, name))) return name;
  return undefined;
}
