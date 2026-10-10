import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceActionContext, SurfaceAdapter } from "@proofkit/runner";
import { BlockedError, InconclusiveError } from "@proofkit/runner";

export type MobileAdapterOptions = {
  /** Appium or another W3C WebDriver compatible server URL. */
  serverUrl: string;
  capabilities?: Record<string, unknown>;
  sessionId?: string;
  keepSession?: boolean;
  requestTimeoutMs?: number;
};

type WebDriverResponse = {
  value?: unknown;
  sessionId?: string;
  message?: string;
};

type MobileElement = { "element-6066-11e4-a52e-4f735466cecf"?: string; ELEMENT?: string };

/**
 * Thin W3C WebDriver adapter for Appium and compatible mobile drivers.
 * ProofKit owns the run/evidence contract; the driver owns native UI control.
 */
export class MobileAdapter implements SurfaceAdapter {
  readonly name = "mobile";
  private readonly options: MobileAdapterOptions;
  private sessionId?: string;

  constructor(options: MobileAdapterOptions) {
    this.options = { requestTimeoutMs: 30_000, ...options };
  }

  async connect(): Promise<void> {
    if (this.options.sessionId) {
      this.sessionId = this.options.sessionId;
      return;
    }
    const capabilities = this.options.capabilities ?? {};
    const response = await this.request("POST", "/session", {
      capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
    }, false);
    const sessionId = response.sessionId ?? (isRecord(response.value) && typeof response.value.sessionId === "string" ? response.value.sessionId : undefined);
    if (!sessionId) throw new Error("Mobile driver did not return a WebDriver session id");
    this.sessionId = sessionId;
  }

  async discover(): Promise<SurfaceSnapshot> {
    return this.snapshot();
  }

  async snapshot(signal?: AbortSignal): Promise<SurfaceSnapshot> {
    const [source, url, title] = await Promise.all([
      this.command("GET", "/source", undefined, signal),
      this.command("GET", "/url", undefined, signal).catch(() => { signal?.throwIfAborted(); return undefined; }),
      this.command("GET", "/title", undefined, signal).catch(() => { signal?.throwIfAborted(); return undefined; }),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof title === "string" ? { title } : {}),
      text: typeof source === "string" ? source.slice(0, 20_000) : undefined,
      metadata: { adapter: this.name, protocol: "W3C WebDriver" },
    };
  }

  async act(action: Action, context?: SurfaceActionContext): Promise<ActionReceipt> {
    if (action.kind === "setInputFiles") throw new BlockedError("File selection is not supported by the mobile adapter");
    if (action.kind === "captureResponse") throw new BlockedError("Response capture is not supported by the mobile adapter");
    const signal = context?.signal;
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const before = await this.readUrl(signal);
    signal?.throwIfAborted();
    switch (action.kind) {
      case "goto":
        await this.command("POST", "/url", { url: action.url }, signal);
        break;
      case "click":
        await this.elementCommand(action.selector, "POST", "/click", undefined, signal);
        break;
      case "fill":
        if (typeof action.value !== "string") throw new Error("Fill environment reference must be resolved by the runner");
        await this.elementCommand(action.selector, "POST", "/clear", undefined, signal);
        await this.elementCommand(action.selector, "POST", "/value", { text: action.value, value: [...action.value] }, signal);
        break;
      case "press":
        const key = mobileKeyValue(action.key);
        await this.command("POST", "/actions", { actions: [{ type: "key", id: "proofkit-keyboard", actions: [{ type: "keyDown", value: key }, { type: "keyUp", value: key }] }] }, signal);
        break;
      case "waitForText":
        await this.waitForText(action.text, action.timeoutMs ?? 10_000, signal);
        break;
      case "screenshot":
      case "observe":
        break;
      case "capability":
        throw new Error("Capability actions are executed by the runner");
    }
    const after = await this.readUrl(signal);
    signal?.throwIfAborted();
    return {
      actionId: `${action.kind}-${started}`,
      kind: action.kind,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...(before ? { urlBefore: before } : {}),
      ...(after ? { urlAfter: after } : {}),
      metadata: { adapter: this.name },
    };
  }

  async assert(assertion: Assertion): Promise<AssertionResult> {
    if (assertion.kind === "text-visible" || assertion.kind === "text-not-visible") {
      const displayed = await this.textDisplayed(assertion.text);
      const passed = assertion.kind === "text-visible" ? displayed : !displayed;
      return { assertion, passed,
        message: displayed ? `Text is displayed by mobile driver: ${assertion.text}` : `Text is not displayed by mobile driver: ${assertion.text}`,
        evidence: [] };
    }
    if (assertion.kind === "title-contains") {
      const title = await this.command("GET", "/title").catch(() => "");
      const passed = typeof title === "string" && title.includes(assertion.text);
      return { assertion, passed, message: passed ? `Title contains: ${assertion.text}` : `Title does not contain: ${assertion.text}`, evidence: [] };
    }
    const url = await this.readUrl();
    let passed = false;
    try { passed = url !== undefined && new RegExp(assertion.pattern).test(url); } catch { /* invalid patterns remain assertion failures */ }
    return { assertion, passed, message: passed ? `URL matches: ${assertion.pattern}` : `URL does not match: ${assertion.pattern}`, evidence: [] };
  }

  async capture(_label: string): Promise<Uint8Array | undefined> {
    const value = await this.command("GET", "/screenshot");
    if (typeof value !== "string") return undefined;
    return Uint8Array.from(Buffer.from(value, "base64"));
  }

