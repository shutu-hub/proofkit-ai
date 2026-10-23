import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { savePlanningContinuation, loadPlanningContinuation, assertResumeRequirements, mergePlanningInspections, type PlanningResumeRequest } from "./planning-continuation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function root() { const directory = await mkdtemp(join(tmpdir(), "proofkit-plan-resume-")); roots.push(directory); return directory; }
const request: PlanningResumeRequest = { intent: "Create and reload a private note. Verify content and isolation; do not share it.",
  adapter: "web", url: "http://127.0.0.1:3000/notes", level: "core", mode: "deterministic", sideEffectPolicy: "allow", coverage: "declared",
  expect: ["Note saved"], oracleNames: ["current-note", "other-account"], headful: true };
const inspection = { runId: "original-observation", manifestSha256: "a".repeat(64) };

describe("saved planning continuations", () => {
  it("persists only bounded declarative requirements and original pins under a digest", async () => {
    const workspace = await root(); const project = await root();
    const pin = await savePlanningContinuation(workspace, project, request, [inspection], 1);
    const record = await loadPlanningContinuation(workspace, project, pin);
    expect(record).toMatchObject({ request, inspections: [inspection], round: 1, projectRoot: project, workspaceRoot: workspace });
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { intent: "Check only the page" }, { adapter: "electron" }, { url: "http://foreign.local/" }, { level: "quick" },
    { mode: "explore" }, { sideEffectPolicy: "deny" }, { coverage: "project" }, { headful: false },
    { expect: [] }, { oracleNames: ["current-note"] }, { sessionId: "00000000-0000-4000-8000-000000000001" },
  ] as Array<Partial<PlanningResumeRequest>>)("refuses an explicitly changed requirement %j", (supplied) => {
    expect(() => assertResumeRequirements(request, supplied)).toThrow("conflicts with the saved");
  });

  it("accepts omitted fields and reordered equivalent checks without mutating original requirements", () => {
    const before = structuredClone(request);
    expect(() => assertResumeRequirements(request, { intent: request.intent, oracleNames: [...request.oracleNames!].reverse() })).not.toThrow();
    expect(() => assertResumeRequirements(request, {})).not.toThrow();
    expect(request).toEqual(before);
    expect(() => assertResumeRequirements(request, { oracleNames: ["current-note", "current-note"] })).toThrow("oracleNames");
  });

  it("preserves old observations while accepting a repeated identical pin and one new state", () => {
    const additional = { runId: "new-state", manifestSha256: "b".repeat(64) };
    expect(mergePlanningInspections([inspection], [inspection, additional])).toEqual([inspection, additional]);
    expect(() => mergePlanningInspections([inspection], [{ ...inspection, manifestSha256: "c".repeat(64) }])).toThrow("original digest");
    expect(() => mergePlanningInspections([inspection], Array.from({ length: 10 }, (_, index) => ({ runId: "state-" + index, manifestSha256: "b".repeat(64) })))).toThrow("ten-state");
  });

  it("rejects tampered or oversized records before using their saved requirements", async () => {
    const workspace = await root(); const pin = await savePlanningContinuation(workspace, workspace, request, [inspection], 1);
    const file = join(workspace, ".proofkit/planning", pin.id + ".json");
    const bytes = await readFile(file, "utf8"); await writeFile(file, bytes.replace("private note", "public note"));
    await expect(loadPlanningContinuation(workspace, workspace, pin)).rejects.toThrow("changed");
    await writeFile(file, "x".repeat(256 * 1024 + 1));
    await expect(loadPlanningContinuation(workspace, workspace, pin)).rejects.toThrow("changed");
  });

  it("rejects copied foreign-workspace records and a different source project", async () => {
    const workspace = await root(); const other = await root(); const pin = await savePlanningContinuation(workspace, workspace, request, [inspection], 1);
    await mkdir(join(other, ".proofkit/planning"), { recursive: true });
    await copyFile(join(workspace, ".proofkit/planning", pin.id + ".json"), join(other, ".proofkit/planning", pin.id + ".json"));
    await expect(loadPlanningContinuation(other, workspace, pin)).rejects.toThrow("another project/workspace");
    await expect(loadPlanningContinuation(workspace, other, pin)).rejects.toThrow("another project/workspace");
  });

  it("refuses a redirected planning directory for both saving and loading", async () => {
    const workspace = await root(); const other = await root();
    const pin = await savePlanningContinuation(other, workspace, request, [inspection], 1);
    await mkdir(join(workspace, ".proofkit"));
    await symlink(join(other, ".proofkit/planning"), join(workspace, ".proofkit/planning"), "junction");
    await expect(savePlanningContinuation(workspace, workspace, request, [inspection], 1)).rejects.toThrow("redirected");
    await expect(loadPlanningContinuation(workspace, workspace, pin)).rejects.toThrow("redirected");
  });

  it("bounds continuation rounds and file size without exposing request text in errors", async () => {
    const workspace = await root();
    await expect(savePlanningContinuation(workspace, workspace, { ...request, intent: "PRIVATE_INPUT".repeat(30000) }, [inspection], 1)).rejects.toThrow("256 KiB");
    await expect(savePlanningContinuation(workspace, workspace, request, [inspection], 11)).rejects.toThrow();
    await expect(loadPlanningContinuation(workspace, workspace, { id: "../invalid", sha256: "a".repeat(64) })).rejects.toThrow();
  });
});
