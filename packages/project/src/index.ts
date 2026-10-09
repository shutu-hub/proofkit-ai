import { access, link, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { ProjectMapSchema, ProofkitConfigSchema, type ProjectMap, type ProofkitConfig, type RouteHttpMethod } from "@proofkit/contracts";
import { resolveProjectContext, sameProjectPath, type ProjectContext, type ProjectContextOptions } from "./context.js";

export { defaultWorkspaceRoot, resolveProjectContext, resolveWithinWorkspace, sameProjectPath, type ProjectContext, type ProjectContextOptions } from "./context.js";
export { captureSourceState } from "./source-state.js";
export { inspectTargetBinding } from "./target-binding.js";

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
  charters: [],
  suites: [],
  run: { timeoutMs: 300_000 },
  oracles: [],
  policies: {
    environment: "test",
    sideEffects: "confirm",
    saveSensitivePayloads: false,
    runtime: {
      mode: "record",
      pageErrors: true,
      requestFailures: false,
      consoleLevels: ["error"],
      failedResponses: { enabled: true, include4xx: false },
      allowUrlPatterns: [],
      ignoreUrlPatterns: [],
      blockConsolePatterns: [],
    },
    targetBinding: "block-different",
  },
};

const DEFAULT_INTEGRATION = `// ProofKit capabilities and business oracles live in this test workspace.\n// Keep writes limited to test data and always return cleanup from setup.\nexport default {\n  name: "project-integration",\n  version: "1",\n  capabilities: [],\n  oracles: [],\n};\n`;

