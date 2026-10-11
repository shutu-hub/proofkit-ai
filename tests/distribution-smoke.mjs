import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempParent = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempParent, "proofkit-distribution-"));
let environmentServer;
try {
  const packDir = join(scratch, "pack");
  const installDir = join(scratch, "install");
  const source = join(scratch, "source 用户 app");
  const workspace = join(scratch, "workspace");
  await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(source)]);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "external-web-fixture", dependencies: { vite: "*" } }));
  await writeFile(join(source, "index.html"), "<!doctype html><title>External fixture</title>");
  const routerSource = "const routes = [{ path: '/resumes' }, { path: '/login' }];\n";
  await writeFile(join(source, "router.ts"), routerSource);

  const packed = parsePackOutput((await npm(["pack", "--pack-destination", packDir, "--json", "--silent"], projectRoot)).stdout);
  assert.equal(packed.name, "proofkit-ai");
  const files = packed.files.map((file) => file.path).sort();
  const templateManifest = JSON.parse(await readFile(join(projectRoot, "templates", "aihr", "manifest.json"), "utf8"));
  assert.deepEqual(files, ["LICENSE", "README.md", "bundle/main.js", "bundle/server.js",
    "bundle/templates/aihr/manifest.json", ...templateManifest.files.map((file) => `bundle/templates/aihr/${file}`),
    "package.json"].sort());
  await npm([
    "install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", resolve(packDir, packed.filename),
  ], scratch);

  const installed = join(installDir, "node_modules", "proofkit-ai");
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.private, undefined);
  assert.equal(Object.keys(installedManifest.dependencies ?? {}).some((name) => name.startsWith("@proofkit/")), false);
  const cli = join(installed, "bundle", "main.js");
  const mcp = join(installed, "bundle", "server.js");
  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node/);
  assert.equal((await command(process.execPath, [cli, "--version"], scratch)).stdout.trim(), packed.version);
  assert.equal((await npm(["exec", "--prefix", installDir, "--", "proofkit", "--version"], scratch)).stdout.trim(), packed.version);
  assert.match((await npm(["exec", "--prefix", installDir, "--", "proofkit", "mission", "create", "--help"], scratch)).stdout, /--charter <path>/);
  assert.match((await npm(["exec", "--prefix", installDir, "--", "proofkit", "mission", "report", "--help"], scratch)).stdout, /Usage: proofkit mission report \[options\] <missionId>/);
  const inspectionHelp = (await command(process.execPath, [cli, "inspect", "--help"], scratch)).stdout;
  assert.match(inspectionHelp, /--ready-text <text>/);
  assert.match(inspectionHelp, /--ready-timeout-ms <milliseconds>/);
  await command(process.execPath, [cli, "init", "--root", source, "--workspace", workspace], scratch);
  const templateWorkspace = join(scratch, "AIHR external workspace");
  const templateArgs = [cli, "template", "install", "aihr", "--root", source, "--workspace", templateWorkspace];
  const templateInstall = JSON.parse((await command(process.execPath, templateArgs, scratch)).stdout);
  assert.equal(templateInstall.status, "installed");
  assert.equal(templateInstall.testVerdict, "not-asserted");
  assert.deepEqual(templateInstall.files.map((file) => file.name), templateManifest.files);
  for (const file of templateManifest.files) {
    assert.deepEqual(await readFile(join(templateWorkspace, ".proofkit", file)),
      await readFile(join(installed, "bundle", "templates", "aihr", file)));
  }
  assert.equal((await readdir(join(templateWorkspace, ".proofkit"))).includes("runs"), false);
  const templateReused = JSON.parse((await command(process.execPath, templateArgs, scratch)).stdout);
  assert.equal(templateReused.status, "reused");
  await writeFile(join(templateWorkspace, ".proofkit", "aihr-manual-intake.mjs"), "custom connector\n");
  const templateConflict = await command(process.execPath, templateArgs, scratch, [1]);
  assert.match(templateConflict.stderr, /conflicts with an existing workspace file/);
  assert.equal(await readFile(join(templateWorkspace, ".proofkit", "aihr-manual-intake.mjs"), "utf8"), "custom connector\n");
  const conflictingWorkspace = join(scratch, "AIHR conflicting workspace");
  await mkdir(join(conflictingWorkspace, ".proofkit"), { recursive: true });
  await writeFile(join(conflictingWorkspace, ".proofkit", "aihr-manual-intake.mjs"), "existing custom connector\n");
  const preflightConflict = await command(process.execPath, [cli, "template", "install", "aihr", "--root", source,
    "--workspace", conflictingWorkspace], scratch, [1]);
  assert.match(preflightConflict.stderr, /conflicts with an existing workspace file/);
  assert.deepEqual((await readdir(join(conflictingWorkspace, ".proofkit"))).sort(), ["aihr-manual-intake.mjs"]);
  const sourceWorkspace = join(source, ".proofkit", "unsafe workspace");
  const templateSourceRefusal = await command(process.execPath, [cli, "template", "install", "aihr", "--root", source,
    "--workspace", sourceWorkspace], scratch, [1]);
  assert.match(templateSourceRefusal.stderr, /outside the tested source tree/);
  assert.equal((await readdir(source)).includes(".proofkit"), false);
  const agentTemplateWorkspace = join(scratch, "AIHR first setup workspace");
  const agentTemplateArgs = [cli, "agent", "setup", "--harness", "generic", "--template", "aihr",
    "--root", source, "--workspace", agentTemplateWorkspace];
  const agentTemplate = JSON.parse((await command(process.execPath, agentTemplateArgs, scratch)).stdout);
  assert.equal(agentTemplate.template, "aihr");
  assert.equal(agentTemplate.templateInstallation.status, "installed");
  assert.equal(agentTemplate.testVerdict, "not-asserted");
  assert.equal(agentTemplate.connection.status, "not-checked");
  for (const file of templateManifest.files) {
    assert.deepEqual(await readFile(join(agentTemplateWorkspace, ".proofkit", file)),
      await readFile(join(installed, "bundle", "templates", "aihr", file)));
  }
  assert.equal((await readdir(join(agentTemplateWorkspace, ".proofkit"))).includes("missions"), false);
  const agentTemplateReused = JSON.parse((await command(process.execPath, agentTemplateArgs, scratch)).stdout);
  assert.equal(agentTemplateReused.templateInstallation.status, "reused");
  assert.equal(agentTemplateReused.bundle.status, "reused");
  const connectorBefore = await readFile(join(workspace, ".proofkit", "integration.mjs"));
  const lateTemplate = await command(process.execPath, [cli, "agent", "setup", "--harness", "generic",
    "--template", "aihr", "--root", source, "--workspace", workspace], scratch, [1]);
  assert.match(lateTemplate.stderr, /conflicts with an existing workspace file: integration.mjs/);
  assert.deepEqual(await readFile(join(workspace, ".proofkit", "integration.mjs")), connectorBefore);
  const prematureCheck = await command(process.execPath, [...agentTemplateArgs, "--check-connection"], scratch, [1]);
  assert.match(prematureCheck.stderr, /Review the selected template connector/);
  const personalSkills = join(scratch, "host skills");
  const setupArgs = [cli, "agent", "setup", "--harness", "claude-code", "--root", source, "--workspace", workspace,
    "--install-skill", "--skills-dir", personalSkills];
  const onboarding = JSON.parse((await command(process.execPath, setupArgs, scratch)).stdout);
  assert.equal(onboarding.testVerdict, "not-asserted");
  assert.equal(onboarding.connection.status, "not-checked");
  assert.equal(onboarding.defaultLevel, "core");
  assert.equal(onboarding.skill.installation.status, "created");
  assert.equal(onboarding.connection.args[0], await realpath(mcp));
  const installedSkill = await readFile(join(personalSkills, "proofkit-test", "SKILL.md"), "utf8");
  const skillHeader = parseYaml(installedSkill.split("---")[1]);
  assert.equal(skillHeader.name, "proofkit-test");
  assert.equal(await readFile(join(onboarding.skill.path, "SKILL.md"), "utf8"), installedSkill);
  const skillReference = await readFile(join(personalSkills, "proofkit-test", "references", "charter-authoring.md"), "utf8");
  assert.ok(skillReference.length > 0);
  const reused = JSON.parse((await command(process.execPath, setupArgs, scratch)).stdout);
  assert.equal(reused.bundle.path, onboarding.bundle.path);
  assert.equal(reused.bundle.status, "reused");
  assert.equal(reused.skill.installation.status, "reused");
  const codexSetup = JSON.parse((await command(process.execPath, [cli, "agent", "setup", "--harness", "codex",
    "--root", source, "--workspace", workspace], scratch)).stdout);
  assert.equal(codexSetup.connection.serverName, onboarding.connection.serverName);
  assert.equal(codexSetup.skill.installation.status, "not-requested");
  assert.equal(codexSetup.connection.registration.command, "codex");
  const hostCli = join(scratch, "mock-host-cli.js");
  const hostState = join(scratch, "host-registration.json");
  const hostEntry = { name: codexSetup.connection.serverName, transport: { type: "stdio",
    command: codexSetup.connection.command, args: codexSetup.connection.args, env: codexSetup.connection.env } };
  await writeFile(hostCli, `const fs = require('node:fs');
const args = process.argv.slice(2);
const state = ${JSON.stringify(hostState)};
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'get') {
  if (fs.existsSync(state)) { console.log(${JSON.stringify(JSON.stringify(hostEntry))}); process.exit(0); }
  console.error('No MCP server named ' + JSON.stringify(args.at(-1)) + ' found.');
  process.exit(1);
}
if (args[1] === 'add') { fs.writeFileSync(state, JSON.stringify(args)); process.exit(0); }
process.exit(3);
`);
  const registered = JSON.parse((await command(process.execPath, [cli, "agent", "setup", "--harness", "codex",
    "--root", source, "--workspace", workspace, "--skills-dir", personalSkills,
    "--register-host", "--host-cli", hostCli], scratch)).stdout);
  assert.equal(registered.localConnection.status, "connected");
  assert.equal(registered.hostRegistration.status, "registered");
  assert.equal(registered.skill.installation.status, "reused");
  assert.deepEqual(JSON.parse(await readFile(hostState, "utf8")), registered.connection.registration.args);
  const checkedSetup = JSON.parse((await command(process.execPath, [...setupArgs, "--check-connection"], scratch)).stdout);
  assert.equal(checkedSetup.connection.status, "not-checked");
  assert.equal(checkedSetup.localConnection.status, "connected");
  assert.equal(checkedSetup.localConnection.testVerdict, "not-asserted");
  assert.equal(checkedSetup.localConnection.hostRegistration, "not-checked");
  assert.equal(checkedSetup.localConnection.modelBehavior, "not-checked");
  assert.equal(checkedSetup.localConnection.executionChecks, "not-run");
  assert.equal(checkedSetup.localConnection.projectRoot, await realpath(source));
  assert.equal(checkedSetup.localConnection.workspaceRoot, await realpath(workspace));
  assert.equal(checkedSetup.localConnection.scope.routeCandidates, 2);
  assert.equal((await readdir(join(workspace, ".proofkit"))).includes("missions"), false);
  assert.equal((await readdir(join(workspace, ".proofkit"))).includes("runs"), false);
  const nativeConfig = JSON.parse(await readFile(onboarding.connection.configPath, "utf8"));
  const emittedServer = nativeConfig.mcpServers[onboarding.connection.serverName];
  assert.equal(emittedServer.type, "stdio");
  assert.deepEqual(emittedServer.env, { PROOFKIT_ROOT: await realpath(source), PROOFKIT_WORKSPACE_ROOT: await realpath(workspace) });
  const doctor = await command(process.execPath, [cli, "doctor", "--root", source, "--workspace", workspace], scratch);
  assert.match(doctor.stdout, /web surface\s+detected/);
  const scope = JSON.parse((await command(process.execPath, [cli, "scope", "--root", source, "--workspace", workspace, "--limit", "1"], scratch)).stdout);
  assert.equal(scope.testVerdict, "not-asserted");
  assert.equal(scope.executionChecks, "not-run");
  assert.equal(scope.selection.level, "core");
  assert.equal(scope.routes.total, 2);
  assert.equal(scope.routes.mapped, 0);
  assert.equal(scope.routes.items.length, 1);
  assert.equal(scope.routes.omitted, 1);
  const focusedScope = JSON.parse((await command(process.execPath, [cli, "scope", "--root", source, "--workspace", workspace, "--focus", "RESUMES"], scratch)).stdout);
  assert.equal(focusedScope.inventory.retentionFocus, "resumes");
  assert.equal(focusedScope.routes.matched, 1);
  assert.equal(focusedScope.routes.items[0].path, "/resumes");
  const cliPlan = parseYaml((await command(process.execPath, [cli, "plan", "check one page", "--root", source, "--workspace", workspace, "--level", "quick", "--expect", "ready", "--coverage", "project"], scratch)).stdout);
  assert.equal(cliPlan.planning.coverage.requested, "project");
  assert.equal(cliPlan.planning.coverage.source, "explicit");
  assert.equal(cliPlan.planning.coverage.inventory, "bounded");
  assert.ok(cliPlan.planning.evidenceGaps.includes("project-workflow-coverage"));

  environmentServer = createServer((_req, response) => {
    response.writeHead(200, { "Set-Cookie": "private-session" });
    response.end("private-response-body");
  });
  await new Promise((resolveServer) => environmentServer.listen(0, "127.0.0.1", resolveServer));
  const environmentUrl = `http://127.0.0.1:${environmentServer.address().port}`;
  const configPath = join(workspace, ".proofkit", "config.yaml");
  const environmentConfig = parseYaml(await readFile(configPath, "utf8"));
  environmentConfig.surfaces = { web: { baseUrl: environmentUrl } };
  environmentConfig.project.health = [`${environmentUrl}/health?secret=private-query`];
  await writeFile(configPath, JSON.stringify(environmentConfig));
  const environmentCli = JSON.parse((await command(process.execPath, [cli, "environment", "--root", source, "--workspace", workspace], scratch, [2])).stdout);
  // Deliberately outside Git: HTTP success cannot supply source association.
  assert.equal(environmentCli.status, "incomplete");
  assert.equal(environmentCli.testVerdict, "not-asserted");
  assert.ok(environmentCli.checks.some((check) => check.id === "surface-http" && check.status === "passed"));
  assert.ok(environmentCli.checks.some((check) => check.id === "source-binding" && check.status === "unverified"));
  assert.doesNotMatch(JSON.stringify(environmentCli), /private-query|private-response-body|private-session/);
  assert.equal(createHash("sha256").update(await readFile(environmentCli.artifact.path)).digest("hex"), environmentCli.artifact.sha256);

  assert.match(await readFile(mcp, "utf8"), /^#!\/usr\/bin\/env node/);
  const npmBin = await npmExecutable();
  const mcpEnv = { ...process.env, PROOFKIT_ROOT: source, PROOFKIT_WORKSPACE_ROOT: workspace };
  for (const key of Object.keys(mcpEnv)) if (/^npm_config_/i.test(key)) delete mcpEnv[key];
  const binTransport = new StdioClientTransport({
    command: npmBin.executable,
    args: [...npmBin.prefix, "exec", "--prefix", installDir, "--", "proofkit-mcp"],
    env: mcpEnv,
  });
  const binClient = new Client({ name: "proofkit-installed-bin-smoke", version: "1" });
  try {
    await withDeadline(binClient.connect(binTransport), 10_000, "Installed MCP binary connection");
    assert.ok((await binClient.listTools()).tools.some((tool) => tool.name === "run_test"));
    assert.ok((await binClient.listTools()).tools.some((tool) => tool.name === "await_test_result"));
  } finally { await binClient.close(); }
  const transport = new StdioClientTransport({ command: emittedServer.command, args: emittedServer.args,
    env: { ...mcpEnv, ...emittedServer.env } });
  const client = new Client({ name: "proofkit-distribution-smoke", version: "1" });
  try {
    await withDeadline(client.connect(transport), 10_000, "Emitted native MCP configuration connection");
    const listed = await withDeadline(client.listTools(), 10_000, "MCP tool listing");
    assert.ok(listed.tools.some((tool) => tool.name === "inspect_surface"));
    const surfaceInspection = listed.tools.find((tool) => tool.name === "inspect_surface");
    assert.equal(surfaceInspection.inputSchema.properties.readyWhen.properties.timeoutMs.maximum, 15000);
    const invalidReadiness = await client.callTool({ name: "inspect_surface", arguments: { readyWhen: { text: "ready", timeoutMs: 15001 } } });
    assert.equal(invalidReadiness.isError, true);
    assert.ok(listed.tools.some((tool) => tool.name === "inspect_test_scope"));
    const environmentTool = listed.tools.find((tool) => tool.name === "inspect_test_environment");
    assert.ok(environmentTool);
    assert.equal(environmentTool.inputSchema.properties.timeoutMs.default, 10000);
    const environmentResponse = await withDeadline(client.callTool({ name: "inspect_test_environment", arguments: {} }), 10_000, "Installed MCP environment inspection");
    assert.equal(environmentResponse.isError, undefined);
    const environment = JSON.parse(environmentResponse.content.find((item) => item.type === "text").text);
    assert.equal(environment.status, "incomplete");
    assert.equal(environment.testVerdict, "not-asserted");
    assert.ok(environment.notChecked.includes("business-terminal"));
    assert.doesNotMatch(JSON.stringify(environment), /private-query|private-response-body|private-session/);
    assert.equal(createHash("sha256").update(await readFile(environment.artifact.path)).digest("hex"), environment.artifact.sha256);
    const runTest = listed.tools.find((tool) => tool.name === "run_test");
    assert.ok(runTest);
    assert.ok(runTest.inputSchema.properties?.charter);
    assert.ok(runTest.inputSchema.properties?.coverage);
    const deniedUpload = await withDeadline(client.callTool({ name: "run_test", arguments: {
      intent: "Verify prepared resume upload", surface: "web",
      charter: { intent: "Verify prepared resume upload", level: "quick", sideEffectPolicy: "deny",
        actions: [{ kind: "setInputFiles", selector: 'input[type="file"]', files: [".proofkit/fixtures/resume.pdf"] }],
        assertions: [{ kind: "text-visible", text: "ready" }] },
    } }), 10_000, "Installed MCP file-input policy");
    assert.equal(deniedUpload.isError, true);
    assert.match(deniedUpload.content.find((content) => content.type === "text")?.text ?? "", /interactive action setInputFiles requires sideEffectPolicy=allow/);
    const deniedCapture = await withDeadline(client.callTool({ name: "run_test", arguments: {
      intent: "Verify this submission identity", surface: "web",
      charter: { intent: "Verify this submission identity", level: "quick", sideEffectPolicy: "deny",
        actions: [{ kind: "captureResponse", name: "current-intake", trigger: { kind: "click", selector: "#submit" },
          response: { url: "http://127.0.0.1:8080/api/v1/intakes", method: "POST", statuses: [201],
            fields: { fileId: { pointer: "/data/file_id", type: "id" } } } }],
        assertions: [{ kind: "text-visible", text: "ready" }] },
    } }), 10_000, "Installed MCP response-capture policy");
    assert.equal(deniedCapture.isError, true);
    assert.match(deniedCapture.content.find((content) => content.type === "text")?.text ?? "", /interactive action captureResponse requires sideEffectPolicy=allow/);
    const discovered = await withDeadline(client.callTool({ name: "discover_project", arguments: {} }), 10_000, "MCP project discovery");
    const item = discovered.content.find((content) => content.type === "text");
    assert.ok(item);
    assert.equal(JSON.parse(item.text).detected.web, true);
    const inspected = await withDeadline(client.callTool({ name: "inspect_test_scope", arguments: { focus: "RESUMES" } }), 10_000, "MCP test scope inspection");
    assert.equal(inspected.isError, undefined);
    const scopeItem = inspected.content.find((content) => content.type === "text");
    assert.ok(scopeItem);
    const testScope = JSON.parse(scopeItem.text);
    assert.equal(testScope.testVerdict, "not-asserted");
    assert.equal(testScope.selection.level, "core");
    assert.equal(testScope.inventory.retentionFocus, "resumes");
    assert.equal(testScope.routes.total, 2);
    assert.equal(testScope.routes.matched, 1);
    assert.equal(testScope.routes.items[0].source, "router.ts");
    assert.equal(testScope.routes.items[0].line, 1);
    assert.equal(testScope.routes.items[0].status, "unmapped");
    const planned = await withDeadline(client.callTool({ name: "plan_test", arguments: { intent: "test the entire project", level: "quick", expect: ["ready"] } }), 10_000, "MCP coverage planning");
    assert.equal(planned.isError, undefined);
    const planItem = planned.content.find((content) => content.type === "text");
    assert.ok(planItem);
    const plan = JSON.parse(planItem.text).charter;
    assert.equal(plan.planning.coverage.requested, "project");
    assert.equal(plan.planning.coverage.source, "inferred");
    assert.equal(plan.planning.coverage.workflowCoverage, "unmeasured");
    assert.ok(plan.planning.evidenceGaps.includes("project-workflow-coverage"));
  } finally {
    await client.close();
  }
  assert.deepEqual((await readdir(source)).sort(), ["index.html", "package.json", "router.ts"]);
  assert.equal(await readFile(join(source, "router.ts"), "utf8"), routerSource);
  const workspaceFiles = await readdir(join(workspace, ".proofkit"));
  assert.equal(workspaceFiles.includes("missions"), false);
  assert.equal(workspaceFiles.includes("runs"), false);
  assert.equal((await readdir(join(workspace, ".proofkit", "inspections"))).length, 2);
  console.log(JSON.stringify({ package: packed.name, version: packed.version, files, verified: ["isolated-npm-install", "installed-cli-bin", "cli-mission-charter-option", "cli-init-doctor", "installed-aihr-reference-template", "agent-selected-aihr-first-setup", "template-idempotence-and-conflict-guard", "template-source-immutability", "installed-agent-skill-and-idempotent-setup", "codex-and-claude-native-config-export", "emitted-native-config-stdio-connection", "installed-cli-local-connection-check", "isolated-host-registration", "installed-cli-scope", "installed-cli-mcp-environment", "environment-artifact-digests-and-redaction", "installed-mcp-bin-stdio-discovery", "mcp-inline-charter-schema", "installed-mcp-file-input-policy", "installed-mcp-response-capture-policy", "installed-mcp-test-scope", "installed-cli-mcp-coverage-planning", "source-unchanged-and-no-tests-started"] }, null, 2));
} finally {
  if (environmentServer) {
    environmentServer.closeAllConnections();
    await new Promise((resolveServer) => environmentServer.close(resolveServer));
  }
  const safeRoot = resolve(scratch);
  if (!safeRoot.startsWith(resolve(tempParent) + sep) || !basename(safeRoot).startsWith("proofkit-distribution-")) {
    throw new Error("Distribution scratch directory escaped the temporary parent");
  }
  await rm(safeRoot, { recursive: true, force: true });
}

function command(executable, args, cwd, acceptedExitCodes = [0]) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectCommand);
    child.once("close", (code) => acceptedExitCodes.includes(code)
      ? resolveCommand({ stdout, stderr })
      : rejectCommand(new Error(`${executable} ${args[0]} exited ${code}: ${stderr || stdout}`)));
  });
}

async function npm(args, cwd) {
  const resolved = await npmExecutable();
  return command(resolved.executable, [...resolved.prefix, ...args], cwd);
}

async function npmExecutable() {
  if (process.platform !== "win32") return { executable: "npm", prefix: [] };
  const cli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(cli);
  return { executable: process.execPath, prefix: [cli] };
}

function withDeadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function parsePackOutput(output) {
  for (let start = output.lastIndexOf("["); start >= 0; start = output.lastIndexOf("[", start - 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed) && parsed[0]?.name === "proofkit-ai") return parsed[0];
    } catch { /* prepack writes build output before npm's final JSON array */ }
  }
  throw new Error("npm pack did not return a proofkit-ai package description");
}
