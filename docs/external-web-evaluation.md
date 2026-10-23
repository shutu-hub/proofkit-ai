# 外部 Web 任务验收

`tests/model-web-evaluation.mjs` 是源码仓库中的验收工具，可以读取操作员编写的外部任务模块，使用现有 Local Runner 完成观察、规划、持续会话执行、独立业务检查和 Mission 报告。它不要求修改 ProofKit 的业务分支，也不把外部任务自动标为陌生项目盲测。

## 执行方式

先配置 `PROOFKIT_PLANNER_BASE_URL`、`PROOFKIT_PLANNER_MODEL`，需要鉴权时配置 `PROOFKIT_PLANNER_API_KEY`。构建后执行：

```powershell
$suitePath = 'C:\qa\reviewed-web-cases.mjs'
$suiteDigest = (Get-FileHash -LiteralPath $suitePath -Algorithm SHA256).Hash.ToLowerInvariant()
node tests/model-web-evaluation.mjs --suite $suitePath --suite-sha256 $suiteDigest --trials 3 --output-dir C:\qa\results --headful
```

`--trials` 接受 1–5，默认 3；`--headful` 让操作过程在可见浏览器中执行。没有外部模块时仍运行三个内置固定样例；没有模型配置时直接失败，不降级为模拟模型。

**外部模块是操作员信任的 Node.js 代码，具有当前进程权限。** 摘要校验确认被选中的模块版本，不是代码沙箱。不要加载模型临时生成、未经审核的模块。模块只在 `prepare` 中分配测试环境，避免导入时产生业务副作用；主文件以外的依赖、后端镜像和测试数据版本仍由测试负责人冻结。

## 模块接口

模块必须是非重定向的普通 `.mjs` 文件，最多 128 KiB，导出：

- `cases`：1–12 个 `{ id, intent, expect }` 对象。`id` 为唯一的小写字母/数字/连字符标识；`intent` 是本次测试意图；`expect` 是已经审核的 1–8 个最终可见文本。
- `prepare({ caseId, root, trial })`：为本次试验分配独立应用状态，返回下面的对象。每次试验单独启动子进程，并拥有不同的 `root`。

返回值结构为：

```typescript
type PreparedTrial = {
  projectRoot: string;
  url: string;
  config?: ProofkitConfig;
  verify(): Promise<{
    passed: boolean | null;
    facts: Record<string, string | number | boolean>;
  }>;
  dispose(): Promise<void>;
};
```

`projectRoot` 指向实际被测项目，`url` 是批准的 HTTP/HTTPS 入口；遵循 Local Runner 原有的目标 origin 限制。`config` 可提供浏览器路径、工作区截图遮罩、运行时策略等。规划器和项目启动命令由验收流程控制，模块中的 `planning`、`project` 和写入策略不覆盖该流程。应用启动、测试数据准备和重置由 `prepare` 完成。

`verify` 必须只读、可重复，检查独立的后端/API/文件等事实，并限定到本次试验的租户、记录或唯一标识。它不接收 UI、模型答案或 Runner verdict。基线、Runner 业务 Oracle 和执行后评分都会调用它；不得根据调用次数返回预制答案。

- `passed: false` 表示有独立事实证明目标未满足。
- `passed: true` 表示当前独立事实满足预期。
- `passed: null` 表示读数、关联身份或终态不足以判断，不能当作业务失败。

开始规划前必须读到 `false`。如果初始状态已经是 `true` 或不可判断，流程停止，防止旧记录被计成本次完成。随后把 Oracle 名称和 `expect` 交给规划器；生成计划必须自行保留它们，不在事后补充模型遗漏的检查。需要额外页面观察时保留规划失败，不猜测后续控件，也不自动执行探索提案。

`facts` 最多 16 项，字段名最多 64 个字母/数字/下划线/连字符且以字母开头，每个字符串最多 256 字符，只保留审核过的标量事实。使用环境变量读取凭据，不要在事实或模块中嵌入密码、完整响应、个人资料。常规证据脱敏会应用于保存的计划和独立读数，但不能替代测试负责人的字段审核。

