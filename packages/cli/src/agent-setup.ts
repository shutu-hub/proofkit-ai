import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWorkspaceRoot, initProject, loadConfigForContext, resolveProjectContext, resolveWithinWorkspace } from "@proofkit/project";
import { PROOFKIT_CHARTER_AUTHORING, PROOFKIT_TEST_SKILL } from "./agent-skill.js";
import { installAihrTemplate } from "./template-install.js";

export type AgentHarness = "codex" | "claude-code" | "generic";
export type AgentSetupInput = {
  root: string;
  workspaceRoot?: string;
  harness: AgentHarness;
  installSkill?: boolean;
  skillsDir?: string;
  allowCapabilityWrites?: boolean;
  template?: "aihr";
};

type SetupRuntime = { serverPath?: string; nodePath?: string; userHome?: string };
type FileSet = Record<string, string>;

/** Export onboarding artifacts without loading connectors or changing the tested source. */
export async function setupAgent(input: AgentSetupInput, runtime: SetupRuntime = {}) {
  if (!["codex", "claude-code", "generic"].includes(input.harness)) throw new Error("Harness must be codex, claude-code or generic");
  if (input.template !== undefined && input.template !== "aihr") throw new Error(`Unknown reference template: ${input.template}`);
  if (input.skillsDir !== undefined && !input.installSkill) throw new Error("--skills-dir requires --install-skill");
  if (input.installSkill && input.harness === "generic" && !input.skillsDir) throw new Error("Generic Skill installation requires --skills-dir for the host's documented discovery location");
  const context = resolveProjectContext(input.root, {
    // Agent onboarding always chooses an external workspace, including legacy projects.
    workspaceRoot: input.workspaceRoot ?? defaultWorkspaceRoot(input.root),
  });
  if (!(await stat(context.projectRoot)).isDirectory()) throw new Error("Project root must be an existing directory");
  for (const path of [context.metadataDir, context.configPath, join(context.metadataDir, "integration.mjs")]) {
    assertExternal(context.projectRoot, resolveWithinWorkspace(context.workspaceRoot, path));
  }
  loadConfigForContext(context);

  const nodePath = canonical(runtime.nodePath ?? process.execPath);
  const serverPath = await resolveServer(runtime.serverPath);
  const env: Record<string, string> = { PROOFKIT_ROOT: context.projectRoot, PROOFKIT_WORKSPACE_ROOT: context.workspaceRoot };
  if (input.allowCapabilityWrites) env.PROOFKIT_ALLOW_CAPABILITY_WRITES = "1";
  const serverName = `proofkit-${digest([identity(context.projectRoot), identity(context.workspaceRoot)]).slice(0, 12)}`;
  const launcher = { command: nodePath, args: [serverPath], env };
  const configFile = input.harness === "codex" ? "mcp.toml" : "mcp.json";
  const config = input.harness === "codex"
    ? `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(nodePath)}\nargs = ${JSON.stringify([serverPath])}\n\n[mcp_servers.${serverName}.env]\n${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`
    : json({ mcpServers: { [serverName]: { type: "stdio", ...launcher } } });
  const skillFiles: FileSet = { "SKILL.md": PROOFKIT_TEST_SKILL, "references/charter-authoring.md": PROOFKIT_CHARTER_AUTHORING };
  const bundleKey = digest({ harness: input.harness, config, skillFiles, template: input.template }).slice(0, 20);
  const bundlePath = resolveWithinWorkspace(context.workspaceRoot, join(context.metadataDir, "agents", input.harness, bundleKey));
  assertExternal(context.projectRoot, bundlePath);
  const configPath = join(bundlePath, configFile);
  const registration = registrationCommand(input.harness, serverName, launcher);
  const manifest = {
    formatVersion: 1,
    harness: input.harness,
    projectRoot: context.projectRoot,
    workspaceRoot: context.workspaceRoot,
    defaultLevel: "core",
    ...(input.template ? { template: input.template } : {}),
    testVerdict: "not-asserted",
    connection: { status: "not-checked", serverName, ...launcher, configPath, ...(registration ? { registration } : {}) },
    skill: { name: "proofkit-test", path: join(bundlePath, "proofkit-test") },
    next: [...(input.template ? ["Review the installed AIHR connector as trusted local JavaScript before starting or checking the MCP server; examples are not registered tests."] : []),
      "Register the emitted MCP server with the host, or merge its native configuration fragment.",
      "Install the emitted proofkit-test Skill in the host's discovery directory, or rerun setup with --install-skill.",
      input.template ? "Configure isolated AIHR Web/Electron endpoints, test identity and independent business readers in the external workspace." : "Set Web/Electron endpoints and business checks in the external workspace config.",
      "Verify the host can call inspect_test_scope and confirm the returned projectRoot.",
      "Use proofkit-test for a natural-language test; environment and setup success are not product acceptance."],
  };
  const bundleFiles: FileSet = { [configFile]: config, "setup.json": json(manifest),
    ...Object.fromEntries(Object.entries(skillFiles).map(([path, content]) => [`proofkit-test/${path}`, content])) };
  await verifyIfPresent(bundlePath, bundleFiles);

  let skillPath: string | undefined;
  if (input.installSkill) {
    const skillsDir = canonical(input.skillsDir ?? join(runtime.userHome ?? homedir(), input.harness === "codex" ? ".agents" : ".claude", "skills"));
    assertExternal(context.projectRoot, skillsDir);
    skillPath = join(skillsDir, "proofkit-test");
    assertExternal(context.projectRoot, canonical(skillPath));
    await verifyIfPresent(skillPath, skillFiles);
  }

  // Validation above precedes publication; neither path imports integration.mjs.
  const templateInstallation = input.template === "aihr"
    ? await installAihrTemplate(context.projectRoot, context.workspaceRoot)
    : undefined;
  if (!templateInstallation) await initProject(context.projectRoot, { workspaceRoot: context.workspaceRoot });
  const bundleStatus = await publish(bundlePath, bundleFiles);
  const skillStatus = skillPath ? await publish(skillPath, skillFiles) : "not-requested";
  return { ...manifest, bundle: { path: bundlePath, status: bundleStatus },
    ...(templateInstallation ? { templateInstallation } : {}),
    skill: { ...manifest.skill, installation: { status: skillStatus, ...(skillPath ? { path: skillPath } : {}) } } };
}

