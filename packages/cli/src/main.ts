#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { MissionComparison, RunMode, SideEffectPolicy, TestCoverage, TestLevel } from "@proofkit/contracts";
import { IntentPlanner, loadCharter } from "@proofkit/planner";
import { inspectEvidenceRetention, LocalRunnerService, type LocalAdapterName } from "@proofkit/local-runner";
import { captureSourceState, collectWorkflowReviewMaterials, initProject, inspectWorkflowInventory, loadConfig, resolveProjectContext,
  resolveWithinWorkspace, scanProject, signWorkflowReview } from "@proofkit/project";
import { setupAgent, type AgentHarness } from "./agent-setup.js";
import { checkAgentConnection } from "./agent-connection.js";
import { registerAgentHost } from "./agent-registration.js";
import { installAihrTemplate } from "./template-install.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("proofkit")
    .description("Evidence-driven AI system testing for Web, Electron and mobile")
    .version("0.1.0");

  const agent = program.command("agent").description("Export host Agent Skills and native MCP onboarding configuration");
  agent.command("setup")
    .description("Generate an external onboarding bundle; optionally install the Skill and register the host MCP server")
    .requiredOption("--harness <harness>", "codex, claude-code or generic")
    .option("--root <path>", "tested project root", ".")
    .option("--template <name>", "install a reviewed reference in the external workspace; currently: aihr")
    .option("--install-skill", "install the portable Skill in the host's personal discovery directory")
    .option("--skills-dir <path>", "explicit personal Skill directory; required for generic installation")
    .option("--allow-capability-writes", "emit operator opt-in for trusted test-environment write capabilities")
    .option("--check-connection", "launch the emitted MCP server and check tools and project binding")
    .option("--register-host", "after a successful local check, install the Skill and register the MCP server with Codex or Claude Code")
    .option("--host-cli <path>", "native host executable or JavaScript entrypoint for --register-host")
    .option("--check-timeout-ms <milliseconds>", "total local connection deadline (1000-60000)", "30000")
    .action(async (options: RootOptions & { harness: AgentHarness; template?: string; installSkill?: boolean; skillsDir?: string; allowCapabilityWrites?: boolean; checkConnection?: boolean; registerHost?: boolean; hostCli?: string; checkTimeoutMs: string }) => {
      const timeoutMs = Number(options.checkTimeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Agent connection timeout must be 1000–60000 milliseconds");
      if (options.hostCli && !options.registerHost) throw new Error("--host-cli requires --register-host");
      if (options.registerHost && options.harness === "generic") throw new Error("--register-host requires --harness codex or claude-code");
      if (options.template && options.template !== "aihr") throw new Error(`Unknown reference template: ${options.template}`);
      if (options.template && (options.checkConnection || options.registerHost)) {
        throw new Error("Review the selected template connector before --check-connection or --register-host; run setup again without --template after review");
      }
      const setup = await setupAgent({ root: options.root, workspaceRoot: options.workspace,
        harness: options.harness, installSkill: options.installSkill || options.registerHost, skillsDir: options.skillsDir,
        allowCapabilityWrites: options.allowCapabilityWrites, template: options.template === "aihr" ? "aihr" : undefined });
      const localConnection = options.checkConnection || options.registerHost ? await checkAgentConnection(setup, timeoutMs) : undefined;
      const hostRegistration = options.registerHost
        ? localConnection?.status === "connected"
          ? await registerAgentHost(setup, { hostCliPath: options.hostCli, timeoutMs })
          : { status: "not-attempted", issue: "local-connection-blocked" }
        : undefined;
      console.log(JSON.stringify({ ...setup, ...(hostRegistration?.status === "registered" ? { next: setup.next.slice(2) } : {}),
        ...(localConnection ? { localConnection } : {}),
        ...(hostRegistration ? { hostRegistration } : {}) }, null, 2));
      if (localConnection?.status === "blocked" || hostRegistration && hostRegistration.status !== "registered") process.exitCode = 1;
    });

  program.command("init")
    .description("Create a ProofKit test workspace bound to the source project")
    .option("--root <path>", "project root", ".")
    .action(async ({ root, workspace }: RootOptions) => {
      const path = await initProject(resolve(root), { workspaceRoot: workspace });
      console.log(`Created ${path}`);
    });

  const template = program.command("template").description("Install reviewable project reference files in an external test workspace");
  template.command("install")
    .description("Install a named reference without changing the tested source")
    .argument("<name>", "currently: aihr")
    .option("--root <path>", "tested project root", ".")
    .action(async (name: string, options: RootOptions) => {
      if (name !== "aihr") throw new Error(`Unknown reference template: ${name}`);
      console.log(JSON.stringify(await installAihrTemplate(resolve(options.root), options.workspace), null, 2));
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
    .description("Observe Web/Electron endpoints or mobile WebDriver readiness without starting an app or running a test")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web, electron or mobile", "web")
    .option("--url <url>", "one-time Web HTTP endpoint; does not change workspace configuration")
    .option("--timeout-ms <milliseconds>", "total observation deadline (100-15000)", "10000")
    .action(async (options: RootOptions & { surface: string; url?: string; timeoutMs: string }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const inspection = await runner.inspectEnvironment({ surface: options.surface as "web" | "electron" | "mobile", url: options.url, timeoutMs: Number(options.timeoutMs) });
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
    .description("Observe the current Web, Electron or mobile surface without asserting product success")
    .option("--root <path>", "project root", ".")
    .option("--adapter <adapter>", "web, electron or mobile", "web")
    .option("--url <url>", "Web entry URL")
    .option("--cdp <url>", "local CDP endpoint")
    .option("--devtools-port-file <path>", "Electron DevToolsActivePort path")
    .option("--mobile-server <url>", "mobile WebDriver server URL")
    .option("--headful", "launch a visible Web browser")
    .option("--ready-text <text>", "wait for visible text before observing (overrides configured readyWhen)")
    .option("--ready-timeout-ms <milliseconds>", "readiness timeout (100-15000, default 5000)")
    .action(async (options: RootOptions & { adapter: string; url?: string; cdp?: string; devtoolsPortFile?: string; mobileServer?: string; headful?: boolean; readyText?: string; readyTimeoutMs?: string }) => {
      if (options.adapter !== "web" && options.adapter !== "electron" && options.adapter !== "mobile") throw new Error("Inspection adapter must be web, electron or mobile");
      if (options.adapter !== "web" && options.url) throw new Error("Only Web inspection accepts --url");
      if (options.adapter !== "mobile" && options.mobileServer) throw new Error("--mobile-server requires --adapter mobile");
      if (options.readyTimeoutMs !== undefined && options.readyText === undefined) throw new Error("--ready-timeout-ms requires --ready-text");
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const inspection = await runner.inspectSurface({ adapter: options.adapter, url: options.url, cdp: options.cdp,
        devtoolsPortFile: options.devtoolsPortFile, mobileServer: options.mobileServer, headful: options.headful,
        readyWhen: options.readyText === undefined ? undefined : { text: options.readyText, timeoutMs: options.readyTimeoutMs === undefined ? undefined : Number(options.readyTimeoutMs) } });
      console.log(JSON.stringify(inspection, null, 2));
      if (inspection.status !== "observed") process.exitCode = 1;
    });

  program.command("scope")
    .description("Inspect source scope, registered plans, unregistered workspace Charter hints and business checks without running tests")
    .option("--root <path>", "project root", ".")
    .option("--surface <surface>", "web, electron or mobile", "web")
    .option("--level <level>", "quick, core or release", "core")
    .option("--focus <text>", "literal substring in source or Charter metadata; unmatched workspace candidates are shown as fallback")
    .option("--limit <count>", "maximum details per section (1-50)", "20")
    .option("--source-state", "include a bounded Git source fingerprint for workflow inventory authoring")
    .action(async (options: RootOptions & { surface: string; level: string; focus?: string; limit: string; sourceState?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const scope = await runner.inspectTestScope({ surface: options.surface as LocalAdapterName, level: options.level as TestLevel, focus: options.focus, limit: Number(options.limit), includeSourceState: Boolean(options.sourceState) });
      console.log(JSON.stringify(scope, null, 2));
    });

  program.command("review-workflows")
    .description("Sign a complete workflow declaration with an operator-controlled Ed25519 key")
    .option("--root <path>", "project root", ".")
    .requiredOption("--key-id <id>", "trusted reviewer key ID")
    .requiredOption("--private-key <path>", "private PEM key outside the project and test workspace")
    .action(async (options: RootOptions & { keyId: string; privateKey: string }) => {
      const root = resolve(options.root);
      const context = resolveProjectContext(root, { workspaceRoot: options.workspace });
      const config = await loadConfig(root, { workspaceRoot: context.workspaceRoot });
      const map = await scanProject(root);
      const source = await captureSourceState(root);
      const reviewed = await inspectWorkflowInventory(root, context.workspaceRoot, config, source, map);
      const inspection = reviewed.inspection;
      const candidates = inspection.candidateAudit;
      if (!reviewed.inventory || inspection.status !== "loaded" || inspection.sourceMatch !== "matching"
        || !inspection.reviewDeclared || inspection.exclusionCount !== 0
        || inspection.linkedWorkflowCount !== inspection.workflowCount
        || inspection.missingSourcePaths.length || inspection.uncoveredSurfaces.length || inspection.missingCharterIds.length
        || !candidates || candidates.status !== "scanned" || candidates.routeCandidates + candidates.entryCandidates === 0
        || candidates.unclaimed || candidates.unlinkedRoutes || candidates.overlappingExclusions
        || candidates.unresolvedRouteDeclarations || candidates.skippedCandidates || candidates.omittedGaps) {
        throw new Error("Workflow review requires a matching source fingerprint, declared reviewer, complete candidate scan, no exclusions and fully linked Charter/platform checks");
      }
      if (!isAbsolute(options.privateKey)) throw new Error("Workflow review private key path must be absolute");
      const keyPath = await realpath(options.privateKey);
      const sourceRoot = await realpath(root);
      const workspaceRoot = await realpath(context.workspaceRoot);
      const within = (base: string) => {
        const path = relative(base, keyPath);
        return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      };
      if (within(sourceRoot) || within(workspaceRoot)) throw new Error("Workflow review private key must be outside the project and test workspace");
      const keyInfo = await stat(keyPath);
      if (!keyInfo.isFile() || keyInfo.size > 16_384) throw new Error("Workflow review private key is unavailable or too large");
      const privatePem = await readFile(keyPath, "utf8");
      const materials = await collectWorkflowReviewMaterials(reviewed.inventory, config, map, context.workspaceRoot);
      const attestation = signWorkflowReview(reviewed.inventory, candidates, materials, options.keyId, privatePem);
      const final = await captureSourceState(root);
      if (!final.complete || final.method !== "git" || final.headSha !== reviewed.inventory.source.headSha
        || final.worktreeSha256 !== reviewed.inventory.source.worktreeSha256) {
        throw new Error("Project source changed during workflow review signing");
      }
      await writeWorkspaceOutput(context.workspaceRoot, ".proofkit/workflow-review.json", `${JSON.stringify(attestation, null, 2)}\n`);
      console.log(JSON.stringify({ status: "signed", path: ".proofkit/workflow-review.json", keyId: attestation.keyId,
        inventorySha256: attestation.inventorySha256, candidateSha256: attestation.candidateSha256,
        candidateSetSha256: attestation.candidateSetSha256, charterManifestSha256: attestation.charterManifestSha256,
        acceptance: "unverified-until-executed-and-audited" }, null, 2));
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
    .option("--oracle-url <url>", "read-only HTTP reachability observation (does not prove business success)")
    .option("--oracle-name <name>", "HTTP observation name", "http-check")
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
    .option("--surface <surface>", "web, electron or mobile; inferred from an unambiguous intent when omitted")
    .option("--charter <path>", "load a Charter from the test workspace")
    .option("--candidate <path>", "select an unregistered Charter path from scope inspection")
    .option("--candidate-sha256 <digest>", "pin --candidate to its scope SHA-256")
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
        charterPath: options.candidate,
        charterSha256: options.candidateSha256,
        charterId: options.charterId,
        suiteId: options.suiteId,
        coverage: options.coverage as TestCoverage | undefined,
        surface: options.surface as LocalAdapterName | undefined,
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
      process.exitCode = missionExitCode(evidence.testVerdict);
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

  mission.command("check <missionId>")
    .description("Audit saved evidence and return a CI exit code for the current test verdict")
    .option("--root <path>", "project root", ".")
    .action(async (missionId: string, options: RootOptions) => {
      // Checking saved evidence does not need to import or execute workspace integration code.
      const runner = new LocalRunnerService({ root: resolve(options.root), workspaceRoot: options.workspace });
      const evidence = await runner.missionEvidence(missionId);
      console.log(JSON.stringify({
        missionId: evidence.missionId,
        status: evidence.status,
        verdict: evidence.verdict,
        testVerdict: evidence.testVerdict,
        testVerdictReason: evidence.testVerdictReason,
        acceptanceEvidenceIntegrity: evidence.acceptanceEvidenceIntegrity,
        proofClassification: evidence.proofClassification,
        summary: evidence.summary,
        report: evidence.report,
        reportUnavailable: evidence.reportUnavailable,
      }, null, 2));
      process.exitCode = missionExitCode(evidence.testVerdict);
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
    .description("Create a replay Mission; use --approve to authorize its execution when approval is required")
    .option("--root <path>", "project root", ".")
    .option("--approve", "approve this new replay execution after reviewing its scope and side effects")
    .option("--allow-capability-writes", "allow approved test-environment write capabilities")
    .action(async (missionId: string, options: RootOptions & { approve?: boolean; allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace, allowCapabilityWrites: options.allowCapabilityWrites });
      const started = await runner.replayMission(missionId, { approve: options.approve });
      const completed = await runner.waitMission(started.mission.missionId);
      const evidence = await runner.missionEvidence(completed.missionId);
      console.log(JSON.stringify({ missionId: completed.missionId, replayOfMissionId: missionId, status: completed.status, verdict: completed.verdict, testVerdict: evidence.testVerdict, testVerdictReason: evidence.testVerdictReason, comparison: evidence.comparison, summary: evidence.summary, report: evidence.report, reportUnavailable: evidence.reportUnavailable }, null, 2));
      process.exitCode = evidence.testVerdict === "passed" && (evidence.comparisonUnavailable || evidence.comparison?.baselineVerdict === "failed")
        ? evidence.comparison ? comparisonExitCode(evidence.comparison.status) : 2
        : missionExitCode(evidence.testVerdict);
    });

  mission.command("compare <baselineMissionId> <candidateMissionId>")
    .description("Compare a Mission with its direct replay using saved business evidence")
    .option("--root <path>", "project root", ".")
    .action(async (baselineMissionId: string, candidateMissionId: string, options: RootOptions) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace });
      const comparison = await runner.compareMissions(baselineMissionId, candidateMissionId);
      console.log(JSON.stringify(comparison, null, 2));
      process.exitCode = comparisonExitCode(comparison.status);
    });

  mission.command("stability <missionIds...>")
    .description("Re-audit 3–5 ordered Mission samples without running the project")
    .option("--root <path>", "project root", ".")
    .action(async (missionIds: string[], options: RootOptions) => {
      const runner = new LocalRunnerService({ root: resolve(options.root), workspaceRoot: options.workspace });
      const analysis = await runner.analyzeMissionStability(missionIds);
      console.log(JSON.stringify(analysis, null, 2));
      process.exitCode = analysis.status === "uniform-pass" ? 0 : analysis.status === "inconclusive" ? 2 : 1;
    });

  const repeat = mission.command("repeat").description("Persist and resume an evidenced 3–5 sample Mission series");
  repeat.command("create <baselineMissionId>")
    .requiredOption("--samples <count>", "total sample count, including the baseline", (value) => Number(value))
    .option("--root <path>", "project root", ".")
    .action(async (baselineMissionId: string, options: RootOptions & { samples: number }) => {
      const runner = new LocalRunnerService({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.createMissionRepeatSeries(baselineMissionId, options.samples), null, 2));
    });

  repeat.command("status <seriesId>")
    .option("--root <path>", "project root", ".")
    .action(async (seriesId: string, options: RootOptions) => {
      const runner = new LocalRunnerService({ root: resolve(options.root), workspaceRoot: options.workspace });
      console.log(JSON.stringify(await runner.missionRepeatSeriesStatus(seriesId), null, 2));
    });

  repeat.command("advance <seriesId>")
    .option("--root <path>", "project root", ".")
    .option("--approve", "authorize this one replay execution")
    .option("--allow-capability-writes", "allow approved test-environment write capabilities")
    .action(async (seriesId: string, options: RootOptions & { approve?: boolean; allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace, allowCapabilityWrites: options.allowCapabilityWrites });
      console.log(JSON.stringify(await runner.advanceMissionRepeatSeries(seriesId, options.approve), null, 2));
    });

  repeat.command("run <seriesId>")
    .description("Drive approval-free slots until complete; --approve authorizes only the next interactive replay")
    .option("--root <path>", "project root", ".")
    .option("--approve", "authorize only the next replay execution")
    .option("--allow-capability-writes", "allow approved test-environment write capabilities")
    .action(async (seriesId: string, options: RootOptions & { approve?: boolean; allowCapabilityWrites?: boolean }) => {
      const runner = await LocalRunnerService.create({ root: resolve(options.root), workspaceRoot: options.workspace, allowCapabilityWrites: options.allowCapabilityWrites });
      const state = await runner.driveMissionRepeatSeries(seriesId, options.approve);
      console.log(JSON.stringify(state, null, 2));
      process.exitCode = state.state !== "complete" ? 2 : state.analysis?.status === "uniform-pass" ? 0 : 1;
    });

  program.command("report <runId>")
    .description("Return the saved static report for a completed Run without rewriting evidence")
    .option("--root <path>", "project root", ".")
    .option("--evidence-dir <path>", "run artifact directory", ".proofkit/runs")
    .action(async (runId: string, options: RootOptions & { evidenceDir: string }) => {
      const runner = new LocalRunnerService({ root: options.root, workspaceRoot: options.workspace, evidenceDir: options.evidenceDir });
      console.log(await runner.savedRunReport(runId));
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

  const workspaceCommand = program.command("workspace").description("Inspect the external test workspace");
  workspaceCommand.command("retention")
    .description("Audit Run storage and references without deleting evidence")
    .option("--root <path>", "project root", ".")
    .option("--older-than-days <days>", "review age in whole days", "30")
    .action(async (options: RootOptions & { olderThanDays: string }) => {
      const context = resolveProjectContext(resolve(options.root), { workspaceRoot: options.workspace });
      const result = await inspectEvidenceRetention(context.projectRoot, context.workspaceRoot, Number(options.olderThanDays));
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "incomplete") process.exitCode = 2;
    });

  // Every leaf command resolves the same source/workspace pair.
  for (const command of [...program.commands, ...mission.commands, ...repeat.commands, ...resources.commands, ...workspaceCommand.commands, ...agent.commands, ...template.commands]) {
    if (command !== mission && command !== repeat && command !== resources && command !== workspaceCommand && command !== agent && command !== template) command.option("--workspace <path>", "test workspace root; defaults to an external workspace or legacy .proofkit (agent setup always external)");
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
  surface?: string;
  charter?: string;
  candidate?: string;
  candidateSha256?: string;
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

/** A missing or unauditable acceptance claim is distinct from an observed failure. */
function missionExitCode(testVerdict: string): number {
  if (testVerdict === "passed") return 0;
  if (testVerdict === "failed") return 1;
  return 2;
}

/** Repair evidence has the same pass, observed failure, and unknown distinction as Mission acceptance. */
function comparisonExitCode(status: MissionComparison["status"]): number {
  if (status === "verified-in-scope") return 0;
  if (status === "defect-reproduced") return 1;
  return 2;
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
