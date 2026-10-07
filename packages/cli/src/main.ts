import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { ElectronAdapter, WebAdapter } from "@proofkit/adapters";
import type { ProofkitConfig, RunMode, SideEffectPolicy } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { IntentPlanner, loadCharter } from "@proofkit/planner";
import { httpOracle } from "@proofkit/oracles";
import { initProject, loadConfig, scanProject } from "@proofkit/project";
import { ExecutionRunner, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("proofkit")
    .description("Evidence-driven AI system testing for web and Electron")
    .version("0.1.0");

  program.command("init")
    .description("Create a local ProofKit project configuration")
    .option("--root <path>", "project root", ".")
    .action(async ({ root }: { root: string }) => {
      const path = await initProject(resolve(root));
      console.log(`Created ${path}`);
    });

  program.command("doctor")
    .description("Inspect project entry points and local configuration")
    .option("--root <path>", "project root", ".")
    .action(async ({ root }: { root: string }) => {
      const project = await scanProject(resolve(root));
      const config = await loadConfig(resolve(root));
      const checks: Array<[string, string]> = [
        ["project root", project.root],
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
    .action(async ({ root, out }: { root: string; out?: string }) => {
      const map = await scanProject(resolve(root));
      const output = `${JSON.stringify(map, null, 2)}\n`;
      if (out) await writeFile(resolve(root, out), output, "utf8");
      console.log(output);
    });

  program.command("plan <intent>")
    .description("Turn a business intent into a reviewable Test Charter")
    .option("--root <path>", "project root", ".")
    .option("--url <url>", "entry URL")
    .option("--expect <text>", "visible text assertion", collect, [])
    .option("--mode <mode>", "deterministic, guided or explore", "guided")
    .option("--side-effects <policy>", "deny, confirm or allow", "confirm")
    .option("--out <path>", "write YAML output")
    .action(async (intent: string, options: PlanCommandOptions) => {
      const planner = new IntentPlanner();
      const charter = planner.plan(intent, {
        url: options.url,
        expect: options.expect,
        mode: options.mode as RunMode,
        sideEffectPolicy: options.sideEffects as SideEffectPolicy,
      });
      const output = planner.toYaml(charter);
      if (options.out) await writeFile(resolve(options.root, options.out), output, "utf8");
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
    .option("--mode <mode>", "deterministic, guided or explore", "guided")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .option("--oracle-url <url>", "read-only HTTP endpoint used as a business oracle")
    .option("--oracle-name <name>", "business oracle name", "http-check")
    .action(async (intent: string, options: RunCommandOptions) => {
      const root = resolve(options.root);
      const config = await loadConfig(root);
      const charter = options.charter
        ? await loadCharter(resolve(root, options.charter))
        : new IntentPlanner().plan(intent, {
            url: options.url ?? config.surfaces.web?.baseUrl,
            expect: options.expect,
            mode: options.mode as RunMode,
            sideEffectPolicy: config.policies.sideEffects,
          });
      const adapter = createAdapter(options, config);
      const oracles = options.oracleUrl ? [httpOracle({ name: options.oracleName, url: options.oracleUrl })] : [];
      const summary = await new ExecutionRunner(adapter, {
        evidenceDir: resolve(root, options.evidenceDir),
        oracles,
        setup: options.start && config.project.start ? async ({ emit }) => {
          const runtime = new ProjectRuntime({
            root,
            config,
            onEvent: (event) => void emit({ timestamp: new Date().toISOString(), type: "adapter.event", payload: { source: "project-runtime", ...event } }),
          });
          try {
            await runtime.start();
          } catch (error) {
            await runtime.stop();
            throw error;
          }
          return () => runtime.stop();
        } : undefined,
      }).run(charter);
      console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict, report: resolve(root, options.evidenceDir, summary.runId, "report.html") }, null, 2));
      if (summary.verdict === "failed" || summary.verdict === "blocked") process.exitCode = 1;
    });

  program.command("report <runId>")
    .description("Regenerate a static report for a run")
    .option("--root <path>", "project root", ".")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .action(async (runId: string, options: { root: string; evidenceDir: string }) => {
      const store = new EvidenceStore(resolve(options.root, options.evidenceDir));
      const summary = await store.loadSummary(runId);
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
    .action(async (runId: string, options: ReplayOptions) => {
      const root = resolve(options.root);
      const store = new EvidenceStore(resolve(root, options.evidenceDir));
      const previous = await store.loadSummary(runId);
      if (!options.rerun) {
        console.log(JSON.stringify({ runId: previous.runId, verdict: previous.verdict, charter: previous.charter, steps: previous.steps.length, artifacts: previous.artifacts.length }, null, 2));
        return;
      }
      const adapter = createAdapter(options, await loadConfig(root));
      const summary = await new ExecutionRunner(adapter, { evidenceDir: resolve(root, options.evidenceDir) }).run(previous.charter);
      console.log(JSON.stringify({ runId: summary.runId, verdict: summary.verdict }, null, 2));
    });

  return program;
}

type PlanCommandOptions = {
  root: string;
  url?: string;
  expect: string[];
  mode: string;
  sideEffects: string;
  out?: string;
};

type RunCommandOptions = PlanCommandOptions & {
  charter?: string;
  adapter: string;
  cdp?: string;
  devtoolsPortFile?: string;
  headful?: boolean;
  start: boolean;
  evidenceDir: string;
  oracleUrl?: string;
  oracleName: string;
};

type ReplayOptions = {
  root: string;
  evidenceDir: string;
  rerun?: boolean;
  adapter: string;
  cdp?: string;
  devtoolsPortFile?: string;
  headful?: boolean;
};

function createAdapter(options: { adapter: string; cdp?: string; devtoolsPortFile?: string; headful?: boolean; url?: string }, config: ProofkitConfig): SurfaceAdapter {
  if (options.adapter === "electron") {
    return new ElectronAdapter({ cdpUrl: options.cdp ?? config.surfaces.electron?.cdpUrl, devtoolsActivePortPath: options.devtoolsPortFile ?? config.surfaces.electron?.devtoolsActivePort });
  }
  if (options.adapter !== "web") throw new Error(`Unsupported adapter: ${options.adapter}`);
  return new WebAdapter({ baseUrl: options.url ?? config.surfaces.web?.baseUrl, cdpUrl: options.cdp, headless: !options.headful });
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
