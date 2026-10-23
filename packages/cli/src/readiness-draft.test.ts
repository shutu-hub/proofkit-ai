import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProgram } from "./main.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = originalExitCode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("checks a workspace draft through CLI without modifying it or starting a Run", async () => {
  const base = await mkdtemp(join(tmpdir(), "proofkit-cli-draft-readiness-")); roots.push(base);
  const root = join(base, "source"), workspace = join(base, "tests");
  await mkdir(root); await mkdir(join(workspace, ".proofkit/charters"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(workspace, ".proofkit/integration.mjs"), 'export default {name:"draft-readiness-fixture",async readiness(){return {passed:false,message:"Independent fields unavailable",evidence:{},issues:[{code:"independent-fields-unavailable",guidance:"Keep the full acceptance contract"}]}},async preflight(){throw Error("Must not run")},async setup(){throw Error("Must not run")}};');
  const path = join(workspace, ".proofkit/charters/draft.yml");
  await writeFile(path, JSON.stringify({ intent: "Verify the full booking", level: "core", surfaces: ["web"], metadata: { requiredFields: ["email"] } }));
  const before = await readFile(path);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["readiness", "--root", root, "--workspace", workspace, "--draft", ".proofkit/charters/draft.yml"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ status: "blocked", testVerdict: "not-asserted",
    level: "core", surfaces: ["web"], draftSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(process.exitCode).toBe(1); expect(await readFile(path)).toEqual(before);
  expect(await readdir(join(workspace, ".proofkit"))).toEqual(["charters", "integration.mjs"]);
  await expect(createProgram().parseAsync(["readiness", "some-id", "--draft", "missing.json"], { from: "user" })).rejects.toThrow("exactly one");
});
