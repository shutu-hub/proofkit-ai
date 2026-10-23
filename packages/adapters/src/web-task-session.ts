import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, BrowserContextOptions, Page, Request, Response } from "playwright-core";
import type { VideoRecordingBudget, VideoRecordingStopReason } from "@proofkit/contracts";
import { BenchmarkHarRecorder, type BenchmarkHarManifest, type BenchmarkHarOptions } from "./benchmark-har.js";
import { WebVideoRecording, type WebVideoRecordingOptions } from "./web-video-recording.js";

export type SessionNetworkEvent = {
  type: "request" | "response" | "requestfailed";
  requestId: string;
  method: string;
  url: string;
  status?: number;
  observedAt: string;
  initiatingRunId?: string;
  observedDuringRunId?: string;
};

/** Controller-owned context. Runs borrow it serially; only the task owner closes it. */
export class WebTaskSession {
  readonly contextId = randomUUID();
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private recordingPage?: Page;
  private connecting?: Promise<void>;
  private closing?: Promise<BenchmarkHarManifest | undefined>;
  private contextClosing?: Promise<void>;
  private recorder?: BenchmarkHarRecorder;
  private activeRun?: string;
  private readonly runIds: string[];
  private sealed = false;
  private failure?: string;
  private detachNetwork?: () => void;
  private videoRecording?: WebVideoRecording;

  constructor(private readonly options: {
    startUrl: string;
    executablePath?: string;
    headless?: boolean;
    extraHTTPHeaders?: Record<string, string>;
    benchmarkHar?: BenchmarkHarOptions;
    restrictToOrigin?: boolean;
    storageStateLoader?: () => Promise<NonNullable<BrowserContextOptions["storageState"]> | undefined>;
    storageStateSaver?: (state: NonNullable<BrowserContextOptions["storageState"]>) => Promise<void>;
    borrowedRunIds?: string[];
    onNetworkEvent?: (event: SessionNetworkEvent) => void;
    recordVideo?: WebVideoRecordingOptions;
    onRecordingStopped?: (reason: VideoRecordingStopReason) => Promise<void>;
  }) {
    const url = new URL(options.startUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Task session needs an HTTP start URL without embedded credentials");
    }
    if (options.recordVideo && options.benchmarkHar) throw new Error("Task video recording cannot be combined with raw benchmark HAR");
    this.runIds = [...new Set((options.borrowedRunIds ?? []).filter((runId) => /^[a-zA-Z0-9_-]{1,128}$/.test(runId)))].slice(-100);
  }

  get activeRunId(): string | undefined { return this.activeRun; }
  get origin(): string { return new URL(this.options.startUrl).origin; }
  get headless(): boolean { return this.options.headless ?? true; }
  get unavailableReason(): string | undefined { return this.failure; }
  recordingStatus(): "recorded" | "partial" | "unavailable" | undefined { return this.options.recordVideo ? this.videoRecording?.status ?? "unavailable" : undefined; }
  recordingStopReason(): VideoRecordingStopReason | undefined { return this.videoRecording?.stopReason; }
  recordingBudget(): VideoRecordingBudget | undefined { return this.videoRecording?.budget; }
  selectedPageRecording(): { observed: number; saved: number[] } | undefined { return this.videoRecording?.selectedPageResult(); }
  get reusable(): boolean {
    if (this.sealed || this.failure) return false;
    if (!this.page) return Boolean(this.options.storageStateLoader);
    if (this.page.isClosed()) return false;
    if (!this.options.restrictToOrigin) return true;
    try { return new URL(this.page.url()).origin === new URL(this.options.startUrl).origin; }
    catch { return false; }
  }
  async persist(): Promise<void> {
    if (!this.context || !this.options.storageStateSaver) return;
    await this.options.storageStateSaver(await this.context.storageState());
  }
  borrowedRunIds(): string[] { return [...this.runIds]; }
  invalidate(reason: "run-interrupted" | "connection-interrupted"): void { this.failure ??= reason; }

