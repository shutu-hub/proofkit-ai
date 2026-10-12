import type { Action, ActionReceipt, Assertion, AssertionResult, SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent, SurfaceActionContext, SurfaceAdapter } from "@proofkit/runner";
import { BlockedError, InconclusiveError } from "@proofkit/runner";
import { sanitizeSurfaceText, sanitizeSurfaceUrl } from "./surface-sanitize.js";

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
const MAX_DRIVER_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Thin W3C WebDriver adapter for Appium and compatible mobile drivers.
 * ProofKit owns the run/evidence contract; the driver owns native UI control.
 */
export class MobileAdapter implements SurfaceAdapter {
  readonly name = "mobile";
  private readonly options: MobileAdapterOptions;
  private sessionId?: string;

  constructor(options: MobileAdapterOptions) {
    this.options = { requestTimeoutMs: 30_000, keepSession: Boolean(options.sessionId), ...options };
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
      ...(typeof url === "string" ? { url: sanitizeSurfaceUrl(url) } : {}),
      ...(typeof title === "string" ? { title: sanitizeSurfaceText(title, 200) } : {}),
      text: typeof source === "string" ? summarizeMobileSource(source) : undefined,
      metadata: { adapter: this.name, protocol: "W3C WebDriver", sourceTextScope: "non-editable-xml-labels" },
    };
  }

  async act(action: Action, context?: SurfaceActionContext): Promise<ActionReceipt> {
    if (action.kind === "selectOption" || action.kind === "setChecked") throw new BlockedError("Native browser form actions are not supported by the mobile adapter");
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
        const inputElement = await this.findElement(action.selector, signal);
        await this.command("POST", `/element/${encodeURIComponent(inputElement)}/clear`, undefined, signal);
        signal?.throwIfAborted();
        await this.command("POST", `/element/${encodeURIComponent(inputElement)}/value`,
          { text: action.value, value: [...action.value] }, signal);
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
      ...(before ? { urlBefore: sanitizeSurfaceUrl(before) } : {}),
      ...(after ? { urlAfter: sanitizeSurfaceUrl(after) } : {}),
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
      const title = await this.assertionText("/title", "mobile-title-unavailable");
      const passed = title.includes(assertion.text);
      return { assertion, passed, message: passed ? `Title contains: ${assertion.text}` : `Title does not contain: ${assertion.text}`, evidence: [] };
    }
    const url = await this.assertionText("/url", "mobile-url-unavailable");
    let pattern: RegExp;
    try { pattern = new RegExp(assertion.pattern); }
    catch { throw new InconclusiveError("mobile-url-pattern-invalid", "Mobile URL assertion has an invalid pattern"); }
    const passed = pattern.test(url);
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
    try {
      await this.request("DELETE", `/session/${encodeURIComponent(this.sessionId)}`, undefined, false);
    } catch {
      throw new InconclusiveError("mobile-session-cleanup-unverified", "Mobile driver session cleanup could not be verified; the session may still be active.");
    }
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
    const value = await this.command("POST", "/elements", locator, signal);
    if (!Array.isArray(value) || value.length > 100) {
      throw new InconclusiveError("mobile-selector-elements-invalid", "Mobile driver did not return a bounded element list for the action target");
    }
    if (value.length !== 1) {
      throw new InconclusiveError(value.length === 0 ? "mobile-selector-missing" : "mobile-selector-ambiguous",
        `Mobile action target matched ${value.length} elements; use a unique selector`);
    }
    const match = value[0];
    const element = isRecord(match) ? match["element-6066-11e4-a52e-4f735466cecf"] ?? match.ELEMENT : undefined;
    if (typeof element !== "string" || !element) {
      throw new InconclusiveError("mobile-selector-element-invalid", "Mobile driver returned an invalid action target element");
    }
    let displayed: unknown;
    try { displayed = await this.command("GET", `/element/${encodeURIComponent(element)}/displayed`, undefined, signal); }
    catch {
      signal?.throwIfAborted();
      throw new InconclusiveError("mobile-selector-visibility-unavailable", "Mobile driver could not verify action target visibility");
    }
    if (displayed !== true) {
      throw new InconclusiveError(displayed === false ? "mobile-selector-hidden" : "mobile-selector-visibility-unavailable",
        "Mobile action target is not verified visible");
    }
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

  private async assertionText(path: "/title" | "/url", code: string): Promise<string> {
    let value: unknown;
    try { value = await this.command("GET", path); }
    catch { throw new InconclusiveError(code, `Mobile driver could not verify ${path === "/title" ? "the title" : "the URL"}`); }
    if (typeof value !== "string" || value.length > 4_096) {
      throw new InconclusiveError(code, `Mobile driver did not return a bounded ${path === "/title" ? "title" : "URL"}`);
    }
    return value;
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
      const raw = await boundedDriverResponse(response, controller);
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

async function boundedDriverResponse(response: Response, controller: AbortController): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DRIVER_RESPONSE_BYTES) {
    const error = new InconclusiveError("mobile-driver-response-too-large", "Mobile driver response exceeds the allowed size");
    controller.abort(error);
    throw error;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DRIVER_RESPONSE_BYTES) {
        const error = new InconclusiveError("mobile-driver-response-too-large", "Mobile driver response exceeds the allowed size");
        controller.abort(error);
        throw error;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extract labels from a bounded XML prefix; never retain raw attributes or editable values. */
function summarizeMobileSource(source: string): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const tag of source.slice(0, 256_000).matchAll(/<([A-Za-z][A-Za-z0-9_.:-]{0,100})\b([^<>]{0,4096})>/g)) {
    const name = tag[1] ?? "";
    if (/(?:EditText|TextField|TextArea|Secure|Password|Input)/i.test(name)) continue;
    const attributes = new Map<string, string>();
    for (const attribute of (tag[2] ?? "").matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/g)) {
      attributes.set((attribute[1] ?? "").toLowerCase(), attribute[3] ?? "");
    }
    if (["password", "secure"].some((key) => /^(true|1)$/i.test(attributes.get(key) ?? ""))) continue;
    if (/^(false|0)$/i.test(attributes.get("displayed") ?? "")) continue;
    for (const key of ["text", "label", "name", "content-desc"]) {
      const raw = attributes.get(key);
      if (!raw) continue;
      const label = sanitizeSurfaceText(decodeXmlAttribute(raw), 200).trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
      if (labels.length >= 60) return labels.join("\n").slice(0, 20_000);
    }
  }
  return labels.join("\n").slice(0, 20_000);
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity]) return named[entity];
    const code = entity.startsWith("&#x") ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
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
