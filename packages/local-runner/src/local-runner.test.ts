import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema } from "@proofkit/contracts";
import { ExecutionRunner, type SurfaceAdapter } from "@proofkit/runner";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("LocalRunnerService", () => {
  it("loads a project-local integration module without a hosted service", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-"));
    roots.push(root);
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "integration.mjs"), "export default { name: 'fixture-integration', version: '1' };", "utf8");

    const service = await LocalRunnerService.create({ root });

    expect(service.integration?.name).toBe("fixture-integration");
    expect(service.integration?.version).toBe("1");
  });

  it("executes capabilities, oracles and cleanup from the loaded integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-integration-run-"));
    roots.push(root);
    await mkdir(join(root, ".proofkit"), { recursive: true });
    await writeFile(join(root, ".proofkit", "integration.mjs"), `
      const passthrough = { parse(value) { return value; } };
      const integration = {
        name: "fixture-integration",
        state: { cleaned: false },
        capabilities: [{
          name: "readResumeState",
          description: "Read the fixture resume terminal state",
          sideEffect: "read",
          environments: ["test"],
          timeoutMs: 1000,
          inputSchema: passthrough,
          outputSchema: passthrough,
          execute: async () => ({ status: "complete" }),
          evidence: (output) => ({ status: output.status }),
        }],
        oracles: [{
          name: "resume-terminal",
          check: async ({ steps }) => ({
            name: "resume-terminal",
            passed: steps[0]?.capabilityOutput?.status === "complete",
            message: "resume reached the terminal state",
            evidence: [],
          }),
        }],
        setup: async () => async () => { integration.state.cleaned = true; },
      };
      export default integration;
    `, "utf8");
    const service = await LocalRunnerService.create({ root });
    const adapter: SurfaceAdapter = {
      name: "fixture",
      async connect() {},
      async discover() { return { capturedAt: new Date().toISOString(), metadata: {} }; },
      async snapshot() { return { capturedAt: new Date().toISOString(), metadata: {} }; },
      async act() { throw new Error("not used"); },
      async assert(assertion) { return { assertion, passed: true, message: "not used", evidence: [] }; },
      async capture() { return undefined; },
      async subscribeEvents() { return () => {}; },
      async close() {},
    };
    const summary = await new ExecutionRunner(adapter, {
      evidenceDir: service.evidenceDir,
      capabilities: service.integration?.capabilities,
      oracles: service.integration?.oracles,
      setup: service.integration?.setup,
    }).run({
      intent: "verify resume",
      mode: "deterministic",
      preconditions: [],
      actions: [{ kind: "capability", name: "readResumeState", input: {} }],
      assertions: [],
      oracles: ["resume-terminal"],
      sideEffectPolicy: "deny",
      metadata: {},
    }, "integration-run");
    expect(summary.verdict).toBe("passed");
    expect((service.integration as unknown as { state: { cleaned: boolean } }).state.cleaned).toBe(true);
  });

  it("uses the configured OpenAI-compatible planner through the local service", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    let modelCalled = false;
    const server = createServer(async (request, response) => {
      modelCalled = request.method === "POST" && request.url === "/v1/chat/completions";
      for await (const _chunk of request) { /* consume request body */ }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "check resume", actions: [{ kind: "goto", url: "http://127.0.0.1:5173" }, { kind: "observe" }], assertions: [{ kind: "text-visible", text: "Resume ready" }], sideEffectPolicy: "confirm" }) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No model server port");
    const config = ProofkitConfigSchema.parse({ planning: { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }, surfaces: { web: { baseUrl: "http://127.0.0.1:5173" } } });
    const charter = await new LocalRunnerService({ root, config }).plan("check resume");
    expect(modelCalled).toBe(true);
    expect(charter.assertions).toEqual([{ kind: "text-visible", text: "Resume ready" }]);
    expect(charter.metadata.planner).toBe("openai-compatible");
  });

  it("validates model actions, oracle references and navigation scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const config = ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "http://127.0.0.1:5173" } }, oracles: [{ name: "resume", url: "http://127.0.0.1:8080/status", statusPointer: "/data/status", successValues: ["done"] }] });
    let actions: unknown[] = [{ kind: "goto", url: "http://127.0.0.1:5173/resumes" }, { kind: "observe" }];
    const service = new LocalRunnerService({ root, config, plannerProvider: { name: "fake-model", async plan() { return { intent: "test resume", actions, assertions: [], oracles: ["resume"], sideEffectPolicy: "confirm" }; } } });
    const valid = await service.plan("test resume");
    expect(valid.oracles).toEqual(["resume"]);
    expect(valid.metadata.planner).toBe("fake-model");
    actions = [{ kind: "click", selector: "#delete" }];
    await expect(service.plan("test resume")).rejects.toThrow("outside the allowed action kinds");
    actions = [{ kind: "goto", url: "https://example.com" }];
    await expect(service.plan("test resume")).rejects.toThrow("outside the approved origin");
  });

  it("rejects an unregistered charter oracle before browser execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofkit-local-"));
    roots.push(root);
    const service = new LocalRunnerService({ root });
    const started = await service.start({ charter: { intent: "check", mode: "guided", preconditions: [], actions: [], assertions: [], oracles: ["unknown"], sideEffectPolicy: "deny", metadata: {} } });
    await expect(service.wait(started.runId)).rejects.toThrow("Oracle is not registered");
  });

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
        planning: { provider: "deterministic", timeoutMs: 30_000 },
        integration: {},
        run: { timeoutMs: 300_000 },
        oracles: [],
        policies: { environment: "test", sideEffects: "confirm", saveSensitivePayloads: false },
      },
    });
    const started = await service.start({ intent: "observe" });
    await expect(service.wait(started.runId)).rejects.toThrow("cannot execute project.start");
  });
});
