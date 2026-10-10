#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { RunMode, SideEffectPolicy, TestCoverage, TestLevel } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { IntentPlanner, loadCharter } from "@proofkit/planner";
import { LocalRunnerService, type LocalAdapterName } from "@proofkit/local-runner";
import { initProject, loadConfig, resolveProjectContext, resolveWithinWorkspace, scanProject } from "@proofkit/project";
import { setupAgent, type AgentHarness } from "./agent-setup.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("proofkit")
    .description("Evidence-driven AI system testing for Web, Electron and mobile")
    .version("0.1.0");

  const agent = program.command("agent").description("Export host Agent Skills and native MCP onboarding configuration");
  agent.command("setup")
    .description("Generate an external onboarding bundle; optionally install the portable testing Skill")
    .requiredOption("--harness <harness>", "codex, claude-code or generic")
    .option("--root <path>", "tested project root", ".")
    .option("--install-skill", "install the portable Skill in the host's personal discovery directory")
    .option("--skills-dir <path>", "explicit personal Skill directory; required for generic installation")
    .option("--allow-capability-writes", "emit operator opt-in for trusted test-environment write capabilities")
    .action(async (options: RootOptions & { harness: AgentHarness; installSkill?: boolean; skillsDir?: string; allowCapabilityWrites?: boolean }) => {
      console.log(JSON.stringify(await setupAgent({ root: options.root, workspaceRoot: options.workspace,
        harness: options.harness, installSkill: options.installSkill, skillsDir: options.skillsDir,
        allowCapabilityWrites: options.allowCapabilityWrites }), null, 2));
    });

  program.command("init")
    .description("Create a ProofKit test workspace bound to the source project")
    .option("--root <path>", "project root", ".")
    .action(async ({ root, workspace }: RootOptions) => {
      const path = await initProject(resolve(root), { workspaceRoot: workspace });
      console.log(`Created ${path}`);
    });

  program.command("doctor")
    .description("Inspect project entry points and local configuration")
    .option("--root <path>", "project root", ".")
    .action(async ({ root, workspace }: RootOptions) => {
      const project = await scanProject(resolve(root));
      const context = resolveProjectContext(root, { workspaceRoot: workspace });
      const config = await loadConfig(root, { workspaceRoot: context.workspaceRoot });
      const checks: Array<[string, string]> = [
        ["project root", project.root],
        ["test workspace", context.workspaceRoot],
        ["config", context.configPath],
        ["package manager", project.packageManager ?? "unknown"],
        ["web surface", project.detected.web ? "detected" : "not detected"],
        ["electron surface", project.detected.electron ? "detected" : "not detected"],
        ["backend surface", project.detected.backend ? "detected" : "not detected"],
        ["environment policy", config.policies.environment],
      ];
      for (const [name, value] of checks) console.log(`${name.padEnd(20)} ${value}`);
      if (!project.detected.web && !project.detected.electron) process.exitCode = 2;
    });

  program.command("environment")
    .description("Observe configured HTTP endpoints and source association without starting the app or running a test")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web or electron", "web")
    .option("--timeout-ms <milliseconds>", "total observation deadline (100-15000)", "5000")
    .action(async (options: RootOptions & { surface: string; timeoutMs: string }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const inspection = await runner.inspectEnvironment({ surface: options.surface as "web" | "electron", timeoutMs: Number(options.timeoutMs) });
      console.log(JSON.stringify(inspection, null, 2));
      process.exitCode = inspection.status === "checks-passed" ? 0 : inspection.status === "blocked" ? 1 : 2;
    });

  program.command("map")
    .description("Generate a project map for planning")
    .option("--root <path>", "project root", ".")
    .option("--out <path>", "write JSON output")
    .action(async ({ root, workspace, out }: RootOptions & { out?: string }) => {
      const map = await scanProject(resolve(root));
      const output = `${JSON.stringify(map, null, 2)}\n`;
      if (out) {
        const context = resolveProjectContext(root, { workspaceRoot: workspace });
        await initProject(root, { workspaceRoot: context.workspaceRoot });
        await writeWorkspaceOutput(context.workspaceRoot, out, output);
      }
      console.log(output);
    });

  program.command("inspect")
    .description("Observe the current Web or Electron surface and list bounded selector hints")
    .option("--root <path>", "project root", ".")
    .option("--adapter <adapter>", "web or electron", "web")
    .option("--url <url>", "Web entry URL")
    .option("--cdp <url>", "local CDP endpoint")
    .option("--devtools-port-file <path>", "Electron DevToolsActivePort path")
    .option("--headful", "launch a visible Web browser")
    .option("--ready-text <text>", "wait for visible text before observing (overrides configured readyWhen)")
    .option("--ready-timeout-ms <milliseconds>", "readiness timeout (100-15000, default 5000)")
    .action(async (options: RootOptions & { adapter: string; url?: string; cdp?: string; devtoolsPortFile?: string; headful?: boolean; readyText?: string; readyTimeoutMs?: string }) => {
      if (options.adapter !== "web" && options.adapter !== "electron") throw new Error("Inspection adapter must be web or electron");
      if (options.adapter === "electron" && options.url) throw new Error("Electron inspection uses CDP page selection, not --url");
      if (options.readyTimeoutMs !== undefined && options.readyText === undefined) throw new Error("--ready-timeout-ms requires --ready-text");
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const inspection = await runner.inspectSurface({ adapter: options.adapter, url: options.url, cdp: options.cdp,
        devtoolsPortFile: options.devtoolsPortFile, headful: options.headful,
        readyWhen: options.readyText === undefined ? undefined : { text: options.readyText, timeoutMs: options.readyTimeoutMs === undefined ? undefined : Number(options.readyTimeoutMs) } });
      console.log(JSON.stringify(inspection, null, 2));
      if (inspection.status !== "observed") process.exitCode = 1;
    });

  program.command("scope")
    .description("Inspect candidate test scope, catalog plan gaps and registered business checks without running tests")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web, electron or mobile", "web")
    .option("--level <level>", "quick, core or release", "core")
    .option("--focus <text>", "literal substring in source paths or registration metadata")
    .option("--limit <count>", "maximum details per section (1-50)", "20")
    .action(async (options: RootOptions & { surface: string; level: string; focus?: string; limit: string }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const scope = await runner.inspectTestScope({ surface: options.surface as LocalAdapterName, level: options.level as TestLevel, focus: options.focus, limit: Number(options.limit) });
      console.log(JSON.stringify(scope, null, 2));
    });

  program.command("charters")
    .description("List curated tests configured in the external test workspace")
    .option("--root <path>", "project root", ".")
    .action(async ({ root, workspace }: RootOptions) => {
      const config = await loadConfig(resolve(root), { workspaceRoot: workspace });
      console.log(JSON.stringify({ charters: config.charters }, null, 2));
    });

  program.command("suites")
    .description("List explicit release suites configured in the test workspace")
    .option("--root <path>", "project root", ".")
    .action(async ({ root, workspace }: RootOptions) => {
      const config = await loadConfig(resolve(root), { workspaceRoot: workspace });
      console.log(JSON.stringify({ suites: config.suites }, null, 2));
    });

  program.command("plan <intent>")
    .description("Turn a business intent into a reviewable Test Charter")
    .option("--root <path>", "project root", ".")
    .option("--url <url>", "entry URL")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--oracle <name>", "configured business oracle", collect, [])
    .option("--level <level>", "quick, core or release")
    .option("--coverage <scope>", "declared scenarios or project workflow coverage")
    .option("--mode <mode>", "deterministic, guided or explore", "guided")
    .option("--side-effects <policy>", "deny, confirm or allow")
    .option("--out <path>", "write YAML output")
    .action(async (intent: string, options: PlanCommandOptions) => {
      const root = resolve(options.root);
      const runner = await LocalRunnerService.create({ root, workspaceRoot: options.workspace });
      const planner = new IntentPlanner();
      const charter = await runner.plan(intent, {
        url: options.url,
        expect: options.expect,
        oracleNames: options.oracle.length ? options.oracle : undefined,
        level: options.level as TestLevel,
        coverage: options.coverage as TestCoverage | undefined,
        mode: options.mode as RunMode,
        sideEffectPolicy: options.sideEffects as SideEffectPolicy | undefined,
      });
      const output = planner.toYaml(charter);
      if (options.out) {
        await initProject(root, { workspaceRoot: runner.workspaceRoot });
        await writeWorkspaceOutput(runner.workspaceRoot, options.out, output);
      }
      process.stdout.write(output);
    });

  program.command("run <intent>")
    .description("Execute a Test Charter against a Web, Electron or mobile surface")
    .option("--root <path>", "project root", ".")
    .option("--charter <path>", "load an existing YAML charter")
    .option("--adapter <adapter>", "web, electron or mobile", "web")
    .option("--mobile-server <url>", "Appium/W3C WebDriver server URL")
    .option("--url <url>", "entry URL")
    .option("--cdp <url>", "CDP endpoint")
    .option("--devtools-port-file <path>", "Electron DevToolsActivePort path")
    .option("--headful", "launch a visible browser")
    .option("--no-start", "do not start the configured project command")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--oracle <name>", "configured business oracle", collect, [])
    .option("--level <level>", "quick, core or release")
    .option("--mode <mode>", "deterministic, guided or explore", "guided")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .option("--oracle-url <url>", "read-only HTTP endpoint used as a business oracle")
    .option("--oracle-name <name>", "business oracle name", "http-check")
    .option("--allow-capability-writes", "allow explicitly declared write capabilities")
    .action(async (intent: string, options: RunCommandOptions) => {
      const root = resolve(options.root);
      const runner = await LocalRunnerService.create({
        root,
        workspaceRoot: options.workspace,
        evidenceDir: options.evidenceDir,
        allowCapabilityWrites: options.allowCapabilityWrites,
      });
      const started = await runner.start({
        intent,
        charterPath: options.charter,
        adapter: options.adapter as LocalAdapterName,
        url: options.url,
        cdp: options.cdp,
        devtoolsPortFile: options.devtoolsPortFile,
        mobileServer: options.mobileServer,
        headful: options.headful,
        start: options.start,
        expect: options.expect,
        oracleNames: options.oracle.length ? options.oracle : undefined,
        mode: options.mode as RunMode,
        level: options.level as TestLevel,
        sideEffectPolicy: runner.config.policies.sideEffects,
        oracleUrl: options.oracleUrl,
        oracleName: options.oracleName,
      });
      const onSigint = () => { void runner.cancel(started.runId, "CLI interrupted the run"); };
      process.once("SIGINT", onSigint);
      let summary;
      try {
        summary = await runner.wait(started.runId);
      } finally {
        process.off("SIGINT", onSigint);
      }
      console.log(JSON.stringify({
        runId: summary.runId,
        verdict: summary.verdict,
        targetBinding: summary.targetBinding?.status,
        report: resolve(runner.evidenceDir, summary.runId, "report.html"),
      }, null, 2));
      if (summary.verdict !== "passed") process.exitCode = 1;
    });

  const mission = program.command("mission").description("Create and run an evidence-driven AI test mission");
  mission.command("create <intent>")
    .description("Create a reviewable mission plan from a natural-language intent")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web, electron or mobile", "web")
    .option("--charter <path>", "load a Charter from the test workspace")
    .option("--charter-id <id>", "select a curated test by catalog ID")
    .option("--suite-id <id>", "select an explicit release suite by ID")
    .option("--coverage <scope>", "declared scenarios or project workflow coverage")
    .option("--url <url>", "entry URL")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--oracle <name>", "configured business oracle", collect, [])
    .option("--level <level>", "quick, core or release")
    .option("--mode <mode>", "deterministic, guided or explore")
    .option("--side-effects <policy>", "deny, confirm or allow")
    .action(async (intent: string, options: MissionCreateCommandOptions) => {
      const root = resolve(options.root);
      const runner = await LocalRunnerService.create({ root, workspaceRoot: options.workspace });
      const created = await runner.createMission({
        intent,
        charter: options.charter ? await loadCharter(resolveWithinWorkspace(runner.workspaceRoot, options.charter)) : undefined,
        charterId: options.charterId,
        suiteId: options.suiteId,
        coverage: options.coverage as TestCoverage | undefined,
        surface: options.surface as LocalAdapterName,
        url: options.url,
        expect: options.expect,
        oracleNames: options.oracle.length ? options.oracle : undefined,
        level: options.level as TestLevel,
        mode: options.mode as RunMode,
        sideEffectPolicy: options.sideEffects as SideEffectPolicy | undefined,
      });
      console.log(JSON.stringify(created, null, 2));
    });

  mission.command("approve <missionId>")
    .description("Approve a mission plan")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.approveMission(missionId), null, 2));
    });

  mission.command("run <missionId>")
    .description("Run an approved mission and wait for its final verdict")
    .option("--root <path>", "project root", ".")
    .option("--approve", "approve the plan before starting")
    .option("--allow-capability-writes", "allow approved test-environment write capabilities")
    .action(async (missionId: string, options: RootOptions & { approve?: boolean; allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace, allowCapabilityWrites: options.allowCapabilityWrites });
      await runner.startMission(missionId, { approve: options.approve });
      const completed = await runner.waitMission(missionId);
      const evidence = await runner.missionEvidence(completed.missionId);
      console.log(JSON.stringify(evidence, null, 2));
      if (completed.verdict !== "passed") process.exitCode = 1;
    });

  mission.command("status <missionId>")
    .description("Read mission status and task graph")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.missionStatus(missionId), null, 2));
    });

  mission.command("evidence <missionId>")
    .description("Read mission evidence references and findings")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.missionEvidence(missionId), null, 2));
    });

  mission.command("report <missionId>")
    .description("Generate a compact HTML/JSON snapshot of a Mission's saved results")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const evidence = await runner.missionEvidence(missionId);
      console.log(JSON.stringify({ summary: evidence.summary, report: evidence.report, reportUnavailable: evidence.reportUnavailable }, null, 2));
      if (!evidence.report) process.exitCode = 1;
    });

  mission.command("replay <missionId>")
    .description("Replay a mission charter and wait for its final verdict")
    .option("--root <path>", "project root", ".")
    .option("--allow-capability-writes", "allow approved test-environment write capabilities")
    .action(async (missionId: string, options: RootOptions & { allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace, allowCapabilityWrites: options.allowCapabilityWrites });
      const started = await runner.replayMission(missionId);
      const completed = await runner.waitMission(started.mission.missionId);
      const evidence = await runner.missionEvidence(completed.missionId);
      console.log(JSON.stringify({ missionId: completed.missionId, replayOfMissionId: missionId, status: completed.status, verdict: completed.verdict, comparison: evidence.comparison, summary: evidence.summary, report: evidence.report, reportUnavailable: evidence.reportUnavailable }, null, 2));
      if (completed.verdict !== "passed") process.exitCode = 1;
    });

  mission.command("compare <baselineMissionId> <candidateMissionId>")
    .description("Compare a Mission with its direct replay using saved business evidence")
    .option("--root <path>", "project root", ".")
    .action(async (baselineMissionId: string, candidateMissionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const comparison = await runner.compareMissions(baselineMissionId, candidateMissionId);
      console.log(JSON.stringify(comparison, null, 2));
      if (comparison.status !== "verified-in-scope") process.exitCode = 1;
    });

  program.command("report <runId>")
    .description("Regenerate a static report for a run")
    .option("--root <path>", "project root", ".")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .action(async (runId: string, options: RootOptions & { evidenceDir: string }) => {
      const runner = new LocalRunnerService({ root: options.root, workspaceRoot: options.workspace, evidenceDir: options.evidenceDir });
      const store = new EvidenceStore(runner.evidenceDir);
      const summary = await runner.wait(runId);
      console.log(await store.writeReport(summary));
    });

  program.command("replay <runId>")
    .description("Inspect a previous run and optionally execute its charter again")
    .option("--root <path>", "project root", ".")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .option("--rerun", "execute the saved charter again")
    .option("--adapter <adapter>", "web, electron or mobile", "web")
    .option("--mobile-server <url>", "Appium/W3C WebDriver server URL")
    .option("--cdp <url>", "CDP endpoint")
    .option("--devtools-port-file <path>", "Electron DevToolsActivePort path")
    .option("--headful", "launch a visible browser")
    .option("--allow-capability-writes", "allow explicitly declared write capabilities")
    .action(async (runId: string, options: ReplayOptions) => {
      const root = resolve(options.root);
      const reader = new LocalRunnerService({ root, workspaceRoot: options.workspace, evidenceDir: options.evidenceDir });
      const previous = await reader.wait(runId);
      if (!options.rerun) {
        console.log(JSON.stringify({ runId: previous.runId, verdict: previous.verdict, charter: previous.charter, steps: previous.steps.length, artifacts: previous.artifacts.length }, null, 2));
        return;
      }
      const runner = await LocalRunnerService.create({
        root,
        workspaceRoot: options.workspace,
        evidenceDir: options.evidenceDir,
        allowCapabilityWrites: options.allowCapabilityWrites,
      });
      const started = await runner.replay(runId, {
        adapter: options.adapter as LocalAdapterName,
        cdp: options.cdp,
        devtoolsPortFile: options.devtoolsPortFile,
        mobileServer: options.mobileServer,
        headful: options.headful,
      });
      const summary = await runner.wait(started.runId);
      console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict }, null, 2));
      if (summary.verdict !== "passed") process.exitCode = 1;
    });

  const resources = program.command("resources").description("Inspect or recover registered integration resources after an interrupted process");
  resources.command("inspect <runId>")
    .option("--root <path>", "project root", ".")
    .action(async (runId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.inspectRunResources(runId), null, 2));
    });
  resources.command("recover <runId>")
    .option("--root <path>", "project root", ".")
    .option("--allow-capability-writes", "allow trusted connector cleanup in its declared test environment")
    .action(async (runId: string, options: RootOptions & { allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace,
        allowCapabilityWrites: options.allowCapabilityWrites ?? false });
      const recovered = await runner.recoverRunResources(runId);
      console.log(JSON.stringify(recovered, null, 2));
      if (recovered.status !== "verified") process.exitCode = 2;
    });

  // Every leaf command resolves the same source/workspace pair.
  for (const command of [...program.commands, ...mission.commands, ...resources.commands, ...agent.commands]) {
    if (command !== mission && command !== resources && command !== agent) command.option("--workspace <path>", "test workspace root; defaults to an external workspace or legacy .proofkit (agent setup always external)");
  }
  return program;
}

