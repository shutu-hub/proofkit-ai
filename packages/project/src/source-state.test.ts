import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureSourceState } from "./source-state.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("source state capture", () => {
  it("detects tracked and untracked source changes without persisting their contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-source-state-"));
    roots.push(root);
    await git(root, "init", "-q");
    await git(root, "config", "core.autocrlf", "false");
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "secret.env\n");
    await writeFile(join(root, "src", "app.ts"), "export const state = 'before';\n");
    await git(root, "add", ".gitignore", "src/app.ts");
    await git(root, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");

    const clean = await captureSourceState(root);
    expect(clean).toMatchObject({ method: "git", complete: true, trackedDiffBytes: 0, untrackedFiles: 0 });
    expect(clean.headSha).toMatch(/^[a-f0-9]{40}$/);
    await writeFile(join(root, "src", "app.ts"), "export const state = 'after-secret-marker';\n");
    const tracked = await captureSourceState(root);
    expect(tracked.worktreeSha256).not.toBe(clean.worktreeSha256);
    expect(tracked.trackedDiffBytes).toBeGreaterThan(0);
    expect(JSON.stringify(tracked)).not.toContain("after-secret-marker");

    await writeFile(join(root, "src", "new.ts"), "export const added = 1;\n");
    const untracked = await captureSourceState(root);
    expect(untracked).toMatchObject({ method: "git", complete: true, untrackedFiles: 1 });
    expect(untracked.worktreeSha256).not.toBe(tracked.worktreeSha256);
    await writeFile(join(root, "src", "new.ts"), "export const added = 2;\n");
    const changedUntracked = await captureSourceState(root);
    expect(changedUntracked.worktreeSha256).not.toBe(untracked.worktreeSha256);

    await writeFile(join(root, "secret.env"), "PRIVATE_TOKEN=do-not-record\n");
    await mkdir(join(root, ".proofkit"));
    await writeFile(join(root, ".proofkit", "mission.json"), "changed evidence");
    const ignored = await captureSourceState(root);
    expect(ignored.worktreeSha256).toBe(changedUntracked.worktreeSha256);
    expect(JSON.stringify(ignored)).not.toContain("PRIVATE_TOKEN");
  }, 15_000);

  it("marks an oversized untracked source incomplete instead of claiming a complete fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-source-bound-"));
    roots.push(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "package.json"), "{}\n");
    await git(root, "add", "package.json");
    await git(root, "-c", "user.name=ProofKit", "-c", "user.email=proofkit@example.invalid", "commit", "-qm", "fixture");
    await writeFile(join(root, "large.ts"), "x".repeat(1024 * 1024 + 1));
    const snapshot = await captureSourceState(root);
    expect(snapshot).toMatchObject({ method: "git", complete: false, untrackedFiles: 1 });
    expect(snapshot.reason).toContain("bound");
  });

  it("does not borrow the parent repository revision for a separate source directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "proofkit-source-parent-"));
    roots.push(parent);
    await git(parent, "init", "-q");
    const child = join(parent, "project");
    await mkdir(child);
    await writeFile(join(child, "main.ts"), "export const value = 1;\n");
    expect(await captureSourceState(child)).toMatchObject({ method: "unavailable", complete: false });
  });
});

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, timeout: 10_000 });
}
