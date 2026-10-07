import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceAdapter } from "@proofkit/runner";

export type WebAdapterOptions = {
  baseUrl?: string;
  cdpUrl?: string;
  headless?: boolean;
  executablePath?: string;
};

export class WebAdapter implements SurfaceAdapter {
  readonly name: string = "web";
  protected browser?: Browser;
  protected context?: BrowserContext;
  protected activePage?: Page;
  protected readonly options: WebAdapterOptions;

  constructor(options: WebAdapterOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const { chromium } = await import("playwright-core");
    if (this.options.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
    } else {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        executablePath: this.options.executablePath,
      });
    }
    this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.activePage = this.context.pages()[0] ?? await this.context.newPage();
    if (this.options.baseUrl && (await this.activePage.url()) === "about:blank") {
      await this.activePage.goto(this.options.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  async discover(): Promise<SurfaceSnapshot> {
    return this.snapshot();
  }

  async snapshot(): Promise<SurfaceSnapshot> {
    const page = this.page();
    const [url, title, text] = await Promise.all([
      page.url(),
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      url,
      title,
      text: text.slice(0, 20_000),
      metadata: { adapter: this.name },
    };
  }

  async act(action: Action): Promise<ActionReceipt> {
    const page = this.page();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const urlBefore = page.url();
    switch (action.kind) {
      case "goto":
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await page.locator(action.selector).first().click();
        break;
      case "fill":
        await page.locator(action.selector).first().fill(action.value);
        break;
      case "press":
        await page.locator(action.selector).first().press(action.key);
        break;
      case "waitForText":
        await page.getByText(action.text, { exact: false }).first().waitFor({ state: "visible", timeout: action.timeoutMs ?? 10_000 });
        break;
      case "screenshot":
      case "observe":
        break;
    }
    return {
      actionId: `${action.kind}-${started}`,
      kind: action.kind,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      urlBefore,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ""),
      metadata: { adapter: this.name },
    };
  }

  async assert(assertion: Assertion): Promise<AssertionResult> {
    const page = this.page();
    if (assertion.kind === "text-visible") {
      const count = await page.getByText(assertion.text, { exact: false }).count();
      return { assertion, passed: count > 0, message: count > 0 ? `Text is visible: ${assertion.text}` : `Text is not visible: ${assertion.text}`, evidence: [] };
    }
    if (assertion.kind === "title-contains") {
      const title = await page.title();
      const passed = title.includes(assertion.text);
      return { assertion, passed, message: passed ? `Title contains: ${assertion.text}` : `Title does not contain: ${assertion.text}`, evidence: [] };
    }
    const url = page.url();
    let passed = false;
    try { passed = new RegExp(assertion.pattern).test(url); } catch { /* invalid patterns are assertion failures */ }
    return { assertion, passed, message: passed ? `URL matches: ${assertion.pattern}` : `URL does not match: ${assertion.pattern}`, evidence: [] };
  }

  async capture(_label: string): Promise<Uint8Array | undefined> {
    return this.page().screenshot({ type: "png" });
  }

  async subscribeEvents(listener: (event: AdapterEvent) => void): Promise<() => void> {
    const page = this.page();
    const onRequest = (request: { method(): string; url(): string }) => listener({ type: "request", payload: { method: request.method(), url: request.url() } });
    const onResponse = (response: { status(): number; url(): string }) => listener({ type: "response", payload: { status: response.status(), url: response.url() } });
    const onConsole = (message: { type(): string; text(): string }) => listener({ type: "console", payload: { level: message.type(), text: message.text() } });
    const onPageError = (error: Error) => listener({ type: "pageerror", payload: { message: error.message } });
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    return () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.activePage = undefined;
  }

  protected page(): Page {
    if (!this.activePage) throw new Error("Web adapter is not connected");
    return this.activePage;
  }
}
