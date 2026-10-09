import { DeterministicPlannerProvider, OpenAICompatiblePlannerProvider } from "../packages/planner/dist/index.js";
import { evaluatePlannerBenchmark } from "../packages/planner/dist/benchmark.js";

const projectMap = {
  root: ".",
  packageManager: "pnpm",
  scripts: { dev: "pnpm dev", build: "pnpm build" },
  workspaces: [],
  packages: [],
  detected: { web: true, electron: true, backend: true },
  generatedAt: "1970-01-01T00:00:00.000Z",
};

const cases = [
  {
    caseId: "quick-login-smoke",
    intent: "快速冒烟检查登录页",
    projectMap,
    constraints: {
      url: "http://127.0.0.1:4173/login",
      expect: ["登录"],
    },
    expect: {
      level: "quick",
      requiredActionKinds: ["goto", "observe"],
      forbiddenActionKinds: ["capability"],
      requireAssertions: true,
      requireNegativeCases: false,
    },
  },
  {
    caseId: "core-resume-acquisition",
    intent: "测试简历获取核心链路",
    projectMap,
    constraints: {
      url: "http://127.0.0.1:4173/resumes",
      expect: ["解析完成"],
      oracleNames: ["resume-status"],
    },
    expect: {
      level: "core",
      requiredActionKinds: ["goto", "observe"],
      forbiddenActionKinds: ["capability"],
      requiredOracleNames: ["resume-status"],
      requireAssertions: true,
      requireNegativeCases: false,
    },
  },
  {
    caseId: "release-cross-surface-skeleton",
    intent: "上线前完整回归 Web 和 Electron",
    projectMap,
    constraints: {
      url: "http://127.0.0.1:4173/resumes",
      expect: ["解析完成"],
      oracleNames: ["resume-status"],
    },
    expect: {
      level: "release",
      requiredActionKinds: ["goto", "observe"],
      forbiddenActionKinds: ["capability"],
      requiredOracleNames: ["resume-status"],
      requireAssertions: true,
      requireNegativeCases: false,
    },
  },
];

const provider = createProvider();
const report = await evaluatePlannerBenchmark(provider, cases);
const output = {
  planner: report.planner,
  total: report.total,
  passed: report.passed,
  passRate: report.passRate,
  averageScore: report.averageScore,
  failureCounts: report.failureCounts,
  cases: report.results.map(({ caseId, valid, score, checks, failures }) => ({ caseId, valid, score, checks, failures })),
};
console.log(JSON.stringify(output, null, 2));
if (report.passed !== report.total) process.exitCode = 1;

function createProvider() {
  const providerName = process.env.PROOFKIT_PLANNER_PROVIDER ?? (process.env.PROOFKIT_PLANNER_BASE_URL ? "openai-compatible" : "deterministic");
  if (providerName === "deterministic") return new DeterministicPlannerProvider();
  if (providerName !== "openai-compatible") throw new Error(`Unsupported PROOFKIT_PLANNER_PROVIDER: ${providerName}`);
  const baseUrl = process.env.PROOFKIT_PLANNER_BASE_URL;
  const model = process.env.PROOFKIT_PLANNER_MODEL;
  if (!baseUrl || !model) throw new Error("OpenAI-compatible benchmark requires PROOFKIT_PLANNER_BASE_URL and PROOFKIT_PLANNER_MODEL");
  return new OpenAICompatiblePlannerProvider({
    baseUrl,
    model,
    apiKey: process.env.PROOFKIT_PLANNER_API_KEY,
    timeoutMs: Number(process.env.PROOFKIT_PLANNER_TIMEOUT_MS ?? 30_000),
  });
}
