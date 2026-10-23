import { describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { inspectWebPages, selectWebPage } from "./web-pages.js";

function page(title: string, url = "http://fixture.local/"): Page {
  return { title: async () => title, url: () => url, isClosed: () => false } as unknown as Page;
}
const context = (pages: Page[]) => ({ pages: () => pages }) as unknown as BrowserContext;

describe("owned Web page selection", () => {
  it("selects only one exact same-origin title", async () => {
    const first = page("Cart"); const second = page("Review", "http://fixture.local/review?token=hidden");
    const owned = context([first, second]);
    expect(await selectWebPage(owned, "Review", "http://fixture.local", 100)).toBe(second);
    const observation = await inspectWebPages(owned, first, "http://fixture.local");
    expect(observation.pages).toEqual([{ title: "Cart", url: "http://fixture.local/", active: true, eligibleForSwitch: true },
      { title: "Review", url: "http://fixture.local/__redacted__", active: false, eligibleForSwitch: true }]);
    expect(JSON.stringify(observation)).not.toContain("hidden");
  });

  it("rejects duplicate titles and reports them as ineligible", async () => {
    const pages = [page("Review"), page("Review")]; const owned = context(pages);
    await expect(selectWebPage(owned, "Review", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-ambiguous" });
    expect((await inspectWebPages(owned, pages[0]!, "http://fixture.local")).pages?.every((item) => !item.eligibleForSwitch)).toBe(true);
  });

  it("rejects foreign origins, missing pages, secrets in titles and exceeded inventory bounds", async () => {
    await expect(selectWebPage(context([page("Review", "http://foreign.local/")]), "Review", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-origin" });
    await expect(selectWebPage(context([]), "Review", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-missing" });
    await expect(selectWebPage(context([page("token=private")]), "token=private", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-scope" });
    const pages = Array.from({ length: 17 }, (_, index) => page(`Page ${index}`));
    await expect(selectWebPage(context(pages), "Page 0", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-bound" });
    const observed = await inspectWebPages(context(pages), pages[0]!, "http://fixture.local");
    expect(observed.pagesTruncated).toBe(true); expect(observed.pages).toHaveLength(16);
    expect(observed.pages!.every((item) => !item.eligibleForSwitch)).toBe(true);
  });

  it("honors cancellation and rejects a page that changes origin during selection", async () => {
    const controller = new AbortController(); controller.abort(new Error("Stop selecting"));
    await expect(selectWebPage(context([]), "Review", "http://fixture.local", 100, controller.signal)).rejects.toThrow("Stop selecting");
    let reads = 0;
    const changed = { ...page("Review"), url: () => ++reads === 1 ? "http://fixture.local/" : "http://foreign.local/" } as unknown as Page;
    await expect(selectWebPage(context([changed]), "Review", "http://fixture.local", 100)).rejects.toMatchObject({ code: "surface-page-changed" });
  });
});
