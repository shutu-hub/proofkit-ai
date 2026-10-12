import { createHash } from "node:crypto";
import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { BenchmarkHarRecorder } from "./benchmark-har.js";
import { WebAdapter } from "./web.js";

const har = { log: { entries: [{ request: { url: "http://fixture.test/", method: "GET", headers: [] }, response: { status: 200 } }] } };
const temporary = () => mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-har-unit-"));

describe("raw benchmark capture boundaries", () => {
  it("refuses CDP capture before creating output or contacting the browser", async () => {
    const root = await temporary();
    const directory = join(root, "not-created");
    const adapter = new WebAdapter({ cdpUrl: "http://127.0.0.1:1", benchmarkHar: { directory, runId: "run-1" } });
    await expect(adapter.connect()).rejects.toMatchObject({ code: "benchmark-har-attach-unsupported" });
    await expect(readFile(join(directory, "capture-start.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await adapter.close();
    expect(adapter.benchmarkHarManifest()).toBeUndefined();
  });

  it("does not overwrite an existing directory, and refuses relative or invalid identity inputs", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "sentinel"), "preserve");
    await expect(new BenchmarkHarRecorder({ directory, runId: "run-1" }).prepare()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(directory, "sentinel"), "utf8")).toBe("preserve");
    expect(() => new BenchmarkHarRecorder({ directory: "relative", runId: "run-1" })).toThrow();
    expect(() => new BenchmarkHarRecorder({ directory, runId: "../escape" })).toThrow();
  });

  it("records hashes only for finalized nonempty traces; repeated finish preserves the original manifest", async () => {
    const directory = join(await temporary(), "capture");
    const recorder = new BenchmarkHarRecorder({ directory, runId: "run-2" });
    await recorder.prepare();
    const bytes = JSON.stringify(har);
    await writeFile(recorder.path, bytes);
    const manifest = await recorder.finish();
    expect(manifest).toMatchObject({ runId: "run-2", status: "recorded", entries: 1,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    await writeFile(recorder.path, "{}");
    expect(await recorder.finish()).toEqual(manifest);
    // A later consumer must check the saved digest against current bytes.
    expect(JSON.parse(await readFile(join(directory, "capture.json"), "utf8"))).toEqual(manifest);
  });

  it("retains explicit capture gaps without a usable trace digest", async () => {
    for (const [value, reason] of [["{bad", "invalid-trace"], ["null", "invalid-trace"],
      [JSON.stringify({ log: { entries: [] } }), "empty-trace"], [JSON.stringify({ log: { entries: [{}] } }), "invalid-trace"]]) {
      const recorder = new BenchmarkHarRecorder({ directory: join(await temporary(), "capture"), runId: "run-3" });
      await recorder.prepare();
      await writeFile(recorder.path, value!);
      expect(await recorder.finish()).toMatchObject({ status: "unavailable", reason });
      expect((await recorder.finish()).sha256).toBeUndefined();
    }
    const recorder = new BenchmarkHarRecorder({ directory: join(await temporary(), "oversized"), runId: "run-4" });
    await recorder.prepare();
    await writeFile(recorder.path, "");
    await truncate(recorder.path, 128 * 1024 * 1024 + 1);
    expect(await recorder.finish()).toMatchObject({ status: "unavailable", reason: "trace-too-large" });
  });

  it("retains and hashes a valid trace above the former 32 MiB ceiling", async () => {
    const recorder = new BenchmarkHarRecorder({ directory: join(await temporary(), "large-valid"), runId: "run-large" });
    await recorder.prepare();
    const bytes = JSON.stringify({ log: { entries: har.log.entries,
      comment: "x".repeat(35 * 1024 * 1024) } });
    await writeFile(recorder.path, bytes);
    expect(await recorder.finish()).toMatchObject({ status: "recorded", bytes: Buffer.byteLength(bytes), entries: 1,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  });

  it("attempts browser release after context close fails and never certifies that HAR", async () => {
    const directory = join(await temporary(), "capture");
    const recorder = new BenchmarkHarRecorder({ directory, runId: "run-5" });
    await recorder.prepare();
    await writeFile(recorder.path, JSON.stringify(har));
    let browserClosed = false;
    const adapter = new WebAdapter();
    Object.assign(adapter, { context: { close: async () => { throw new Error("context close failed"); } } as unknown as BrowserContext,
      browser: { close: async () => { browserClosed = true; } } as unknown as Browser,
      ownedContext: true, harRecorder: recorder });
    await expect(adapter.close()).rejects.toThrow("context close failed");
    expect(browserClosed).toBe(true);
    expect(adapter.benchmarkHarManifest()).toMatchObject({ status: "unavailable", reason: "context-close-failed" });
    await expect(adapter.snapshot()).rejects.toThrow("not connected");
  });

  it("deduplicates concurrent closes and closes late-acquired resources before finalization", async () => {
    const directory = join(await temporary(), "capture");
    const recorder = new BenchmarkHarRecorder({ directory, runId: "run-late" });
    await recorder.prepare();
    await writeFile(recorder.path, JSON.stringify(har));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let contextClosed = 0;
    let browserClosed = 0;
    const adapter = new WebAdapter({ benchmarkHar: { directory, runId: "run-late" } });
    Object.assign(adapter, { connectBrowser: async () => {
      Object.assign(adapter, { harRecorder: recorder, benchmarkCaptureStarted: true });
      await gate;
      Object.assign(adapter, { ownedContext: true,
        context: { close: async () => { contextClosed++; } },
        browser: { close: async () => { browserClosed++; } } });
      (adapter as unknown as { checkConnectOpen(): void }).checkConnectOpen();
    } });
    const connection = adapter.connect();
    const firstClose = adapter.close();
    expect(adapter.close()).toBe(firstClose);
    await firstClose;
    expect(adapter.benchmarkHarManifest()).toBeUndefined();
    await expect(readFile(join(directory, "capture.json"))).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await expect(connection).rejects.toThrow("closed during connection");
    expect(contextClosed).toBe(1);
    expect(browserClosed).toBe(1);
    expect(adapter.benchmarkHarManifest()?.status).toBe("recorded");
    await adapter.close();
    expect(contextClosed).toBe(1);
    expect(browserClosed).toBe(1);
    await expect(adapter.connect()).rejects.toThrow("single-use");
  });

  it("waits for a late context even when the first browser close is still pending", async () => {
    const directory = join(await temporary(), "capture");
    const recorder = new BenchmarkHarRecorder({ directory, runId: "run-overlap" });
    await recorder.prepare();
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    let releaseBrowser!: () => void;
    const browserGate = new Promise<void>((resolve) => { releaseBrowser = resolve; });
    let contextClosed = false;
    const adapter = new WebAdapter({ benchmarkHar: { directory, runId: "run-overlap" } });
    Object.assign(adapter, { connectBrowser: async () => {
      Object.assign(adapter, { harRecorder: recorder, benchmarkCaptureStarted: true,
        browser: { close: async () => { await browserGate; } } });
      await contextGate;
      Object.assign(adapter, { ownedContext: true, context: { close: async () => {
        await expect(readFile(join(directory, "capture.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await writeFile(recorder.path, JSON.stringify(har));
        contextClosed = true;
      } } });
      (adapter as unknown as { checkConnectOpen(): void }).checkConnectOpen();
    } });
    const connection = adapter.connect();
    // Attach a rejection handler before unblocking asynchronous connection.
    const rejected = expect(connection).rejects.toThrow("closed during connection");
    const closing = adapter.close();
    releaseContext();
    await Promise.resolve();
    releaseBrowser();
    await closing;
    await rejected;
    expect(contextClosed).toBe(true);
    expect(adapter.benchmarkHarManifest()?.status).toBe("recorded");
  });

  it("disconnects borrowed CDP resources without closing their context", async () => {
    const adapter = new WebAdapter();
    let browserClosed = 0;
    Object.assign(adapter, { context: { close: async () => { throw new Error("borrowed context must stay open"); } },
      browser: { close: async () => { browserClosed++; } }, ownedContext: false });
    await adapter.close();
    expect(browserClosed).toBe(1);
  });
});