`dispose` 负责释放本次分配的应用和数据；无论试验成功失败都会尝试清理。清理失败不能计为完成。子进程硬超时保留已知证据目录，但不能保证任意外部服务完成清理，需要按保留目录及测试租户清单检查。

## 会话与报告

流程使用同一保留浏览器会话进行观察、规划和正式 Mission 执行。设置 `config.sessions.recordVideo: true` 可以录制该会话；`run.recordVideo` 不适用于此路径，会被显式拒绝。会话关闭后重新生成 Mission 报告，纳入经过封存的录像和网络元数据。录像像素尚未脱敏，是否录制由任务负责人决定。

每次试验保留：

- `independent-baseline.json`：执行前独立状态。
- `planned-charter.json`：实际模型计划；不会把它标为已经人工批准的计划。
- `independent-outcome.json`：执行后独立读数。
- `run-manifest-pin.json`：主 Run 证据清单的原始摘要。
- 独立测试工作区：原始规划观察、Run、会话采集及 Mission HTML/JSON 报告。
- 子进程回执：阶段、verdict、报告路径、耗时及完成/失败状态。

顶层 `evaluation-*.json` 在开始执行前创建，此后每次试验更新，记录模块摘要、ProofKit Git 状态及全部尝试。`plannedAttempts` 是计划总数，`pendingAttempts` 是尚未完成的试验数；`evaluationStatus: running` 不能被当作最终成绩。缺失回执不会算成功；运行只完成一部分时返回非零退出码。

`completed` 要求 Mission 通过、独立读数为 `true`、主 Run 清单完整、所有请求的会话留痕已经完整封存并通过检查，且清理成功。业务结果通过但请求的录像或网络留痕不完整，仍不能算作完整完成。`falsePasses` 仅统计 Mission 声称通过但独立读数明确为 `false` 的情况；其比率分母仅包含有明确独立读数的通过声明。`null` 单列为 `unavailableBusiness`，不会冒充“零误报”的确定证据。这里的完成率衡量正向任务达成；带缺陷版本的检出率、正确失败与修复回归需要独立的已知真值任务集。

外部模型 trial 的收据还必须包含 `planningSummary`：`source` 必须为 `model`，记录动作/断言/Oracle/负向场景数量、规划置信度、空的 `evidenceGaps` 和 `missingInputs`，以及已保存 `planned-charter.json` 的 SHA-256。缺少或不一致的规划收据会使 trial 无效，不会进入完成率；这避免把宿主补写 Charter、未完成规划或只跑通执行器误计为模型自主规划成功。

## 验收边界

`node tests/external-web-evaluation-smoke.mjs` 会临时创建仓库外的应用和模块，用随机控件标识检验通用观察路径，并验证成功、独立读数缺失、初始状态已满足三种情形。加 `--keep-artifacts` 可保留样例报告。这个测试使用模拟提供者，仅证明外部任务接口和留痕流程可运行。

顶层评估报告写入机器可读的 `evaluationScope`：无 suite 的内置样例是 `fixture`，带摘要固定 suite 默认是 `reviewed-external`。真正的 `unseen-holdout` suite 必须在模块中显式声明 `evaluationScope='unseen-holdout'` 和 `holdoutAttestation=true`，否则 loader 拒绝；attestation 仍是测试负责人声明，不替代对应用、提示和数据冻结的外部审计。

Smoke 和真实模型 trial 都会在每个 case 的隔离 workspace 中保存 `planned-charter.json` 与 `planning-receipt.json`。评估器重新读取每个 case 的 Charter 文件计算 SHA-256，并要求收据的 `planningSummary.source` 为 `model`、缺口为空；因此 host-authored 或自行修补的 Charter 不会被统计为模型完成。

真正的陌生项目验收仍需要：实际模型、未用于修改提示和实现的保留应用、冻结的数据/预期、重复试验、失败原始记录，以及同条件浏览器基线。外部任务路径可执行不等于这些门槛已经通过。
