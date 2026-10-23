import { describe, expect, it } from "vitest";
import { ProofkitConfigSchema, RunRecordingSchema, SessionCaptureSummarySchema, VideoRecordingBudgetSchema } from "./index.js";

describe("video recording budgets", () => {
  it("supplies bounded defaults independently for ordinary Runs and retained sessions", () => {
    expect(VideoRecordingBudgetSchema.parse({})).toEqual({ maxDurationMs: 600_000, maxBytes: 64 * 1024 * 1024 });
    const config = ProofkitConfigSchema.parse({ run: { videoBudget: { maxDurationMs: 5000 } }, sessions: { videoBudget: { maxBytes: 1024 * 1024 } } });
    expect(config.run.videoBudget).toEqual({ maxDurationMs: 5000, maxBytes: 64 * 1024 * 1024 });
    expect(config.sessions?.videoBudget).toEqual({ maxDurationMs: 600_000, maxBytes: 1024 * 1024 });
    expect(config.run.recordVideo).toBeUndefined();
    expect(config.sessions?.recordVideo).toBeUndefined();
  });

  it.each([{ maxDurationMs: 0 }, { maxDurationMs: 999 }, { maxDurationMs: 3_600_001 }, { maxBytes: 0 }, { maxBytes: 1024 * 1024 - 1 }, { maxBytes: 64 * 1024 * 1024 + 1 }, { maxBytes: 1.5 }, { unknown: 1 }])("rejects invalid or unbounded budgets %j", (budget) => {
    expect(VideoRecordingBudgetSchema.safeParse(budget).success).toBe(false);
  });

  it("retains a finite machine-readable reason without storing raw diagnostics", () => {
    expect(RunRecordingSchema.parse({ status: "unavailable", stopReason: "duration-limit", budget: {} })).toMatchObject({ stopReason: "duration-limit" });
    expect(RunRecordingSchema.safeParse({ status: "unavailable", stopReason: "private password" }).success).toBe(false);
    expect(RunRecordingSchema.safeParse({ status: "recorded", stopReason: "duration-limit" }).success).toBe(false);
  });

  it("requires a bounded-stop reason and saved artifact for partial footage without certifying complete capture", () => {
    const recording = { status: "partial", stopReason: "duration-limit", artifact: "run/artifacts/recording.webm" };
    expect(RunRecordingSchema.parse(recording)).toEqual(recording);
    for (const changed of [{ artifact: undefined }, { stopReason: undefined }, { stopReason: "inspection-failed" }]) {
      expect(RunRecordingSchema.safeParse({ ...recording, ...changed }).success).toBe(false);
    }
    const capture = { runId: "session-network-00000000-0000-4000-8000-000000000001", status: "partial", closed: true,
      events: 0, omittedEvents: 0, unresolvedRequests: 0, networkEnabled: false, recording };
    expect(SessionCaptureSummarySchema.safeParse(capture).success).toBe(true);
    expect(SessionCaptureSummarySchema.safeParse({ ...capture, status: "sealed" }).success).toBe(false);
  });

  it("accounts for every selected page without blessing an orphan popup recording", () => {
    const saved = { status: "recorded", artifact: "session-network-00000000-0000-4000-8000-000000000001/artifacts/recording.webm",
      selectedPages: { observed: 2, artifacts: ["session-network-00000000-0000-4000-8000-000000000001/artifacts/selected-page-001.webm"], omitted: 1 } };
    expect(RunRecordingSchema.safeParse(saved).success).toBe(true);
    expect(RunRecordingSchema.safeParse({ ...saved, artifact: undefined }).success).toBe(false);
    expect(RunRecordingSchema.safeParse({ ...saved, selectedPages: { ...saved.selectedPages, omitted: 0 } }).success).toBe(false);
    expect(RunRecordingSchema.safeParse({ ...saved, selectedPages: { observed: 1, artifacts: ["foreign/artifacts/selected-page-002.webm"], omitted: 0 } }).success).toBe(false);
    const second = saved.selectedPages.artifacts[0]!.replace("-001.webm", "-002.webm");
    expect(RunRecordingSchema.safeParse({ ...saved, selectedPages: { observed: 2, artifacts: [saved.selectedPages.artifacts[0]!, second], omitted: 0 } }).success).toBe(true);
    expect(RunRecordingSchema.safeParse({ ...saved, selectedPages: { observed: 2, artifacts: [second, second], omitted: 0 } }).success).toBe(false);
    expect(RunRecordingSchema.safeParse({ ...saved, selectedPages: { observed: 2, artifacts: [second.replace("-002.webm", "-017.webm")], omitted: 1 } }).success).toBe(false);
  });
});
