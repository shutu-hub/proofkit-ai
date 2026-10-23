import { lstat, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext, Page, Video } from "playwright-core";
import { VideoRecordingBudgetSchema, type VideoRecordingBudget, type VideoRecordingStopReason } from "@proofkit/contracts";

export type WebVideoRecordingOptions = { directory: string; path: string; budget?: Partial<VideoRecordingBudget> };

export class WebVideoRecording {
  readonly budget: VideoRecordingBudget;
  status: "recorded" | "partial" | "unavailable" = "unavailable";
  stopReason?: VideoRecordingStopReason;
  private readonly videos = new Set<Video>();
  private readonly selectedPages = new Set<Page>();
  private readonly selectedVideos: (Video | undefined)[] = [];
  private readonly selectedSaved: number[] = [];
  private pageCount = 0;
  private startedAt?: number;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private diskTimer?: ReturnType<typeof setInterval>;
  private inspection?: Promise<void>;
  private stopped = false;
  private inspectionFailed = false;
  private detach?: () => void;

  constructor(private readonly options: WebVideoRecordingOptions, private readonly onLimit: (reason: VideoRecordingStopReason) => void) {
    this.budget = VideoRecordingBudgetSchema.parse(options.budget ?? {});
  }

  attach(context: BrowserContext): void {
    if (this.startedAt !== undefined) throw new Error("Recording monitor is single-use");
    this.startedAt = Date.now();
    const onPage = (page: Page) => {
      if (this.pageCount >= 64) { this.limit("page-limit"); return; }
      const video = page.video();
      if (video) this.videos.add(video);
      if (++this.pageCount > 16) this.limit("page-limit");
    };
    context.on("page", onPage);
    this.detach = () => context.off("page", onPage);
    for (const page of context.pages()) onPage(page);
    if (this.stopReason) return;
    this.durationTimer = setTimeout(() => this.limit("duration-limit"), this.budget.maxDurationMs);
    this.diskTimer = setInterval(() => { void this.inspect(); }, 250);
    this.durationTimer.unref(); this.diskTimer.unref();
    void this.inspect();
  }

  selectPage(page: Page, initial: Page | undefined): void {
    if (this.stopped || page === initial || this.selectedPages.has(page)) return;
    if (this.selectedPages.size >= 16) { this.limit("page-limit"); return; }
    this.selectedPages.add(page);
    this.selectedVideos.push(page.video() ?? undefined);
  }

  selectedPageResult(): { observed: number; saved: number[] } | undefined {
    return this.selectedPages.size ? { observed: this.selectedPages.size, saved: this.status !== "unavailable" ? [...this.selectedSaved] : [] } : undefined;
  }

  private limit(reason: VideoRecordingStopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.clearTimers();
    if (!this.stopped) this.onLimit(reason);
  }

