import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
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