function registrationCommand(harness: AgentHarness, serverName: string, launcher: { command: string; args: string[]; env: Record<string, string> }) {
  const envArgs = Object.entries(launcher.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  if (harness === "codex") return { command: "codex", args: ["mcp", "add", serverName, ...envArgs, "--", launcher.command, ...launcher.args] };
  if (harness === "claude-code") return { command: "claude", args: ["mcp", "add", "--scope", "user", ...envArgs, "--transport", "stdio", serverName, "--", launcher.command, ...launcher.args] };
  return undefined;
}

async function resolveServer(explicit?: string): Promise<string> {
  const candidates = explicit ? [resolve(explicit)] : [
    fileURLToPath(new URL("./server.js", import.meta.url)),
    fileURLToPath(new URL("../../mcp/dist/server.js", import.meta.url)),
  ];
  for (const path of candidates) {
    const info = await optionalStat(path);
    if (info?.isFile()) return canonical(path);
  }
  throw new Error("ProofKit MCP entrypoint is missing; install a built package or run pnpm build before agent setup");
}

function canonical(path: string): string { return resolveProjectContext(path, { workspaceRoot: path }).projectRoot; }
function identity(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }
function assertExternal(source: string, path: string): void {
  const rel = relative(identity(source), identity(path));
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error("Agent setup output must stay outside the tested source; choose an external --workspace or --skills-dir");
  }
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function optionalStat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/** Existing artifacts must match exactly; never overwrite a custom Skill or redirected file. */
async function verifyIfPresent(directory: string, files: FileSet): Promise<boolean> {
  const info = await optionalStat(directory);
  if (!info) return false;
  const conflict = () => new Error(`Existing agent artifact differs or is redirected: ${directory}; preserve it and choose another location`);
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict();
  const actual: string[] = [];
  const visit = async (parent: string, prefix = "") => {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw conflict();
      if (entry.isDirectory()) {
        if (!Object.keys(files).some((file) => file.startsWith(`${name}/`))) throw conflict();
        await visit(join(parent, entry.name), name);
      } else if (entry.isFile()) {
        actual.push(name);
        const expected = files[name];
        if (expected === undefined || (await stat(join(parent, entry.name))).size !== Buffer.byteLength(expected)
          || await readFile(join(parent, entry.name), "utf8") !== expected) throw conflict();
      } else throw conflict();
    }
  };
  await visit(directory);
  if (actual.length !== Object.keys(files).length) throw conflict();
  return true;
}

async function publish(directory: string, files: FileSet): Promise<"created" | "reused"> {
  if (await verifyIfPresent(directory, files)) return "reused";
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".proofkit-agent-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = resolveWithinWorkspace(temporary, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    }
    try { await rename(temporary, directory); } catch (error) {
      // A concurrent setup may have published the same complete bundle.
      if (!await verifyIfPresent(directory, files)) throw error;
      return "reused";
    }
    return "created";
  } finally {
    if (dirname(temporary) !== parent || !temporary.startsWith(join(parent, ".proofkit-agent-"))) throw new Error("Temporary agent directory escaped its parent");
    await rm(temporary, { recursive: true, force: true });
  }
}
