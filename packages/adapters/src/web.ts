import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page, Request, Response } from "playwright-core";
import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceControl, SurfaceSnapshot } from "@proofkit/contracts";
import { SurfaceTextReadRequestSchema, type SurfaceTextReadRequest } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceAdapter, SurfaceActionContext } from "@proofkit/runner";
import { AmbiguousSurfaceTargetError, InconclusiveError, InvalidFileInputControlError } from "@proofkit/runner";
import { captureActionResponse } from "./response-capture.js";
import { projectSurfaceUrl, sanitizeSurfaceText } from "./surface-sanitize.js";
import { BenchmarkHarRecorder, type BenchmarkHarManifest, type BenchmarkHarOptions } from "./benchmark-har.js";
import type { WebTaskSession } from "./web-task-session.js";

export type WebAdapterOptions = {
  baseUrl?: string;
  cdpUrl?: string;
  /** Selects one existing application page when attaching over CDP. */
  targetUrlPrefix?: string;
  targetTitleContains?: string;
  /** Save only matched declared route patterns; never persist raw hash paths. */
  routePatterns?: string[];
  headless?: boolean;
  executablePath?: string;
  /**
   * Screenshots are supporting evidence. Keep a broken or offscreen renderer
   * from holding the business assertions and Oracles for Playwright's
   * default 30 second timeout.
   */
  screenshotTimeoutMs?: number;
  /** Raw, unsanitized HAR in a new external benchmark directory. No CDP attach. */
  benchmarkHar?: BenchmarkHarOptions;
  /** Trusted task owner only; a Run must not close or reset its borrowed context. */
  taskSession?: { session: WebTaskSession; runId: string };
};

export class WebAdapter implements SurfaceAdapter {
  readonly name: string = "web";
  readonly supportsFileInputs = true;
  readonly supportsResponseCapture = true;
  protected browser?: Browser;
  protected context?: BrowserContext;
  protected activePage?: Page;
  protected readonly options: WebAdapterOptions;
  private eventSink?: (event: AdapterEvent) => void;
  private pendingEvents: AdapterEvent[] = [];
  private droppedPendingEvents = 0;
  private detachPageEvents?: () => void;
  private ownedContext = false;
  private harRecorder?: BenchmarkHarRecorder;
  private harManifest?: BenchmarkHarManifest;
  private connecting = false;
  private closeRequested = false;
  private closing?: Promise<void>;
  private benchmarkCaptureStarted = false;
  private harCloseFailure?: "context-close-failed" | "browser-close-failed";
  private releaseTask?: () => void;

