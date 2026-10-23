import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, Video } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebVideoRecording } from "./web-video-recording.js";

const roots: string[] = [];
const recordings: WebVideoRecording[] = [];
afterEach(async () => {
  await Promise.all(recordings.splice(0).map((recording) => recording.stop()));
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-video-budget-")); roots.push(root);
  const directory = join(root, "tmp"); await mkdir(directory);
  const path = join(root, "recording.webm");
  const limited = vi.fn();
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const recording = new WebVideoRecording({ directory, path, budget: { maxBytes: 1024 * 1024, maxDurationMs: 1000 } }, limited);
  recordings.push(recording);
  const page = async (name: string, bytes = 64) => {
    const source = join(directory, name); await writeFile(source, Buffer.alloc(bytes, 1));
    const video = { path: vi.fn(async () => source), saveAs: vi.fn(async (target: string) => writeFile(target, await readFile(source))), delete: vi.fn(async () => rm(source, { force: true })) };
    context.emit("page", { video: () => video } as unknown as Page);
    return video;
  };
  const attach = () => recording.attach(context as unknown as BrowserContext);
  return { root, directory, path, context, recording, limited, page, attach };
}

describe("owned Web recording budgets", () => {
  it("seals distinct selected windows in selection order", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm", 64);
    const popup = await state.page("popup.webm", 80);
    const popupPage = { video: () => popup } as unknown as Page;
    state.recording.selectPage(popupPage, undefined);
    state.recording.selectPage(popupPage, undefined);
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("recorded");
    expect(state.recording.selectedPageResult()).toEqual({ observed: 1, saved: [1] });
    expect(await readFile(join(state.root, "selected-page-001.webm"))).toHaveLength(80);
    expect(popup.saveAs).toHaveBeenCalledOnce();

    const multiple = await fixture(); multiple.attach();
    const first = await multiple.page("first.webm");
    const selected = await multiple.page("selected.webm");
    const omitted = await multiple.page("omitted.webm");
    multiple.recording.selectPage({ video: () => selected } as unknown as Page, undefined);
    multiple.recording.selectPage({ video: () => omitted } as unknown as Page, undefined);
    await multiple.recording.finish(first as unknown as Video, true);
    expect(multiple.recording.selectedPageResult()).toEqual({ observed: 2, saved: [1, 2] });
    expect(await readFile(join(multiple.root, "selected-page-002.webm"))).toHaveLength(64);
    expect(omitted.saveAs).toHaveBeenCalledOnce();
  });

  it("keeps a selected popup gap when source ownership or the shared budget is invalid", async () => {
    const redirected = await fixture(); redirected.attach();
    const primary = await redirected.page("primary.webm");
    const popup = await redirected.page("popup.webm");
    popup.path.mockResolvedValue(join(redirected.root, "foreign.webm"));
    redirected.recording.selectPage({ video: () => popup } as unknown as Page, undefined);
    await redirected.recording.finish(primary as unknown as Video, true);
    expect(redirected.recording.status).toBe("recorded");
    expect(redirected.recording.selectedPageResult()).toEqual({ observed: 1, saved: [] });
    await expect(readFile(join(redirected.root, "selected-page-001.webm"))).rejects.toMatchObject({ code: "ENOENT" });

    const budget = await fixture(); budget.attach();
    const largePrimary = await budget.page("primary.webm", 800 * 1024);
    const extra = await budget.page("popup.webm", 240 * 1024);
    budget.recording.selectPage({ video: () => extra } as unknown as Page, undefined);
    await budget.recording.finish(largePrimary as unknown as Video, true);
    expect(budget.recording.selectedPageResult()).toEqual({ observed: 1, saved: [] });
    expect(extra.saveAs).not.toHaveBeenCalled();
  });

  it("preserves selection numbers and saves a later window when an earlier source is invalid", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    const invalid = await state.page("invalid.webm");
    invalid.path.mockResolvedValue(join(state.root, "foreign.webm"));
    const valid = await state.page("valid.webm", 96);
    state.recording.selectPage({ video: () => invalid } as unknown as Page, undefined);
    state.recording.selectPage({ video: () => valid } as unknown as Page, undefined);
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.selectedPageResult()).toEqual({ observed: 2, saved: [2] });
    await expect(readFile(join(state.root, "selected-page-001.webm"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state.root, "selected-page-002.webm"))).toHaveLength(96);
  });

  it("keeps an earlier selected clip when a later clip exceeds the shared byte ceiling", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm", 800 * 1024);
    const first = await state.page("first.webm", 150 * 1024);
    const second = await state.page("second.webm", 100 * 1024);
    state.recording.selectPage({ video: () => first } as unknown as Page, undefined);
    state.recording.selectPage({ video: () => second } as unknown as Page, undefined);
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("partial");
    expect(state.recording.stopReason).toBe("size-limit");
    expect(state.recording.selectedPageResult()).toEqual({ observed: 2, saved: [1] });
    expect(await readFile(join(state.root, "selected-page-001.webm"))).toHaveLength(150 * 1024);
    await expect(readFile(join(state.root, "selected-page-002.webm"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seals the primary page and deletes all temporary popup recordings", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    const popup = await state.page("popup.webm");
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("recorded");
    expect(await readFile(state.path)).toHaveLength(64);
    expect(primary.delete).toHaveBeenCalledOnce(); expect(popup.delete).toHaveBeenCalledOnce();
    expect(state.limited).not.toHaveBeenCalled();
    expect(state.context.listenerCount("page")).toBe(0);
  });

  it("limits total live bytes and retains only the under-budget primary page as partial footage", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm", 700 * 1024);
    await state.page("popup.webm", 700 * 1024);
    await vi.waitFor(() => expect(state.recording.stopReason).toBe("size-limit"), { timeout: 1500, interval: 20 });
    expect(state.limited).toHaveBeenCalledWith("size-limit");
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("partial");
    expect(primary.saveAs).toHaveBeenCalledOnce();
    expect(await readFile(state.path)).toHaveLength(700 * 1024);
    expect(state.limited).toHaveBeenCalledOnce();
  });

  it("checks flushed bytes after stopping timers without sending another automatic close", async () => {
    const state = await fixture(); state.attach(); await state.recording.stop();
    const primary = await state.page("primary.webm", 2 * 1024 * 1024);
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.stopReason).toBe("size-limit");
    expect(state.recording.status).toBe("unavailable");
    expect(state.limited).not.toHaveBeenCalled();
  });

  it("stops idle recording at its duration budget", async () => {
    const state = await fixture(); state.attach();
    await vi.waitFor(() => expect(state.recording.stopReason).toBe("duration-limit"), { timeout: 1800, interval: 20 });
    expect(state.limited).toHaveBeenCalledOnce();
    expect(state.limited).toHaveBeenCalledWith("duration-limit");
    await state.recording.finish(undefined, false);
    expect(state.recording.status).toBe("unavailable");
  });

  it("retains duration-limited footage only after successful context finalization", async () => {
    for (const canSave of [true, false]) {
      const state = await fixture(); state.attach();
      const primary = await state.page("primary.webm");
      await vi.waitFor(() => expect(state.recording.stopReason).toBe("duration-limit"), { timeout: 1800, interval: 20 });
      await state.recording.finish(primary as unknown as Video, canSave);
      expect(state.recording.status).toBe(canSave ? "partial" : "unavailable");
      expect(primary.saveAs).toHaveBeenCalledTimes(canSave ? 1 : 0);
    }
  });

  it("does not let an earlier budget stop hide a failed final directory inspection", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    for (let index = 0; index < 17; index++) state.context.emit("page", { video: () => null });
    expect(state.recording.stopReason).toBe("page-limit");
    await mkdir(join(state.directory, "unexpected"));
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("unavailable");
    expect(primary.saveAs).not.toHaveBeenCalled();
  });

  it("does not copy a primary video from outside the owned recording directory", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    const foreign = join(state.root, "foreign.webm"); await writeFile(foreign, "foreign bytes");
    primary.path.mockResolvedValue(foreign);
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("unavailable");
    expect(primary.saveAs).not.toHaveBeenCalled();
    expect(await readFile(foreign, "utf8")).toBe("foreign bytes");
  });

  it("bounds a burst of popup pages before the next disk poll", async () => {
    const state = await fixture(); state.attach();
    for (let index = 0; index < 17; index++) state.context.emit("page", { video: () => null });
    expect(state.recording.stopReason).toBe("page-limit");
    expect(state.limited).toHaveBeenCalledOnce();
    await state.recording.finish(undefined, false);
  });

  it("rejects redirected or unexpectedly populated recording directories", async () => {
    const state = await fixture();
    const redirected = join(state.root, "other"); await rename(state.directory, redirected);
    await symlink(redirected, state.directory, process.platform === "win32" ? "junction" : "dir");
    state.attach();
    await vi.waitFor(() => expect(state.recording.stopReason).toBe("inspection-failed"), { timeout: 1500, interval: 20 });
    await state.recording.finish(undefined, false);
    const nested = await fixture(); await mkdir(join(nested.directory, "unexpected")); nested.attach();
    await vi.waitFor(() => expect(nested.recording.stopReason).toBe("inspection-failed"), { timeout: 1500, interval: 20 });
    await nested.recording.finish(undefined, false);
    expect(nested.recording.status).toBe("unavailable");
  });

  it("rejects an oversized saved recording even when temporary metadata was within budget", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    primary.saveAs.mockImplementation(async (target) => writeFile(target, Buffer.alloc(2 * 1024 * 1024)));
    await state.recording.finish(primary as unknown as Video, true);
    expect(state.recording.status).toBe("unavailable");
    expect(state.recording.stopReason).toBe("size-limit");
  });

  it("clears duration and disk callbacks after explicit shutdown", async () => {
    const state = await fixture(); vi.useFakeTimers(); state.attach(); await state.recording.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.limited).not.toHaveBeenCalled();
    expect(state.recording.stopReason).toBeUndefined();
  });

  it("removes owned temporary WebM bytes even when the browser video handle can no longer delete them", async () => {
    const state = await fixture(); state.attach();
    const primary = await state.page("primary.webm");
    primary.delete.mockRejectedValue(new Error("private browser disconnected diagnostic"));
    await state.recording.finish(primary as unknown as Video, false);
    expect(state.recording.status).toBe("unavailable");
    await expect(readFile(join(state.directory, "primary.webm"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
