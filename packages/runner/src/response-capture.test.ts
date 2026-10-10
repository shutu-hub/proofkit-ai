import { mkdtemp, readFile, rm } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestCharterSchema, type ResponseObservation, type SurfaceSnapshot } from "@proofkit/contracts";
import { CancelledError, ExecutionRunner, InconclusiveError, type SurfaceAdapter } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const now = "2026-10-10T00:00:00.000Z";
const charter = TestCharterSchema.parse({ intent: "submit and independently check this intake", sideEffectPolicy: "allow",
  actions: [{ kind: "captureResponse", name: "intake", trigger: { kind: "click", selector: "#submit" },
    response: { url: "http://127.0.0.1/api/v1/intakes", method: "POST", fields: { fileId: { pointer: "/data/file_id", type: "id" } } } }],
  assertions: [{ kind: "text-visible", text: "Submitted" }], oracles: ["intake"],
});
const observation: ResponseObservation = { name: "intake", association: "action-window", url: "http://127.0.0.1/api/v1/intakes",
  method: "POST", status: 201, requestCount: 1, windowStartedAt: now, windowEndedAt: now, capturedAt: now,
  bodyBytes: 27, bodySha256: "a".repeat(64), fields: { fileId: "41" } };
function adapter(response: unknown = observation): SurfaceAdapter {
  const snapshot = async (): Promise<SurfaceSnapshot> => ({ capturedAt: now, text: "Submitted", metadata: {} });
  return { name: "response-fixture", supportsResponseCapture: true, async connect() {}, discover: snapshot, snapshot,
    async act(action) { return { actionId: "trigger", kind: action.kind, startedAt: now, endedAt: now, durationMs: 0,
      metadata: { response, privateBody: "UNSELECTED_PRIVATE_BODY" } }; },
    async assert(assertion) { return { assertion, passed: true, message: "Submitted", evidence: [] }; },
    async capture() { return undefined; }, async subscribeEvents() { return () => {}; }, async close() {},
  };
}
async function root() { const dir = await mkdtemp(join(tmpdir(), "proofkit-response-runner-")); roots.push(dir); return dir; }

describe("response facts in the ordinary Run lifecycle", () => {
  it("persists selected facts and passes the same observation to an independent Oracle", async () => {
    const dir = await root(); let seen: unknown;
    const summary = await new ExecutionRunner(adapter(), { evidenceDir: dir, oracles: [{ name: "intake", async check(context) {
      seen = context.steps[0]?.response;
      return { name: "intake", passed: context.steps[0]?.response?.fields.fileId === "41", message: "Independent identity read",
        evidence: [JSON.stringify({ fileId: "41", state: "completed" })], observedAt: now };
    } }] }).run(charter, "response-pass");
    expect(summary.verdict).toBe("passed"); expect(seen).toEqual(observation);
    expect(summary.steps[0]?.response).toEqual(observation);
    const path = summary.steps[0]!.artifacts.find((item) => item.endsWith("step-001-response.json"))!;
    expect(JSON.parse(await readFile(join(dir, path), "utf8"))).toEqual(observation);
    const saved = await readFile(join(dir, "response-pass", "run.json"), "utf8");
    expect(saved).not.toContain("UNSELECTED_PRIVATE_BODY");
    expect(await readFile(join(dir, "response-pass", "events.jsonl"), "utf8")).toContain("response-observation");
  });

  it.each([
    { response: undefined }, { response: { ...observation, name: "other" } },
    { response: { ...observation, url: "http://127.0.0.1/other" } }, { response: { ...observation, method: "GET" } },
    { response: { ...observation, status: 503 } }, { response: { ...observation, fields: {} } },
    { response: { ...observation, fields: { fileId: 41 } } }, { response: { ...observation, fields: { fileId: "01" } } },
    { response: { ...observation, fields: { fileId: "41", private: "UNSELECTED_PRIVATE_BODY" } } },
  ])("refuses invalid or missing adapter facts without persisting the unvalidated receipt", async ({ response }) => {
    const dir = await root(); const surface = adapter(); surface.act = async (action) => ({
      actionId: "trigger", kind: action.kind, startedAt: now, endedAt: now, durationMs: 0, metadata: { response },
    }); let oracleCalls = 0;
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir, oracles: [{ name: "intake", async check() {
      oracleCalls++; return { name: "intake", passed: true, message: "historical success", evidence: [], observedAt: now };
    } }] }).run(charter, "response-invalid");
    expect(summary.verdict).toBe("inconclusive"); expect(oracleCalls).toBe(0);
    expect(summary.steps[0]?.response).toBeUndefined(); expect(summary.steps[0]?.receipt).toBeUndefined();
    expect(summary.steps[0]?.artifacts.some((path) => path.endsWith("response-gap.json"))).toBe(true);
    expect(await readFile(join(dir, "response-invalid", "run.json"), "utf8")).not.toContain("UNSELECTED_PRIVATE_BODY");
  });

  it("requires the recorded follow-up branch to match the declared capture action", async () => {
    const withFollowUp = TestCharterSchema.parse({ ...charter, actions: [{ ...charter.actions[0],
      followUp: { kind: "clickIfVisible", selector: "#confirm", waitMs: 100 } }] });
    for (const [plan, response] of [[withFollowUp, observation], [charter, { ...observation, followUp: "clicked" }]] as const) {
      const summary = await new ExecutionRunner(adapter(response), { evidenceDir: await root() }).run(plan);
      expect(summary.verdict).toBe("inconclusive");
      expect(summary.steps[0]?.response).toBeUndefined();
    }
  });

  it.each(["permission", "unsupported"])("blocks %s capture before connecting", async (reason) => {
    const dir = await root(); const surface = { ...adapter(), supportsResponseCapture: reason !== "unsupported" }; let connected = false;
    surface.connect = async () => { connected = true; };
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir }).run({ ...charter,
      sideEffectPolicy: reason === "permission" ? "deny" : "allow" }, "response-blocked");
    expect(summary.verdict).toBe("blocked"); expect(connected).toBe(false);
  });

  it("retains a typed observation gap across the asynchronous action boundary", async () => {
    const dir = await root(); const surface = adapter(); surface.act = async () => { throw new InconclusiveError("response-ambiguous", "Duplicate requests"); };
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir }).run(charter, "response-duplicate");
    expect(summary.verdict).toBe("inconclusive"); expect(summary.steps[0]?.error).toBe("Duplicate requests");
  });

  it("propagates cancellation to capture and releases signal listeners and the adapter", async () => {
    const dir = await root(); const controller = new AbortController(); const surface = adapter(); let closed = false; let signal: AbortSignal | undefined;
    let began!: () => void; const started = new Promise<void>((resolve) => { began = resolve; });
    surface.close = async () => { closed = true; };
    surface.act = async (_action, context) => {
      signal = context!.signal!; began(); let stop!: () => void;
      try { return await new Promise<never>((_, reject) => { stop = () => reject(signal!.reason); signal!.addEventListener("abort", stop, { once: true }); }); }
      finally { signal.removeEventListener("abort", stop); }
    };
    const running = new ExecutionRunner(surface, { evidenceDir: dir, signal: controller.signal }).run(charter, "response-cancel");
    await started; controller.abort(new CancelledError("operator stopped capture"));
    const summary = await running;
    expect(summary.verdict).toBe("cancelled"); expect(summary.findings.join(" ")).toContain("operator stopped capture");
    expect(closed).toBe(true); expect(getEventListeners(signal!, "abort")).toHaveLength(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
