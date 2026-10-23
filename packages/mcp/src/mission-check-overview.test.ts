import { describe, expect, it } from "vitest";
import { MissionCheckOverviewSchema, type MissionResult } from "@proofkit/contracts";
import { briefMissionResult } from "./mission-evidence-brief.js";

describe("brief Mission checks", () => {
  it("keeps bounded prioritized checkpoints and all omitted counts in the first host response", () => {
    const summary = { evidenceId: "summary", kind: "snapshot", path: "run-1/run.json", sha256: "a".repeat(64), capturedAt: "2026-10-21T00:00:00.000Z", description: "Private metadata that is not needed in the brief" };
    const checkOverview = MissionCheckOverviewSchema.parse({ scope: "saved-run-checks", inspectedRuns: 2, omittedRuns: 3,
      unavailableRuns: Array.from({ length: 7 }, (_, index) => ({ runId: "missing-" + index, title: "Unavailable Run" })),
      counts: { failed: 1, passed: 109, inconclusive: 0, "not-recorded": 0, unverified: 0 },
      items: Array.from({ length: 12 }, (_, index) => ({ runId: "run-1", title: "Save note", runKind: "primary", kind: "business", status: index === 0 ? "failed" : "passed",
        expected: "Checkpoint " + index, observed: "Saved observation", summary })), omittedChecks: 98 });
    const brief = briefMissionResult({ checkOverview } as unknown as MissionResult);
    expect(brief.checkOverview?.items).toHaveLength(8);
    expect(brief.checkOverview?.items[0]).toMatchObject({ expected: "Checkpoint 0", status: "failed" });
    expect(brief.checkOverview?.counts).toEqual(checkOverview.counts);
    expect(brief.checkOverview).toMatchObject({ omittedChecks: 102, omittedRuns: 3, omittedUnavailableRuns: 2 });
    expect(brief.checkOverview?.unavailableRuns).toHaveLength(5);
    expect(brief.checkOverview?.items[0]?.summary).not.toHaveProperty("description");
    expect(checkOverview.items).toHaveLength(12);
  });
});