  constructor(options: WebAdapterOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.options.taskSession && (this.options.cdpUrl || this.options.benchmarkHar || this.name !== "web")) {
      throw new Error("Task sessions require Web without CDP or per-Run HAR");
    }
    if (this.options.benchmarkHar && this.options.cdpUrl) {
      throw new InconclusiveError("benchmark-har-attach-unsupported", "Benchmark HAR requires a new adapter-owned browser context; existing CDP sessions cannot establish capture from task start.");
    }
    if (this.connecting || this.browser || this.closing) throw new Error("Web adapter is already connecting or connected");
    if (this.options.benchmarkHar && this.benchmarkCaptureStarted) throw new Error("Benchmark HAR adapters are single-use; create a new adapter and capture directory");
    this.connecting = true;
    this.closeRequested = false;
    try {
      await this.connectBrowser();
    } finally {
      this.connecting = false;
      // A resource can arrive after the runner's cancellation cleanup grace.
      if (this.closeRequested) await this.closeAfterConnect();
    }
  }

  private async connectBrowser(): Promise<void> {
    this.pendingEvents = [];
    this.droppedPendingEvents = 0;
    if (this.options.taskSession) {
      const borrowed = await this.options.taskSession.session.acquire(this.options.taskSession.runId);
      this.browser = borrowed.browser; this.context = borrowed.context; this.activePage = borrowed.page;
      this.releaseTask = borrowed.release;
      this.checkConnectOpen();
      this.attachPageEvents(borrowed.page);
      return;
    }
    const { chromium } = await import("playwright-core");
    this.checkConnectOpen();
    if (this.options.benchmarkHar) {
      this.benchmarkCaptureStarted = true;
      const recorder = new BenchmarkHarRecorder(this.options.benchmarkHar);
      await recorder.prepare();
      this.harRecorder = recorder;
      this.harManifest = undefined;
      this.checkConnectOpen();
    }
    if (this.options.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
      this.checkConnectOpen();
      const deadline = Date.now() + 5_000;
      while (true) {
        const pages = this.browser.contexts().flatMap((context) => context.pages());
        const selected = await selectAttachedPage(pages, this.options);
        this.checkConnectOpen();
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
      this.checkConnectOpen();
    }
    this.context = await this.browser.newContext(this.harRecorder ? {
      recordHar: { path: this.harRecorder.path, mode: "full", content: "embed" },
      serviceWorkers: "block",
    } : {});
    this.ownedContext = true;
    this.checkConnectOpen();
    this.activePage = this.context.pages()[0] ?? await this.context.newPage();
    this.checkConnectOpen();
    this.attachPageEvents(this.activePage);
    if (this.options.baseUrl && (await this.activePage.url()) === "about:blank") {
      await this.activePage.goto(this.options.baseUrl, { waitUntil: "domcontentloaded" });
    }
    this.checkConnectOpen();
  }

  private checkConnectOpen(): void {
    if (this.closeRequested) throw new Error("Web adapter was closed during connection");
  }

  private async closeAfterConnect(): Promise<void> {
    await this.closing?.catch(() => {});
    await this.close();
  }

  async discover(): Promise<SurfaceSnapshot> {
    const snapshot = await this.snapshot();
    const page = this.page();
    const { candidates, total } = await page.locator("button, input:not([type=hidden]), textarea, select, a[href], [role=button], [role=link], [role=textbox], [role=combobox], [role=checkbox], [role=radio]").evaluateAll((nodes) => {
      const visible = nodes.filter((element) => element instanceof HTMLElement
        && ((element instanceof HTMLInputElement && element.type === "file")
          || (element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== "hidden"
            && element.getAttribute("aria-hidden") !== "true")));
      const candidates = visible.slice(0, 60).map((element) => {
        const html = element as HTMLElement;
        const tag = html.tagName.toLowerCase();
        const type = html.getAttribute("type")?.toLowerCase();
        const role = type === "file" ? "file-input" : html.getAttribute("role") ?? (tag === "a" ? "link" : tag === "button" || type === "button" || type === "submit" ? "button"
          : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : tag === "select"
            ? html instanceof HTMLSelectElement && (html.multiple || html.size > 1) ? "listbox" : "combobox" : "textbox");
        const labelled = html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement || html instanceof HTMLSelectElement
          ? html.labels?.[0]?.innerText : undefined;
        const name = [html.getAttribute("aria-label"), labelled, html.getAttribute("placeholder"), html.innerText, html.getAttribute("title")]
          .find((value) => typeof value === "string" && value.trim().length > 0) ?? "";
        const testIdAttribute = html.hasAttribute("data-testid") ? "data-testid" : html.hasAttribute("data-test") ? "data-test" : undefined;
        const testId = testIdAttribute ? html.getAttribute(testIdAttribute) ?? undefined : undefined;
        const id = html.id || undefined;
        return { tag, role, inputType: tag === "input" ? type ?? "text" : undefined,
          visible: html.getClientRects().length > 0 && getComputedStyle(html).visibility !== "hidden" && html.getAttribute("aria-hidden") !== "true",
          name: name.trim(), id, idSelector: id ? `#${CSS.escape(id)}` : undefined,
          testId, testIdAttribute, disabled: html.matches(":disabled") || html.getAttribute("aria-disabled") === "true",
          nativeForm: html instanceof HTMLSelectElement ? { kind: "select" as const, multiple: html.multiple,
            optionCount: html.options.length, selectedCount: html.selectedOptions.length }
            : html instanceof HTMLInputElement && ["checkbox", "radio"].includes(html.type)
              ? { kind: "checkable" as const, checked: html.checked } : undefined };
      });
      return { candidates, total: visible.length };
    });
    const controls: SurfaceControl[] = [];
    for (const candidate of candidates) {
      const rawName = candidate.name.slice(0, 120);
      const name = sanitizeSurfaceText(rawName, 120);
      const control: SurfaceControl = { tag: candidate.tag, role: candidate.role, disabled: candidate.disabled,
        visible: candidate.visible, ...(candidate.inputType ? { inputType: candidate.inputType } : {}),
        ...(name ? { name } : {}), ...(candidate.nativeForm ? { nativeForm: candidate.nativeForm } : {}) };
      const selectors: Array<{ value: string; kind: NonNullable<SurfaceControl["selectorKind"]> }> = [];
      if (candidate.testId && candidate.testIdAttribute && sanitizeSurfaceText(candidate.testId, 120) === candidate.testId) {
        selectors.push({ value: `[${candidate.testIdAttribute}=${JSON.stringify(candidate.testId)}]`, kind: "test-id" });
      }
      if (candidate.idSelector && candidate.id && sanitizeSurfaceText(candidate.id, 120) === candidate.id) {
        selectors.push({ value: candidate.idSelector, kind: "id" });
      }
      if (rawName && name === rawName && ["button", "link", "textbox", "combobox", "listbox", "checkbox", "radio"].includes(candidate.role)) {
        selectors.push({ value: `role=${candidate.role}[name=${JSON.stringify(rawName)}]`, kind: "role" });
      }
      if (candidate.inputType === "file") selectors.push({ value: 'input[type="file"]', kind: "css" });
      for (const selector of selectors) {
        if (await page.locator(selector.value).count().catch(() => 0) !== 1) continue;
        control.selector = selector.value;
        control.selectorKind = selector.kind;
        break;
      }
      if (control.nativeForm) {
        control.nativeActions = control.selector && control.visible && !control.disabled
          ? [control.nativeForm.kind === "select" ? control.nativeForm.multiple ? "selectOptions" : "selectOption" : "setChecked"] : [];
      }
      controls.push(control);
    }
    return { ...snapshot, controls, controlsTruncated: total > candidates.length,
      frameCount: page.frames().length, metadata: { ...snapshot.metadata, controlScope: "main-frame", includesHiddenFileInputs: true } };
  }

  /** Read only rendered text of one visible main-frame region, with verified continuation. */
  async readText(input: SurfaceTextReadRequest): Promise<SurfaceSnapshot> {
    const request = SurfaceTextReadRequestSchema.parse(input);
    let locator: Locator;
    try {
      locator = await uniqueActionLocator(this.page(), request.selector);
    } catch (error) {
      if (error instanceof AmbiguousSurfaceTargetError) throw new InconclusiveError("surface-text-read-ambiguous", "Targeted text reading requires exactly one rendered region.");
      throw error;
    }
    const observed = await locator.evaluate((element) => element instanceof HTMLElement && window === window.top
      ? { text: element.innerText.slice(0, 200_001), url: document.URL, title: document.title } : null);
    if (observed === null) throw new InconclusiveError("surface-text-read-control", "Targeted text reading requires a rendered main-frame HTML region.");
    const capturedAt = new Date().toISOString();
    if (observed.text.length > 200_000) throw new InconclusiveError("surface-text-read-too-large", "Rendered region exceeds the text-read limit; select a smaller region.");
    // Redact the entire bounded region before slicing; credentials spanning a window boundary stay redacted.
    const text = sanitizeSurfaceText(observed.text, observed.text.length);
    if (text.length > 200_000) throw new InconclusiveError("surface-text-read-too-large", "Sanitized region exceeds the text-read limit; select a smaller region.");
    const sourceSha256 = createHash("sha256").update(JSON.stringify({ url: observed.url, selector: request.selector, text })).digest("hex");
    if (request.expectedSourceSha256 && request.expectedSourceSha256 !== sourceSha256) {
      throw new InconclusiveError("surface-text-read-changed", "Rendered region changed since the previous read; restart the read instead of combining different states.");
    }
    if (request.offset > text.length) throw new InconclusiveError("surface-text-read-range", "Requested offset is outside the current sanitized region.");
    const textWindow = text.slice(request.offset, request.offset + request.limit);
    const projected = projectSurfaceUrl(observed.url, this.options.routePatterns);
    const fileDocumentSha256 = fileDocumentFingerprint(observed.url);
    return { capturedAt, url: projected.value, title: sanitizeSurfaceText(observed.title, 200), text: textWindow, textRead: {
      scope: "rendered-main-frame-region", text: textWindow, sourceSha256,
      offset: request.offset, limit: request.limit, totalChars: text.length, returnedChars: textWindow.length,
      nextOffset: request.offset + textWindow.length < text.length ? request.offset + textWindow.length : null,
    }, metadata: { adapter: this.name, urlPathEvidence: projected.pathEvidence,
      matchedRoutePaths: matchDeclaredRoutePaths(observed.url, this.options.routePatterns ?? []),
      ...(fileDocumentSha256 ? { fileDocumentSha256 } : {}) } };
  }

  async snapshot(): Promise<SurfaceSnapshot> {
    const page = this.page();
    const [url, title, text] = await Promise.all([
      page.url(),
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
    ]);
    const projected = projectSurfaceUrl(url, this.options.routePatterns);
    const fileDocumentSha256 = fileDocumentFingerprint(url);
    return {
      capturedAt: new Date().toISOString(),
      url: projected.value,
      title: sanitizeSurfaceText(title, 200),
      text: sanitizeSurfaceText(text, 20_000),
      metadata: { adapter: this.name, urlPathEvidence: projected.pathEvidence,
        matchedRoutePaths: matchDeclaredRoutePaths(url, this.options.routePatterns ?? []),
        ...(fileDocumentSha256 ? { fileDocumentSha256 } : {}) },
    };
  }

  async act(action: Action, context?: SurfaceActionContext): Promise<ActionReceipt> {
    const page = this.page();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const urlBefore = page.url();
    let response;
    let nativeForm;
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
      case "selectOption":
      case "selectOptions":
      case "setChecked":
        nativeForm = await actNativeForm(page, action, context?.signal);
        break;
      case "captureResponse": {
        response = await captureActionResponse(page, action, async ({ signal, remainingTimeoutMs }) => {
          const locator = await uniqueActionLocator(page, action.trigger.selector, "visible", remainingTimeoutMs());
          signal.throwIfAborted();
          const timeout = remainingTimeoutMs();
          if (action.trigger.kind === "click") await locator.click({ timeout });
          else await locator.press(action.trigger.key, { timeout });
          if (action.followUp) {
            const followUp = page.locator(action.followUp.selector).filter({ visible: true });
            try {
              await followUp.first().waitFor({ state: "visible", timeout: Math.min(action.followUp.waitMs, remainingTimeoutMs()) });
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof Error && error.name === "TimeoutError") { remainingTimeoutMs(); return "skipped"; }
              throw error;
            }
            signal.throwIfAborted();
            const count = await followUp.count();
            if (count !== 1) throw new InconclusiveError("follow-up-ambiguous", `Follow-up selector matched ${count} elements`);
            signal.throwIfAborted();
            await followUp.click({ timeout: remainingTimeoutMs() });
            return "clicked";
          }
        }, context?.signal);
        break;
      }
      case "setInputFiles": {
        const files = context?.inputFiles;
        if (!files || files.length !== action.files.length || files.some((file, index) => file.fixture !== action.files[index])) {
          throw new Error("File fixtures must be resolved by the runner");
        }
        // Upload libraries commonly hide the native input behind a styled button.
        const input = await uniqueActionLocator(page, action.selector, "attached");
        const isFileInput = await input.evaluate((element) => element instanceof HTMLInputElement && element.type === "file");
        if (!isFileInput) throw new InvalidFileInputControlError();
        await input.setInputFiles(files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
        break;
      }
      case "waitForText":
        await page.getByText(action.text, { exact: false }).filter({ visible: true }).first()
          .waitFor({ state: "visible", timeout: action.timeoutMs ?? 10_000 });
        break;
      case "screenshot":
      case "observe":
        break;
      case "capability":
        throw new Error("Capability actions are executed by the runner");
    }
    const projectedBefore = projectSurfaceUrl(urlBefore, this.options.routePatterns);
    const projectedAfter = projectSurfaceUrl(page.url(), this.options.routePatterns);
    return {
      actionId: `${action.kind}-${started}`,
      kind: action.kind,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      urlBefore: projectedBefore.value,
      urlAfter: projectedAfter.value,
      titleAfter: sanitizeSurfaceText(await page.title().catch(() => ""), 200),
      metadata: { adapter: this.name, urlBeforePathEvidence: projectedBefore.pathEvidence,
        urlAfterPathEvidence: projectedAfter.pathEvidence, ...(response ? { response } : {}), ...(nativeForm ? { nativeForm } : {}) },
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

  close(): Promise<void> {
    this.closeRequested = true;
    if (this.options.taskSession && this.connecting) this.options.taskSession.session.invalidate("connection-interrupted");
    if (this.closing) return this.closing;
    const closing = this.closeBrowser();
    this.closing = closing;
    void closing.finally(() => {
      if (this.closing === closing) this.closing = undefined;
    }).catch(() => {});
    return closing;
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    const ownedContext = this.ownedContext;
    this.browser = undefined;
    this.context = undefined;
    this.activePage = undefined;
    this.ownedContext = false;
    this.detachPageEvents?.();
    this.detachPageEvents = undefined;
    this.eventSink = undefined;
    this.pendingEvents = [];
    this.droppedPendingEvents = 0;
    if (this.options.taskSession) {
      this.releaseTask?.(); this.releaseTask = undefined;
      return;
    }
    let closeError: unknown;
    let closeFailure: "context-close-failed" | "browser-close-failed" | undefined;
    try {
      if (ownedContext) await context?.close();
    } catch (error) { closeError = error; closeFailure = "context-close-failed"; }
    try { await browser?.close(); }
    catch (error) { closeError ??= error; closeFailure ??= "browser-close-failed"; }
    this.harCloseFailure ??= closeFailure;
    // Do not seal a manifest while acquisition may still produce resources.
    if (this.harRecorder && !this.connecting && !this.context && !this.browser) {
      this.harManifest = await this.harRecorder.finish(this.harCloseFailure);
      if (this.harManifest.status !== "recorded" && !closeError) {
        throw new InconclusiveError("benchmark-har-unavailable", "Benchmark HAR could not establish a finalized nonempty trace; inspect the capture manifest.");
      }
    }
    if (closeError) throw closeError;
  }

  /** Informational Run label and hash; not an attestation of Mission ownership. */
  benchmarkHarManifest(): BenchmarkHarManifest | undefined {
    return this.harManifest ? { ...this.harManifest, recording: { ...this.harManifest.recording } } : undefined;
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

async function uniqueActionLocator(page: Page, selector: string, state: "visible" | "attached" = "visible", timeout = 10_000): Promise<Locator> {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state, timeout });
  const count = await locator.count();
  if (count !== 1) throw new AmbiguousSurfaceTargetError(count);
  return locator;
}

/** Native controls only. Never guess an option, force a click, or persist option contents. */
async function actNativeForm(page: Page, action: Extract<Action, { kind: "selectOption" | "selectOptions" | "setChecked" }>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const control = await uniqueActionLocator(page, action.selector);
  signal?.throwIfAborted();
  if (!await control.isEnabled()) throw new InconclusiveError("native-control-disabled", "Native form control is disabled; no action was performed.");
  if (action.kind === "setChecked") {
    const type = await control.evaluate((element) => element instanceof HTMLInputElement ? element.type : "");
    if (type !== "checkbox" && type !== "radio") throw new InconclusiveError("native-control-type", "setChecked requires a native checkbox or radio input.");
    if (type === "radio" && !action.checked) throw new InconclusiveError("native-radio-uncheck", "Select another radio option to clear this radio input.");
    signal?.throwIfAborted();
    if (await control.isChecked() !== action.checked) {
      await control.scrollIntoViewIfNeeded({ timeout: 10_000 });
      // Styled native switches often cover the input with its own associated label.
      // Use only the label at the input click point, never a nearby caption or forced click.
      const activation = await control.evaluateHandle((element) => {
        if (!(element instanceof HTMLInputElement)) return null;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const labels = Array.from(element.labels ?? []).filter((label) => label.control === element
          && (label === hit || label.contains(hit)) && !label.contains(element));
        return labels.length > 1 ? "ambiguous" : labels[0] ?? null;
      });
      try {
        const label = activation.asElement();
        if (label) {
          const input = await control.elementHandle();
          try {
            signal?.throwIfAborted();
            if (!input || !await label.evaluate((element, input) => element instanceof HTMLLabelElement
              && element.control === input, input)) {
              throw new InconclusiveError("native-state-unverified", "Native label association changed before activation.");
            }
            if (!await control.isEnabled()) throw new InconclusiveError("native-control-disabled", "Native form control is disabled; no action was performed.");
            // Another UI event may already have achieved the requested state while scrolling.
            if (await control.isChecked() !== action.checked) await label.click({ timeout: 10_000 });
          } finally { await input?.dispose(); }
        } else {
          if (await activation.jsonValue() === "ambiguous") {
            throw new InconclusiveError("native-label-match", "Multiple native labels cover the control; no action was performed.");
          }
          signal?.throwIfAborted();
          await control.setChecked(action.checked, { timeout: 10_000 });
        }
      } finally { await activation.dispose(); }
    }
    signal?.throwIfAborted();
    const matches = await control.evaluate((element, checked) => element instanceof HTMLInputElement
      && ["checkbox", "radio"].includes(element.type) && element.checked === checked, action.checked);
    if (!matches) throw new InconclusiveError("native-state-unverified", "Native checked state did not match the requested state after the action.");
    return { kind: action.kind, verified: true, checked: action.checked };
  }
  const requested = { multiple: action.kind === "selectOptions", options: action.kind === "selectOptions" ? action.options : [action.option] };
  const selection = await control.evaluate((element, requested) => {
    if (!(element instanceof HTMLSelectElement) || element.multiple !== requested.multiple) return { valid: false, matches: [] };
    return { valid: true, matches: requested.options.map((option) => {
      const matches = Array.from(element.options).filter((item) => "value" in option ? item.value === option.value : item.label === option.label);
      const match = matches[0];
      return { count: matches.length, index: match?.index ?? -1,
        disabled: Boolean(match?.disabled || (match?.parentElement instanceof HTMLOptGroupElement && match.parentElement.disabled)) };
    }) };
  }, requested);
  if (!selection.valid) throw new InconclusiveError("native-control-type", `${action.kind} requires a native ${requested.multiple ? "multiple" : "single"}-select control.`);
  const invalid = selection.matches.find((match) => match.count !== 1);
  if (invalid) throw new InconclusiveError("native-option-match", `Exact option matched ${invalid.count} entries; no selection was performed.`);
  if (new Set(selection.matches.map((match) => match.index)).size !== selection.matches.length) {
    throw new InconclusiveError("native-option-match", "Requested options resolve to the same entry; no selection was performed.");
  }
  if (selection.matches.some((match) => match.disabled)) throw new InconclusiveError("native-option-disabled", "Requested option is disabled; no selection was performed.");
  signal?.throwIfAborted();
  await control.selectOption(selection.matches.map((match) => ({ index: match.index })), { timeout: 10_000 });
  signal?.throwIfAborted();
  const matches = await control.evaluate((element, requested) => {
    if (!(element instanceof HTMLSelectElement) || element.multiple !== requested.multiple
      || element.selectedOptions.length !== requested.options.length) return false;
    const exact = requested.options.map((option) => Array.from(element.options)
      .filter((item) => "value" in option ? item.value === option.value : item.label === option.label));
    return exact.every((matches) => matches.length === 1) && new Set(exact.map((matches) => matches[0])).size === exact.length
      && exact.every((matches) => Array.from(element.selectedOptions).includes(matches[0]!));
  }, requested);
  if (!matches) throw new InconclusiveError("native-state-unverified", "Native selected state did not match the exact requested option set after the action.");
  return { kind: action.kind, verified: true, selectedCount: requested.options.length };
}

/** Project only declared patterns from the live URL; hash parameters stay local. */
export function matchDeclaredRoutePaths(value: string, patterns: readonly string[]): string[] {
  let url: URL;
  try { url = new URL(value); } catch { return []; }
  const observed = url.hash.startsWith("#/") ? url.hash.slice(1).split(/[?#]/, 1)[0]
    : url.protocol === "http:" || url.protocol === "https:" ? url.pathname : undefined;
  if (!observed) return [];
  const actual = observed.split("/");
  const matches = [...new Set(patterns.filter((pattern) => {
    if (!pattern.startsWith("/") || /[?#\s{}$]/.test(pattern)) return false;
    const expected = pattern.split("/");
    return expected.length === actual.length && expected.every((segment, index) =>
      segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index]);
  }))].sort();
  return matches.length === 1 ? matches : [];
}

/** A digest lets the suite verifier bind a redacted file URL to its configured document. */
function fileDocumentFingerprint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return undefined;
    return createHash("sha256").update(`${url.host}${url.pathname}`).digest("hex");
  } catch { return undefined; }
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
