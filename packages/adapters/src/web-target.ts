import type { ElementHandle, Page } from "playwright-core";
import { changedSurfaceTargetFields, SurfaceTargetCheckSchema, type SurfaceTargetExpectation, type SurfaceTargetIdentity } from "@proofkit/contracts";
import { AmbiguousSurfaceTargetError, InconclusiveError, type SurfaceActionContext } from "@proofkit/runner";
import { sanitizeSurfaceText } from "./surface-sanitize.js";
import { observedRowName } from "./web-control-selectors.js";

export async function withWebActionTarget<Result>(page: Page, selector: string, expected: SurfaceTargetExpectation | undefined,
  context: SurfaceActionContext | undefined, execute: (target: ElementHandle<HTMLElement | SVGElement>) => Promise<Result>,
  state: "visible" | "attached" = "visible", timeout = 10_000): Promise<Result> {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state, timeout });
  const count = await locator.count();
  if (count !== 1) throw new AmbiguousSurfaceTargetError(count);
  context?.signal?.throwIfAborted();
  const handle = await locator.elementHandle({ timeout });
  if (!handle) throw new InconclusiveError("surface-target-unavailable", "The planned control disappeared before its identity could be checked.");
  try {
    if (!expected) return await execute(handle);
    const { actual, actualOrigin } = await inspectWebTargetIdentity(page, handle);
    const changedFields = changedSurfaceTargetFields(expected, actual, actualOrigin);
    const check = SurfaceTargetCheckSchema.parse({ selector, observedAt: new Date().toISOString(), expected, actual,
      ...(actualOrigin ? { actualOrigin } : {}), status: changedFields.length ? "changed" : "matched", changedFields });
    await context?.recordTargetCheck?.(check);
    context?.signal?.throwIfAborted();
    if (check.status !== "matched") throw new InconclusiveError("surface-target-changed", "The observed control identity differs from the reviewed plan. Inspect the saved target check and review a new plan before acting.");
    return await execute(handle);
  } finally { await handle.dispose(); }
}

export async function inspectWebTargetIdentity(page: Page, handle: ElementHandle<HTMLElement | SVGElement>) {
  const raw = await handle.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return null;
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type")?.toLowerCase();
    const role = type === "file" ? "file-input" : element.getAttribute("role") ?? (tag === "tr" ? "row" : tag === "a" ? "link" : tag === "button" || type === "button" || type === "submit" ? "button"
      : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : tag === "select"
        ? element instanceof HTMLSelectElement && (element.multiple || element.size > 1) ? "listbox" : "combobox" : "textbox");
    const nativeInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
    const labelled = nativeInput ? element.labels?.[0]?.innerText : undefined;
    const legend = nativeInput ? element.closest("fieldset")?.querySelector(":scope > legend") : undefined;
    const legendText = legend instanceof HTMLElement ? legend.innerText.trim() : undefined;
    const rowText = tag === "tr" ? element.innerText.replace(/\s+/g, " ").trim() : undefined;
    const name = [element.getAttribute("aria-label"), labelled, element.getAttribute("placeholder"), rowText ?? element.innerText, element.getAttribute("title")]
      .find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
    const tableRow = element instanceof HTMLTableRowElement ? element : undefined;
    const tableHead = tableRow?.closest("table")?.tHead;
    const headerCells = tableHead?.rows.length === 1 ? Array.from(tableHead.rows[0]!.cells) : [];
    const simpleColumns = tableRow && headerCells.length === tableRow.cells.length
      && [...headerCells, ...Array.from(tableRow.cells)].every((cell) => cell.colSpan === 1 && cell.rowSpan === 1);
    const cellText = (cell: HTMLTableCellElement) => cell.getClientRects().length > 0
      && getComputedStyle(cell).visibility !== "hidden" && cell.getAttribute("aria-hidden") !== "true" ? cell.innerText.replace(/\s+/g, " ").trim() : "";
    const cells = tableRow ? Array.from(tableRow.cells).slice(0, 4).map(cellText) : undefined;
    const headers = simpleColumns ? headerCells.slice(0, 4).map(cellText) : undefined;
    return { tag, role, name, cells, headers, groupName: legendText && legendText.length <= 512 ? legendText : "", inputType: tag === "input" ? type ?? "text" : undefined };
  });
  if (!raw) throw new InconclusiveError("surface-target-unavailable", "The planned target is no longer a supported HTML control.");
  const name = sanitizeSurfaceText(observedRowName(raw.name, raw.headers, raw.cells).slice(0, 120), 120);
  const groupName = raw.groupName ? sanitizeSurfaceText(raw.groupName, raw.groupName.length).slice(0, 120) : "";
  const actual: SurfaceTargetIdentity = { tag: raw.tag, role: raw.role, name, groupName: groupName === name ? "" : groupName,
    ...(raw.inputType ? { inputType: raw.inputType } : {}) };
  let actualOrigin: string | undefined;
  try { const url = new URL(page.url()); if (["http:", "https:"].includes(url.protocol)) actualOrigin = url.origin; } catch {}
  return { actual, actualOrigin };
}
