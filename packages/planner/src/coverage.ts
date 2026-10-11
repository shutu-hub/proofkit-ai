import { normalizePlanningQuality, PlanningCoverageSchema, PlanningQualitySchema, TestCoverageSchema, type PlanningCoverage, type PlanningQuality, type ProjectMap, type TestCoverage } from "@proofkit/contracts";

const WHOLE_PROJECT_SCOPE = /整个项目|全项目|整个产品|所有功能|全部功能|所有业务流程|全部业务流程|\b(?:whole|entire)\s+(?:project|application|product)\b|\ball\s+(?:features|workflows)\b/g;
const SCOPE_CLAUSE = /[，,。.!?;；\n]/;

/** Only a positive whole-project phrase can expand or conflict with the requested scope. */
function requestsWholeProject(intent: string): boolean {
  const normalized = intent.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(WHOLE_PROJECT_SCOPE)) {
    const before = normalized.slice(0, match.index);
    const clause = before.split(SCOPE_CLAUSE).at(-1)?.trimEnd() ?? "";
    const after = normalized.slice(match.index + match[0].length);
    if (/(?:不(?:需要|要|用|是|再)?|无需|无须|并非)(?:\s*(?:测试|测|检查|验证|验收|覆盖|回归))?\s*$/.test(clause)) continue;
    if (/(?:\bnot|\bdon't|\bdo\s+not|\bexclude)\s+(?:(?:to\s+)?(?:test|check|verify|cover)\s+)?(?:the)?\s*$/.test(clause)) continue;
    if (/\b(?:in|within)\s+(?:the)?\s*$/.test(clause)) continue;
    if (/^(?:的|中|里|内)(?:的)?(?!所有|全部|全体)[^，,。.!?;；\n]{1,24}?(?:模块|功能|页面|链路|流程|接口|服务)/.test(after)) continue;
    return true;
  }
  return false;
}

/** Resolve from the host request, never from provider-authored planning metadata. */
export function assessPlanningCoverage(intent: string, projectMap?: ProjectMap, requested?: TestCoverage): PlanningCoverage {
  const explicit = requested === undefined ? undefined : TestCoverageSchema.parse(requested);
  const projectRequest = requestsWholeProject(intent);
  if (projectRequest && explicit === "declared") {
    throw new Error("Test coverage conflict: intent requests whole-project acceptance but supplied coverage is declared; align the request and coverage selection");
  }
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
    missingInputs: coverage.gaps.includes("project-workflow-coverage")
      ? ["全项目业务流程清单与可度量的执行覆盖证明"] : [],
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
