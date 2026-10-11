import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProgram } from "./main.js";

let scratch: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it("exposes a read-only external workspace retention audit through CLI", async () => {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-cli-retention-"));
  const root = join(scratch, "source project");
  const workspace = join(scratch, "test workspace");
  await Promise.all([mkdir(root), mkdir(workspace)]);
  await writeFile(join(root, "package.json"), "{}");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["workspace", "retention", "--root", root, "--workspace", workspace,
    "--older-than-days", "45"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    status: "complete", testVerdict: "not-asserted", olderThanDays: 45,
    totalRuns: 0, reviewRuns: 0, deletionSupported: false,
  });
  await expect(createProgram().parseAsync(["workspace", "retention", "--root", root,
    "--workspace", workspace, "--older-than-days", "0"], { from: "user" })).rejects.toThrow("1–3650");
});
