import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionRunner, type SurfaceAdapter, type SurfaceActionContext } from "./index.js";
import { inputFileFacts, MAX_INPUT_FILE_BYTES, resolveInputFiles } from "./input-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "proofkit-upload-")); roots.push(root);
  await mkdir(join(root, ".proofkit", "fixtures"), { recursive: true });
  return root;
}
const reference = ".proofkit/fixtures/resume.pdf";
function charter() {
  return { intent: "upload resume", level: "quick" as const, mode: "deterministic" as const, preconditions: [],
    actions: [{ kind: "setInputFiles" as const, selector: "#resume", files: [reference] }], assertions: [], sideEffectPolicy: "allow" as const, metadata: {} };
}
function adapter() {
  const value: SurfaceAdapter = { name: "fixture", supportsFileInputs: true, connect: vi.fn(async () => {}),
    discover: async () => ({ capturedAt: "now", metadata: {} }), snapshot: async () => ({ capturedAt: "now", metadata: {} }),
    act: vi.fn(async (action, _context?: SurfaceActionContext) => ({ actionId: "upload", kind: action.kind, startedAt: "now", endedAt: "now", durationMs: 0, metadata: {} })),
    assert: async (assertion) => ({ assertion, passed: true, message: "ready", evidence: [] }), capture: async () => undefined,
    subscribeEvents: async () => () => {}, close: vi.fn(async () => {}) };
  return value;
}
describe("bounded fixture input", () => {
  it("passes transient bytes to the adapter and persists only file facts", async () => {
    const root = await workspace(); const content = "PRIVATE_FIXTURE_CONTENT_never_persist_this";
    await writeFile(join(root, reference), content);
    const surface = adapter();
    const summary = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: true }).run(charter(), "upload-facts");
    expect(summary.verdict).toBe("inconclusive");
    const context = vi.mocked(surface.act).mock.calls[0]?.[1];
    expect(context?.inputFiles?.[0]?.buffer.toString()).toBe(content);
    expect(summary.steps[0]?.receipt?.metadata.inputFiles).toEqual([{ fixture: reference, name: "resume.pdf", sizeBytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"), mimeType: "application/pdf" }]);
    const persisted = await readFile(join(root, "runs/upload-facts/run.json"), "utf8");
    const events = await readFile(join(root, "runs/upload-facts/events.jsonl"), "utf8");
    expect(persisted + events).not.toContain(content);
    expect(persisted + events).not.toContain('"buffer"');
    expect(summary.artifacts.some((path) => path.endsWith("step-001-input-files.json"))).toBe(true);
  });
  it("keeps file facts even if the surface action fails", async () => {
    const root = await workspace(); await writeFile(join(root, reference), "fixture");
    const surface = adapter(); vi.mocked(surface.act).mockRejectedValue(new Error("ambiguous selector"));
    const summary = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: true }).run(charter());
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.artifacts.some((path) => path.endsWith("step-001-input-files.json"))).toBe(true);
    expect(summary.steps[0]?.inputFiles?.[0]?.sizeBytes).toBe(7);
  });
  it("replays identical bytes independently of object property order", async () => {
    const root = await workspace(); await writeFile(join(root, reference), "same input");
    const facts = inputFileFacts(await resolveInputFiles(root, [reference], new AbortController().signal));
    const file = facts[0]!;
    const reordered = { mimeType: file.mimeType, sha256: file.sha256, sizeBytes: file.sizeBytes, name: file.name, fixture: file.fixture };
    const surface = adapter();
    const summary = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: true,
      expectedInputFiles: { "step-001": [reordered] } }).run(charter());
    expect(surface.act).toHaveBeenCalledOnce();
    expect(summary.steps[0]?.replayInputMatched).toBe(true);
  });
  it.each(["changed", "missing-facts", "missing-file"])("blocks replay with %s before file selection", async (kind) => {
    const root = await workspace(); await writeFile(join(root, reference), "original input");
    const facts = inputFileFacts(await resolveInputFiles(root, [reference], new AbortController().signal));
    if (kind === "changed") await writeFile(join(root, reference), "changed input");
    if (kind === "missing-file") await rm(join(root, reference));
    const surface = adapter();
    const summary = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: true,
      expectedInputFiles: { "step-001": kind === "missing-facts" ? [] : facts } }).run(charter());
    expect(summary.verdict).toBe("blocked");
    expect(surface.act).not.toHaveBeenCalled();
    expect(summary.steps[0]?.replayInputMatched).toBe(false);
    expect(summary.steps[0]?.error).toContain(kind === "missing-file" ? "ENOENT" : "missing or changed");
  });
  it.each(["runner-policy", "charter-policy", "unsupported"])("blocks %s before connecting", async (kind) => {
    const root = await workspace(); const surface = adapter();
    if (kind === "unsupported") Object.assign(surface, { supportsFileInputs: false });
    const plan = kind === "charter-policy" ? { ...charter(), sideEffectPolicy: "deny" as const } : charter();
    const result = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: kind !== "runner-policy" }).run(plan);
    expect(result.verdict).toBe("blocked"); expect(surface.connect).not.toHaveBeenCalled(); expect(surface.act).not.toHaveBeenCalled();
  });
  it("blocks a missing fixture and does not expose its absolute path", async () => {
    const root = await workspace(); const surface = adapter();
    const summary = await new ExecutionRunner(surface, { workspaceRoot: root, evidenceDir: join(root, "runs"), allowFileUploads: true }).run(charter());
    expect(summary.verdict).toBe("blocked"); expect(surface.act).not.toHaveBeenCalled();
    expect(summary.findings.join()).not.toContain(root); expect(summary.steps[0]?.error).toContain("ENOENT");
  });
  it("rejects traversal, non-fixture files, directories and an absent workspace", async () => {
    const root = await workspace(); const signal = new AbortController().signal;
    for (const file of ["../private.pdf", ".proofkit/config.yaml", ".proofkit/fixtures/a:stream", ".proofkit/fixtures/a\\b.pdf"]) {
      await expect(resolveInputFiles(root, [file], signal)).rejects.toThrow("Invalid fixture reference");
    }
    await mkdir(join(root, ".proofkit/fixtures/directory"));
    await expect(resolveInputFiles(root, [".proofkit/fixtures/directory"], signal)).rejects.toThrow("regular file");
    await expect(resolveInputFiles(undefined, [reference], signal)).rejects.toThrow("explicit test workspace");
  });
  it("rejects over-limit files and aggregate input bytes", async () => {
    const root = await workspace(); const file = await open(join(root, reference), "w");
    try { await file.truncate(MAX_INPUT_FILE_BYTES + 1); } finally { await file.close(); }
    await expect(resolveInputFiles(root, [reference], new AbortController().signal)).rejects.toThrow("20 MiB");
    await writeFile(join(root, reference), Buffer.alloc(MAX_INPUT_FILE_BYTES / 2 + 1));
    await expect(resolveInputFiles(root, [reference, reference], new AbortController().signal)).rejects.toThrow("20 MiB");
  });
  it("rejects symlink escapes and a redirected fixture root", async () => {
    const root = await workspace(); const outside = await workspace();
    await mkdir(join(outside, "credentials")); await writeFile(join(outside, "credentials/private.pdf"), "secret");
    await symlink(join(outside, "credentials"), join(root, ".proofkit/fixtures/link"), "junction");
    await expect(resolveInputFiles(root, [".proofkit/fixtures/link/private.pdf"], new AbortController().signal)).rejects.toThrow("outside");
    await rm(join(root, ".proofkit/fixtures"), { recursive: true });
    await symlink(join(outside, "credentials"), join(root, ".proofkit/fixtures"), "junction");
    await expect(resolveInputFiles(root, [reference], new AbortController().signal)).rejects.toThrow("symlink");
  });
  it("preserves cancellation during fixture resolution", async () => {
    const root = await workspace(); const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
    await expect(resolveInputFiles(root, [reference], controller.signal)).rejects.toThrow("fixture cancelled");
    expect(inputFileFacts([])).toEqual([]);
  });
});
