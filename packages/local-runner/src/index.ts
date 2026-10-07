import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ElectronAdapter, WebAdapter } from "@proofkit/adapters";
import { createRunId, EvidenceStore } from "@proofkit/evidence";
import { TestCharterSchema, type ProofkitConfig, type ProjectMap, type RunMode, type RunSummary, type SideEffectPolicy, type TestCharter } from "@proofkit/contracts";
import { httpOracle } from "@proofkit/oracles";
import { IntentPlanner, loadCharter, type PlanOptions } from "@proofkit/planner";
import { loadConfig, scanProject } from "@proofkit/project";
import { ExecutionRunner, type SurfaceAdapter } from "@proofkit/runner";
import { ProjectRuntime } from "@proofkit/runtime";

export type LocalAdapterName = "web" | "electron";

export type LocalRunInput = {
  intent?: string;
  charter?: TestCharter;
  charterPath?: string;
  adapter?: LocalAdapterName;
  url?: string;
  cdp?: string;
  devtoolsPortFile?: string;
  headful?: boolean;
  start?: boolean;
  expect?: string[];
  mode?: RunMode;
  sideEffectPolicy?: SideEffectPolicy;
  oracleUrl?: string;
  oracleName?: string;
};

export type LocalRunStatus = {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  verdict?: RunSummary["verdict"];
  summary?: RunSummary;
  error?: string;
  report?: string;
};

type LocalRunRecord = {
  runId: string;
  status: LocalRunStatus["status"];
  promise: Promise<RunSummary>;
  summary?: RunSummary;
  error?: string;
};

export type LocalRunnerOptions = {
  root: string;
  config?: ProofkitConfig;
  evidenceDir?: string;
  restrictWebOrigins?: boolean;
};

export class LocalRunnerService {
  readonly root: string;
  readonly config: ProofkitConfig;
  readonly evidenceDir: string;
  private readonly records = new Map<string, LocalRunRecord>();
  private readonly evidence: EvidenceStore;
  private readonly restrictWebOrigins: boolean;

  constructor(options: LocalRunnerOptions) {
    this.root = resolve(options.root);
    this.config = options.config ?? { ...loadConfigDefaults() };
    this.evidenceDir = resolve(this.root, options.evidenceDir ?? ".proofkit/runs");
    this.evidence = new EvidenceStore(this.evidenceDir);
    this.restrictWebOrigins = options.restrictWebOrigins ?? false;
  }

  static async create(options: Omit<LocalRunnerOptions, "config"> & { config?: ProofkitConfig }): Promise<LocalRunnerService> {
    return new LocalRunnerService({ ...options, config: options.config ?? await loadConfig(options.root) });
  }

  async discover(): Promise<ProjectMap> {
    return scanProject(this.root);
  }

  plan(intent: string, options: PlanOptions = {}): TestCharter {
    return new IntentPlanner().plan(intent, {
      url: options.url ?? this.config.surfaces.web?.baseUrl,
      expect: options.expect,
      mode: options.mode,
      sideEffectPolicy: options.sideEffectPolicy ?? this.config.policies.sideEffects,
    });
  }

  async start(input: LocalRunInput): Promise<LocalRunStatus> {
    const runId = createRunId();
    const record: LocalRunRecord = { runId, status: "running", promise: Promise.resolve(undefined as never) };
    this.records.set(runId, record);
    const promise = this.execute(runId, input);
    record.promise = promise;
    void promise.then((summary) => {
      record.status = "completed";
      record.summary = summary;
    }).catch((error: unknown) => {
      record.status = "failed";
      record.error = toError(error).message;
    });
    return this.toStatus(record);
  }

  async wait(runId: string): Promise<RunSummary> {
    const record = this.records.get(validateRunId(runId));
    if (record) return record.promise;
    return this.evidence.loadSummary(runId);
  }

  async status(runId: string): Promise<LocalRunStatus> {
    const safeRunId = validateRunId(runId);
    const record = this.records.get(safeRunId);
    if (record) {
      if (record.status === "running") {
        try { record.summary = await this.evidence.loadSummary(safeRunId); } catch { /* run has not written its initial summary yet */ }
      }
      return this.toStatus(record);
    }
    try {
      const summary = await this.evidence.loadSummary(safeRunId);
      return {
        runId: safeRunId,
        status: summary.status === "completed" ? "completed" : "running",
        verdict: summary.verdict,
        summary,
        report: this.reportPath(safeRunId),
      };
    } catch {
      throw new Error(`Run not found: ${safeRunId}`);
    }
  }

