import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import type { RunMode, SideEffectPolicy, TestLevel } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { IntentPlanner } from "@proofkit/planner";
import { LocalRunnerService, type LocalAdapterName } from "@proofkit/local-runner";
import { initProject, loadConfig, resolveProjectContext, resolveWithinWorkspace, scanProject } from "@proofkit/project";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("proofkit")
    .description("Evidence-driven AI system testing for web and Electron")
    .version("0.1.0");

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

  program.command("plan <intent>")
    .description("Turn a business intent into a reviewable Test Charter")
    .option("--root <path>", "project root", ".")
    .option("--url <url>", "entry URL")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--oracle <name>", "configured business oracle", collect, [])
    .option("--level <level>", "quick, core or release")
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
    .description("Execute a Test Charter against a Web or Electron surface")
    .option("--root <path>", "project root", ".")
    .option("--charter <path>", "load an existing YAML charter")
    .option("--adapter <adapter>", "web or electron", "web")
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
      console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, report: resolve(runner.evidenceDir, summary.runId, "report.html") }, null, 2));
      if (summary.verdict !== "passed") process.exitCode = 1;
    });

  const mission = program.command("mission").description("Create and run an evidence-driven AI test mission");
  mission.command("create <intent>")
    .description("Create a reviewable mission plan from a natural-language intent")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web or electron", "web")
    .option("--url <url>", "entry URL")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--oracle <name>", "configured business oracle", collect, [])
    .option("--level <level>", "quick, core or release")
    .option("--mode <mode>", "deterministic, guided or explore", "guided")
    .option("--side-effects <policy>", "deny, confirm or allow")
    .action(async (intent: string, options: MissionCreateCommandOptions) => {
      const root = resolve(options.root);
      const runner = await LocalRunnerService.create({ root, workspaceRoot: options.workspace });
      const created = await runner.createMission({
        intent,
        surface: options.surface as "web" | "electron",
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
    .action(async (missionId: string, options: RootOptions & { approve?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
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

  mission.command("replay <missionId>")
    .description("Replay a mission charter and wait for its final verdict")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const started = await runner.replayMission(missionId);
      const completed = await runner.waitMission(started.mission.missionId);
      console.log(JSON.stringify({ missionId: completed.missionId, status: completed.status, verdict: completed.verdict }, null, 2));
      if (completed.verdict !== "passed") process.exitCode = 1;
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
    .option("--adapter <adapter>", "web or electron", "web")
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
        headful: options.headful,
      });
      const summary = await runner.wait(started.runId);
      console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict }, null, 2));
      if (summary.verdict !== "passed") process.exitCode = 1;
    });

  // Every leaf command resolves the same source/workspace pair.
  for (const command of [...program.commands, ...mission.commands]) {
    if (command !== mission) command.option("--workspace <path>", "test workspace root; defaults to an external workspace or existing project .proofkit");
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
  mode: string;
  sideEffects?: string;
  out?: string;
  level?: string;
};

type MissionCreateCommandOptions = PlanCommandOptions & {
  surface: string;
};

type RunCommandOptions = PlanCommandOptions & {
  charter?: string;
  adapter: string;
  cdp?: string;
  devtoolsPortFile?: string;
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

if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