export async function scanProject(projectRoot = process.cwd()): Promise<ProjectMap> {
  const root = resolve(projectRoot);
  const packageJson = await readJson<PackageJson>(join(root, "package.json"));
  const packagePaths = await findPackageJsons(root);
  const packages = [];
  const dependencyNames = new Set<string>();
  let packageHasElectron = false;
  let packageHasWeb = false;
  for (const packagePath of packagePaths) {
    const item = await readJson<PackageJson>(packagePath);
    const dependencies = { ...(item?.dependencies ?? {}), ...(item?.devDependencies ?? {}) };
    for (const dependency of Object.keys(dependencies)) dependencyNames.add(dependency);
    packageHasElectron ||= Boolean(dependencies.electron || dependencies["electron-builder"]);
    packageHasWeb ||= Boolean(dependencies.vite || dependencies.vue || dependencies.react);
    packages.push({
      path: packagePath.slice(root.length + 1).replaceAll("\\", "/").replace(/\/package\.json$/, ""),
      name: item?.name,
      scripts: item?.scripts ?? {},
    });
  }

  for (const dependency of Object.keys({ ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) })) {
    dependencyNames.add(dependency);
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
  const inventory = await scanInventory(root, packageJson?.scripts ?? {}, packages, dependencyNames);

  return ProjectMapSchema.parse({
    root,
    packageManager: packageJson?.packageManager ?? (await fileExists(join(root, "pnpm-lock.yaml")) ? "pnpm" : undefined),
    packageName: packageJson?.name,
    scripts: packageJson?.scripts ?? {},
    workspaces: workspaces ?? [],
    packages,
    detected,
    inventory,
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

type InventoryEntryPoint = {
  kind: "web" | "electron" | "backend" | "test" | "script";
  path: string;
  reason: string;
};

type InventoryRouteHint = {
  kind: "web" | "api";
  path: string;
  source: string;
  line: number;
  method?: RouteHttpMethod;
};

const SOURCE_EXTENSIONS = new Set([".cjs", ".css", ".go", ".java", ".js", ".jsx", ".mjs", ".py", ".rs", ".scss", ".ts", ".tsx", ".vue"]);
const CONFIG_EXTENSIONS = new Set([".ini", ".json", ".toml", ".yaml", ".yml"]);
const IGNORED_DIRECTORIES = new Set([".agents", ".cache", ".codex", ".git", ".pnpm", ".proofkit", ".turbo", ".venv", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);
const MAX_INVENTORY_FILES = 4_000;
const MAX_ROUTE_HINTS = 200;
const MAX_SOURCE_BYTES = 1_000_000;
const execFileAsync = promisify(execFile);

async function scanInventory(root: string, rootScripts: Record<string, string>, packages: Array<{ path: string; scripts: Record<string, string> }>, dependencies: Set<string>): Promise<{
  filesScanned: number;
  truncated: boolean;
  source: "git" | "filesystem";
  sourceFiles: number;
  testFiles: number;
  configFiles: number;
  testFrameworks: string[];
  entryPoints: InventoryEntryPoint[];
  routeHints: InventoryRouteHint[];
}> {
  const entryPoints: InventoryEntryPoint[] = [];
  const routeHints: InventoryRouteHint[] = [];
  const seenEntries = new Set<string>();
  const seenRoutes = new Set<string>();
  let filesScanned = 0;
  let truncated = false;
  let sourceFiles = 0;
  let testFiles = 0;
  let configFiles = 0;

  const addEntry = (entry: InventoryEntryPoint) => {
    const key = `${entry.kind}:${entry.path}`;
    if (seenEntries.has(key) || entryPoints.length >= 1_000) return;
    seenEntries.add(key);
    entryPoints.push(entry);
  };
  const addRoute = (route: InventoryRouteHint) => {
    const key = `${route.kind}:${route.path}:${route.method ?? ""}:${route.source}:${route.line}`;
    if (seenRoutes.has(key) || routeHints.length >= MAX_ROUTE_HINTS * 5) return;
    seenRoutes.add(key);
    routeHints.push(route);
  };

  const addScriptEntries = (packagePath: string, scripts: Record<string, string>) => {
    for (const name of Object.keys(scripts)) {
      if (/^(dev|start|preview|serve|build|test|e2e|integration|smoke)(:|$)/i.test(name)) {
        addEntry({
          kind: /^test|e2e|integration|smoke/i.test(name) ? "test" : "script",
          path: packagePath,
          reason: `package script ${name}`,
        });
      }
    }
  };
  addScriptEntries("package.json", rootScripts);
  for (const item of packages) addScriptEntries(`${item.path}/package.json`, item.scripts);

  const classifyEntry = (path: string): InventoryEntryPoint["kind"] | undefined => {
    const normalized = path.toLowerCase();
    const fileName = basename(normalized);
    if (/(^|\/)(electron|desktop|desktop-shell)(\/|$)/.test(normalized) && /^(main|background|preload|electron|index)\.[cm]?[jt]sx?$/.test(fileName)) return "electron";
    if (/(^|\/)(services|service|server|cmd)(\/|$)/.test(normalized) && /^(main|server|router|handler|index)\.[cm]?[jt]sx?$|^main\.(go|java|py)$/.test(fileName)) return "backend";
    if (/^(app|main|router|routes|index)\.(vue|jsx?|tsx?)$/.test(fileName)) return "web";
    return undefined;
  };

  const gitFiles = await listGitFiles(root);
  const source = gitFiles ? "git" : "filesystem";
  const candidates = (gitFiles ?? await listFilesystemFiles(root)).filter(shouldIncludeInventoryPath);
  candidates.sort((left, right) => inventoryPriority(right) - inventoryPriority(left) || left.localeCompare(right));
  truncated = candidates.length > MAX_INVENTORY_FILES;
  for (const path of candidates.slice(0, MAX_INVENTORY_FILES)) {
    const absolute = resolve(root, path);
    const withinRoot = relative(root, absolute);
    if (isAbsolute(path) || withinRoot === ".." || withinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
    let metadata;
    try { metadata = await lstat(absolute); } catch { continue; }
    if (!metadata.isFile()) continue;
    filesScanned += 1;
    const extension = extname(path).toLowerCase();
    if (isTestFile(path)) testFiles += 1;
    if (SOURCE_EXTENSIONS.has(extension)) {
      sourceFiles += 1;
      const kind = classifyEntry(path);
      if (kind) addEntry({ kind, path, reason: "conventional entry point" });
      if (!isTestFile(path) && !(await readRouteHints(absolute, path, addRoute))) truncated = true;
    } else if (CONFIG_EXTENSIONS.has(extension) || /(^|\/)Dockerfile[^/]*$|\.env(?:\.|$)/i.test(path)) {
      configFiles += 1;
    }
  }

  const testFrameworks: string[] = ([
    ["vitest", "vitest"], ["jest", "jest"], ["@playwright/test", "playwright"], ["playwright", "playwright"],
    ["cypress", "cypress"], ["@wdio/cli", "webdriverio"], ["mocha", "mocha"], ["pytest", "pytest"],
  ] as Array<[string, string]>).filter(([dependency]) => dependencies.has(dependency)).map(([, framework]) => framework);
  if (testFiles > 0) testFrameworks.push("repository-tests");

  entryPoints.sort((left, right) => inventoryPriority(right.path) - inventoryPriority(left.path) || left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  routeHints.sort((left, right) => inventoryPriority(right.source) - inventoryPriority(left.source) || left.source.localeCompare(right.source) || left.line - right.line);
  truncated ||= entryPoints.length > 200 || routeHints.length > MAX_ROUTE_HINTS;
  return {
    filesScanned,
    truncated,
    source,
    sourceFiles,
    testFiles,
    configFiles,
    testFrameworks: [...new Set(testFrameworks)].sort(),
    entryPoints: entryPoints.slice(0, 200),
    routeHints: routeHints.slice(0, MAX_ROUTE_HINTS),
  };
}

async function listGitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    });
    const files = [...new Set(stdout.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/")))];
    if (files.length === 0) {
      // A source nested in an ignored directory of a *parent* repository is
      // independent of that repository. Scan its own files instead.
      const { stdout: topLevel } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", timeout: 10_000 });
      if (!sameProjectPath(topLevel.trim(), root)) return undefined;
    }
    return files;
  } catch {
    return undefined;
  }
}

async function listFilesystemFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const directories: string[][] = [[], [], [], [root]];
  const nextDirectory = (): string | undefined => {
    for (let priority = directories.length - 1; priority >= 0; priority--) {
      const directory = directories[priority]?.shift();
      if (directory) return directory;
    }
    return undefined;
  };
  for (let directory = nextDirectory(); directory && files.length <= MAX_INVENTORY_FILES; directory = nextDirectory()) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          const child = join(directory, entry.name);
          directories[inventoryPriority(relative(root, child))]!.push(child);
        }
      } else if (entry.isFile()) {
        files.push(relative(root, join(directory, entry.name)).replaceAll("\\", "/"));
        if (files.length > MAX_INVENTORY_FILES) break;
      }
    }
  }
  return files;
}

