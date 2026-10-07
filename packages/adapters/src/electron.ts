import { readFile } from "node:fs/promises";
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
    super({ cdpUrl: options.cdpUrl });
    this.electronOptions = options;
  }

  override async connect(): Promise<void> {
    const cdpUrl = this.electronOptions.cdpUrl ?? await readDevtoolsUrl(this.electronOptions.devtoolsActivePortPath);
    if (!cdpUrl) throw new Error("Electron CDP endpoint is missing. Set --cdp or --devtools-port-file.");
    this.electronOptions.cdpUrl = cdpUrl;
    this.options.cdpUrl = cdpUrl;
    await super.connect();
  }

  override async discover(): Promise<SurfaceSnapshot> {
    const snapshot = await super.discover();
    return { ...snapshot, metadata: { ...snapshot.metadata, surface: "electron" } };
  }
}

async function readDevtoolsUrl(path?: string): Promise<string | undefined> {
  const candidate = path ?? process.env.PROOFKIT_ELECTRON_DEVTOOLS_PORT;
  if (!candidate) return undefined;
  if (/^https?:\/\//.test(candidate)) return candidate;
  const source = await readFile(resolve(candidate), "utf8");
  const port = source.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!port || !/^\d+$/.test(port)) throw new Error(`Invalid DevToolsActivePort file: ${candidate}`);
  return `http://127.0.0.1:${port}`;
}

export type { AdapterEvent };
