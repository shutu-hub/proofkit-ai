import type { Browser, BrowserContext, Locator, Page, Request, Response } from "playwright-core";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceControl, SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceAdapter } from "@proofkit/runner";

export type WebAdapterOptions = {
  baseUrl?: string;
  cdpUrl?: string;
  /** Selects one existing application page when attaching over CDP. */
  targetUrlPrefix?: string;
  targetTitleContains?: string;
  headless?: boolean;
  executablePath?: string;
  /**
   * Screenshots are supporting evidence. Keep a broken or offscreen renderer
   * from holding the business assertions and Oracles for Playwright's
   * default 30 second timeout.
   */
  screenshotTimeoutMs?: number;
};

export class WebAdapter implements SurfaceAdapter {
  readonly name: string = "web";
  protected browser?: Browser;
  protected context?: BrowserContext;
  protected activePage?: Page;
  protected readonly options: WebAdapterOptions;
  private eventSink?: (event: AdapterEvent) => void;
  private pendingEvents: AdapterEvent[] = [];
  private droppedPendingEvents = 0;
  private detachPageEvents?: () => void;

  constructor(options: WebAdapterOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.pendingEvents = [];
    this.droppedPendingEvents = 0;
    const { chromium } = await import("playwright-core");
    if (this.options.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
      const deadline = Date.now() + 5_000;
      while (true) {
        const pages = this.browser.contexts().flatMap((context) => context.pages());
        const selected = await selectAttachedPage(pages, this.options);
        if (selected) {
          this.context = selected.context();
          this.activePage = selected;
          this.attachPageEvents(selected);
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error("CDP attachment found no matching application page. Open the app or configure targetUrlPrefix/targetTitleContains in the test workspace.");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        executablePath: this.options.executablePath,
      });
    }
    this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.activePage = this.context.pages()[0] ?? await this.context.newPage();
    this.attachPageEvents(this.activePage);
    if (this.options.baseUrl && (await this.activePage.url()) === "about:blank") {
      await this.activePage.goto(this.options.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  async discover(): Promise<SurfaceSnapshot> {
    const snapshot = await this.snapshot();
    const page = this.page();
    const { candidates, total } = await page.locator("button, input:not([type=hidden]), textarea, select, a[href], [role=button], [role=link], [role=textbox], [role=combobox], [role=checkbox], [role=radio]").evaluateAll((nodes) => {
      const visible = nodes.filter((element) => element instanceof HTMLElement
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== "hidden"
        && element.getAttribute("aria-hidden") !== "true");
      const candidates = visible.slice(0, 60).map((element) => {
        const html = element as HTMLElement;
        const tag = html.tagName.toLowerCase();
        const type = html.getAttribute("type")?.toLowerCase();
        const role = html.getAttribute("role") ?? (tag === "a" ? "link" : tag === "button" || type === "button" || type === "submit" ? "button"
          : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : tag === "select" ? "combobox" : "textbox");
        const labelled = html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement || html instanceof HTMLSelectElement
          ? html.labels?.[0]?.innerText : undefined;
        const name = [html.getAttribute("aria-label"), labelled, html.getAttribute("placeholder"), html.innerText, html.getAttribute("title")]
          .find((value) => typeof value === "string" && value.trim().length > 0) ?? "";
        const testIdAttribute = html.hasAttribute("data-testid") ? "data-testid" : html.hasAttribute("data-test") ? "data-test" : undefined;
        const testId = testIdAttribute ? html.getAttribute(testIdAttribute) ?? undefined : undefined;
        const id = html.id || undefined;
        return { tag, role, name: name.trim(), id, idSelector: id ? `#${CSS.escape(id)}` : undefined,
          testId, testIdAttribute, disabled: html.hasAttribute("disabled") || html.getAttribute("aria-disabled") === "true" };
      });
      return { candidates, total: visible.length };
    });
    const controls: SurfaceControl[] = [];
    for (const candidate of candidates) {
      const rawName = candidate.name.slice(0, 120);
      const name = sanitizeSurfaceText(rawName, 120);
      const control: SurfaceControl = { tag: candidate.tag, role: candidate.role, disabled: candidate.disabled,
        ...(name ? { name } : {}) };
      const selectors: Array<{ value: string; kind: NonNullable<SurfaceControl["selectorKind"]> }> = [];
      if (candidate.testId && candidate.testIdAttribute && sanitizeSurfaceText(candidate.testId, 120) === candidate.testId) {
        selectors.push({ value: `[${candidate.testIdAttribute}=${JSON.stringify(candidate.testId)}]`, kind: "test-id" });
      }
      if (candidate.idSelector && candidate.id && sanitizeSurfaceText(candidate.id, 120) === candidate.id) {
        selectors.push({ value: candidate.idSelector, kind: "id" });
      }
      if (rawName && name === rawName && ["button", "link", "textbox", "combobox", "checkbox", "radio"].includes(candidate.role)) {
        selectors.push({ value: `role=${candidate.role}[name=${JSON.stringify(rawName)}]`, kind: "role" });
      }
      for (const selector of selectors) {
        if (await page.locator(selector.value).count().catch(() => 0) !== 1) continue;
        control.selector = selector.value;
        control.selectorKind = selector.kind;
        break;
      }
      controls.push(control);
    }
    return { ...snapshot, controls, controlsTruncated: total > candidates.length,
      frameCount: page.frames().length, metadata: { ...snapshot.metadata, controlScope: "main-frame" } };
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
      url: sanitizeSurfaceUrl(url),
      title: sanitizeSurfaceText(title, 200),
      text: sanitizeSurfaceText(text, 20_000),
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
        await (await uniqueActionLocator(page, action.selector)).click();
        break;
      case "fill":
        if (typeof action.value !== "string") throw new Error("Fill environment reference must be resolved by the runner");
        await (await uniqueActionLocator(page, action.selector)).fill(action.value);
        break;
      case "press":
        await (await uniqueActionLocator(page, action.selector)).press(action.key);
        break;
      case "waitForText":
        await page.getByText(action.text, { exact: false }).first().waitFor({ state: "visible", timeout: action.timeoutMs ?? 10_000 });
        break;
      case "screenshot":
      case "observe":
        break;
      case "capability":
        throw new Error("Capability actions are executed by the runner");
    }
    return {
      actionId: `${action.kind}-${started}`,
      kind: action.kind,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      urlBefore: sanitizeSurfaceUrl(urlBefore),
      urlAfter: sanitizeSurfaceUrl(page.url()),
      titleAfter: sanitizeSurfaceText(await page.title().catch(() => ""), 200),
      metadata: { adapter: this.name },
    };
  }

  async assert(assertion: Assertion): Promise<AssertionResult> {
    const page = this.page();
    if (assertion.kind === "text-visible" || assertion.kind === "text-not-visible") {
      const visible = await hasVisibleText(page, assertion.text);
      const passed = assertion.kind === "text-visible" ? visible : !visible;
      return {
        assertion,
        passed,
        message: visible ? `Text is visible: ${assertion.text}` : `Text is not visible: ${assertion.text}`,
        evidence: [],
      };
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
    return this.page().screenshot({
      type: "png",
      timeout: this.options.screenshotTimeoutMs ?? 5_000,
      animations: "disabled",
    });
  }

  async subscribeEvents(listener: (event: AdapterEvent) => void): Promise<() => void> {
    this.page();
    if (this.eventSink) throw new Error("Web adapter events are already subscribed");
    this.eventSink = listener;
    for (const event of this.pendingEvents) listener(event);
    this.pendingEvents = [];
    if (this.droppedPendingEvents > 0) {
      listener({ type: "event-buffer-overflow", payload: { dropped: this.droppedPendingEvents }, timestamp: new Date().toISOString() });
      this.droppedPendingEvents = 0;
    }
    return () => {
      if (this.eventSink === listener) this.eventSink = undefined;
      this.detachPageEvents?.();
      this.detachPageEvents = undefined;
    };
  }

  async close(): Promise<void> {
    this.detachPageEvents?.();
    this.detachPageEvents = undefined;
    this.eventSink = undefined;
    this.pendingEvents = [];
    this.droppedPendingEvents = 0;
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.activePage = undefined;
  }

  protected page(): Page {
    if (!this.activePage) throw new Error("Web adapter is not connected");
    return this.activePage;
  }

  private attachPageEvents(page: Page): void {
    this.detachPageEvents?.();
    const onRequest = (request: Request) => this.recordPageEvent({ type: "request", payload: { method: request.method(), url: request.url() } });
    const onResponse = (response: Response) => this.recordPageEvent({ type: "response", payload: { method: response.request().method(), status: response.status(), url: response.url() } });
    const onRequestFailed = (request: Request) => this.recordPageEvent({ type: "requestfailed", payload: {
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText,
    } });
    const onConsole = (message: { type(): string; text(): string }) => this.recordPageEvent({ type: "console", payload: { level: message.type(), text: message.text(), url: page.url() } });
    const onPageError = (error: Error) => this.recordPageEvent({ type: "pageerror", payload: { message: error.message, url: page.url() } });
    page.on("request", onRequest);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    this.detachPageEvents = () => {
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    };
  }

  private recordPageEvent(event: AdapterEvent): void {
    const stamped = { ...event, timestamp: new Date().toISOString() };
    if (this.eventSink) this.eventSink(stamped);
    else if (this.pendingEvents.length < 2_000) this.pendingEvents.push(stamped);
    else this.droppedPendingEvents += 1;
  }
}

async function hasVisibleText(page: Page, text: string): Promise<boolean> {
  const matches = page.getByText(text, { exact: false });
  const count = await matches.count();
  for (let index = 0; index < count; index++) {
    if (await matches.nth(index).isVisible()) return true;
  }
  return false;
}

async function uniqueActionLocator(page: Page, selector: string): Promise<Locator> {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state: "visible", timeout: 10_000 });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Action selector matched ${count} elements: ${sanitizeSurfaceText(selector, 120)}`);
  return locator;
}

/** Never choose the first tab by accident when an attached browser has several pages. */
export async function selectAttachedPage(pages: Page[], options: Pick<WebAdapterOptions, "baseUrl" | "targetUrlPrefix" | "targetTitleContains">): Promise<Page | undefined> {
  const explicitTarget = Boolean(options.targetUrlPrefix || options.targetTitleContains);
  const base = !explicitTarget && options.baseUrl ? new URL(options.baseUrl) : undefined;
  const baseOrigin = base && ["http:", "https:"].includes(base.protocol) ? base.origin : undefined;
  const matching: Page[] = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    const url = page.url();
    if (!applicationPageUrl(url)) continue;
    if (options.targetUrlPrefix && !url.startsWith(options.targetUrlPrefix)) continue;
    if (baseOrigin && new URL(url).origin !== baseOrigin) continue;
    if (options.targetTitleContains && !(await page.title().catch(() => "")).includes(options.targetTitleContains)) continue;
    matching.push(page);
  }
  if (matching.length > 1) {
    throw new Error(`CDP attachment matched ${matching.length} application pages. Configure targetUrlPrefix and/or targetTitleContains to select one page.`);
  }
  return matching[0];
}

function applicationPageUrl(url: string): boolean {
  return Boolean(url) && !/^(about:|devtools:|chrome:|chrome-extension:|chrome-error:|edge:)/i.test(url);
}

function sanitizeSurfaceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return `data:${url.pathname.split(",", 1)[0]},[CONTENT REDACTED]`;
    if (url.protocol === "blob:") return "blob:[CONTENT REDACTED]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return value.split(/[?#]/, 1)[0] ?? ""; }
}

function sanitizeSurfaceText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => sanitizeSurfaceUrl(candidate));
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(authorization|cookie|password|secret|token|access[_-]?key|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  text = text.replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]");
  return text;
}
