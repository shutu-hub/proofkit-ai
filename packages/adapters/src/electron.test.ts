import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronAdapter, resolveElectronCdpUrl } from "./electron.js";
import { WebAdapter } from "./web.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function portFile(content: string) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-devtools-port-"));
  roots.push(root);
  const path = join(root, "DevToolsActivePort");
  await writeFile(path, content);
  return path;
}
describe("shared Electron endpoint resolution", () => {
  it("uses the same file resolver for adapter attachment and environment inspection", async () => {
    const path = await portFile("9222\n/devtools/browser/opaque\n");
    expect(await resolveElectronCdpUrl({ devtoolsActivePortPath: path })).toBe("http://127.0.0.1:9222");
    const connect = vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
    await new ElectronAdapter({ devtoolsActivePortPath: path }).connect();
    expect(connect).toHaveBeenCalledOnce();
  });
  it("preserves endpoint, configured file, then environment fallback precedence", async () => {
    const path = await portFile("9223\n");
    vi.stubEnv("PROOFKIT_ELECTRON_DEVTOOLS_PORT", "http://127.0.0.1:9224");
    expect(await resolveElectronCdpUrl({ cdpUrl: "http://127.0.0.1:9222", devtoolsActivePortPath: path })).toBe("http://127.0.0.1:9222");
    expect(await resolveElectronCdpUrl({ devtoolsActivePortPath: path })).toBe("http://127.0.0.1:9223");
    expect(await resolveElectronCdpUrl({})).toBe("http://127.0.0.1:9224");
  });
  it.each(["0\n", "65536\n", "invalid\n", "9".repeat(4097)])("rejects an invalid or oversized port file", async (content) => {
    await expect(resolveElectronCdpUrl({ devtoolsActivePortPath: await portFile(content) })).rejects.toThrow();
  });
  it("does not read a file for a pre-aborted resolution", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(resolveElectronCdpUrl({ devtoolsActivePortPath: "missing" }, controller.signal)).rejects.toBe(reason);
  });
});
