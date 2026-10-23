import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestCharterSchema } from "@proofkit/contracts";
import { EvidenceStore } from "@proofkit/evidence";
import { createProgram } from "./main.js";

let scratch: string | undefined;
const originalExitCode = process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it("uses distinct CLI exit codes for intact, changed, missing and unverifiable evidence", async () => {
  scratch = await mkdtemp(join(tmpdir(), "proofkit-cli-manifest-"));
  const project = join(scratch, "source");
  const workspace = join(scratch, "workspace");
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{}");
  const evidenceRoot = join(workspace, ".proofkit", "runs");
  const store = new EvidenceStore(evidenceRoot);
  await store.startRun({ runId: "cli-run", startedAt: new Date().toISOString(), status: "completed", verdict: "inconclusive",
    projectRoot: project, workspaceRoot: workspace,
    charter: TestCharterSchema.parse({ intent: "verify CLI evidence", level: "quick", actions: [], assertions: [] }),
    steps: [], assertions: [], oracles: [], artifacts: [], findings: [] });
  const artifact = await store.writeText("cli-run", "note", "recorded");
  const manifest = await store.writeManifest("cli-run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const verify = async () => {
    await createProgram().parseAsync(["verify-manifest", "cli-run", "--root", project, "--workspace", workspace,
      "--manifest-sha256", manifest.sha256], { from: "user" });
    return JSON.parse(log.mock.calls.at(-1)![0] as string);
  };
  expect((await verify()).status).toBe("intact");
  expect(process.exitCode).toBe(0);
  await writeFile(join(evidenceRoot, artifact), "changed");
  expect((await verify()).status).toBe("changed");
  expect(process.exitCode).toBe(1);
  await rm(join(evidenceRoot, artifact));
  expect((await verify()).status).toBe("missing");
  expect(process.exitCode).toBe(1);
  await writeFile(join(evidenceRoot, manifest.path), JSON.stringify({ schemaVersion: 1, runId: "cli-run", files: [] }));
  expect((await verify()).status).toBe("unverified");
  expect(process.exitCode).toBe(2);
});