  private clearTimers(): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.durationTimer = undefined; this.diskTimer = undefined;
  }

  private inspect(): Promise<void> {
    if (this.inspection) return this.inspection;
    this.inspection = this.inspectDirectory().catch(() => { this.inspectionFailed = true; this.limit("inspection-failed"); }).finally(() => { this.inspection = undefined; });
    return this.inspection;
  }

  private async inspectDirectory(): Promise<void> {
    const directory = resolve(this.options.directory);
    let direct;
    try { direct = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const canonical = await realpath(directory);
    const same = process.platform === "win32" ? canonical.toLowerCase() === directory.toLowerCase() : canonical === directory;
    if (!direct.isDirectory() || !same) throw new Error("Recording directory is redirected");
    let bytes = 0;
    let files = 0;
    for await (const entry of await opendir(directory)) {
      if (++files > 64) { this.inspectionFailed = true; this.limit("page-limit"); return; }
      const file = await lstat(join(directory, entry.name));
      if (!entry.isFile() || !file.isFile()) throw new Error("Recording directory has an unexpected entry");
      bytes += file.size;
      if (bytes > this.budget.maxBytes) this.limit("size-limit");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    await this.inspection;
  }

  private async removeTemporaryFiles(): Promise<void> {
    const directory = resolve(this.options.directory);
    let direct;
    try { direct = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const canonical = await realpath(directory);
    const same = process.platform === "win32" ? canonical.toLowerCase() === directory.toLowerCase() : canonical === directory;
    if (!direct.isDirectory() || !same) throw new Error("Recording directory is redirected");
    let count = 0;
    for await (const entry of await opendir(directory)) {
      if (++count > 64 || !entry.isFile() || !entry.name.endsWith(".webm")) throw new Error("Recording cleanup exceeded its owned file inventory");
      const target = join(directory, entry.name);
      if (!(await lstat(target)).isFile()) throw new Error("Recording file is redirected");
      await unlink(target);
    }
    await rmdir(directory);
  }

  async finish(primary: Video | null | undefined, canSave: boolean): Promise<void> {
    await this.stop();
    if (this.startedAt !== undefined && Date.now() - this.startedAt > this.budget.maxDurationMs) this.limit("duration-limit");
    await this.inspect();
    const selectedPaths = new Map<number, string>();
    try {
      if (primary && canSave && !this.inspectionFailed && this.stopReason !== "inspection-failed") {
        const source = resolve(await primary.path());
        const directory = resolve(this.options.directory);
        const canonical = await realpath(source);
        const owned = process.platform === "win32" ? dirname(source).toLowerCase() === directory.toLowerCase() && canonical.toLowerCase() === source.toLowerCase()
          : dirname(source) === directory && canonical === source;
        const original = await lstat(source);
        if (!owned || !original.isFile() || original.size <= 0) throw new Error("Recording source is unavailable");
        if (original.size > this.budget.maxBytes) this.limit("size-limit");
        else {
          await primary.saveAs(this.options.path);
          const saved = await lstat(this.options.path);
          if (!saved.isFile() || saved.size <= 0) throw new Error("Recording is empty");
          if (saved.size > this.budget.maxBytes) this.limit("size-limit");
          else {
            this.status = this.stopReason ? "partial" : "recorded";
            let remaining = this.budget.maxBytes - saved.size;
            for (const [index, video] of this.selectedVideos.entries()) {
              if (!video) continue;
              const selectedPath = join(dirname(this.options.path), `selected-page-${String(index + 1).padStart(3, "0")}.webm`);
              try {
                const extra = resolve(await video.path());
                const canonicalExtra = await realpath(extra);
                const sameDirectory = process.platform === "win32" ? dirname(extra).toLowerCase() === directory.toLowerCase() && canonicalExtra.toLowerCase() === extra.toLowerCase()
                  : dirname(extra) === directory && canonicalExtra === extra;
                const extraInfo = await lstat(extra);
                if (sameDirectory && extraInfo.isFile() && extraInfo.size > 0 && extraInfo.size <= remaining) {
                  const destination = await lstat(selectedPath).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return undefined;
                    throw error;
                  });
                  if (destination) throw new Error("Selected-page destination is already occupied");
                  selectedPaths.set(index + 1, selectedPath);
                  await video.saveAs(selectedPath);
                  const copied = await lstat(selectedPath);
                  if (copied.isFile() && copied.size > 0 && copied.size <= remaining) {
                    this.selectedSaved.push(index + 1);
                    remaining -= copied.size;
                  }
                }
              } catch {}
            }
          }
        }
      }
    } catch { this.status = "unavailable"; }
    const cleanup = await Promise.all([...this.videos].map((video) => video.delete().then(() => true, () => false)));
    this.videos.clear();
    this.detach?.(); this.detach = undefined;
    if (cleanup.some((success) => !success)) this.status = "unavailable";
    try { await this.removeTemporaryFiles(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.status = "unavailable"; }
    for (const [index, path] of selectedPaths) {
      if (this.status !== "unavailable" && this.selectedSaved.includes(index)) continue;
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") this.status = "unavailable";
      });
    }
    if (this.status === "unavailable") this.selectedSaved.length = 0;
  }
}
