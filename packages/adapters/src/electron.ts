import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { SurfaceSnapshot } from "@proofkit/contracts";
import type { AdapterEvent } from "@proofkit/runner";
import { WebAdapter, type WebAdapterOptions } from "./web.js";

export type ElectronAdapterOptions = Omit<WebAdapterOptions, "baseUrl" | "headless"> & {
  devtoolsActivePortPath?: string;
};

export class ElectronAdapter extends WebAdapter {
  override readonly name = "electron";
  private readonly electronOptions: ElectronAdapterOptions;

  constructor(options: ElectronAdapterOptions = {}) {
    super({ cdpUrl: options.cdpUrl, targetUrlPrefix: options.targetUrlPrefix, targetTitleContains: options.targetTitleContains });
    this.electronOptions = options;
  }

  /** Use exactly the endpoint protected by the post-setup target lease. */
  pinCdpUrl(cdpUrl: string): void {
    this.electronOptions.cdpUrl = cdpUrl;
    this.options.cdpUrl = cdpUrl;
  }

  override async connect(): Promise<void> {
    const cdpUrl = await resolveElectronCdpUrl(this.electronOptions);
    if (!cdpUrl) throw new Error("Electron CDP endpoint is missing. Set --cdp or --devtools-port-file.");
    this.pinCdpUrl(cdpUrl);
    await super.connect();
  }

  override async discover(): Promise<SurfaceSnapshot> {
    const snapshot = await super.discover();
    return { ...snapshot, metadata: { ...snapshot.metadata, surface: "electron" } };
  }
}

export async function resolveElectronCdpUrl(options: Pick<ElectronAdapterOptions, "cdpUrl" | "devtoolsActivePortPath">, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (options.cdpUrl) return options.cdpUrl;
  const candidate = options.devtoolsActivePortPath ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT;
  if (!candidate) return undefined;
  if (/^(https?|wss?):\/\//i.test(candidate)) return candidate;
  const handle = await open(resolve(candidate), "r");
  let source: string;
  try {
    signal?.throwIfAborted();
    if (!(await handle.stat()).isFile()) throw new Error("DevToolsActivePort must be a regular file");
    const buffer = Buffer.alloc(4_097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    if (bytesRead > 4_096) throw new Error("DevToolsActivePort exceeds 4096 bytes");
    source = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const port = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) throw new Error("Invalid DevToolsActivePort port");
  return `http://127.0.0.1:${port}`;
}

export type { AdapterEvent };