  async acquire(runId: string): Promise<{ browser: Browser; context: BrowserContext; page: Page; selectPage(page: Page): void; release(): void }> {
    if (this.sealed || this.failure || this.activeRun || this.runIds.includes(runId)) {
      throw new Error("Task browser is closed, interrupted or already borrowed");
    }
    this.activeRun = runId;
    this.runIds.push(runId);
    try {
      this.connecting ??= this.connect();
      await this.connecting;
      if (!this.reusable) throw new Error("Task browser is unavailable or left its target origin");
      let released = false;
      return { browser: this.browser!, context: this.context!, page: this.page!,
        selectPage: (page) => {
          if (released || this.activeRun !== runId || this.sealed || page.isClosed() || !this.context?.pages().includes(page)
            || new URL(page.url()).origin !== this.origin) throw new Error("Selected page is outside the active session borrow");
          this.page = page;
          this.videoRecording?.selectPage(page, this.recordingPage);
        },
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
    if (this.options.benchmarkHar) {
      this.recorder = new BenchmarkHarRecorder({ ...this.options.benchmarkHar, contextOwner: "task-owned" });
      await this.recorder.prepare();
    }
    if (this.sealed) throw new Error("Task browser already closed");
    this.browser = await chromium.launch({ executablePath: this.options.executablePath, headless: this.options.headless ?? true });
    this.browser.once("disconnected", () => { if (!this.sealed) this.failure ??= "browser-disconnected"; });
    if (this.sealed) throw new Error("Task browser already closed");
    this.context = await this.browser.newContext({ ...(this.recorder ? { serviceWorkers: "block" as const,
      recordHar: { path: this.recorder.path, mode: "full" as const, content: "embed" as const } } : {}),
      ...(this.options.storageStateLoader ? { storageState: await this.options.storageStateLoader() } : {}),
      ...(this.options.extraHTTPHeaders ? { extraHTTPHeaders: this.options.extraHTTPHeaders } : {}),
      ...(this.options.recordVideo ? { recordVideo: { dir: this.options.recordVideo.directory } } : {}),
    });
    this.context.once("close", () => { if (!this.sealed) this.failure ??= "context-closed"; });
    if (this.sealed) throw new Error("Task browser already closed");
    if (this.options.onNetworkEvent) this.attachNetwork(this.context);
    if (this.options.recordVideo) {
      this.videoRecording = new WebVideoRecording(this.options.recordVideo, (reason) => {
        this.failure ??= `recording-${reason}`;
        const browser = this.browser;
        void this.closeContext().catch(() => browser?.close().catch(() => {}));
        void this.close(true).catch(() => {});
      });
      this.videoRecording.attach(this.context);
    }
    this.page = await this.context.newPage();
    this.recordingPage = this.page;
    // Bound initialization independently of Playwright's default navigation timeout.
    await this.page.goto(this.options.startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  private closeContext(): Promise<void> {
    if (!this.context) return this.contextClosing ?? Promise.resolve();
    this.contextClosing ??= this.context.close();
    return this.contextClosing;
  }

  private async closeResources(): Promise<BenchmarkHarManifest | undefined> {
    // Launch/context creation can settle after a Run's cancellation grace period.
    await this.connecting?.catch(() => {});
    await this.videoRecording?.stop();
    const primaryVideo = this.options.recordVideo ? (this.recordingPage ?? this.page)?.video() : undefined;
    let closeFailure: "context-close-failed" | "browser-close-failed" | undefined;
    let browserClosed = false;
    try { await this.closeContext(); } catch { closeFailure = "context-close-failed"; }
    this.detachNetwork?.(); this.detachNetwork = undefined;
    this.failure ??= closeFailure;
    if (this.options.recordVideo && closeFailure) {
      try { await this.browser?.close(); } catch { closeFailure ??= "browser-close-failed"; }
      browserClosed = true;
    }
    if (this.options.recordVideo) {
      const budgetStop = this.videoRecording?.stopReason;
      await this.videoRecording?.finish(primaryVideo, !closeFailure && (!this.failure || Boolean(budgetStop && this.failure === `recording-${budgetStop}`)));
      if (this.videoRecording?.status === "unavailable") this.failure ??= "recording-finalization-failed";
    }
    if (!browserClosed) {
      try { await this.browser?.close(); } catch { closeFailure ??= "browser-close-failed"; }
    }
    this.failure ??= closeFailure;
    if (this.videoRecording && (closeFailure || (this.failure && this.failure !== `recording-${this.videoRecording.stopReason}`))) this.videoRecording.status = "unavailable";
    this.page = undefined; this.context = undefined; this.browser = undefined; this.activeRun = undefined;
    if (this.videoRecording?.stopReason) await this.options.onRecordingStopped?.(this.videoRecording.stopReason);
    return this.recorder ? this.recorder.finish(closeFailure) : undefined;
  }

  private attachNetwork(context: BrowserContext): void {
    const requests = new WeakMap<Request, { id: string; initiatingRunId?: string }>();
    let nextId = 0;
    const record = (type: SessionNetworkEvent["type"], request: Request, status?: number) => {
      let identity = requests.get(request);
      if (!identity) {
        identity = { id: `${this.contextId}-request-${++nextId}`, initiatingRunId: type === "request" ? this.activeRun : undefined };
        requests.set(request, identity);
      }
      try {
        this.options.onNetworkEvent?.({ type, requestId: identity.id, method: request.method(), url: request.url(),
          ...(status === undefined ? {} : { status }), observedAt: new Date().toISOString(),
          ...(identity.initiatingRunId ? { initiatingRunId: identity.initiatingRunId } : {}),
          ...(this.activeRun ? { observedDuringRunId: this.activeRun } : {}) });
      } catch { this.failure ??= "network-listener-failed"; }
    };
    const onRequest = (request: Request) => record("request", request);
    const onResponse = (response: Response) => record("response", response.request(), response.status());
    const onFailure = (request: Request) => record("requestfailed", request);
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfailed", onFailure);
    this.detachNetwork = () => {
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailure);
    };
  }
}
