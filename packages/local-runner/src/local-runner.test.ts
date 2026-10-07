import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalRunnerService", () => {
  it("rejects untrusted model-authored actions before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ root, restrictWebOrigins: true });
    const started = await service.start({
      charter: { intent: "unsafe", mode: "guided", preconditions: [], actions: [{ kind: "shell", command: "whoami" } as never], assertions: [], sideEffectPolicy: "deny", metadata: {} },
    });
    await expect(service.wait(started.runId)).rejects.toThrow();
    const status = await service.status(started.runId);
    expect(status.status).toBe("failed");
  });

  it("blocks off-origin navigation in MCP mode before creating evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ root, restrictWebOrigins: true });
    const started = await service.start({ intent: "open external", url: "https://example.com" });
    await expect(service.wait(started.runId)).rejects.toThrow("outside the configured origin");
    await expect(readFile(join(root, ".proofkit", "runs", started.runId, "run.json"), "utf8")).rejects.toThrow();
  });

  it("does not start a configured shell command from MCP mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({
      root,
      restrictWebOrigins: true,
      config: {
        project: { root: ".", start: "echo forbidden", health: [], startupTimeoutMs: 1_000 },
        surfaces: {},
        policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
      },
    });
    const started = await service.start({ intent: "observe" });
    await expect(service.wait(started.runId)).rejects.toThrow("cannot execute project.start");
  });
});