type RootOptions = {
  root: string;
  workspace?: string;
};

type PlanCommandOptions = RootOptions & {
  url?: string;
  expect: string[];
  oracle: string[];
  mode?: string;
  sideEffects?: string;
  out?: string;
  level?: string;
  coverage?: string;
};

type MissionCreateCommandOptions = PlanCommandOptions & {
  surface: string;
  charter?: string;
  charterId?: string;
  suiteId?: string;
};

type RunCommandOptions = PlanCommandOptions & {
  charter?: string;
  adapter: string;
  cdp?: string;
  devtoolsPortFile?: string;
  mobileServer?: string;
  headful?: boolean;
  start: boolean;
  evidenceDir: string;
  allowCapabilityWrites?: boolean;
  oracleUrl?: string;
  oracleName: string;
};

type ReplayOptions = RootOptions & {
  evidenceDir: string;
  rerun?: boolean;
  adapter: string;
  cdp?: string;
  devtoolsPortFile?: string;
  mobileServer?: string;
  headful?: boolean;
  allowCapabilityWrites?: boolean;
};

async function writeWorkspaceOutput(workspaceRoot: string, path: string, output: string): Promise<void> {
  const destination = resolveWithinWorkspace(workspaceRoot, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output, "utf8");
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (invokedAsExecutable()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function invokedAsExecutable(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entry = realpathSync.native(process.argv[1]);
    const current = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? entry.toLowerCase() === current.toLowerCase() : entry === current;
  } catch {
    return false;
  }
}
