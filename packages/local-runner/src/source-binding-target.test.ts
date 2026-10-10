import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceBindingTarget } from "./source-binding-target.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("source binding target", () => {
  it("uses the CDP listener for an Electron file page and drops its browser path and query", async () => {
    expect(await sourceBindingTarget("electron", "file:///app/index.html#/resumes/42",
      "ws://127.0.0.1:9222/devtools/browser/private?token=secret", undefined))
      .toBe("http://127.0.0.1:9222");
    const root = await mkdtemp(join(tmpdir(), "proofkit-binding-port-"));
    roots.push(root);
    const file = join(root, "DevToolsActivePort");
    await writeFile(file, "9223\n/devtools/browser/private\n");
    expect(await sourceBindingTarget("electron", undefined, undefined, file)).toBe("http://127.0.0.1:9223");
  });

  it("keeps the page server as the source target when Electron loads HTTP content", async () => {
    expect(await sourceBindingTarget("electron", "http://127.0.0.1:5173/app", "http://127.0.0.1:9222", undefined))
      .toBe("http://127.0.0.1:5173/app");
    expect(await sourceBindingTarget("web", undefined, "http://127.0.0.1:9222", undefined)).toBeUndefined();
  });

  it("does not invent a target from an unavailable port file", async () => {
    expect(await sourceBindingTarget("electron", "file:///app/index.html", undefined, "missing-port-file"))
      .toBeUndefined();
  });
});
