import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { TestCharterSchema } from "@proofkit/contracts";
import { resolveProjectContext } from "@proofkit/project";
import { setupAgent, type AgentHarness } from "./agent-setup.js";
import { createProgram } from "./main.js";

const scratches: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "proofkit-agent-setup-"));
  scratches.push(scratch);
  const root = join(scratch, "source 用户 app");
  const workspaceRoot = join(scratch, "external workspace");
  const userHome = join(scratch, "personal home");
  const serverPath = join(scratch, "server with spaces.js");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"untouched-source"}');
  await writeFile(serverPath, "// Entry point placeholder; protocol behavior is covered by installed distribution smoke.\n");
  return { scratch, root, workspaceRoot, userHome, serverPath };
}

describe("Agent onboarding", () => {
  it.each(["codex", "claude-code", "generic"] as const)("exports %s artifacts with an explicit unconnected state and no source writes", async (harness) => {
    const f = await fixture();
    const result = await setupAgent({ ...f, harness }, f);
    const context = resolveProjectContext(f.root, { workspaceRoot: f.workspaceRoot });
    expect(result).toMatchObject({ projectRoot: context.projectRoot, workspaceRoot: context.workspaceRoot,
      defaultLevel: "core", testVerdict: "not-asserted", connection: { status: "not-checked", args: [f.serverPath] },
      bundle: { status: "created" }, skill: { installation: { status: "not-requested" } } });
    expect(result.connection.env).toEqual({ PROOFKIT_ROOT: context.projectRoot, PROOFKIT_WORKSPACE_ROOT: context.workspaceRoot });
    if (harness !== "codex") {
      const config = JSON.parse(await readFile(result.connection.configPath, "utf8"));
      expect(config.mcpServers[result.connection.serverName]).toEqual({ type: "stdio", command: process.execPath,
        args: [f.serverPath], env: result.connection.env });
    }
    if (harness === "claude-code") {
      const registration = result.connection.registration!;
      expect(registration.command).toBe("claude");
      expect(registration.args.slice(0, 4)).toEqual(["mcp", "add", "--scope", "user"]);
      expect(registration.args.slice(-6)).toEqual(["--transport", "stdio", result.connection.serverName, "--", process.execPath, f.serverPath]);
    }
    if (harness === "generic") expect(result.connection.registration).toBeUndefined();
    expect(await readdir(f.root)).toEqual(["package.json"]);
    expect(await readFile(join(f.root, "package.json"), "utf8")).toBe('{"name":"untouched-source"}');
    expect((await readdir(join(f.workspaceRoot, ".proofkit"))).sort()).toEqual(["agents", "config.yaml", "integration.mjs"]);
  });

  it.each(["codex", "claude-code"] as const)("installs %s Skill into personal discovery, reuses identical output and preserves host config", async (harness) => {
    const f = await fixture();
    const hostRoot = join(f.userHome, harness === "codex" ? ".agents" : ".claude");
    await mkdir(hostRoot, { recursive: true });
    const hostConfig = join(hostRoot, "existing-config");
    await writeFile(hostConfig, "user settings");
    const result = await setupAgent({ ...f, harness, installSkill: true }, f);
    expect(result.skill.installation).toEqual({ status: "created", path: join(hostRoot, "skills", "proofkit-test") });
    expect(await readFile(join(result.skill.installation.path!, "SKILL.md"), "utf8")).toBe(await readFile(join(result.skill.path, "SKILL.md"), "utf8"));
    const again = await setupAgent({ ...f, harness, installSkill: true }, f);
    expect(again.bundle).toEqual({ path: result.bundle.path, status: "reused" });
    expect(again.skill.installation.status).toBe("reused");
    expect(await readFile(hostConfig, "utf8")).toBe("user settings");
  });

  it("preserves a custom Skill and fails before creating workspace artifacts", async () => {
    const f = await fixture();
    const skillsDir = join(f.scratch, "custom skills");
    await mkdir(join(skillsDir, "proofkit-test"), { recursive: true });
    await writeFile(join(skillsDir, "proofkit-test", "SKILL.md"), "custom user Skill");
    await expect(setupAgent({ ...f, harness: "generic", installSkill: true, skillsDir }, f)).rejects.toThrow("Existing agent artifact differs");
    expect(await readFile(join(skillsDir, "proofkit-test", "SKILL.md"), "utf8")).toBe("custom user Skill");
    expect(await readdir(f.scratch)).not.toContain("external workspace");
  });

  it("requires an explicit generic discovery directory and rejects unused or invalid options before writes", async () => {
    const f = await fixture();
    await expect(setupAgent({ ...f, harness: "generic", installSkill: true }, f)).rejects.toThrow("requires --skills-dir");
    await expect(setupAgent({ ...f, harness: "codex", skillsDir: f.userHome }, f)).rejects.toThrow("requires --install-skill");
    await expect(setupAgent({ ...f, harness: "invented" as AgentHarness }, f)).rejects.toThrow("Harness must be");
    await expect(setupAgent({ ...f, harness: "codex" }, { serverPath: join(f.scratch, "missing.js") })).rejects.toThrow("entrypoint is missing");
    expect(await readdir(f.scratch)).not.toContain("external workspace");
  });

  it("changes immutable bundles on explicit write opt-in without overwriting the original config", async () => {
    const f = await fixture();
    const readOnly = await setupAgent({ ...f, harness: "codex" }, f);
    const original = await readFile(readOnly.connection.configPath, "utf8");
    const writable = await setupAgent({ ...f, harness: "codex", allowCapabilityWrites: true }, f);
    expect(writable.connection.serverName).toBe(readOnly.connection.serverName);
    expect(writable.bundle.path).not.toBe(readOnly.bundle.path);
    expect(writable.connection.env.PROOFKIT_ALLOW_CAPABILITY_WRITES).toBe("1");
    expect(await readFile(readOnly.connection.configPath, "utf8")).toBe(original);
    const config = parse(await readFile(join(f.workspaceRoot, ".proofkit", "config.yaml"), "utf8"));
    expect(config.policies.sideEffects).toBe("confirm");
  });

  it("does not import an existing connector and refuses a foreign workspace binding", async () => {
    const f = await fixture();
    const first = await setupAgent({ ...f, harness: "generic" }, f);
    const connector = join(f.workspaceRoot, ".proofkit", "integration.mjs");
    const sentinel = join(f.scratch, "connector-ran");
    const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'loaded'); throw new Error('connector loaded');`;
    await writeFile(connector, source);
    expect((await setupAgent({ ...f, harness: "generic" }, f)).bundle.path).toBe(first.bundle.path);
    expect(await readdir(f.scratch)).not.toContain("connector-ran");
    const foreign = join(f.scratch, "foreign source");
    await mkdir(foreign);
    await expect(setupAgent({ ...f, root: foreign, harness: "generic" }, f)).rejects.toThrow("bound to another project");
    expect(await readFile(connector, "utf8")).toBe(source);
  });

  it("always selects an external default even when the project has legacy .proofkit", async () => {
    const f = await fixture();
    await mkdir(join(f.root, ".proofkit"));
    await writeFile(join(f.root, ".proofkit", "config.yaml"), "legacy sentinel");
    vi.stubEnv("PROOFKIT_WORKSPACE_HOME", join(f.scratch, "default workspaces"));
    const result = await setupAgent({ root: f.root, harness: "generic" }, f);
    expect(result.workspaceRoot).toContain("default workspaces");
    expect(await readFile(join(f.root, ".proofkit", "config.yaml"), "utf8")).toBe("legacy sentinel");
  });

  it("rejects direct and symlinked source destinations before writes", async () => {
    const f = await fixture();
    await expect(setupAgent({ ...f, harness: "codex", workspaceRoot: join(f.root, "test") }, f)).rejects.toThrow("outside the tested source");
    await expect(setupAgent({ ...f, harness: "codex", installSkill: true, skillsDir: join(f.root, ".agents", "skills") }, f)).rejects.toThrow("outside the tested source");
    const redirected = join(f.scratch, "redirected");
    await symlink(f.root, redirected, process.platform === "win32" ? "junction" : "dir");
    await expect(setupAgent({ ...f, harness: "generic", workspaceRoot: join(redirected, "test") }, f)).rejects.toThrow("outside the tested source");
    await expect(setupAgent({ ...f, harness: "generic", installSkill: true, skillsDir: redirected }, f)).rejects.toThrow("outside the tested source");
    expect(await readdir(f.root)).toEqual(["package.json"]);
  });

  it("rejects redirected workspace metadata and modified generated artifacts", async () => {
    const f = await fixture();
    await mkdir(f.workspaceRoot);
    await symlink(f.root, join(f.workspaceRoot, ".proofkit"), process.platform === "win32" ? "junction" : "dir");
    await expect(setupAgent({ ...f, harness: "generic" }, f)).rejects.toThrow("within the ProofKit workspace");
    await rm(join(f.workspaceRoot, ".proofkit"));
    const result = await setupAgent({ ...f, harness: "generic" }, f);
    await writeFile(result.connection.configPath, "customized config");
    await expect(setupAgent({ ...f, harness: "generic" }, f)).rejects.toThrow("Existing agent artifact differs");
    expect(await readFile(result.connection.configPath, "utf8")).toBe("customized config");
  });

  it("publishes one complete artifact for concurrent identical setups", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 3 }, () => setupAgent({ ...f, harness: "generic", installSkill: true, skillsDir: f.userHome }, f)));
    expect(new Set(results.map((result) => result.bundle.path)).size).toBe(1);
    expect(results.filter((result) => result.bundle.status === "created")).toHaveLength(1);
    expect(await readdir(join(f.workspaceRoot, ".proofkit", "agents", "generic"))).toHaveLength(1);
    expect(await readdir(f.userHome)).toEqual(["proofkit-test"]);
  });

  it("CLI emits reusable setup JSON and the portable example obeys the actual Charter schema", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "proofkit", "agent", "setup", "--harness", "generic", "--root", f.root,
      "--workspace", f.workspaceRoot, "--install-skill", "--skills-dir", f.userHome]);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    const skill = await readFile(join(result.skill.path, "SKILL.md"), "utf8");
    const frontmatter = parse(skill.split("---")[1]!);
    expect(frontmatter.name).toBe("proofkit-test");
    const reference = await readFile(join(result.skill.path, "references", "charter-authoring.md"), "utf8");
    const example = JSON.parse(reference.match(/```json\s*([\s\S]*?)```/)![1]!);
    expect(TestCharterSchema.parse(example.charter).level).toBe("core");
    expect(result.connection.status).toBe("not-checked");
    expect(result.skill.installation.status).toBe("created");
  });
});
