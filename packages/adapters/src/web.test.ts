import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeSurfaceText, sanitizeSurfaceUrl } from "./surface-sanitize.js";
import { matchDeclaredRoutePaths, selectAttachedPage, WebAdapter } from "./web.js";

function page(url: string, title = "", closed = false): Page {
  return {
    url: () => url,
    title: async () => title,
    isClosed: () => closed,
  } as unknown as Page;
}

describe("CDP application page selection", () => {
  it("ignores DevTools and closed tabs and selects the one application page", async () => {
    const application = page("file:///app/index.html", "AIHR Desktop");
    expect(await selectAttachedPage([
      page("devtools://devtools/bundled/inspector.html"),
      page("http://127.0.0.1:3000/old", "Old", true),
      application,
    ], {})).toBe(application);
  });

  it("does not silently pick the first of multiple application pages", async () => {
    const pages = [page("http://127.0.0.1:5173/login", "Login"), page("http://127.0.0.1:5173/resumes", "Resumes")];
    await expect(selectAttachedPage(pages, {})).rejects.toThrow("matched 2 application pages");
    expect(await selectAttachedPage(pages, { targetUrlPrefix: "http://127.0.0.1:5173/resumes" })).toBe(pages[1]);
    expect(await selectAttachedPage(pages, { targetTitleContains: "Login" })).toBe(pages[0]);
  });

  it("uses the configured Web origin as a fallback target", async () => {
    const wanted = page("http://127.0.0.1:5173/resumes", "Resumes");
    expect(await selectAttachedPage([
      page("http://127.0.0.1:8080/admin", "Other app"), wanted,
    ], { baseUrl: "http://127.0.0.1:5173/" })).toBe(wanted);
    expect(await selectAttachedPage([page("about:blank")], { baseUrl: "http://127.0.0.1:5173/" })).toBeUndefined();
  });
});

