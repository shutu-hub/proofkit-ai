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
    scope: ["全项目健康检查", "核心业务链路", "按声明平台执行回归"],
    requiredSignals: ["业务 Oracle", "终态证据", "关键负向路径", "可回放证据"],
    negativeCases: ["权限边界", "无效输入", "重试与恢复", "重复提交与幂等"],
    surfaces: ["web", "electron"],
    evidencePolicy: { requireAssertions: true, requireBusinessOracle: true, requireArtifacts: true, minimumEvidence: 3 },
  },
};

const INTENT_LEVEL_CANDIDATES: Array<{ level: TestLevel; pattern: RegExp; reason: string }> = [
  { level: "release", pattern: /上线|发布|发版|全量|回归测试|\b(?:release|regression|production|launch)\b/iu, reason: "意图包含上线或发布门禁关键词" },
  { level: "core", pattern: /核心|关键链路|端到端|完整链路|\b(?:critical|core|e2e|end[- ]to[- ]end)\b/iu, reason: "意图包含核心模块或链路关键词" },
  { level: "quick", pattern: /快速|冒烟|\b(?:sanity|smoke|quick)\b/iu, reason: "意图包含快速反馈关键词" },
];

function excludedIntensity(prefix: string, suffix: string): boolean {
  return /\b(?:no|not|never|without|excluding|except(?:\s+for)?|rather\s+than|exclude|skip|omit|do\s+not|don't|don’t)\s+(?:(?:run|perform|execute|include|require|do|a|an|the|any|full|complete|entire|whole|project|tests?|testing|checks?|gates?|release|regression|production|launch|quick|smoke|sanity|core|critical|and|or)(?:\s*[,/]\s*|\s+))*$/iu.test(prefix)
    || /(?:不(?:做|需要|要求|进行|执行|包含|涉及)?|不要|不是|无需|不用|排除|跳过)(?:进行|执行|做|跑|完整|全量|任何|的|本次)*$/u.test(prefix)
    || /^\s*(?:(?:tests?|testing|checks?|gates?|regression)\s+)*(?:(?:is|are)\s+)?(?:excluded|out\s+of\s+scope|not\s+(?:required|requested|included))\b/iu.test(suffix)
    || /^(?:测试|检查|门禁|级别)?(?:不在(?:本次)?范围|不需要|无需|排除)/u.test(suffix)
    || /\brather\s+than\s+(?:(?:a|the|full|complete)\s+)*$/iu.test(prefix);
}

function scopedRegression(cue: string, prefix: string): boolean {
  if (!/^(?:regression|回归测试)$/iu.test(cue)) return false;
  if (/\b(?:full|complete|entire|whole)\s+(?:(?:targeted|focused|scoped|local|unit|component|core|critical|e2e)\s+){0,2}$/iu.test(prefix)
    || /(?:全量|完整)(?:核心|模块|链路|关键){0,4}$/u.test(prefix)) return false;
  return /\b(?:targeted|focused|scoped|local|unit|component|core|critical|e2e|single[- ](?:module|page|component|field))\s+(?:(?!(?:full|complete|entire|whole|release)\b)[\p{L}\p{N}_-]+\s+){0,3}$/iu.test(prefix)
    || /(?:定向|专项|局部|单个|单一|核心|关键链路|端到端)(?:(?!全量|完整|上线|发布|发版)[\p{Script=Han}]){0,10}$/u.test(prefix);
}

function intentLevelCandidates(intent: string): typeof INTENT_LEVEL_CANDIDATES {
  const clauses = intent.replace(/https?:\/\/[^\s<>]+/giu, " ")
    .replace(/\b(?:do\s+not|don't|don’t|never|not)\s+(?:skip|omit|exclude|avoid)\b/giu, " include ")
    .replace(/(?:不(?:要|应|能|会)?(?:跳过|省略|排除)|并非不(?:做|需要)|不是不(?:做|需要))/gu, "包含")
    .split(/[.!?;。！？；\n]+|\b(?:but|however|instead)\b|\band\s+(?=(?:run|perform|execute|do|check|verify|test)\b)|但是|而是|但|并(?=执行|进行|检查|测试)/iu);
  return INTENT_LEVEL_CANDIDATES.filter((candidate) => clauses.some((clause) =>
    [...clause.matchAll(new RegExp(candidate.pattern.source, "giu"))].some((match) => {
      const prefix = clause.slice(0, match.index);
      const suffix = clause.slice(match.index! + match[0].length);
      return !excludedIntensity(prefix, suffix) && !scopedRegression(match[0], prefix);
    })));
}

/** Return every intensity indicated by the request; multiple levels are ambiguous. */
export function intentTestLevelHints(intent: string): TestLevel[] {
  return intentLevelCandidates(intent).map((candidate) => candidate.level);
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

  const match = intentLevelCandidates(intent)[0];
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
