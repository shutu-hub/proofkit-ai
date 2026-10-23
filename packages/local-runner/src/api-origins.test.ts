import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofkitConfigSchema, TestCharterSchema } from "@proofkit/contracts";
import { LocalRunnerService } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const apiOrigin = "https://api.example.test";
const charter = TestCharterSchema.parse({ intent: "Create an order and inspect its current backend state", level: "core", sideEffectPolicy: "allow",
  actions: [{ kind: "captureResponse", name: "order", trigger: { kind: "click", selector: "#submit" },
    response: { url: apiOrigin + "/orders", method: "POST", fields: { orderId: { pointer: "/id", type: "identifier" } } } }],
  assertions: [{ kind: "text-visible", text: "Order created" }], oracles: ["order-current"],
  httpOracles: [{ name: "order-current", url: apiOrigin + "/orders/state", statusPointer: "/status", successValues: ["created"],
    query: { id: { source: "response", stepId: "step-001", field: "orderId", matchPointer: "/id" } } }] });

async function service(apiOrigins?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "proofkit-api-origins-")); roots.push(root);
  await mkdir(join(root, "charters"));
  return new LocalRunnerService({ root, workspaceRoot: root, restrictWebOrigins: true,
    config: ProofkitConfigSchema.parse({ surfaces: { web: { baseUrl: "https://shop.example.test", apiOrigins } }, policies: { sideEffects: "allow" } }) });
}

describe("separate browser and API origin admission", () => {
  it("requires explicit API trust and keeps candidate guidance aligned with Mission admission", async () => {
    const blocked = await service();
    await expect(blocked.createMission({ intent: charter.intent, surface: "web", charter })).rejects.toThrow("loopback");
    const allowed = await service([apiOrigin]);
    await writeFile(join(allowed.workspaceRoot, "charters", "api-order.yml"), JSON.stringify({ ...charter, surfaces: ["web"] }));
    const scope = await allowed.inspectTestScope({ focus: "api-order" });
    expect(scope.workspaceCandidates?.items[0]).toMatchObject({ parseStatus: "valid", issues: [] });
    const mission = await allowed.createMission({ intent: charter.intent, surface: "web", charter });
    expect(mission.status).toBe("awaiting-approval");
    expect(mission.plan.executionProfile.requireBusinessOracle).toBe(true);
  });
  it.each(["https://api.example.test.evil.test", "https://sub.api.example.test", "http://api.example.test", "https://api.example.test:8443"])("rejects a non-matching capture origin %s", async (origin) => {
    const allowed = await service([apiOrigin]);
    const changed = structuredClone(charter);
    const capture = changed.actions[0]!;
    if (capture.kind === "captureResponse") capture.response.url = origin + "/orders";
    await expect(allowed.createMission({ intent: changed.intent, surface: "web", charter: changed })).rejects.toThrow("outside the configured origin");
  });
  it("does not allow navigation to an API-only origin", async () => {
    const allowed = await service([apiOrigin]);
    const changed = structuredClone(charter); changed.actions.unshift({ kind: "goto", url: apiOrigin + "/admin" });
    changed.httpOracles![0]!.query.id!.stepId = "step-002";
    await expect(allowed.createMission({ intent: changed.intent, surface: "web", charter: changed })).rejects.toThrow("outside the configured origin");
  });
});
