import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { createProgram } from "./main.js";

let scratch: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it("returns the existing Run report without changing historical evidence", async () => {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-saved-report-"));
  const root = join(scratch, "source");
  const workspace = join(scratch, "workspace");
  const runDir = join(workspace, ".proofkit", "runs", "saved-run");
  await Promise.all([mkdir(root), mkdir(runDir, { recursive: true })]);
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(runDir, "run.json"), JSON.stringify({ runId: "saved-run", projectRoot: root, workspaceRoot: workspace,
    startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z",
    status: "completed", verdict: "inconclusive", charter: TestCharterSchema.parse({ intent: "Inspect fixture", level: "quick" }) }));
  const report = join(runDir, "report.html");
  await writeFile(report, "<html>saved bytes</html>");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["report", "saved-run", "--root", root, "--workspace", workspace], { from: "user" });
  expect(log).toHaveBeenCalledWith(report);
  expect(await readFile(report, "utf8")).toBe("<html>saved bytes</html>");
});
