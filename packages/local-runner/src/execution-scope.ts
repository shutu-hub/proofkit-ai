import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveElectronCdpUrl } from "@proofkit/adapters";
import { LocalExecutionOwnership, sha256, type LocalExecutionLease } from "@proofkit/evidence";
import { TargetLeaseConflictError } from "@proofkit/runner";
import type { ProofkitConfig } from "@proofkit/contracts";
import type { LocalAdapterName, LocalRunInput } from "./index.js";

const TARGET_LEASE_ROOT = join(tmpdir(), "proofkit-target-leases");

/** Hold the workspace first, then a shared attachment target, in one fixed acquisition order. */
export async function acquireExecutionScope(workspaceRoot: string, target: string | undefined): Promise<LocalExecutionLease | undefined> {
  const workspace = await new LocalExecutionOwnership(workspaceRoot, "workspace").acquire("exclusive");
  if (!workspace || !target) return workspace;
  try {
    const shared = await new LocalExecutionOwnership(TARGET_LEASE_ROOT, "target").acquire(sha256(target));
    if (!shared) throw new TargetLeaseConflictError("shared");
    return { release: async () => {
      const settled = await Promise.allSettled([shared.release(), workspace.release()]);
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failure) throw failure.reason;
    } };
  } catch (error) {
    await workspace.release();
    throw error;
  }
}

/** Coordinate port-file attachments with every other CDP attachment to the resolved endpoint. */
export async function acquireCdpTarget(cdpUrl: string): Promise<LocalExecutionLease | undefined> {
  return new LocalExecutionOwnership(TARGET_LEASE_ROOT, "target").acquire(sha256(`cdp:${endpointOrigin(cdpUrl)}`));
}

/** An existing port file can be resolved before setup; a newly started app is resolved after setup. */
export async function acquireElectronPortFileScope(workspaceRoot: string, fileIdentity: string, portFile: string,
  signal: AbortSignal, readExisting: boolean): Promise<{ lease: LocalExecutionLease | undefined; cdpUrl?: string }> {
  const base = await acquireExecutionScope(workspaceRoot, fileIdentity);
  if (!base || !readExisting) return { lease: base };
  try {
    let cdpUrl: string;
    try { cdpUrl = (await resolveElectronCdpUrl({ devtoolsActivePortPath: portFile }, signal))!; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lease: base };
      throw error;
    }
    const endpoint = await acquireCdpTarget(cdpUrl);
    if (!endpoint) throw new TargetLeaseConflictError("cdp");
    return { cdpUrl, lease: { release: async () => {
      const settled = await Promise.allSettled([endpoint.release(), base.release()]);
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failure) throw failure.reason;
    } } };
  } catch (error) {
    await base.release();
    throw error;
  }
}

/** Only shared attachments need a host-wide target lock; launched Web browsers have their own profile. */
export function sharedTargetIdentity(surface: LocalAdapterName, input: LocalRunInput, config: ProofkitConfig): string | undefined {
  if (surface === "web") {
    const cdp = input.cdp ?? config.surfaces.web?.cdpUrl;
    return cdp ? `cdp:${endpointOrigin(cdp)}` : undefined;
  }
  if (surface === "electron") {
    const cdp = input.cdp ?? config.surfaces.electron?.cdpUrl;
    if (cdp) return `cdp:${endpointOrigin(cdp)}`;
    const candidate = input.devtoolsPortFile ?? config.surfaces.electron?.devtoolsActivePort ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT;
    if (!candidate) return undefined;
    if (/^https?:\/\//i.test(candidate) || /^wss?:\/\//i.test(candidate)) return `cdp:${endpointOrigin(candidate)}`;
    const file = resolve(candidate);
    return `cdp-port-file:${process.platform === "win32" ? file.toLowerCase() : file}`;
  }
  const server = input.mobileServer ?? config.surfaces.mobile?.serverUrl ?? "http://127.0.0.1:4723";
  return `webdriver:${endpointOrigin(server)}`;
}

function endpointOrigin(value: string): string {
  const url = new URL(value);
  const scheme = url.protocol === "http:" || url.protocol === "ws:" ? "clear"
    : url.protocol === "https:" || url.protocol === "wss:" ? "tls" : undefined;
  if (!scheme) throw new Error("Shared target endpoint must use HTTP(S) or WebSocket(S)");
  const hostname = url.hostname.toLowerCase();
  const host = ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "loopback" : hostname;
  const port = url.port || (scheme === "tls" ? "443" : "80");
  return `${scheme}://${host}:${port}`;
}
