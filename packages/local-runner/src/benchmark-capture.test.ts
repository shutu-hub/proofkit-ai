import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkCaptureSession } from "./benchmark-capture.js";

const inputHash = "a".repeat(64);
async function fixture() {
  const temporary = await mkdtemp(join(process.env.PROOFKIT_WEBARENA_RUNS ?? tmpdir(), "proofkit-capture-contract-"));
  const root = join(temporary, "source"), workspaceRoot = join(temporary, "workspace");
  await mkdir(root); await mkdir(workspaceRoot);
  return { temporary, root, workspaceRoot, evidenceDir: join(workspaceRoot, ".proofkit/runs") };
}

describe("trusted benchmark capture lifecycle", () => {
  it("does not finalize an empty or active persistent task, or continue after abandonment", async () => {
    const f = await fixture();
    const session = new BenchmarkCaptureSession({ directory: join(f.temporary, "captures"), taskId: 44,
      publicInputSha256: inputHash, browser: { startUrl: "http://127.0.0.1:1" } }); session.bind(f);
    await expect(session.finalizeTask({})).rejects.toThrow("finished Runs");
    const simultaneous = await Promise.allSettled([session.begin("first"), session.begin("second")]);
    expect(simultaneous.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(session.finalizeTask({})).rejects.toThrow("finished Runs");
    await session.abandonTask();
    expect((await session.auditTask()).issues).toContain("task-not-finalized");
    await expect(session.begin("after-abandonment")).rejects.toThrow("lifecycle");
  });
  it("rejects invalid identity, nested storage, reused attachment and canonical redirects", async () => {
    const f = await fixture();
    expect(() => new BenchmarkCaptureSession({ directory: "relative", taskId: 44, publicInputSha256: inputHash })).toThrow();
    expect(() => new BenchmarkCaptureSession({ directory: f.temporary, taskId: -1, publicInputSha256: inputHash })).toThrow();
    for (const directory of [f.root, join(f.root, "captures"), join(f.workspaceRoot, "captures"), f.temporary]) {
      expect(() => new BenchmarkCaptureSession({ directory, taskId: 44, publicInputSha256: inputHash }).bind(f)).toThrow("external");
    }
    const link = join(f.temporary, "source-alias");
    await symlink(f.root, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => new BenchmarkCaptureSession({ directory: join(link, "captures"), taskId: 44, publicInputSha256: inputHash }).bind(f)).toThrow("external");
    const session = new BenchmarkCaptureSession({ directory: join(f.temporary, "captures"), taskId: 44, publicInputSha256: inputHash });
    session.bind(f);
    expect(() => session.bind(f)).toThrow("already attached");
  });

  it("retains pre-browser failures, disallows overwrite and never associates an orphan", async () => {
    const f = await fixture(), directory = join(f.temporary, "captures");
    const options = { directory, taskId: 44, publicInputSha256: inputHash };
    const session = new BenchmarkCaptureSession(options); session.bind(f);
    await session.begin("blocked-run"); await session.finish("blocked-run", undefined);
    const record = JSON.parse(await readFile(join(directory, "blocked-run.finished.json"), "utf8"));
    expect(record).toMatchObject({ status: "unavailable", reason: "capture-or-run-unavailable", runKind: "standalone" });
    expect((await session.auditRun("blocked-run")).status).toBe("incomplete");
    expect((await session.auditRun("orphan")).issues).toContain("run-not-finalized-in-this-session");
    await expect(session.begin("blocked-run")).rejects.toThrow("lifecycle");
    await expect(session.finish("blocked-run", undefined)).rejects.toThrow("finalization");
    const other = new BenchmarkCaptureSession(options); other.bind(f);
    await expect(other.begin("new-run")).rejects.toThrow("initialization failed");
    const traversal = new BenchmarkCaptureSession({ ...options, directory: join(f.temporary, "other-captures") }); traversal.bind(f);
    await expect(traversal.begin("new-run", { missionId: "../other", missionTaskId: "task", tool: "surface.inspect", runKind: "inspection" })).rejects.toThrow("identity");
  });
});
