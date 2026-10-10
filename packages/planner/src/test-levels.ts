import {
  TestLevelSchema,
  TestLevelSelectionSchema,
  type TestLevel,
  type TestLevelSelection,
} from "@proofkit/contracts";

export type TestLevelProfile = {
  level: TestLevel;
  label: string;
  scope: string[];
  requiredSignals: string[];
  negativeCases: string[];
  surfaces: Array<"web" | "electron">;
  evidencePolicy: {
    requireAssertions: boolean;
    requireBusinessOracle: boolean;
    requireArtifacts: boolean;
    minimumEvidence: number;
  };
};

const PROFILES: Record<TestLevel, TestLevelProfile> = {
  quick: {
    level: "quick",
    label: "快速测试",
    scope: ["项目健康检查", "目标功能最短主路径"],
    requiredSignals: ["至少一个可观察断言"],
    negativeCases: [],
    surfaces: ["web", "electron"],
    evidencePolicy: { requireAssertions: true, requireBusinessOracle: false, requireArtifacts: true, minimumEvidence: 1 },
  },
  core: {
    level: "core",
    label: "核心模块测试",
    scope: ["目标模块关键路径", "异步任务终态", "关键失败与重试路径"],
    requiredSignals: ["可观察断言", "独立业务结果或状态证据"],
    negativeCases: ["关键权限或输入边界"],
    surfaces: ["web", "electron"],
    evidencePolicy: { requireAssertions: true, requireBusinessOracle: true, requireArtifacts: true, minimumEvidence: 2 },
  },
  release: {
    level: "release",
    label: "完整上线测试",
    scope: ["全项目健康检查", "核心业务链路", "跨 Web/Electron 表面回归"],
    requiredSignals: ["业务 Oracle", "终态证据", "关键负向路径", "可回放证据"],
    negativeCases: ["权限边界", "无效输入", "重试与恢复", "重复提交与幂等"],
    surfaces: ["web", "electron"],
    evidencePolicy: { requireAssertions: true, requireBusinessOracle: true, requireArtifacts: true, minimumEvidence: 3 },
  },
};

const INTENT_LEVEL_CANDIDATES: Array<{ level: TestLevel; pattern: RegExp; reason: string }> = [
  { level: "release", pattern: /(上线|发布|发版|全量|回归测试|release|regression|production|launch)/i, reason: "意图包含上线或发布门禁关键词" },
  { level: "core", pattern: /(核心|关键链路|端到端|完整链路|critical|core|e2e|end.to.end)/i, reason: "意图包含核心模块或链路关键词" },
  { level: "quick", pattern: /(快速|冒烟|sanity|smoke|quick)/i, reason: "意图包含快速反馈关键词" },
];

/** Return every intensity indicated by the request; multiple levels are ambiguous. */
export function intentTestLevelHints(intent: string): TestLevel[] {
  const normalized = intent.toLocaleLowerCase();
  return INTENT_LEVEL_CANDIDATES.filter((candidate) => candidate.pattern.test(normalized)).map((candidate) => candidate.level);
}

export function getTestLevelProfile(level: TestLevel): TestLevelProfile {
  return PROFILES[TestLevelSchema.parse(level)];
}

/** Resolve a human request once and persist the decision with the mission. */
export function resolveTestLevel(intent: string, requested?: TestLevel): TestLevelSelection {
  if (requested) {
    const level = TestLevelSchema.parse(requested);
    return TestLevelSelectionSchema.parse({
      requested: level,
      resolved: level,
      source: "explicit",
      reason: `用户明确指定${PROFILES[level].label}`,
      confidence: 1,
    });
  }

  const normalized = intent.toLocaleLowerCase();
  const match = INTENT_LEVEL_CANDIDATES.find((candidate) => candidate.pattern.test(normalized));
  if (match) {
    return TestLevelSelectionSchema.parse({
      resolved: match.level,
      source: "inferred",
      reason: match.reason,
      confidence: match.level === "quick" ? 0.9 : 0.95,
    });
  }
  return TestLevelSelectionSchema.parse({
    resolved: "core",
    source: "default",
    reason: "未指定测试力度，默认采用核心模块测试以平衡反馈速度和覆盖范围",
    confidence: 0.75,
  });
}
