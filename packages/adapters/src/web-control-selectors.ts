import { sanitizeSurfaceText } from "./surface-sanitize.js";

export const WEB_CONTROL_SELECTOR = "button, input:not([type=hidden]), textarea, select, a[href], [role=button], [role=link], [role=textbox], [role=combobox], [role=checkbox], [role=radio], tr[tabindex]";

export function observedRowName(text: string, headers: readonly string[] = [], cells: readonly string[] = []): string {
  if (headers.filter((header) => /^(?:id|record id|identifier)$/i.test(header.trim())).length !== 1) return text;
  const index = headers.findIndex((header) => /^(?:id|record id|identifier)$/i.test(header.trim()));
  const value = index >= 0 ? cells[index]?.trim() : undefined;
  return value && value.length <= 120 && sanitizeSurfaceText(value, value.length) === value ? value : text;
}

export function rowControlSelectors(tag: string, cells: readonly string[] = []): string[] {
  if (tag !== "tr") return [];
  const safe = [...new Set(cells.slice(0, 4).map((text) => text.trim()).filter((text) => text.length > 0 && text.length <= 120 && sanitizeSurfaceText(text, text.length) === text))];
  const selectors = safe.flatMap((text) => ['tr:has(> td:text-is(' + JSON.stringify(text) + ')):visible', 'tr:has(> td :text-is(' + JSON.stringify(text) + ')):visible']);
  if (safe.length > 1) selectors.push('tr:has(> td:text-is(' + JSON.stringify(safe[0]) + ')):has(> td:text-is(' + JSON.stringify(safe[1]) + ')):visible');
  return selectors.filter((selector) => selector.length <= 512);
}

export function nativeClassSelectors(tag: string, tokens: readonly string[] = []): string[] {
  if (!["input", "textarea", "select", "button"].includes(tag)) return [];
  const classes = [...new Set(tokens.slice(0, 12).filter((token) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(token)
    && sanitizeSurfaceText(token, token.length) === token))].slice(0, 3);
  return [...new Set([...classes.map((token) => `${tag}.${token}`), ...(classes.length > 1 ? [`${tag}.${classes.join(".")}`] : [])])];
}

export function landmarkControlSelectors(ancestors: readonly string[] = [], targets: readonly string[] = []): string[] {
  const landmarks = new Set(["footer", "dialog", "form", "nav", "aside", "header", "section"]);
  const selectors: string[] = [];
  for (const tag of ancestors.slice(0, 4)) {
    if (!landmarks.has(tag)) continue;
    for (const target of targets.slice(0, 4)) {
      const scoped = `${tag} >> ${target}`;
      if (scoped.length <= 512) selectors.push(scoped);
    }
  }
  return [...new Set(selectors)];
}

export function scopedControlSelectors(tag: string, scopes: readonly { tag: string; path: string[]; text: string }[] = [], targets: readonly string[] = []): string[] {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(tag)) return [];
  const selectors: string[] = [];
  const bases = [...new Set([...targets.slice(0, 3), tag])];
  for (const scope of scopes.slice(0, 3)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(scope.tag) || scope.path.length < 1 || scope.path.length > 4
      || scope.path.some((part) => !/^[a-z][a-z0-9-]{0,31}$/.test(part))
      || !/^(label|legend|h[1-6])$/.test(scope.path.at(-1)!) || !scope.text.trim() || scope.text.length > 120
      || sanitizeSurfaceText(scope.text, scope.text.length) !== scope.text) continue;
    const prefix = scope.tag + ':has(> ' + scope.path.join(' > ') + ':text-is(' + JSON.stringify(scope.text) + '))';
    for (const base of bases) if (base.length <= 512) selectors.push(prefix + ' >> ' + base);
  }
  return [...new Set(selectors)];
}
