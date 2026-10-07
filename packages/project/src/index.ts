import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { ProjectMapSchema, ProofkitConfigSchema, type ProjectMap, type ProofkitConfig } from "@proofkit/contracts";

type PackageJson = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const DEFAULT_CONFIG: ProofkitConfig = {
  project: { root: ".", health: [] },
  surfaces: {},
  policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
};

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

export async function initProject(projectRoot = process.cwd()): Promise<string> {
  const configPath = join(resolve(projectRoot), ".proofkit", "config.yaml");
  await mkdir(join(resolve(projectRoot), ".proofkit"), { recursive: true });
  if (!(await fileExists(configPath))) {
    await writeFile(configPath, stringify(DEFAULT_CONFIG), "utf8");
  }
  return configPath;
}

export async function loadConfig(projectRoot = process.cwd()): Promise<ProofkitConfig> {
  const configPath = join(resolve(projectRoot), ".proofkit", "config.yaml");
  if (!(await fileExists(configPath))) return ProofkitConfigSchema.parse(DEFAULT_CONFIG);
  const source = await readFile(configPath, "utf8");
  return ProofkitConfigSchema.parse(parse(source));
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
