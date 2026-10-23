import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { sha256 } from "@proofkit/evidence";
import type { ProjectIntegration } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";
import { readWorkspaceCharterFile } from "./workspace-charter-file.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(readiness?: ProjectIntegration["readiness"]) {
  const base = await mkdtemp(join(tmpdir(), "proofkit-readiness-boundary-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "tests");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"untouched-source"}');
  await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
  await writeFile(join(workspaceRoot, ".proofkit", "charters", "resume.yml"), JSON.stringify({
    intent: "resume core", level: "core", surfaces: ["web"], actions: [],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny",
  }));
  const integration: ProjectIntegration = { name: "readiness-fixture", version: "1", readiness,
    preflight: vi.fn(async () => { throw new Error("must not call lifecycle preflight"); }),
    setup: vi.fn(async () => { throw new Error("must not call lifecycle setup"); }),
  };
  const service = new LocalRunnerService({ root, workspaceRoot, integration, config: ProofkitConfigSchema.parse({
    charters: [{ id: "resume-core", path: ".proofkit/charters/resume.yml", aliases: ["resume core"], level: "core", surfaces: ["web"] }],
  }) });
  return { service, root, workspaceRoot, integration };
}

const request = { charterId: "resume-core" };

async function candidateFixture(readiness: ProjectIntegration["readiness"], overrides: Record<string, unknown> = {}) {
  const result = await fixture(readiness);
  const path = ".proofkit/charters/candidate.yml";
  const file = join(result.workspaceRoot, path);
  const charter = { intent: "candidate core", level: "core", surfaces: ["electron"], actions: [],
    assertions: [{ kind: "text-visible", text: "ready" }], sideEffectPolicy: "deny", ...overrides };
  await writeFile(file, JSON.stringify(charter));
  return { ...result, path, file, charter };
}

describe("connector readiness trust boundary", () => {
  it("checks a full submitted draft without saving or executing it and fingerprints the normalized content", async () => {
    const readiness = vi.fn(async () => ({ passed: false, message: "Independent contact fields are not observable", evidence: { independentFieldsAvailable: false },
      issues: [{ code: "independent-fields-unavailable", guidance: "Keep email and contactNumber required; provide an independent reader before creating bookings." }] }));
    const { service, root, workspaceRoot, integration } = await fixture(readiness);
    const charter = { intent: "Verify the full booking", level: "core" as const, surfaces: ["web" as const],
      actions: [{ kind: "click" as const, selector: "#submit" }], oracles: ["full-booking"],
      planning: { source: "submitted" as const, confidence: 0.8, missingInputs: ["Independent contacts"], evidenceGaps: ["booking-contact-fields"], assumptions: [] },
      metadata: { requiredFields: ["roomId", "email", "contactNumber"] } };
    const before = await readdir(join(workspaceRoot, ".proofkit"));
    const result = await service.inspectIntegrationReadiness({ charter });
    expect(result).toMatchObject({ status: "blocked", testVerdict: "not-asserted", level: "core", surfaces: ["web"],
      draftSha256: sha256(JSON.stringify(TestCharterSchema.parse(charter))), check: { issues: [{ code: "independent-fields-unavailable" }] } });
    expect(result.charterId).toBeUndefined(); expect(result.charterPath).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"requiredFields"');
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ charter: expect.objectContaining({
      metadata: charter.metadata, planning: expect.objectContaining({ evidenceGaps: ["booking-contact-fields"] }) }) }));
    expect(integration.preflight).not.toHaveBeenCalled(); expect(integration.setup).not.toHaveBeenCalled();
    expect(await readdir(join(workspaceRoot, ".proofkit"))).toEqual(before);
    expect(await readdir(root)).toEqual(["package.json"]);
    const changed = await service.inspectIntegrationReadiness({ charter: { ...charter, metadata: { requiredFields: ["roomId"] } } });
    expect(changed.draftSha256).not.toBe(result.draftSha256);
  });

  it("rejects oversized or unsurfaced drafts before calling the connector", async () => {
    const readiness = vi.fn(async () => ({ passed: true, message: "ready" }));
    const { service } = await fixture(readiness);
    await expect(service.inspectIntegrationReadiness({ charter: { intent: "Draft without surface" } })).rejects.toThrow("surfaces");
    await expect(service.inspectIntegrationReadiness({ charter: { intent: "Bounded draft", surfaces: ["web"], metadata: { large: "x".repeat(128 * 1024) } } })).rejects.toThrow("128 KiB");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("isolates a draft from caller mutation and refuses a connector-modified draft", async () => {
    const source = { intent: "Immutable draft", surfaces: ["web" as const], metadata: { expected: { contact: "original" } } };
    const readiness = vi.fn(async ({ charter }: Parameters<NonNullable<ProjectIntegration["readiness"]>>[0]) => {
      source.metadata.expected.contact = "changed by caller";
      expect(charter.metadata).toEqual({ expected: { contact: "original" } });
      charter.intent = "Changed by connector";
      charter.surfaces![0] = "electron";
      return { passed: true, message: "ready" };
    });
    const { service } = await fixture(readiness);
    expect(await service.inspectIntegrationReadiness({ charter: source })).toMatchObject({ status: "unavailable", testVerdict: "not-asserted", surfaces: ["web"] });
  });
  it("checks the scope-pinned candidate and retains its platform and digest without creating execution records", async () => {
    const readiness = vi.fn(async () => ({ passed: true, message: "prerequisites met", evidence: {} }));
    const { service, root, workspaceRoot, integration, path, file } = await candidateFixture(readiness);
    const before = await readFile(file);
    const candidate = (await service.inspectTestScope({ level: "core", surface: "electron" })).workspaceCandidates!.items[0]!;
    // Readiness must not erase planning gaps or present connector success as acceptance.
    expect(candidate.issues).toContain("missing-business-oracle");
    const result = await service.inspectIntegrationReadiness({ charterPath: path, charterSha256: candidate.sha256! });
    expect(result).toMatchObject({ status: "ready", testVerdict: "not-asserted", level: "core", surfaces: ["electron"],
      charterPath: path, charterSha256: candidate.sha256 });
    expect(result.charterId).toBeUndefined();
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ charter: expect.objectContaining({ intent: "candidate core" }),
      projectRoot: root, workspaceRoot, signal: expect.any(AbortSignal) }));
    expect(integration.preflight).not.toHaveBeenCalled();
    expect(integration.setup).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readdir(join(workspaceRoot, ".proofkit"))).toEqual(["charters"]);
  });

  it("rejects changed candidate bytes before invoking the readiness hook", async () => {
    const readiness = vi.fn(async () => ({ passed: true, message: "ready", evidence: {} }));
    const { service, path, file, workspaceRoot } = await candidateFixture(readiness);
    const loaded = await readWorkspaceCharterFile(workspaceRoot, path);
    await writeFile(file, JSON.stringify({ ...loaded.charter, intent: "changed plan" }));
    await expect(service.inspectIntegrationReadiness({ charterPath: path, charterSha256: loaded.sha256 })).rejects.toThrow("digest changed");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("pins endpoint bindings using the same reader as Mission creation", async () => {
    vi.stubEnv("PROOFKIT_TEST_GATEWAY_URL", "http://127.0.0.1:8123/api/v1");
    const readiness = vi.fn(async () => ({ passed: false, message: "fixture missing", evidence: {} }));
    const { service, path } = await candidateFixture(readiness, { surfaces: ["web"], sideEffectPolicy: "allow",
      actions: [{ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
        response: { url: "$env:PROOFKIT_TEST_GATEWAY_URL/intakes", method: "POST",
          fields: { fileId: { pointer: "/data/file_id", type: "id" } } } }] });
    const candidate = (await service.inspectTestScope({ level: "core", surface: "web" })).workspaceCandidates!.items[0]!;
    const selected = { charterPath: path, charterSha256: candidate.sha256! };
    expect(await service.inspectIntegrationReadiness(selected)).toMatchObject({ status: "blocked", ...selected });
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ charter: expect.objectContaining({
      actions: [expect.objectContaining({ response: expect.objectContaining({ url: "http://127.0.0.1:8123/api/v1/intakes" }) })],
    }) }));
    readiness.mockClear();
    vi.stubEnv("PROOFKIT_TEST_GATEWAY_URL", "http://127.0.0.1:8124/api/v1");
    await expect(service.inspectIntegrationReadiness(selected)).rejects.toThrow("endpoint binding changed");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("keeps a registered file under catalog identity even when selected by its candidate digest", async () => {
    const readiness = vi.fn(async () => ({ passed: true, message: "ready", evidence: {} }));
    const { service, workspaceRoot } = await fixture(readiness);
    const path = ".proofkit/charters/resume.yml";
    const loaded = await readWorkspaceCharterFile(workspaceRoot, path);
    await expect(service.inspectIntegrationReadiness({ charterPath: path, charterSha256: loaded.sha256 })).rejects.toThrow("already registered");
    expect(readiness).not.toHaveBeenCalled();
  });

  it("requires a candidate platform declaration before invoking the connector", async () => {
    const readiness = vi.fn(async () => ({ passed: true, message: "ready", evidence: {} }));
    const { service, workspaceRoot, path } = await candidateFixture(readiness, { surfaces: undefined });
    const loaded = await readWorkspaceCharterFile(workspaceRoot, path);
    await expect(service.inspectIntegrationReadiness({ charterPath: path, charterSha256: loaded.sha256 })).rejects.toThrow("supported surfaces");
    expect(readiness).not.toHaveBeenCalled();
  });

  it.each([
    {}, { charterSha256: "a".repeat(64) }, { charterPath: ".proofkit/charters/candidate.yml" },
    { ...request, charterPath: ".proofkit/charters/candidate.yml", charterSha256: "a".repeat(64) },
    { ...request, charterSha256: "a".repeat(64) },
    { charterPath: ".proofkit/charters/candidate.yml", charterSha256: "not-a-digest" },
  ])("rejects ambiguous or incomplete selection before connector execution (%j)", async (selection) => {
    const readiness = vi.fn(async () => ({ passed: true, message: "ready", evidence: {} }));
    const { service } = await fixture(readiness);
    await expect(service.inspectIntegrationReadiness(selection)).rejects.toThrow();
    expect(readiness).not.toHaveBeenCalled();
  });

  it("returns unavailable without substituting a lifecycle hook or creating execution records", async () => {
    const { service, root, workspaceRoot, integration } = await fixture();
    expect(await service.inspectIntegrationReadiness(request)).toMatchObject({ status: "unavailable", testVerdict: "not-asserted" });
    expect(integration.preflight).not.toHaveBeenCalled();
    expect(integration.setup).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readdir(join(workspaceRoot, ".proofkit"))).toEqual(["charters"]);
  });

  it.each(["throw", "reject"])("withholds connector diagnostics on a %s", async (mode) => {
    const readiness = vi.fn(() => {
      const error = new Error("private-connector-diagnostic");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
    const { service } = await fixture(readiness);
    const output = await service.inspectIntegrationReadiness(request);
    expect(output).toMatchObject({ status: "unavailable", testVerdict: "not-asserted" });
    expect(output.check).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("private-connector-diagnostic");
  });

  it.each([
    ["null", null],
    ["nonboolean verdict", { passed: "true", message: "ready" }],
    ["empty message", { passed: true, message: "" }],
    ["oversized message", { passed: true, message: "x".repeat(1025) }],
    ["nested evidence", { passed: true, message: "ready", evidence: { nested: { token: "private" } } }],
    ["nonfinite evidence", { passed: true, message: "ready", evidence: { count: Infinity } }],
    ["too many facts", { passed: true, message: "ready", evidence: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`fact-${i}`, true])) }],
    ["oversized fact", { passed: true, message: "ready", evidence: { fact: "x".repeat(1025) } }],
    ["oversized key", { passed: true, message: "ready", evidence: { ["x".repeat(129)]: true } }],
    ["invalid issue", { passed: true, message: "ready", issues: [{ code: "../secret", guidance: "fix" }] }],
    ["oversized issue guidance", { passed: false, message: "blocked", issues: [{ code: "missing", guidance: "x".repeat(241) }] }],
    ["too many issues", { passed: false, message: "blocked", issues: Array.from({ length: 33 }, () => ({ code: "missing", guidance: "fix" })) }],
  ])("does not claim ready for %s", async (_label, value) => {
    const { service } = await fixture(async () => value as never);
    expect(await service.inspectIntegrationReadiness(request)).toMatchObject({ status: "unavailable", testVerdict: "not-asserted" });
  });

  it("scrubs short and overlapping credentials, evidence keys and numeric values while preserving ordinary provenance", async () => {
    vi.stubEnv("PROOFKIT_TEST_SECRET", "pk.7+");
    vi.stubEnv("PROOFKIT_TEST_TOKEN", "pk.7+-long");
    vi.stubEnv("PROOFKIT_TEST_PASSWORD", "7823");
    vi.stubEnv("PROOFKIT_API_BASE_URL", "http://127.0.0.1:8080/api/v1");
    vi.stubEnv("PROOFKIT_SOURCE_ROOT", "D:/code/fixture-source");
    const { service } = await fixture(async () => ({
      passed: false, message: "pk.7+-long / pk.7+",
      evidence: { "credential-pk.7+": "pk.7+", numeric: 7823,
        endpoint: process.env.PROOFKIT_API_BASE_URL!, source: process.env.PROOFKIT_SOURCE_ROOT!,
        authorization: "Bearer fixture-only-bearer", labelled: "password=fixture-only-password" },
      issues: [{ code: "credential-invalid", guidance: "pk.7+" }],
    }));
    const output = await service.inspectIntegrationReadiness(request);
    expect(output).toMatchObject({ status: "blocked", check: {
      message: "[REDACTED] / [REDACTED]",
      evidence: { "redacted-key-1": "[REDACTED]", numeric: "[REDACTED]",
        endpoint: "http://127.0.0.1:8080/api/v1", source: "D:/code/fixture-source",
        authorization: "Bearer [REDACTED]", labelled: "password=[REDACTED]" },
      issues: [{ code: "credential-invalid", guidance: "[REDACTED]" }],
    } });
    for (const secret of ["pk.7+", "7823", "fixture-only-bearer", "fixture-only-password"]) expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("fails closed when redacted keys would overwrite an existing fact", async () => {
    vi.stubEnv("PROOFKIT_TEST_SECRET", "pk.7+");
    const { service } = await fixture(async () => ({ passed: true, message: "ready",
      evidence: { "pk.7+": true, "redacted-key-1": false } }));
    expect(await service.inspectIntegrationReadiness(request)).toMatchObject({ status: "unavailable" });
  });

  it("scrubs credentials captured before a connector changes the environment", async () => {
    vi.stubEnv("PROOFKIT_TEST_SECRET", "fixture-removed-secret");
    const { service } = await fixture(async () => {
      const message = process.env.PROOFKIT_TEST_SECRET!;
      delete process.env.PROOFKIT_TEST_SECRET;
      return { passed: false, message, evidence: {} };
    });
    expect(await service.inspectIntegrationReadiness(request)).toMatchObject({ status: "blocked", check: { message: "[REDACTED]" } });
  });

  it("rejects an already cancelled inspection even when no hook is registered", async () => {
    const { service } = await fixture();
    const reason = new Error("caller stopped");
    await expect(service.inspectIntegrationReadiness(request, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it.each(["cancel", "timeout"])("settles on %s even when the connector ignores cancellation and removes caller listeners", async (mode) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let hookSignal!: AbortSignal;
    let rejectLate!: (reason: Error) => void;
    const { service } = await fixture(async ({ signal }) => {
      hookSignal = signal;
      entered();
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    });
    const caller = new AbortController();
    const baseline = getEventListeners(caller.signal, "abort").length;
    const reason = new Error("caller stopped");
    vi.useFakeTimers();
    const pending = service.inspectIntegrationReadiness(request, caller.signal);
    const settled = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
    await started;
    if (mode === "cancel") caller.abort(reason);
    else await vi.advanceTimersByTimeAsync(15_000);
    if (mode === "cancel") expect(await settled).toEqual({ error: reason });
    else expect(await settled).toMatchObject({ result: { status: "unavailable", testVerdict: "not-asserted" } });
    expect(hookSignal.aborted).toBe(true);
    expect(getEventListeners(caller.signal, "abort").length).toBe(baseline);
    expect(getEventListeners(hookSignal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    // The race keeps a rejection handler on a hook that settles late.
    rejectLate(new Error("late private diagnostic"));
    await Promise.resolve();
  });
});
