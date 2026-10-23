import { mkdtemp, readFile, rm } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseErrorObservationSchema, TestCharterSchema, type ResponseObservation, type SurfaceSnapshot } from "@proofkit/contracts";
import { CancelledError, ExecutionRunner, InconclusiveError, ResponseCaptureError, ResponseStatusError, type SurfaceAdapter } from "./index.js";

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

describe("unexpected response facts stop the Run", () => {
  it("keeps valid identity fields separately after incomplete projection and prevents Oracle acceptance", async () => {
    const dir = await root(); const surface = adapter(); let triggers = 0; let oracleCalls = 0;
    const incomplete = ResponseErrorObservationSchema.parse({ ...observation, kind: "incomplete-fields", acceptance: "not-established",
      expectedStatuses: [200, 201], fieldGaps: [{ name: "room", code: "missing" }] });
    const plan = TestCharterSchema.parse({ ...charter, actions: [{ ...charter.actions[0], response: { url: observation.url, method: "POST", fields: {
      fileId: { pointer: "/data/file_id", type: "id" }, room: { pointer: "/room", type: "number" } }, errorFields: { errorMessage: { pointer: "/error", type: "string" } } } },
      { kind: "click", selector: "#later-write" }] });
    surface.act = async () => { triggers++; throw new ResponseCaptureError(incomplete); };
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir, oracles: [{ name: "intake", async check() {
      oracleCalls++; throw new Error("must not execute");
    } }] }).run(plan, "incomplete-projection");
    expect(summary.verdict).toBe("inconclusive"); expect(triggers).toBe(1); expect(oracleCalls).toBe(0);
    expect(summary.steps[0]!.response).toBeUndefined(); expect(summary.steps[0]!.responseError).toEqual(incomplete);
    expect(summary.steps[0]!.failureCode).toBe("response-field-missing");
    const artifact = summary.steps[0]!.artifacts.find((path) => path.endsWith("-response-error.json"))!;
    expect(JSON.parse(await readFile(join(dir, artifact), "utf8"))).toEqual(incomplete);
    surface.act = async () => { throw new ResponseCaptureError({ ...incomplete, fields: { errorMessage: "PRIVATE_UNDECLARED" }, fieldGaps: [{ name: "room", code: "missing" }] }); };
    const invalid = await new ExecutionRunner(surface, { evidenceDir: dir }).run(plan, "incomplete-forged");
    expect(invalid.steps[0]!.failureCode).toBe("response-fields-unverified"); expect(invalid.steps[0]!.responseError).toBeUndefined();
    expect(await readFile(join(dir, invalid.runId, "run.json"), "utf8")).not.toContain("PRIVATE_UNDECLARED");
  });
  const diagnostic = ResponseErrorObservationSchema.parse({ ...observation, status: 422, kind: "unexpected-status", acceptance: "not-established", expectedStatuses: [200, 201],
    fields: { message: "Invalid address" }, fieldGaps: [], requestBodyBytes: 14, requestBodySha256: "b".repeat(64), requestFields: { quantity: 2 } });
  const rejectedCharter = TestCharterSchema.parse({ ...charter, actions: [{ ...charter.actions[0], response: {
    url: observation.url, method: observation.method, fields: { fileId: { pointer: "/data/file_id", type: "id" } }, errorFields: { message: { pointer: "/message", type: "string" } },
    requestFields: { quantity: { pointer: "/quantity", type: "number" } } } }, { kind: "click", selector: "#write-again" }] });
  it("records the first failed response separately and never executes later writes or Oracles", async () => {
    const dir = await root(); const surface = adapter(); let triggers = 0; let oracles = 0;
    surface.act = async () => { triggers++; throw new ResponseStatusError(diagnostic); };
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir, oracles: [{ name: "intake", async check() {
      oracles++; return { name: "intake", passed: true, message: "must not run", evidence: [], observedAt: now };
    } }] }).run(rejectedCharter, "unexpected-response");
    expect(triggers).toBe(1); expect(oracles).toBe(0); expect(summary.verdict).toBe("inconclusive");
    expect(summary.steps[0]).toMatchObject({ status: "failed", failureCode: "response-status", responseError: diagnostic });
    expect(summary.steps[0]!.response).toBeUndefined();
    const artifact = summary.steps[0]!.artifacts.find((path) => path.endsWith("step-001-response-error.json"))!;
    expect(JSON.parse(await readFile(join(dir, artifact), "utf8"))).toEqual(diagnostic);
  });
  it.each([
    { url: "http://127.0.0.1/other" }, { method: "GET" }, { name: "other" }, { expectedStatuses: [202] },
    { fields: { private: "UNDECLARED_PRIVATE_VALUE" } }, { fields: { message: 12 } },
    { fields: {}, fieldGaps: [] }, { fields: {}, fieldGaps: [{ name: "other", code: "missing" }] },
    { requestFields: { quantity: "2" } }, { requestFields: {} }, { followUp: "clicked" },
  ])("rejects adapter diagnostics that disagree with declarations: %j", async (change) => {
    const dir = await root(); const surface = adapter();
    surface.act = async () => { throw new ResponseStatusError(ResponseErrorObservationSchema.parse({ ...diagnostic, ...change })); };
    const summary = await new ExecutionRunner(surface, { evidenceDir: dir }).run(rejectedCharter, "unexpected-forged");
    expect(summary.steps[0]!.failureCode).toBe("response-status-unverified");
    expect(summary.steps[0]!.responseError).toBeUndefined();
    expect(await readFile(join(dir, summary.runId, "run.json"), "utf8")).not.toContain("UNDECLARED_PRIVATE_VALUE");
  });
});

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