describe("Web screenshot privacy", () => {
  it("reserves screenshot retry budget only for a timeout with observed same-origin navigation", async () => {
    let elapsed = 1000, url = "http://127.0.0.1:3000/login";
    const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
    const timeout = new Error("Screenshot deadline"); timeout.name = "TimeoutError";
    const screenshot = vi.fn().mockImplementationOnce(async (options: { timeout: number }) => { elapsed += options.timeout; url = "http://127.0.0.1:3000/workspace"; throw timeout; })
      .mockResolvedValue(new Uint8Array([7, 8, 9]));
    const page = { url: () => url, isClosed: () => false, locator: (selector: string) => ({ selector }), screenshot, waitForLoadState: vi.fn(async () => {}) } as unknown as Page;
    const adapter = new WebAdapter({ screenshotTimeoutMs: 5000, screenshotMaskSelectors: ["#private"] });
    (adapter as unknown as { activePage: Page }).activePage = page;
    try {
      expect(await adapter.capture("after.png")).toEqual(new Uint8Array([7, 8, 9]));
      expect(screenshot.mock.calls[0]![0].timeout).toBeLessThan(5000);
      expect(screenshot.mock.calls[1]![0].timeout).toBe(5000 - screenshot.mock.calls[0]![0].timeout);
      expect(screenshot.mock.calls[1]![0].mask).toEqual(screenshot.mock.calls[0]![0].mask);
      expect(adapter.takeCaptureNavigationRecovery()).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it("does not retry a screenshot timeout without navigation", async () => {
    const timeout = new Error("Screenshot deadline"); timeout.name = "TimeoutError";
    const screenshot = vi.fn().mockRejectedValue(timeout);
    const page = { url: () => "http://127.0.0.1:3000/stable", isClosed: () => false, locator: (selector: string) => ({ selector }), screenshot, waitForLoadState: vi.fn() } as unknown as Page;
    const adapter = new WebAdapter(); (adapter as unknown as { activePage: Page }).activePage = page;
    await expect(adapter.capture("after.png")).rejects.toBe(timeout); expect(screenshot).toHaveBeenCalledTimes(1);
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });
  it("masks standard sensitive fields and declared marked regions at every capture", async () => {
    const adapter = new WebAdapter();
    const locator = { count: vi.fn() };
    const screenshot = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const page = { url: () => "http://127.0.0.1:3000/login", locator: vi.fn(() => locator), screenshot } as unknown as Page;
    (adapter as unknown as { activePage: Page }).activePage = page;
    expect(await adapter.capture("failure.png")).toEqual(new Uint8Array([1, 2, 3]));
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('input[type="password"]'));
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('input[autocomplete~="one-time-code" i]'));
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('input[autocomplete~="cc-number" i]'));
    expect(page.locator).toHaveBeenCalledWith(expect.stringContaining('[data-proofkit-mask]'));
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: [locator], maskColor: "#1D2330" }));
  });

  it("adds project-selected masks and never retries an unsuccessful capture without masks", async () => {
    const screenshot = vi.fn(async () => { throw new Error("Invalid masking selector"); });
    const page = { url: () => "http://127.0.0.1:3000/login", locator: vi.fn((selector: string) => ({ selector })), screenshot } as unknown as Page;
    const adapter = new WebAdapter({ screenshotMaskSelectors: ["#private"] });
    (adapter as unknown as { activePage: Page }).activePage = page;
    await expect(adapter.capture("failed.png")).rejects.toThrow("Invalid masking selector");
    expect(screenshot).toHaveBeenCalledOnce();
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: [expect.any(Object), { selector: "#private" }] }));
  });

  it.each(["Execution context was destroyed, most likely because of a navigation", "Protocol error (Page.captureScreenshot): Not attached to an active page"])
  ("retries a same-origin navigation interruption with identical masking and a shared deadline: %s", async (message) => {
    let url = "http://127.0.0.1:3000/login";
    const screenshot = vi.fn().mockImplementationOnce(async () => { url = "http://127.0.0.1:3000/workspace"; throw new Error(message); })
      .mockResolvedValue(new Uint8Array([4, 5, 6]));
    const waitForLoadState = vi.fn(async () => {});
    const page = { url: () => url, isClosed: () => false, locator: vi.fn((selector: string) => ({ selector })), screenshot, waitForLoadState } as unknown as Page;
    const adapter = new WebAdapter({ screenshotMaskSelectors: ["#private"], screenshotTimeoutMs: 5000 });
    (adapter as unknown as { activePage: Page }).activePage = page;
    expect(await adapter.capture("after.png")).toEqual(new Uint8Array([4, 5, 6]));
    expect(waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: expect.any(Number) });
    expect(screenshot).toHaveBeenCalledTimes(2);
    for (const [options] of screenshot.mock.calls) {
      expect(options.mask.map((mask: { selector: string }) => mask.selector)).toEqual([expect.stringContaining("password"), "#private"]);
      expect(options.maskColor).toBe("#1D2330");
      expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(5000);
    }
    expect(adapter.takeCaptureNavigationRecovery()).toBe(true);
    expect(adapter.takeCaptureNavigationRecovery()).toBe(false);
  });

  it("does not retry after cross-origin navigation or a non-navigation masking error", async () => {
    let url = "http://127.0.0.1:3000/login";
    const screenshot = vi.fn(async () => { url = "http://127.0.0.1:4000/other"; throw new Error("Execution context was destroyed, most likely because of a navigation"); });
    const waitForLoadState = vi.fn(async () => {});
    const page = { url: () => url, isClosed: () => false, locator: vi.fn((selector: string) => ({ selector })), screenshot, waitForLoadState } as unknown as Page;
    const adapter = new WebAdapter(); (adapter as unknown as { activePage: Page }).activePage = page;
    await expect(adapter.capture("after.png")).rejects.toThrow("Execution context was destroyed");
    expect(waitForLoadState).not.toHaveBeenCalled(); expect(screenshot).toHaveBeenCalledTimes(1);
    expect(adapter.takeCaptureNavigationRecovery()).toBe(false);
  });
});

