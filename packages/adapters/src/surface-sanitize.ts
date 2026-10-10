export type SurfaceUrlProjection = {
  value: string;
  pathEvidence: "declared" | "root" | "redacted";
};

/** Persist declared route patterns or an opaque placeholder, never a live path ID. */
export function projectSurfaceUrl(value: string, routePatterns: readonly string[] = []): SurfaceUrlProjection {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return { value: "data:[CONTENT REDACTED]", pathEvidence: "redacted" };
    if (url.protocol === "blob:") return { value: "blob:[CONTENT REDACTED]", pathEvidence: "redacted" };
    if (url.protocol === "file:") return { value: "file:[PATH REDACTED]", pathEvidence: "redacted" };
    if (url.protocol === "about:" && url.pathname === "blank") return { value: "about:blank", pathEvidence: "root" };
    if (url.protocol !== "http:" && url.protocol !== "https:") return { value: "[URL REDACTED]", pathEvidence: "redacted" };
    const matches = [...new Set(routePatterns.filter((pattern) => routePathMatches(pattern, url.pathname)))];
    if (matches.length === 1) return { value: `${url.origin}${matches[0]}`, pathEvidence: "declared" };
    if (url.pathname === "/") return { value: `${url.origin}/`, pathEvidence: "root" };
    return { value: `${url.origin}/__redacted__`, pathEvidence: "redacted" };
  } catch {
    return value === "NATIVE_APP" ? { value, pathEvidence: "root" } : { value: "[invalid URL]", pathEvidence: "redacted" };
  }
}

export function sanitizeSurfaceUrl(value: string, routePatterns: readonly string[] = []): string {
  return projectSurfaceUrl(value, routePatterns).value;
}

function routePathMatches(pattern: string, observed: string): boolean {
  if (!pattern.startsWith("/") || /[?#\s{}$]/.test(pattern)) return false;
  const expected = pattern.split("/");
  const actual = observed.split("/");
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index]);
}

export function sanitizeSurfaceText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => sanitizeSurfaceUrl(candidate));
  text = text.replace(/\b(?:data:|blob:|file:)[^\s"'<>]+/gi, "[URL REDACTED]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(authorization|cookie|password|secret|token|access[_-]?key|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  text = text.replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]");
  return text;
}
