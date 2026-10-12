import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BenchmarkHarRecorder, type BenchmarkHarManifest, type BenchmarkHarOptions } from "./benchmark-har.js";

/** Controller-owned context. Runs borrow it serially; only the task owner closes it. */
export class WebTaskSession {
  readonly contextId = randomUUID();
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private connecting?: Promise<void>;
  private closing?: Promise<BenchmarkHarManifest | undefined>;
  private recorder?: BenchmarkHarRecorder;
  private activeRun?: string;
  private readonly runIds: string[] = [];
  private sealed = false;
  private failure?: string;

  constructor(private readonly options: {
    startUrl: string;
    executablePath?: string;
    headless?: boolean;
    extraHTTPHeaders?: Record<string, string>;
    benchmarkHar: BenchmarkHarOptions;
  }) {
    const url = new URL(options.startUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Task session needs an HTTP start URL without embedded credentials");
    }
  }

  get activeRunId(): string | undefined { return this.activeRun; }
  get unavailableReason(): string | undefined { return this.failure; }
  borrowedRunIds(): string[] { return [...this.runIds]; }
  invalidate(reason: "run-interrupted" | "connection-interrupted"): void { this.failure ??= reason; }

  async acquire(runId: string): Promise<{ browser: Browser; context: BrowserContext; page: Page; release(): void }> {
    if (this.sealed || this.failure || this.activeRun || this.runIds.includes(runId)) {
      throw new Error("Task browser is closed, interrupted or already borrowed");
    }
    this.activeRun = runId;
    this.runIds.push(runId);
    try {
      this.connecting ??= this.connect();
      await this.connecting;
      if (this.sealed || this.failure || !this.page || this.page.isClosed()) throw new Error("Task browser is unavailable");
      let released = false;
      return { browser: this.browser!, context: this.context!, page: this.page,
        release: () => { if (!released) { released = true; if (this.activeRun === runId) this.activeRun = undefined; } } };
    } catch (error) {
      this.failure ??= "connection-unavailable";
      this.activeRun = undefined;
      throw error;
    }
  }

  /** Closing while a Run owns the page is reserved for abandonment/cancellation. */
  close(abandon = false): Promise<BenchmarkHarManifest | undefined> {
    if (this.closing) return this.closing;
    if (this.activeRun && !abandon) return Promise.reject(new Error("Task browser still has an active Run"));
    this.sealed = true;
    if (abandon && this.activeRun) this.failure ??= "run-interrupted";
    this.closing = this.closeResources();
    return this.closing;
  }

  private async connect(): Promise<void> {
    const { chromium } = await import("playwright-core");
    if (this.sealed) throw new Error("Task browser already closed");
    this.recorder = new BenchmarkHarRecorder({ ...this.options.benchmarkHar, contextOwner: "task-owned" });
    await this.recorder.prepare();
    if (this.sealed) throw new Error("Task browser already closed");
    this.browser = await chromium.launch({ executablePath: this.options.executablePath, headless: this.options.headless ?? true });
    if (this.sealed) throw new Error("Task browser already closed");
    this.context = await this.browser.newContext({ serviceWorkers: "block",
      ...(this.options.extraHTTPHeaders ? { extraHTTPHeaders: this.options.extraHTTPHeaders } : {}),
      recordHar: { path: this.recorder.path, mode: "full", content: "embed" } });
    if (this.sealed) throw new Error("Task browser already closed");
    this.page = await this.context.newPage();
    // Bound initialization independently of Playwright's default navigation timeout.
    await this.page.goto(this.options.startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  private async closeResources(): Promise<BenchmarkHarManifest | undefined> {
    // Launch/context creation can settle after a Run's cancellation grace period.
    await this.connecting?.catch(() => {});
    let closeFailure: "context-close-failed" | "browser-close-failed" | undefined;
    try { await this.context?.close(); } catch { closeFailure = "context-close-failed"; }
    try { await this.browser?.close(); } catch { closeFailure ??= "browser-close-failed"; }
    this.page = undefined; this.context = undefined; this.browser = undefined; this.activeRun = undefined;
    return this.recorder ? this.recorder.finish(closeFailure) : undefined;
  }
}