describe("declared route projection", () => {
  it("retains only declared hash-route patterns from file and HTTP pages", () => {
    const patterns = ["/resumes/:id", "/login"];
    const privateUrl = "file:///C:/fixture/index.html#/resumes/private-candidate-123?token=secret";
    const projected = matchDeclaredRoutePaths(privateUrl, patterns);
    expect(projected).toEqual(["/resumes/:id"]);
    expect(JSON.stringify(projected)).not.toContain("private-candidate-123");
    expect(matchDeclaredRoutePaths("http://127.0.0.1:5173/#/login", patterns)).toEqual(["/login"]);
    expect(matchDeclaredRoutePaths("file:///C:/fixture/index.html#/unknown", patterns)).toEqual([]);
    expect(matchDeclaredRoutePaths("http://fixture/resumes/123", ["/resumes/:id", "/:section/:id"])).toEqual([]);
  });

  it("saves a file document fingerprint and route pattern without the local path or hash ID", async () => {
    const adapter = new WebAdapter({ routePatterns: ["/resumes/:id"], targetUrlPrefix: "file:///C:/fixture/index.html" });
    (adapter as unknown as { activePage: Page }).activePage = {
      url: () => "file:///C:/fixture/index.html#/resumes/private-candidate-123",
      title: async () => "Resume",
      locator: () => ({ innerText: async () => "Resume ready" }),
    } as unknown as Page;
    const snapshot = await adapter.snapshot();
    expect(snapshot.url).toBe("file:[PATH REDACTED]");
    expect(snapshot.metadata.matchedRoutePaths).toEqual(["/resumes/:id"]);
    expect(snapshot.metadata.fileDocumentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-candidate-123|C:\/fixture/);
  });

  it("does not bind a different file with the same route hash", async () => {
    const adapter = new WebAdapter({ routePatterns: ["/resumes/:id"], targetUrlPrefix: "file:///C:/fixture/index.html" });
    (adapter as unknown as { activePage: Page }).activePage = {
      url: () => "file:///C:/fixture/index.html.evil#/resumes/private-candidate-123",
      title: async () => "Resume",
      locator: () => ({ innerText: async () => "Resume ready" }),
    } as unknown as Page;
    const snapshot = await adapter.snapshot();
    const expected = new URL("file:///C:/fixture/index.html");
    const expectedFingerprint = createHash("sha256").update(`${expected.host}${expected.pathname}`).digest("hex");
    expect(snapshot.metadata.fileDocumentSha256).not.toBe(expectedFingerprint);
    expect(snapshot.url).toBe("file:[PATH REDACTED]");
  });

  it("projects HTTP paths and embedded URLs without persisting private IDs", () => {
    expect(sanitizeSurfaceUrl("http://user:pass@fixture/resumes/private-123?token=secret", ["/resumes/:id"]))
      .toBe("http://fixture/resumes/:id");
    expect(sanitizeSurfaceUrl("http://fixture/other/private-123")).toBe("http://fixture/__redacted__");
    expect(sanitizeSurfaceText("failed at http://fixture/resumes/private-123?token=secret", 200))
      .toBe("failed at http://fixture/__redacted__");
  });

  it("records route patterns in action receipts without the observed record ID", async () => {
    const adapter = new WebAdapter({ routePatterns: ["/resumes/:id"] });
    (adapter as unknown as { activePage: Page }).activePage = {
      url: () => "http://fixture/resumes/private-candidate-123?token=private",
      title: async () => "Resume",
    } as unknown as Page;
    const receipt = await adapter.act({ kind: "observe" });
    expect(receipt.urlBefore).toBe("http://fixture/resumes/:id");
    expect(receipt.urlAfter).toBe("http://fixture/resumes/:id");
    expect(receipt.metadata.urlAfterPathEvidence).toBe("declared");
    expect(JSON.stringify(receipt)).not.toMatch(/private-candidate-123|token=private/);
  });
});
