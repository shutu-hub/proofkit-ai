import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceAdapter } from "@proofkit/runner";
import { BlockedError } from "@proofkit/runner";

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

  async snapshot(): Promise<SurfaceSnapshot> {
    const [source, url, title] = await Promise.all([
      this.command("GET", "/source"),
      this.command("GET", "/url").catch(() => undefined),
      this.command("GET", "/title").catch(() => undefined),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof title === "string" ? { title } : {}),
      text: typeof source === "string" ? source.slice(0, 20_000) : undefined,
      metadata: { adapter: this.name, protocol: "W3C WebDriver" },
    };
  }

  async act(action: Action): Promise<ActionReceipt> {
    if (action.kind === "setInputFiles") throw new BlockedError("File selection is not supported by the mobile adapter");
    if (action.kind === "captureResponse") throw new BlockedError("Response capture is not supported by the mobile adapter");
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const before = await this.readUrl();
    switch (action.kind) {
      case "goto":
        await this.command("POST", "/url", { url: action.url });
        break;
      case "click":
        await this.elementCommand(action.selector, "POST", "/click");
        break;
      case "fill":
        if (typeof action.value !== "string") throw new Error("Fill environment reference must be resolved by the runner");
        await this.elementCommand(action.selector, "POST", "/clear");
        await this.elementCommand(action.selector, "POST", "/value", { text: action.value, value: [...action.value] });
        break;
      case "press":
        const key = mobileKeyValue(action.key);
        await this.command("POST", "/actions", { actions: [{ type: "key", id: "proofkit-keyboard", actions: [{ type: "keyDown", value: key }, { type: "keyUp", value: key }] }] });
        break;
      case "waitForText":
        await this.waitForText(action.text, action.timeoutMs ?? 10_000);
        break;
      case "screenshot":
      case "observe":
        break;
      case "capability":
        throw new Error("Capability actions are executed by the runner");
    }
    const after = await this.readUrl();
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
      // The driver source is stronger than the bounded evidence snapshot for an
      // absence check: truncation must never turn a present error into a pass.
      const source = await this.command("GET", "/source");
      const found = typeof source === "string" && source.includes(assertion.text);
      const passed = assertion.kind === "text-visible" ? found : typeof source === "string" && !found;
      return { assertion, passed, message: found ? `Text found in mobile source: ${assertion.text}` : `Text not found in mobile source: ${assertion.text}`, evidence: [] };
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

  private async waitForText(text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const snapshot = await this.snapshot();
      if (snapshot.text?.includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(`Timed out waiting for mobile text: ${text}`);
  }

  private async elementCommand(selector: string, method: string, command: string, body?: unknown): Promise<unknown> {
    const element = await this.findElement(selector);
    return this.command(method, `/element/${encodeURIComponent(element)}${command}`, body);
  }

  private async findElement(selector: string): Promise<string> {
    const locator = parseSelector(selector);
    const value = await this.command("POST", "/element", locator);
    if (!isRecord(value)) throw new Error(`Mobile driver returned an invalid element for selector: ${selector}`);
    const element = value["element-6066-11e4-a52e-4f735466cecf"] ?? value.ELEMENT;
    if (typeof element !== "string") throw new Error(`Mobile driver returned no element id for selector: ${selector}`);
    return element;
  }

  private async readUrl(): Promise<string | undefined> {
    const value = await this.command("GET", "/url").catch(() => undefined);
    return typeof value === "string" ? value : undefined;
  }

  private async command(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.sessionId) throw new Error("Mobile adapter is not connected");
    return (await this.request(method, `/session/${encodeURIComponent(this.sessionId)}${path}`, body, true)).value;
  }

  private async request(method: string, path: string, body?: unknown, sessionRequired = true): Promise<WebDriverResponse> {
    if (sessionRequired && !this.sessionId) throw new Error("Mobile adapter is not connected");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
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
    } finally {
      clearTimeout(timeout);
    }
  }
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