  async evidenceFor(runId: string, section: "summary" | "events" | "report" = "summary", maxChars = 20_000): Promise<{ runId: string; section: string; content: string; truncated: boolean }> {
    const safeRunId = validateRunId(runId);
    const path = section === "summary"
      ? resolve(this.evidenceDir, safeRunId, "run.json")
      : section === "events"
        ? resolve(this.evidenceDir, safeRunId, "events.jsonl")
        : resolve(this.evidenceDir, safeRunId, "report.html");
    const content = await readFile(path, "utf8");
    return { runId: safeRunId, section, content: content.slice(0, maxChars), truncated: content.length > maxChars };
  }

  async replay(runId: string, input: Omit<LocalRunInput, "intent" | "charter" | "charterPath"> = {}): Promise<LocalRunStatus> {
    const previous = await this.evidence.loadSummary(validateRunId(runId));
    return this.start({ ...input, charter: previous.charter });
  }

  private async execute(runId: string, input: LocalRunInput): Promise<RunSummary> {
    const charter = TestCharterSchema.parse(await this.resolveCharter(input));
    this.validateWebOrigins(charter, input);
    this.validateCdpEndpoint(input);
    if (this.restrictWebOrigins && this.config.project.start && input.start !== false) {
      throw new Error("MCP runs cannot execute project.start; start the project through the CLI or use startProject=false");
    }
    if (this.restrictWebOrigins && input.oracleUrl) {
      const oracleHost = new URL(input.oracleUrl).hostname;
      if (!isLoopback(oracleHost)) throw new Error("Business oracle URL must use loopback");
    }
    const adapter = this.createAdapter(input);
    const oracles = input.oracleUrl
      ? [httpOracle({ name: input.oracleName ?? "http-check", url: input.oracleUrl })]
      : [];
    return new ExecutionRunner(adapter, {
      evidenceDir: this.evidenceDir,
      oracles,
      setup: input.start !== false && this.config.project.start ? async ({ emit }) => {
        const runtime = new ProjectRuntime({
          root: this.root,
          config: this.config,
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
    }).run(charter, runId);
  }

  private async resolveCharter(input: LocalRunInput): Promise<TestCharter> {
    if (input.charter) return input.charter;
    if (input.charterPath) return loadCharter(resolveWithinRoot(this.root, input.charterPath));
    if (!input.intent) throw new Error("An intent, charter, or charterPath is required");
    return this.plan(input.intent, {
      url: input.url,
      expect: input.expect,
      mode: input.mode,
      sideEffectPolicy: input.sideEffectPolicy,
    });
  }

  private createAdapter(input: LocalRunInput): SurfaceAdapter {
    if ((input.adapter ?? "web") === "electron") {
      return new ElectronAdapter({
        cdpUrl: input.cdp ?? this.config.surfaces.electron?.cdpUrl,
        devtoolsActivePortPath: input.devtoolsPortFile ?? this.config.surfaces.electron?.devtoolsActivePort,
      });
    }
    if ((input.adapter ?? "web") !== "web") throw new Error(`Unsupported adapter: ${input.adapter}`);
    return new WebAdapter({
      baseUrl: input.url ?? this.config.surfaces.web?.baseUrl,
      cdpUrl: input.cdp,
      headless: !input.headful,
    });
  }

  private validateWebOrigins(charter: TestCharter, input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const configuredOrigin = this.config.surfaces.web?.baseUrl
      ? new URL(this.config.surfaces.web.baseUrl).origin
      : undefined;
    const urls = [input.url, ...charter.actions.filter((action) => action.kind === "goto").map((action) => action.url)];
    for (const value of urls) {
      if (!value) continue;
      const parsed = new URL(value);
      if (isLoopback(parsed.hostname) || parsed.origin === configuredOrigin) continue;
      throw new Error(`Web URL is outside the configured origin: ${parsed.origin}`);
    }
  }

  private validateCdpEndpoint(input: LocalRunInput): void {
    if (!this.restrictWebOrigins) return;
    const cdp = input.cdp ?? (input.adapter === "electron" ? this.config.surfaces.electron?.cdpUrl : undefined);
    if (cdp && !isLoopback(new URL(cdp).hostname)) {
      throw new Error("CDP endpoint must use loopback in MCP runs");
    }
  }

  private toStatus(record: LocalRunRecord): LocalRunStatus {
    return {
      runId: record.runId,
      status: record.status,
      verdict: record.summary?.verdict,
      summary: record.summary,
      error: record.error,
      report: record.status === "completed" ? this.reportPath(record.runId) : undefined,
    };
  }

  private reportPath(runId: string): string {
    return resolve(this.evidenceDir, runId, "report.html");
  }
}

function validateRunId(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id");
  return runId;
}

function resolveWithinRoot(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path must stay within the project root");
  return absolute;
}

function loadConfigDefaults(): ProofkitConfig {
  return {
    project: { root: ".", health: [], startupTimeoutMs: 60_000 },
    surfaces: {},
    policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