function shouldIncludeInventoryPath(path: string): boolean {
  const directories = path.replaceAll("\\", "/").split("/").slice(0, -1);
  return directories.every((directory) => !directory.startsWith(".") && !IGNORED_DIRECTORIES.has(directory.toLowerCase()));
}

async function readRouteHints(path: string, source: string, add: (route: InventoryRouteHint) => void): Promise<boolean> {
  let content: string;
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_SOURCE_BYTES) return false;
    content = await readFile(path, "utf8");
  } catch { return false; }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\bpath\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      if (isStaticRoute(match[1])) add({ kind: "web", path: match[1], source, line: index + 1 });
    }
    for (const match of line.matchAll(/\b(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) {
      if (isStaticRoute(match[2])) add({ kind: "api", path: match[2], source, line: index + 1, method: match[1]!.toUpperCase() as RouteHttpMethod });
    }
  });
  return true;
}

function isStaticRoute(value: string | undefined): value is string {
  return Boolean(value && value.startsWith("/") && value.length <= 256 && !/[?#\s{}$]/.test(value));
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/.test(path);
}

function inventoryPriority(path: string): number {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized === "package.json" || normalized.startsWith("apps/") || normalized.startsWith("services/") || normalized.startsWith("packages/")) return 3;
  if (normalized.startsWith("src/") || normalized.includes("/src/")) return 2;
  return 1;
}
