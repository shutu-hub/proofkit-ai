import type { BrowserContext, Page } from "playwright-core";
import type { SurfaceSnapshot } from "@proofkit/contracts";
import { InconclusiveError } from "@proofkit/runner";
import { projectSurfaceUrl, sanitizeSurfaceText } from "./surface-sanitize.js";

export function pageOrigin(url: string): string | undefined {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : undefined; }
  catch { return undefined; }
}

export async function inspectWebPages(context: BrowserContext, active: Page, origin: string | undefined, patterns?: string[]): Promise<Pick<SurfaceSnapshot, "pages" | "pagesTruncated">> {
  const pages = context.pages().filter((page) => !page.isClosed());
  const observed = await Promise.all(pages.slice(0, 16).map(async (page) => {
    const raw = await page.title().catch(() => "");
    const title = sanitizeSurfaceText(raw, 200);
    return { title, url: projectSurfaceUrl(page.url(), patterns).value, active: page === active,
      eligibleForSwitch: Boolean(origin && pageOrigin(page.url()) === origin && raw.trim() && raw === raw.trim() && raw === title) };
  }));
  return { pages: observed.map((page) => ({ ...page, eligibleForSwitch: page.eligibleForSwitch && pages.length <= 16
    && observed.filter((other) => other.title === page.title && other.eligibleForSwitch).length === 1 })), pagesTruncated: pages.length > 16 };
}

export async function selectWebPage(context: BrowserContext, title: string, origin: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Page> {
  if (!origin || sanitizeSurfaceText(title, 200) !== title) throw new InconclusiveError("surface-page-scope", "Page selection requires an unredacted title and an approved HTTP origin.");
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const pages = context.pages().filter((page) => !page.isClosed());
    if (pages.length > 16) throw new InconclusiveError("surface-page-bound", "Page inventory exceeds the 16-page selection bound.");
    const titled = await Promise.all(pages.map(async (page) => ({ page, title: await page.title().catch(() => "") })));
    signal?.throwIfAborted();
    const matches = titled.filter((item) => item.title === title && pageOrigin(item.page.url()) === origin);
    if (matches.length > 1) throw new InconclusiveError("surface-page-ambiguous", "More than one same-origin page has the requested title. Choose a unique observed title.");
    if (matches.length === 1) {
      const selected = matches[0]!.page;
      if (selected.isClosed() || pageOrigin(selected.url()) !== origin || await selected.title().catch(() => "") !== title) {
        throw new InconclusiveError("surface-page-changed", "The selected page changed before focus; inspect its current state.");
      }
      return selected;
    }
    if (titled.some((item) => item.title === title && pageOrigin(item.page.url()) !== origin)) {
      throw new InconclusiveError("surface-page-origin", "The requested page is outside the approved origin.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new InconclusiveError("surface-page-missing", "No same-origin page with the requested title was observed within the selection deadline.");
}