  async subscribeEvents(_listener: (event: AdapterEvent) => void): Promise<() => void> {
    return () => {};
  }

  async close(): Promise<void> {
    if (!this.sessionId || this.options.keepSession) return;
    await this.request("DELETE", `/session/${encodeURIComponent(this.sessionId)}`, undefined, false).catch(() => {});
    this.sessionId = undefined;
  }

  private async waitForText(text: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    const timer = setTimeout(() => controller.abort(new Error(`Timed out waiting for mobile text: ${text}`)), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (Date.now() <= deadline) {
        controller.signal.throwIfAborted();
        if (await this.textDisplayed(text, controller.signal)) return;
        await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())), controller.signal);
      }
      controller.signal.throwIfAborted();
      throw new Error(`Timed out waiting for mobile text: ${text}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async elementCommand(selector: string, method: string, command: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const element = await this.findElement(selector, signal);
    signal?.throwIfAborted();
    return this.command(method, `/element/${encodeURIComponent(element)}${command}`, body, signal);
  }

  private async findElement(selector: string, signal?: AbortSignal): Promise<string> {
    const locator = parseSelector(selector);
    const value = await this.command("POST", "/element", locator, signal);
    if (!isRecord(value)) throw new Error(`Mobile driver returned an invalid element for selector: ${selector}`);
    const element = value["element-6066-11e4-a52e-4f735466cecf"] ?? value.ELEMENT;
    if (typeof element !== "string") throw new Error(`Mobile driver returned no element id for selector: ${selector}`);
    return element;
  }

  private async textDisplayed(text: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const literal = xpathLiteral(text);
      const attributes = ["text", "label", "name", "content-desc", "value"]
        .map((name) => `contains(@${name}, ${literal})`);
      const value = await this.command("POST", "/elements", {
        using: "xpath", value: `//*[${[...attributes, `contains(text(), ${literal})`].join(" or ")}]`,
      }, signal);
      if (!Array.isArray(value) || value.length > 100) {
        throw new InconclusiveError("mobile-text-elements-invalid", "Mobile driver did not return a bounded element list for text visibility");
      }
      for (const item of value as MobileElement[]) {
        signal?.throwIfAborted();
        const element = item?.["element-6066-11e4-a52e-4f735466cecf"] ?? item?.ELEMENT;
        if (typeof element !== "string" || !element) {
          throw new InconclusiveError("mobile-text-element-invalid", "Mobile driver returned an invalid text element");
        }
        const displayed = await this.command("GET", `/element/${encodeURIComponent(element)}/displayed`, undefined, signal);
        if (typeof displayed !== "boolean") {
          throw new InconclusiveError("mobile-display-state-invalid", "Mobile driver did not return a visibility state");
        }
        if (displayed) return true;
      }
      return false;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof InconclusiveError) throw error;
      throw new InconclusiveError("mobile-visibility-unavailable", "Mobile driver could not verify text visibility");
    }
  }

  private async readUrl(signal?: AbortSignal): Promise<string | undefined> {
    const value = await this.command("GET", "/url", undefined, signal).catch(() => {
      signal?.throwIfAborted();
      return undefined;
    });
    return typeof value === "string" ? value : undefined;
  }

  private async command(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.sessionId) throw new Error("Mobile adapter is not connected");
    return (await this.request(method, `/session/${encodeURIComponent(this.sessionId)}${path}`, body, true, signal)).value;
  }

  private async request(method: string, path: string, body?: unknown, sessionRequired = true, signal?: AbortSignal): Promise<WebDriverResponse> {
    if (sessionRequired && !this.sessionId) throw new Error("Mobile adapter is not connected");
    signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort(new Error("Mobile driver request timed out")), this.options.requestTimeoutMs);
    try {
      const response = await fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
        method,
        signal: controller.signal,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      let parsed: WebDriverResponse = {};
      try { parsed = raw ? JSON.parse(raw) as WebDriverResponse : {}; } catch { parsed = { message: raw.slice(0, 256) }; }
      if (!response.ok) throw new Error(`Mobile driver HTTP ${response.status}: ${parsed.message ?? raw.slice(0, 256)}`);
      if (isRecord(parsed.value) && typeof parsed.value.error === "string") throw new Error(`Mobile driver ${parsed.value.error}: ${String(parsed.value.message ?? "command failed")}`);
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSelector(selector: string): { using: string; value: string } {
  const separator = selector.indexOf("=");
  if (separator > 0) {
    const prefix = selector.slice(0, separator).toLowerCase();
    const value = selector.slice(separator + 1);
    const using = prefix === "accessibility" || prefix === "a11y" ? "accessibility id"
      : prefix === "id" ? "id"
        : prefix === "xpath" ? "xpath"
          : prefix === "class" ? "class name"
            : prefix === "css" ? "css selector"
              : undefined;
    if (using) return { using, value };
  }
  return { using: "accessibility id", value: selector };
}

function xpathLiteral(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map((part) => `"${part}"`).join(', \'"\', ')})`;
}

function mobileKeyValue(key: string): string {
  const named: Record<string, string> = {
    ENTER: "\uE007",
    RETURN: "\uE006",
    TAB: "\uE004",
    ESCAPE: "\uE00C",
    BACKSPACE: "\uE003",
    DELETE: "\uE017",
    ARROW_UP: "\uE013",
    ARROW_DOWN: "\uE015",
    ARROW_LEFT: "\uE012",
    ARROW_RIGHT: "\uE014",
  };
  return named[key.toUpperCase()] ?? key;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export type { AdapterEvent };
