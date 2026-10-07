import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { resolve as resolveFs } from "node:path";
import type { ProofkitConfig } from "@proofkit/contracts";

export type RuntimeEvent = {
  type: "process.started" | "process.stdout" | "process.stderr" | "process.exited" | "health.ready" | "health.timeout";
  payload: Record<string, unknown>;
};

export type RuntimeOptions = {
  root: string;
  config: ProofkitConfig;
  onEvent?: (event: RuntimeEvent) => void;
};

export class ProjectRuntime {
  private readonly options: RuntimeOptions;
  private child?: ChildProcess;
  private stopped = false;

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async start(): Promise<void> {
    const command = this.options.config.project.start;
    if (!command) {
      await this.waitForHealth();
      return;
    }
    if (this.running) throw new Error("Project runtime is already running");
    const cwd = this.projectCwd();
    this.stopped = false;
    this.child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PROOFKIT_RUN: "1" },
    });
    this.options.onEvent?.({ type: "process.started", payload: { command, cwd, pid: this.child.pid } });
    this.child.stdout?.on("data", (chunk: Buffer) => this.options.onEvent?.({ type: "process.stdout", payload: { text: chunk.toString("utf8").slice(-8_000) } }));
    this.child.stderr?.on("data", (chunk: Buffer) => this.options.onEvent?.({ type: "process.stderr", payload: { text: chunk.toString("utf8").slice(-8_000) } }));
    this.child.on("exit", (code, signal) => this.options.onEvent?.({ type: "process.exited", payload: { code, signal, expected: this.stopped } }));
    await this.waitForHealth();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) return;
    this.stopped = true;
    if (this.options.config.project.stop) {
      const stopper = spawn(this.options.config.project.stop, {
        cwd: this.projectCwd(),
        shell: true,
        windowsHide: true,
        stdio: "ignore",
      });
      await once(stopper, "exit").catch(() => undefined);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    this.child = undefined;
  }

  private projectCwd(): string {
    return this.options.config.project.cwd
      ? resolvePath(this.options.root, this.options.config.project.cwd)
      : this.options.root;
  }

  private async waitForHealth(): Promise<void> {
    const checks = this.options.config.project.health;
    if (checks.length === 0) return;
    const deadline = Date.now() + this.options.config.project.startupTimeoutMs;
    const normalized = checks.map((item) => typeof item === "string" ? { url: item, expectedStatus: 200 } : item);
    while (Date.now() < deadline) {
      const results = await Promise.all(normalized.map((check) => probe(check.url, check.expectedStatus)));
      if (results.every(Boolean)) {
        this.options.onEvent?.({ type: "health.ready", payload: { checks: normalized.map((check) => check.url) } });
        return;
      }
      await delay(250);
    }
    this.options.onEvent?.({ type: "health.timeout", payload: { checks: normalized.map((check) => check.url), timeoutMs: this.options.config.project.startupTimeoutMs } });
    throw new Error(`Project health checks did not pass within ${this.options.config.project.startupTimeoutMs}ms`);
  }
}

async function probe(url: string, expectedStatus: number): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const requestImpl = parsed.protocol === "https:" ? httpsRequest : request;
    return await new Promise<boolean>((resolve) => {
      const req = requestImpl(parsed, { method: "GET", timeout: 2_000 }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode === expectedStatus));
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}

function resolvePath(root: string, path: string): string {
  return resolveFs(root, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
