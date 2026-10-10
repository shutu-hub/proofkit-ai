import { describe, expect, it } from "vitest";
import { ProjectMapSchema } from "@proofkit/contracts";
import { assessPlanningCoverage, planningCoverageRequirements, withPlanningCoverage } from "./coverage.js";

const map = ProjectMapSchema.parse({ root: ".", detected: { web: true, electron: false, backend: false }, generatedAt: new Date().toISOString() });

describe("planning coverage", () => {
  it.each(["测试整个项目", "验证所有功能", "check the entire application", "test all workflows"])("recognizes whole-project scope: %s", (intent) => {
    const coverage = assessPlanningCoverage(intent, map);
    expect(coverage).toMatchObject({ requested: "project", source: "inferred", inventory: "bounded", workflowCoverage: "unmeasured" });
    expect(planningCoverageRequirements(coverage).evidenceGaps).toEqual(["project-workflow-coverage"]);
  });

  it.each(["完整测试简历模块", "上线前回归关键链路", "release regression"])("keeps intensity independent of project scope: %s", (intent) => {
    expect(assessPlanningCoverage(intent, map).requested).toBe("declared");
  });

  it("rejects an explicit scope that narrows a whole-project request", () => {
    expect(() => assessPlanningCoverage("测试整个项目", map, "declared"))
      .toThrow("intent requests whole-project acceptance but supplied coverage is declared");
    expect(assessPlanningCoverage("完整测试简历模块", map, "declared")).toMatchObject({ requested: "declared", source: "explicit" });
    expect(assessPlanningCoverage("测试简历模块", map, "project")).toMatchObject({ requested: "project", source: "explicit" });
    expect(() => assessPlanningCoverage("test", map, "everything" as never)).toThrow();
  });

  it("reports absence and truncation without declaring a complete workflow inventory", () => {
    expect(planningCoverageRequirements(assessPlanningCoverage("test", undefined, "project")).evidenceGaps)
      .toEqual(["project-map-not-scanned", "project-workflow-coverage"]);
    expect(planningCoverageRequirements(assessPlanningCoverage("test", { ...map, inventory: { ...map.inventory, truncated: true } }, "project")).evidenceGaps)
      .toEqual(["project-map-truncated", "project-workflow-coverage"]);
  });

  it("preserves saved legacy gates while attaching a declared-scenario boundary", () => {
    const quality = withPlanningCoverage({ source: "catalog", confidence: 0.5, assumptions: [], missingInputs: ["legacy review"], evidenceGaps: ["project-map-truncated"] }, assessPlanningCoverage("module", map));
    expect(quality.evidenceGaps).toEqual(["project-map-truncated"]);
    expect(quality.missingInputs).toEqual(["legacy review"]);
    expect(quality.coverage?.requested).toBe("declared");
  });
});
