import { resolveElectronCdpUrl } from "@proofkit/adapters";

/** Associate a local Electron file renderer with its CDP listener when it has no HTTP page server. */
export async function sourceBindingTarget(surface: "web" | "electron", pageUrl: string | undefined,
  cdpUrl: string | undefined, devtoolsActivePort: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (surface === "web" || /^https?:\/\//i.test(pageUrl ?? "")) return pageUrl;
  let endpoint: string | undefined;
  try { endpoint = await resolveElectronCdpUrl({ cdpUrl, devtoolsActivePortPath: devtoolsActivePort }, signal); }
  catch { signal?.throwIfAborted(); return undefined; }
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch { return undefined; }
}
