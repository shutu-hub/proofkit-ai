import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";
import { readWorkspaceCharterFile } from "./workspace-charter-file.js";

const roots: string[] = [];
const environmentKey = "PROOFKIT_TEST_GATEWAY_URL";
const previousEnvironment = process.env[environmentKey];
afterEach(async () => {
  if (previousEnvironment === undefined) delete process.env[environmentKey];
  else process.env[environmentKey] = previousEnvironment;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "proofkit-endpoint-binding-"));
  roots.push(base);
  const root = join(base, "source");
  const workspaceRoot = join(base, "tests");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"fixture"}');
  await mkdir(join(workspaceRoot, ".proofkit", "charters"), { recursive: true });
  const path = ".proofkit/charters/bound.yml";
  const file = join(workspaceRoot, ".proofkit", "charters", "bound.yml");
  const charter = `intent: verify current intake
level: quick
surfaces: [web]
mode: deterministic
sideEffectPolicy: allow
actions:
  - kind: captureResponse
    name: intake
    trigger: { kind: click, selector: '#submit' }
    response:
      url: $env:${environmentKey}/intakes
      method: POST
      fields:
        fileId: { pointer: /data/file_id, type: id }
assertions:
  - { kind: text-visible, text: Submitted }
`;
  await writeFile(file, charter);
  const service = new LocalRunnerService({ root, workspaceRoot, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ project: { root }, policies: { sideEffects: "allow" } }) });
  return { workspaceRoot, file, path, service };
}

describe("external Charter endpoint bindings", () => {
  it("pins the reviewed environment URL before Mission persistence", async () => {
    const { workspaceRoot, path, service } = await fixture();
    process.env[environmentKey] = "http://127.0.0.1:8123/api/v1";
    const candidate = (await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0];
    expect(candidate).toMatchObject({ parseStatus: "valid", issues: [], sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const options = { intent: "快速验证本次录入", level: "quick" as const, surface: "web" as const,
      charterPath: path, charterSha256: candidate!.sha256! };
    const mission = await service.createMission(options);
    expect(mission.charter?.actions[0]).toMatchObject({ response: { url: "http://127.0.0.1:8123/api/v1/intakes" } });
    expect(mission.charter?.metadata.proofkitCandidate).toMatchObject({ sha256: candidate!.sha256 });
    process.env[environmentKey] = "http://127.0.0.1:8124/api/v1";
    await expect(service.createMission(options)).rejects.toThrow("endpoint binding changed");
    const changed = (await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0];
    expect(changed?.sha256).not.toBe(candidate?.sha256);
    const next = await service.createMission({ ...options, charterSha256: changed!.sha256! });
    expect(next.charter?.actions[0]).toMatchObject({ response: { url: "http://127.0.0.1:8124/api/v1/intakes" } });
    expect((await readWorkspaceCharterFile(workspaceRoot, path)).charter.actions[0]).toMatchObject({
      response: { url: "http://127.0.0.1:8124/api/v1/intakes" },
    });
  });

  it("reports missing or unsafe bindings without exposing their values", async () => {
    const { workspaceRoot, file, path, service } = await fixture();
    delete process.env[environmentKey];
    const missing = (await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0];
    expect(missing).toMatchObject({ parseStatus: "invalid", issues: ["endpoint-binding-unavailable"] });
    await expect(readWorkspaceCharterFile(workspaceRoot, path)).rejects.toThrow("endpoint binding is unavailable");
    for (const value of ["https://user:secret@example.test/api", "http://127.0.0.1/api?token=secret", "file:///tmp/data"]) {
      process.env[environmentKey] = value;
      const result = (await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0];
      expect(result?.issues).toEqual(["endpoint-binding-unavailable"]);
    }
    await writeFile(file, `intent: invalid binding\nlevel: quick\nsurfaces: [web]\nactions:\n  - kind: captureResponse\n    name: intake\n    trigger: { kind: click, selector: '#submit' }\n    response: { url: '$env:SECRET_VALUE/intakes', method: POST, fields: { fileId: { pointer: /data/file_id, type: id } } }\nassertions: [{ kind: text-visible, text: Submitted }]\nsideEffectPolicy: allow\n`);
    expect((await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0]?.issues)
      .toEqual(["endpoint-binding-unavailable"]);
  });

  it("binds negative actions and independent inline readers to the same reviewed gateway", async () => {
    const { workspaceRoot, file, path, service } = await fixture();
    process.env[environmentKey] = "http://127.0.0.1:8125/api/v1";
    const capture = { kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
      response: { url: `$env:${environmentKey}/intakes`, method: "POST",
        fields: { fileId: { pointer: "/data/file_id", type: "id" } } } };
    await writeFile(file, JSON.stringify({ intent: "verify current intake", level: "core", surfaces: ["web"],
      sideEffectPolicy: "allow", actions: [capture], assertions: [{ kind: "text-visible", text: "Submitted" }],
      oracles: ["current-intake"], httpOracles: [{ name: "current-intake", url: `$env:${environmentKey}/intakes/status`,
        query: { fileId: { source: "response", stepId: "step-001", field: "fileId", matchPointer: "/data/file_id" } },
        statusPointer: "/data/state", successValues: ["complete"] }],
      negativeCases: [{ caseId: "duplicate", title: "reject duplicate", actions: [capture],
        assertions: [{ kind: "text-visible", text: "Rejected" }], oracles: ["current-intake"],
        expectedVerdict: "passed", sideEffectPolicy: "allow" }] }));
    const candidate = (await service.inspectTestScope({ level: "core", surface: "web" })).workspaceCandidates?.items[0];
    expect(candidate).toMatchObject({ parseStatus: "valid", issues: [] });
    const mission = await service.createMission({ intent: "验证本次录入", level: "core", surface: "web",
      charterPath: path, charterSha256: candidate!.sha256! });
    expect(mission.charter?.httpOracles?.[0]?.url).toBe("http://127.0.0.1:8125/api/v1/intakes/status");
    expect(mission.charter?.negativeCases?.[0]?.actions[0]).toMatchObject({
      response: { url: "http://127.0.0.1:8125/api/v1/intakes" },
    });
    expect((await readWorkspaceCharterFile(workspaceRoot, path)).sha256).toBe(candidate!.sha256);
  });

  it("applies the existing MCP origin policy after resolving a valid remote URL", async () => {
    const { path, service } = await fixture();
    process.env[environmentKey] = "https://outside.example.test/api/v1";
    const candidate = (await service.inspectTestScope({ level: "quick", surface: "web" })).workspaceCandidates?.items[0];
    expect(candidate).toMatchObject({ parseStatus: "valid", issues: ["web-origin-disallowed"] });
    await expect(service.createMission({ intent: "快速验证录入", level: "quick", surface: "web",
      charterPath: path, charterSha256: candidate!.sha256! })).rejects.toThrow("outside the configured origin");
  });
});
