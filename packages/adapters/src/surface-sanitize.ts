/** Bounded surface observations are hints, not a place to persist credentials. */
export function sanitizeSurfaceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return `data:${url.pathname.split(",", 1)[0]},[CONTENT REDACTED]`;
    if (url.protocol === "blob:") return "blob:[CONTENT REDACTED]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return value.split(/[?#]/, 1)[0] ?? ""; }
}

export function sanitizeSurfaceText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => sanitizeSurfaceUrl(candidate));
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(authorization|cookie|password|secret|token|access[_-]?key|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  text = text.replace(/\b1[3-9]\d{9}\b/g, "[REDACTED_PHONE]");
  return text;
}
