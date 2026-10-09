import { normalizePlanningQuality, PlanningCoverageSchema, PlanningQualitySchema, TestCoverageSchema, type PlanningCoverage, type PlanningQuality, type ProjectMap, type TestCoverage } from "@proofkit/contracts";

/** Resolve from the host request, never from provider-authored planning metadata. */
export function assessPlanningCoverage(intent: string, projectMap?: ProjectMap, requested?: TestCoverage): PlanningCoverage {
  const explicit = requested === undefined ? undefined : TestCoverageSchema.parse(requested);
  const normalized = intent.normalize("NFKC").toLowerCase();
  const projectRequest = /整个项目|全项目|整个产品|所有功能|全部功能|所有业务流程|全部业务流程|\b(?:whole|entire)\s+(?:project|application|product)\b|\ball\s+(?:features|workflows)\b/.test(normalized);
  return PlanningCoverageSchema.parse({
    requested: explicit ?? (projectRequest ? "project" : "declared"),
    source: explicit ? "explicit" : projectRequest ? "inferred" : "default",
    reason: explicit ? `调用者明确选择 ${explicit} 验收范围`
      : projectRequest ? "请求包含全项目或全部功能范围，需要完整业务流程覆盖证明"
      : "验收限于声明的 Charter 场景，不推断全项目覆盖",
    inventory: !projectMap ? "not-scanned" : projectMap.inventory.truncated ? "partial" : "bounded",
    workflowCoverage: "unmeasured",
    gaps: [
      ...(!projectMap ? ["project-map-not-scanned"] : projectMap.inventory.truncated ? ["project-map-truncated"] : []),
      "project-workflow-coverage",
    ],
  });
}

/** Project coverage gates cannot be fulfilled by a few passing declared scenarios. */
export function planningCoverageRequirements(coverage: PlanningCoverage): Pick<PlanningQuality, "missingInputs" | "evidenceGaps"> {
  if (coverage.requested === "declared") return { missingInputs: [], evidenceGaps: [] };
  return {
    missingInputs: ["全项目业务流程清单与可度量的执行覆盖证明"],
    evidenceGaps: [...coverage.gaps],
  };
}

/** Keep saved plan gates intact; upgrading a legacy plan requires explicit replanning. */
export function withPlanningCoverage(quality: PlanningQuality | undefined, coverage: PlanningCoverage): PlanningQuality {
  const current = normalizePlanningQuality(quality);
  const required = planningCoverageRequirements(coverage);
  return PlanningQualitySchema.parse({
    ...current, coverage,
    missingInputs: [...new Set([...current.missingInputs, ...required.missingInputs])],
    evidenceGaps: [...new Set([...current.evidenceGaps, ...required.evidenceGaps])],
  });
}
