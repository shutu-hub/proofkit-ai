import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAdapter } from "@proofkit/adapters";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];

beforeEach(() => {
  // Keep browser mechanics out of these registry tests. Local Runner,
  // ExecutionRunner, evidence persistence and integration cleanup are real.
  vi.spyOn(WebAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(WebAdapter.prototype, "snapshot").mockResolvedValue({ capturedAt: new Date().toISOString(), text: "ready", metadata: {} });
  vi.spyOn(WebAdapter.prototype, "subscribeEvents").mockResolvedValue(() => {});
  vi.spyOn(WebAdapter.prototype, "assert").mockImplementation(async (assertion) => ({ assertion, passed: true, message: "fixture ready", evidence: [] }));
  vi.spyOn(WebAdapter.prototype, "close").mockResolvedValue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Oracle registration and selection", () => {
  it("executes a named integration Oracle exactly once and leaves unrelated Oracles idle", async () => {
    const root = await projectRoot();
    const selected = vi.fn(async () => ({ name: "selected", passed: true, message: "terminal", evidence: [] }));
    const unrelated = vi.fn(async () => { throw new Error("Unrelated workflow must not execute"); });
    const cleanup = vi.fn();
    const service = new LocalRunnerService({
      workspaceRoot: root,
      root,
      integration: {
        name: "fixture",
        oracles: [{ name: "selected", check: selected }, { name: "unrelated", check: unrelated }],
        setup: async () => cleanup,
      },
    });
    const started = await service.start({ charter: charter(["selected"]) });
    const summary = await service.wait(started.runId);

    expect(summary.verdict).toBe("passed");
    expect(summary.oracles.map((oracle) => oracle.name)).toEqual(["selected"]);
    expect(selected).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("treats programmatic Oracles as a registry and executes only selected names", async () => {
    const root = await projectRoot();
    const check = vi.fn(async () => ({ name: "programmatic", passed: true, message: "terminal", evidence: [] }));
    const service = new LocalRunnerService({ workspaceRoot: root, root, oracles: [{ name: "programmatic", check }] });
    const unselected = await service.start({ charter: charter([]) });
    expect((await service.wait(unselected.runId)).oracles).toEqual([]);
    expect(check).not.toHaveBeenCalled();

    const selected = await service.start({ charter: charter(["programmatic"]) });
    expect((await service.wait(selected.runId)).verdict).toBe("passed");
    expect(check).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous integration and programmatic registrations", async () => {
    const root = await projectRoot();
    const oracle = { name: "same", check: async () => ({ name: "same", passed: true, message: "ok", evidence: [] }) };
    expect(() => new LocalRunnerService({ workspaceRoot: root, root, integration: { name: "fixture", oracles: [oracle] }, oracles: [oracle] })).toThrow("Duplicate oracle registration");
  });

  it("rejects declarative names that shadow a registered Oracle", async () => {
    const root = await projectRoot();
    const config = ProofkitConfigSchema.parse({ oracles: [{ name: "same", url: "http://127.0.0.1:8080/status", statusPointer: "/status", successValues: ["complete"] }] });
    expect(() => new LocalRunnerService({ workspaceRoot: root, root, config, oracles: [{ name: "same", check: async () => ({ name: "same", passed: true, message: "ok", evidence: [] }) }] })).toThrow("Duplicate oracle registration");
  });

  it("rejects an inline Oracle collision before connecting the browser", async () => {
    const root = await projectRoot();
    const service = new LocalRunnerService({ workspaceRoot: root, root, oracles: [{ name: "selected", check: async () => ({ name: "selected", passed: true, message: "ok", evidence: [] }) }] });
    const started = await service.start({ charter: charter(["selected"]), oracleUrl: "http://127.0.0.1:8080/status", oracleName: "selected" });
    await expect(service.wait(started.runId)).rejects.toThrow("Duplicate oracle name");
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });

  it("checks configured Web CDP endpoints before connecting in MCP mode", async () => {
    const root = await projectRoot();
    const config = ProofkitConfigSchema.parse({ surfaces: { web: { cdpUrl: "http://example.com:9222" } } });
    const service = new LocalRunnerService({ workspaceRoot: root, root, config, restrictWebOrigins: true });
    const started = await service.start({ charter: charter([]) });
    await expect(service.wait(started.runId)).rejects.toThrow("CDP endpoint must use loopback");
    expect(WebAdapter.prototype.connect).not.toHaveBeenCalled();
  });
});

function charter(oracles: string[]) {
  return TestCharterSchema.parse({ intent: "verify fixture", level: "quick", actions: [], assertions: [{ kind: "text-visible", text: "ready" }], oracles, sideEffectPolicy: "deny" });
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "proofkit-oracle-selection-"));
  roots.push(root);
  return root;
}
