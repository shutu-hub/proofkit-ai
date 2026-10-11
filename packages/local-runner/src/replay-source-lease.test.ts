import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { RunSummarySchema, TestCharterSchema } from "@proofkit/contracts";
import { EvidenceStore, LocalExecutionOwnership } from "@proofkit/evidence";
import { LocalRunnerService } from "./index.js";

let scratch: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function fixture() {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-source-lease-"));
  const root = join(scratch, "source");
  const workspaceRoot = join(scratch, "workspace");
  const evidenceDir = join(workspaceRoot, ".proofkit", "runs");
  await Promise.all([mkdir(root), mkdir(evidenceDir, { recursive: true })]);
  await writeFile(join(root, "package.json"), "{}");
  const charter = TestCharterSchema.parse({ intent: "Inspect source", level: "quick", actions: [{ kind: "observe" }],
    assertions: [], sideEffectPolicy: "deny" });
  const store = new EvidenceStore(evidenceDir);
  const summary = RunSummarySchema.parse({ runId: "source-run", projectRoot: root,
    workspaceRoot, startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z",
    status: "completed", verdict: "inconclusive", charter });
  await store.writeSummary(summary);
  await store.writeReport(summary);
  return { root, workspaceRoot, evidenceDir, charter };
}

it("holds the source Run across independent replay until the child Run persists its reference", async () => {
  const f = await fixture();
  let releaseConnect!: () => void;
  const connected = new Promise<void>((resolve) => { releaseConnect = resolve; });
  vi.spyOn(WebAdapter.prototype, "connect").mockImplementation(async () => connected);
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
  const service = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  const owner = new LocalExecutionOwnership(f.evidenceDir, "run");
  const started = await service.replay("source-run", { adapter: "web", start: false });
  expect(await owner.isActive("source-run")).toBe(true);
  expect(await owner.acquire("source-run")).toBeUndefined();
  await expect(service.replay("source-run", { adapter: "web", start: false }))
    .rejects.toThrow("Replay source Run is active");
  releaseConnect();
  const summary = await service.wait(started.runId);
  expect(summary.execution).toMatchObject({ adapter: "web", replayOfRunId: "source-run" });
  expect(await owner.isActive("source-run")).toBe(false);
});

it("releases source ownership when replay cannot load its saved Run", async () => {
  const f = await fixture();
  const service = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  await expect(service.replay("missing-run", { adapter: "web" })).rejects.toThrow();
  expect(await new LocalExecutionOwnership(f.evidenceDir, "run").isActive("missing-run")).toBe(false);
});

it("refuses direct replay of an incomplete source Run", async () => {
  const f = await fixture();
  const store = new EvidenceStore(f.evidenceDir);
  await store.writeSummary(RunSummarySchema.parse({ runId: "source-run", projectRoot: f.root,
    workspaceRoot: f.workspaceRoot, startedAt: "2026-10-01T00:00:00.000Z", status: "running", charter: f.charter }));
  const service = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  await expect(service.start({ charter: f.charter, adapter: "web", replayOfRunId: "source-run" }))
    .rejects.toThrow("Replay source Run is not complete");
  expect(await new LocalExecutionOwnership(f.evidenceDir, "run").isActive("source-run")).toBe(false);
});

it("reads historical reports without rewriting them and refuses an active owner", async () => {
  const f = await fixture();
  const path = join(f.evidenceDir, "source-run", "report.html");
  await writeFile(path, "<html>historical evidence</html>");
  const service = new LocalRunnerService({ root: f.root, workspaceRoot: f.workspaceRoot });
  const owner = new LocalExecutionOwnership(f.evidenceDir, "run");
  const lease = await owner.acquire("source-run");
  expect(lease).toBeDefined();
  try { await expect(service.savedRunReport("source-run")).rejects.toThrow("Run is active"); }
  finally { await lease!.release(); }
  expect(await service.savedRunReport("source-run")).toBe(path);
  expect(await readFile(path, "utf8")).toBe("<html>historical evidence</html>");
  await rm(path);
  await expect(service.savedRunReport("source-run")).rejects.toThrow("Saved Run report is unavailable");
});
