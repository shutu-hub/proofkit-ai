import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalRunnerService, PlanningObservationError } from "@proofkit/local-runner";
import { PlannerConfigurationError } from "@proofkit/planner";
import { TestCharterSchema } from "@proofkit/contracts";
import { createProgram } from "./main.js";

const roots: string[] = [];
const exitCode = process.exitCode;
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = exitCode; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("loads a bounded workspace draft and forwards it with inspection pins while retaining its declared mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-submitted-")); roots.push(root);
  await mkdir(join(root, ".proofkit", "charters"), { recursive: true });
  const charter = TestCharterSchema.parse({ intent: "Host plan", level: "quick", mode: "deterministic", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], sideEffectPolicy: "deny" });
  await writeFile(join(root, ".proofkit", "charters", "draft.yaml"), JSON.stringify(charter));
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  const plan = vi.spyOn(runner, "plan").mockResolvedValue(charter);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await createProgram().parseAsync(["plan", "Original request", "--root", root, "--charter", ".proofkit/charters/draft.yaml", "--inspection", `inspection:${"a".repeat(64)}`], { from: "user" });
  expect(plan).toHaveBeenCalledWith("Original request", expect.objectContaining({ charter, mode: undefined,
    inspections: [{ runId: "inspection", manifestSha256: "a".repeat(64) }] }));
});

it("returns a non-success observation receipt without overwriting the requested Charter output", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-planning-")); roots.push(root);
  const output = join(root, "charter.yaml"); await writeFile(output, "previous reviewed Charter");
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "plan").mockRejectedValue(new PlanningObservationError(undefined, { request: { status: "needs-observation", reason: "Need checkout", expectedObservation: "Observe checkout", action: { kind: "click", selector: "#next" } },
    inspections: [{ runId: "cart", manifestSha256: "a".repeat(64) }] }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["plan", "Place order", "--root", root, "--out", output], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "needs-observation", testVerdict: "not-asserted", observationRequest: { requiresApproval: true } });
  expect(await readFile(output, "utf8")).toBe("previous reviewed Charter");
});

it("forwards a continuation without injecting empty expectations or a default execution mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-resume-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  const charter = TestCharterSchema.parse({ intent: "Original request", actions: [{ kind: "observe" }], assertions: [] });
  const plan = vi.spyOn(runner, "plan").mockResolvedValue(charter);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const id = "00000000-0000-4000-8000-000000000001";
  await createProgram().parseAsync(["plan", "--root", root, "--continuation", id + ":" + "a".repeat(64),
    "--inspection", "new-state:" + "b".repeat(64)], { from: "user" });
  expect(plan).toHaveBeenCalledWith(undefined, expect.objectContaining({ continuation: { id, sha256: "a".repeat(64) }, mode: undefined,
    expect: undefined, oracleNames: undefined, adapter: undefined, inspections: [{ runId: "new-state", manifestSha256: "b".repeat(64) }] }));
});

it("returns explicit JSON draft status and exit 2 while retaining the YAML draft file", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-plan-review-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  const draft = TestCharterSchema.parse({ intent: "Verify persistence", actions: [{ kind: "observe" }], assertions: [], planning: { source: "deterministic" } });
  vi.spyOn(runner, "plan").mockResolvedValue(draft);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await createProgram().parseAsync(["plan", "Verify persistence", "--root", root, "--format", "json", "--out", "draft.yaml"], { from: "user" });
  expect(process.exitCode).toBe(2);
  const output = JSON.parse(stdout.mock.calls.at(-1)![0] as string);
  expect(output).toMatchObject({ status: "needs-input", testVerdict: "not-asserted", executionStarted: false, charter: { intent: draft.intent } });
  expect(output.next).toContainEqual(expect.objectContaining({ action: "connect-business-check" }));
  expect(await readFile(join(root, "draft.yaml"), "utf8")).toContain("intent: Verify persistence");
});

it("keeps default stdout as YAML and sends draft guidance only to stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-plan-yaml-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "plan").mockResolvedValue(TestCharterSchema.parse({ intent: "Read page", actions: [{ kind: "observe" }], assertions: [] }));
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await createProgram().parseAsync(["plan", "Read page", "--root", root], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(stdout.mock.calls.at(-1)![0]).toContain("intent: Read page");
  expect(stdout.mock.calls.at(-1)![0]).not.toContain("Plan: needs-input");
  expect(stderr.mock.calls.at(-1)![0]).toContain("Plan: needs-input");
});

it("reports ready-for-review without claiming execution or a product pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-plan-ready-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "plan").mockResolvedValue(TestCharterSchema.parse({ intent: "Read page", level: "quick", actions: [{ kind: "observe" }], assertions: [{ kind: "text-visible", text: "Ready" }], planning: { source: "submitted" } }));
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await createProgram().parseAsync(["plan", "Read page", "--root", root, "--format", "json"], { from: "user" });
  expect(JSON.parse(stdout.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "ready-for-review", executionStarted: false, testVerdict: "not-asserted" });
  expect(process.exitCode).toBe(exitCode);
});

it("returns structured needs-input for direct intent execution instead of a stack trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-direct-run-gate-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["run", "测试新增一条记录并刷新验证持久化", "--root", root, "--url", "http://127.0.0.1:1", "--no-start"], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "needs-input", testVerdict: "not-asserted", executionStarted: false });
});

it("returns structured needs-observation for a direct intent that needs another page state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-direct-observation-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "start").mockRejectedValue(new PlanningObservationError(undefined, {
    request: { status: "needs-observation", reason: "Need the checkout state", expectedObservation: "Observe checkout", action: { kind: "click", selector: "#next" } },
    inspections: [{ runId: "cart", manifestSha256: "a".repeat(64) }],
  }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["run", "Place order", "--root", root], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "needs-observation", testVerdict: "not-asserted", observationRequest: { requiresApproval: true } });
});

it("returns structured planner-not-ready when the direct CLI planner is unconfigured", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-planner-not-ready-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "start").mockRejectedValue(new PlannerConfigurationError("Configure planner provider"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["run", "Review the checkout", "--root", root], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "planner-not-ready", testVerdict: "not-asserted", executionStarted: false, next: ["configure_planner", "plan_test", "run_test"] });
});

it("returns planner-not-ready from plan before writing a draft when the provider is unconfigured", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-plan-provider-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "plan").mockRejectedValue(new PlannerConfigurationError("Configure planner provider"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["plan", "Review checkout", "--root", root, "--format", "json"], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "planner-not-ready", executionStarted: false, next: ["configure_planner", "plan_test", "run_test"] });
});

it("returns planner-not-ready from mission create before persisting a Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofkit-cli-mission-provider-")); roots.push(root);
  const runner = new LocalRunnerService({ root, workspaceRoot: root });
  vi.spyOn(LocalRunnerService, "create").mockResolvedValue(runner);
  vi.spyOn(runner, "createMission").mockRejectedValue(new PlannerConfigurationError("Configure planner provider"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await createProgram().parseAsync(["mission", "create", "Review checkout", "--root", root], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: "planner-not-ready", executionStarted: false, next: ["configure_planner", "plan_test", "run_test"] });
});

it("rejects an invalid format before loading project configuration", async () => {
  const create = vi.spyOn(LocalRunnerService, "create");
  await expect(createProgram().parseAsync(["plan", "Read page", "--format", "unsupported"], { from: "user" })).rejects.toThrow("yaml or json");
  expect(create).not.toHaveBeenCalled();
});
