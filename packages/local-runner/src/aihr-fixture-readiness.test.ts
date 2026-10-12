import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { ProofkitConfigSchema, TestCharterSchema, type Action } from "@proofkit/contracts";
import * as project from "@proofkit/project";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const reference = ".proofkit/fixtures/resume.pdf";
const privateBytes = "%PDF-1.4 SYNTHETIC_PRIVATE_CONTENT_never_return_this";
const integrationSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.proofkit");
beforeEach(() => {
  for (const [name, value] of Object.entries({ AIHR_PROOFKIT_API_BASE_URL: "http://127.0.0.1:8080/api/v1",
    AIHR_PROOFKIT_ACCESS_TOKEN: "isolated-test-credential", AIHR_PROOFKIT_ENTERPRISE_ID: "1",
    AIHR_PROOFKIT_WORKSPACE_ID: "2", AIHR_PROOFKIT_USER_ID: "3", AIHR_PROOFKIT_TEST_SCOPE: "proofkit:fixture",
    AIHR_PROOFKIT_CLIENT_ITEM_KEY: "proofkit:fixture:unused-global-key" })) vi.stubEnv(name, value);
  vi.stubEnv("AIHR_PROOFKIT_FIXTURE_PATH", undefined);
  vi.spyOn(project, "inspectTargetBinding").mockImplementation(async (root) => ({ status: "unverified", method: "unavailable",
    expectedProjectRoot: root, reason: "No fixture gateway listener.", observedAt: new Date().toISOString() }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function upload(fixturePath: string = reference): Action {
  return { kind: "capability", name: "aihr.uploadResumeFile", input: { fixturePath, clientItemKey: "proofkit:fixture:selected" } };
}
async function fixture(actions: Action[] = [upload()]) {
  const base = await mkdtemp(join(tmpdir(), "proofkit-aihr-fixture-readiness-")); roots.push(base);
  const root = join(base, "source"); const workspaceRoot = join(base, "tests");
  await mkdir(root); await writeFile(join(root, "package.json"), '{"name":"unchanged-tested-source"}');
  await mkdir(join(workspaceRoot, ".proofkit", "fixtures"), { recursive: true });
  await mkdir(join(workspaceRoot, ".proofkit", "charters"));
  for (const file of ["integration.mjs", "aihr-manual-intake.mjs", "aihr-desktop-acquisition.mjs"]) {
    await copyFile(join(integrationSource, file), join(workspaceRoot, ".proofkit", file));
  }
  await writeFile(join(workspaceRoot, reference), privateBytes);
  const charter = TestCharterSchema.parse({ intent: "check selected synthetic resume", level: "core", mode: "deterministic",
    sideEffectPolicy: "allow", actions, assertions: [{ kind: "text-visible", text: "received" }], oracles: ["aihr.resumeCollectionPipeline"] });
  await writeFile(join(workspaceRoot, ".proofkit", "charters", "core.yml"), JSON.stringify(charter));
  const config = ProofkitConfigSchema.parse({ charters: [{ id: "resume-core", aliases: ["resume core"], path: ".proofkit/charters/core.yml",
    level: "core", surfaces: ["web"] }] });
  const service = await LocalRunnerService.create({ root, workspaceRoot, config, allowCapabilityWrites: true });
  return { root, workspaceRoot, service, charter };
}

describe("AIHR selected fixture readiness", () => {
  it("reads the actual literal fixture without a global path and emits only bounded file facts", async () => {
    const { root, workspaceRoot, service } = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway requests permitted"));
    const integration = service.integration!;
    const setup = vi.spyOn(integration, "setup"); const preflight = vi.spyOn(integration, "preflight");
    const execute = integration.capabilities!.map((item) => vi.spyOn(item, "execute"));
    const before = await readdir(join(workspaceRoot, ".proofkit"));
    const ready = await service.inspectIntegrationReadiness({ charterId: "resume-core" });
    expect(ready).toMatchObject({ status: "ready", testVerdict: "not-asserted", check: { evidence: {
      fixtureActionCount: 1, fixtureCheckedCount: 1, fixtureReadiness: "readable", fixtureFactsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    } } });
    expect(JSON.stringify(ready)).not.toContain(privateBytes);
    expect(JSON.stringify(ready)).not.toContain(reference);
    expect(JSON.stringify(ready)).not.toContain("isolated-test-credential");
    expect(fetch).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
    for (const call of execute) expect(call).not.toHaveBeenCalled();
    expect(await readdir(join(workspaceRoot, ".proofkit"))).toEqual(before);
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"unchanged-tested-source"}');
    await writeFile(join(workspaceRoot, reference), "%PDF changed synthetic input");
    const updated = await service.inspectIntegrationReadiness({ charterId: "resume-core" });
    expect(updated.check?.evidence.fixtureFactsSha256).not.toBe(ready.check?.evidence.fixtureFactsSha256);
  });

  it("checks the environment reference in the actual upload action", async () => {
    const { service } = await fixture([upload("$env:AIHR_PROOFKIT_FIXTURE_PATH")]);
    const missing = await service.inspectIntegrationReadiness({ charterId: "resume-core" });
    expect(missing).toMatchObject({ status: "blocked", check: { issues: [expect.objectContaining({ code: "fixture-path-missing" })] } });
    vi.stubEnv("AIHR_PROOFKIT_FIXTURE_PATH", reference);
    expect(await service.inspectIntegrationReadiness({ charterId: "resume-core" })).toMatchObject({ status: "ready" });
  });

  it.each(["missing", "empty", "oversized", "directory", "config", "absolute", "escape", "root-redirect"])(
    "blocks %s before resource creation, setup, page connection or a gateway request", async (kind) => {
      const actions: Action[] = [{ kind: "capability", name: "aihr.createResumeCollectionRun", input: {} }, upload()];
      const { root, workspaceRoot, service, charter } = await fixture(actions);
      const path = join(workspaceRoot, reference);
      if (kind === "missing") await rm(path);
      if (kind === "empty") await writeFile(path, "");
      if (kind === "oversized") { const handle = await open(path, "w"); try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); } }
      if (kind === "directory") { await rm(path); await mkdir(path); }
      if (kind === "config") {
        await writeFile(join(workspaceRoot, ".proofkit", "config.yaml"), `# PRIVATE_CONFIG\n${JSON.stringify(service.config)}\n`);
        charter.actions[1] = upload(".proofkit/config.yaml");
      }
      if (kind === "absolute") charter.actions[1] = upload(path);
      if (kind === "escape" || kind === "root-redirect") {
        await mkdir(join(root, "private")); await writeFile(join(root, "private", "resume.pdf"), privateBytes);
        if (kind === "escape") {
          await symlink(join(root, "private"), join(workspaceRoot, ".proofkit", "fixtures", "link"), "junction");
          charter.actions[1] = upload(".proofkit/fixtures/link/resume.pdf");
        } else {
          await rm(join(workspaceRoot, ".proofkit", "fixtures"), { recursive: true });
          await symlink(join(root, "private"), join(workspaceRoot, ".proofkit", "fixtures"), "junction");
        }
      }
      // A valid global path cannot hide an unusable action-selected fixture.
      vi.stubEnv("AIHR_PROOFKIT_FIXTURE_PATH", reference);
      await writeFile(join(workspaceRoot, ".proofkit", "charters", "core.yml"), JSON.stringify(charter));
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway requests permitted"));
      const setup = vi.spyOn(service.integration!, "setup");
      const connect = vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
      const creates = vi.spyOn(service.integration!.capabilities!.find((item) => item.name === "aihr.createResumeCollectionRun")!, "execute");
      const ready = await service.inspectIntegrationReadiness({ charterId: "resume-core" });
      expect(ready).toMatchObject({ status: "blocked", testVerdict: "not-asserted", check: {
        evidence: { fixtureReadiness: "blocked", fixtureCheckedCount: 0 },
        issues: [expect.objectContaining({ code: kind === "empty" ? "fixture-empty" : "fixture-unavailable" })],
      } });
      const started = await service.start({ charter }); const summary = await service.wait(started.runId);
      expect(summary.verdict).toBe("blocked"); expect(summary.steps).toEqual([]);
      const artifact = summary.artifacts.find((item) => item.endsWith("preflight.json"))!;
      const persisted = await readFile(join(service.evidenceDir, artifact), "utf8");
      expect(JSON.parse(persisted)).toMatchObject({ passed: false, evidence: { fixtureReadiness: "blocked" } });
      expect(persisted + JSON.stringify(ready)).not.toContain(privateBytes);
      expect(persisted).not.toContain(path);
      expect(fetch).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(creates).not.toHaveBeenCalled();
    });

  it("does not hide a missing later upload behind the first readable fixture", async () => {
    const { service } = await fixture([upload(), upload(".proofkit/fixtures/absent.pdf")]);
    expect(await service.inspectIntegrationReadiness({ charterId: "resume-core" })).toMatchObject({ status: "blocked", check: {
      evidence: { fixtureActionCount: 2, fixtureCheckedCount: 1, fixtureReadiness: "blocked" },
      issues: [expect.objectContaining({ code: "fixture-unavailable", guidance: expect.stringContaining("Action 2") })],
    } });
  });

  it("checks UI file selections with the same aggregate action limit", async () => {
    const { workspaceRoot, service } = await fixture([{ kind: "setInputFiles", selector: "#resume", files: [reference, reference] }]);
    const handle = await open(join(workspaceRoot, reference), "w");
    try { await handle.truncate(10 * 1024 * 1024 + 1); } finally { await handle.close(); }
    expect(await service.inspectIntegrationReadiness({ charterId: "resume-core" })).toMatchObject({ status: "blocked", check: {
      evidence: { fixtureReadiness: "blocked" }, issues: [expect.objectContaining({ code: "fixture-unavailable" })],
    } });
  });

  it("rechecks upload bytes at execution and rejects changed invalid inputs before HTTP", async () => {
    const { workspaceRoot, service } = await fixture();
    const ready = await service.inspectIntegrationReadiness({ charterId: "resume-core" });
    expect(ready.status).toBe("ready");
    const uploadCapability = service.integration!.capabilities!.find((item) => item.name === "aihr.uploadResumeFile")!;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway requests permitted"));
    await writeFile(join(workspaceRoot, reference), "");
    await expect(uploadCapability.execute({ fixturePath: reference, clientItemKey: "proofkit:fixture:selected" }, {
      runId: "changed-fixture", signal: new AbortController().signal,
    })).rejects.toThrow("fixture is empty");
    const handle = await open(join(workspaceRoot, reference), "w");
    try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(uploadCapability.execute({ fixturePath: reference, clientItemKey: "proofkit:fixture:selected" }, {
      runId: "oversized-fixture", signal: new AbortController().signal,
    })).rejects.toThrow("20 MiB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves cancellation at the direct upload read boundary", async () => {
    const { service } = await fixture();
    const uploadCapability = service.integration!.capabilities!.find((item) => item.name === "aihr.uploadResumeFile")!;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway requests permitted"));
    const controller = new AbortController(); const reason = { kind: "fixture-read-cancelled" }; controller.abort(reason);
    await expect(uploadCapability.execute({ fixturePath: reference, clientItemKey: "proofkit:fixture:selected" }, {
      runId: "cancelled-fixture", signal: controller.signal,
    })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});
