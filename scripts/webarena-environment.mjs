// Read-only reachability check for the pinned WebArena-Verified pilot. The
// configured endpoints are operator-owned loopback mappings (including SSH
// tunnels); no task agent can supply them through MCP tool arguments.
const SITES = [
  ["shopping_admin", "__SHOPPING_ADMIN__"],
  ["shopping", "__SHOPPING__"],
  ["reddit", "__REDDIT__"],
  ["gitlab", "__GITLAB__"],
];

export async function probePilotEnvironment(config, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("Invalid benchmark probe deadline");
  }
  if (!plain(config) || !plain(config.environments) ||
    Object.keys(config).some((key) => !["environments", "controlUrls"].includes(key)) ||
    !SITES.every(([, token]) => Object.hasOwn(config.environments, token))) {
    throw new Error("Benchmark probe needs all four pinned pilot sites");
  }
  if (config.controlUrls !== undefined && !plain(config.controlUrls)) throw new Error("Invalid environment controls");
  const endpoints = SITES.map(([site, token]) => {
    const entry = config.environments[token];
    if (!plain(entry) || Object.keys(entry).some((key) => key !== "urls") ||
      !Array.isArray(entry.urls) || entry.urls.length !== 1) throw new Error(`Invalid ${site} site mapping`);
    const applicationUrl = loopbackUrl(entry.urls[0]);
    const controlUrl = config.controlUrls?.[token] === undefined ? undefined : loopbackUrl(config.controlUrls[token]);
    return { site, token, applicationUrl, controlUrl };
  });
  if (config.controlUrls && Object.keys(config.controlUrls).some((token) => !SITES.some(([, expected]) => expected === token))) {
    throw new Error("Unknown environment control mapping");
  }
  const sites = await Promise.all(endpoints.map(async ({ site, token, applicationUrl, controlUrl }) => {
    const [application, control] = await Promise.all([
      probeApplication(applicationUrl, timeoutMs),
      controlUrl ? probeControl(controlUrl, timeoutMs) : Promise.resolve({ status: "not-configured" }),
    ]);
    return { site, token, applicationUrl, application, ...(controlUrl ? { controlUrl } : {}), control };
  }));
  return {
    schemaVersion: 1,
    status: sites.every((site) => site.application.status === "reachable" && site.control.status === "healthy")
      ? "reachable" : "incomplete",
    applicationSitesReachable: sites.filter((site) => site.application.status === "reachable").length,
    controlsHealthy: sites.filter((site) => site.control.status === "healthy").length,
    sites,
    reset: "not-verified",
    imageIdentity: "not-verified",
    taskExecution: "not-started",
    proofkitEffectiveness: "not-measured",
  };
}

function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function loopbackUrl(value) {
  if (typeof value !== "string") throw new Error("Benchmark site mappings must be URLs");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid benchmark site URL"); }
  if (!["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("Benchmark probe requires credential-free loopback URL mappings");
  }
  return url.href;
}

async function probeApplication(url, timeoutMs) {
  try {
    const origin = new URL(url).origin;
    const visited = new Set();
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (visited.has(current)) return { status: "unreachable", reason: "redirect-loop" };
      visited.add(current);
      const response = await fetch(current, { method: "GET", redirect: "manual", signal });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) return { status: "reachable", httpStatus: response.status,
        ...(redirects ? { redirect: "same-origin" } : {}) };
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { status: "unreachable", httpStatus: response.status, reason: "redirect-without-location" };
        const target = new URL(location, current);
        if (target.origin !== origin) return { status: "unreachable", httpStatus: response.status, reason: "cross-origin-redirect" };
        current = target.href;
        continue;
      }
      return { status: "unreachable", httpStatus: response.status, reason: "http-error" };
    }
    return { status: "unreachable", reason: "too-many-redirects" };
  } catch { return { status: "unreachable", reason: "request-failed-or-timed-out" }; }
}

async function probeControl(baseUrl, timeoutMs) {
  try {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/status`;
    const response = await fetch(endpoint, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" } });
    if (response.status !== 200) { await response.body?.cancel(); return { status: "unhealthy", httpStatus: response.status, reason: "http-error" }; }
    const bytes = await boundedBody(response, 64 * 1024);
    const result = JSON.parse(bytes.toString("utf8"));
    return result?.success === true ? { status: "healthy", httpStatus: 200 }
      : { status: "unhealthy", httpStatus: 200, reason: "status-not-successful" };
  } catch { return { status: "unhealthy", reason: "request-failed-or-invalid-status" }; }
}

async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty status response");
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Oversized status response");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
