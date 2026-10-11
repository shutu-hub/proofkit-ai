import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema } from "@proofkit/contracts";
import type { MissionTool } from "@proofkit/agent";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function recoveryKey(service: LocalRunnerService): string | undefined {
  const tools = (service as unknown as { createMissionTools(): MissionTool[] }).createMissionTools();
  const keys = tools.map((tool) => tool.recoveryKey);
  expect(new Set(keys).size).toBe(1);
  return keys[0];
}

describe("Mission tool recovery context", () => {
  it("pins source, workspace configuration and connector version without persisting their values", async () => {
    const base = await mkdtemp(join(tmpdir(), "proofkit-recovery-key-"));
    roots.push(base);
    const root = join(base, "source");
    const workspaceRoot = join(base, "workspace");
    await Promise.all([mkdir(root), mkdir(workspaceRoot)]);
    await writeFile(join(root, "package.json"), '{"name":"recovery-context"}');
    const config = (port: number) => ProofkitConfigSchema.parse({ project: { root }, surfaces: { web: { baseUrl: `http://127.0.0.1:${port}/` } } });
    const service = (port: number, version?: string) => new LocalRunnerService({ root, workspaceRoot, config: config(port),
      ...(version ? { integration: { name: "fixture-connector", version } } : {}) });

    const key = recoveryKey(service(5173, "1"));
    expect(key).toMatch(/^local-runner-v1:[a-f0-9]{64}$/);
    expect(key).toBe(recoveryKey(service(5173, "1")));
    expect(key).not.toBe(recoveryKey(service(5174, "1")));
    expect(key).not.toBe(recoveryKey(service(5173, "2")));
    expect(key).not.toContain(root);
    expect(key).not.toContain("127.0.0.1");
    expect(recoveryKey(new LocalRunnerService({ root, workspaceRoot, config: config(5173),
      integration: { name: "unversioned-connector" } }))).toBeUndefined();
  });
});
