# AIHR 简历链路测试地图

## 结论

AIHR 的核心验收对象是一个跨桌面端、网关、多个微服务和异步 worker 的业务事实链。ProofKit 只连接 AIHR 的公开网关契约，项目集成负责受控的测试数据和只读业务观察，ProofKit Runner 负责运行生命周期、证据、超时、取消和 verdict。

ProofKit 不复制 AIHR 业务代码，也不直接开放数据库、任意 SQL、shell 或内部服务调用。

## 已核对的真实链路

### 候选人管理手动录入（独立场景）

当前 `apps/micro-candidate-management/src/components/ManualCandidateDrawer.vue`
使用 Element Plus 上传控件，`auto-upload=false`、单文件、PDF/JPG/PNG、
20 MiB 上限。`src/api/candidate-intake.api.ts` 提交 `file`、`target_job_id`、
`name` 等 FormData 到网关的 `/api/v1/resume-collection/candidate-intakes`。

`services/resume-collection-service/internal/service/manual_candidate_intake.go`
先校验有效岗位，再保存文件、创建候选人与简历版本、绑定岗位，随后排队解析。
返回的 file/candidate/resumeVersion/job/jobCandidate 身份及成功提示不证明解析终态；
解析排队失败时，候选人和岗位关系可能已创建。人才库加入失败作为 warning 返回。
因此此场景需要单独的关系、解析及重复提交验证，不能直接复用 collection run
或在线平台采集的终态假设。

ProofKit 的 `setInputFiles` 可以直接操作这类隐藏文件控件：将脱敏样本放在
外部工作区 `.proofkit/fixtures/`，通过 `inspect_surface` 获取唯一定位线索，
补齐表单、提交、正向 UI 断言和独立业务 Oracle。手动录入专用
`aihr.manualCandidateIntake` 已实现，通过本次提交的五个身份和文件 SHA-256
核对文件、候选人、版本、岗位关系及评估 worker 终态。复制连接器时需同时复制
`.proofkit/integration.mjs` 与 `.proofkit/aihr-manual-intake.mjs`。
真实 Web/Electron 隔离样例已验证执行、缺陷注入与修复回放；真实 AIHR 页面与
worker 验收尚未完成。同摘要版本可以合法复用 ID 并改绑文件，这种当前状态变化
返回 `inconclusive`；缺失 reader 身份也不能确认缺陷。接口非原子且不能证明
历史终态，必须隔离候选人/岗位并避免并发上传。已有 capability 上传的环境变量样本路径
仍按该连接器契约使用，不与 `setInputFiles` 的工作区路径规则混用。

### 桌面端采集/上传

```text
Electron/CDP 或 micro-resume-collection
  → POST /api/v1/resume-collection/runs
  → POST /api/v1/resume-collection/files (multipart PDF)
  → PATCH /api/v1/resume-collection/runs/{run_id}
```

入口代码：

- `apps/desktop-shell/src/resume-channel-backend-bridge.ts`
- `apps/micro-resume-collection/src/resume-channel-backend-bridge.ts`
- `apps/desktop-shell/electron/platformResumeWorker.ts`
- `apps/desktop-shell/electron/liepinResumeWorker.ts`

后端事实：

- `resume_screening.collection_runs`
- `resume_screening.resume_files`
- `resume_screening.resume_file_profiles`
- `resume_screening.resume_extract_tasks`

### BOSS 在线简历异步结构化

```text
桌面端观察到在线简历
  → POST /api/v1/resume-collection/online-resume-intakes
  → online_resume_intake_tasks (pending → processing → succeeded/failed)
  → candidate-service 结构化结果
  → PDF renderer + object storage
  → resume_files + resume_file_profiles
  → candidate identify / job bind / assessment create
  → GET /api/v1/boss-conversations/{conversation_id}/workflows/{workflow_id}
  → online_resume_processing → wait_online_screening
```

关键代码：

- `services/resume-collection-service/internal/service/structured_online_resume.go`
- `services/resume-collection-service/internal/service/resume_post_processor.go`
- `services/resume-collection-service/internal/repository/online_resume_intake_repository.go`
- `services/integration-service/internal/http/handler/boss_conversation_handler.go`

### 候选人、岗位和评估

```text
resume_file_profiles.candidate_id
  → job_candidate_resumes.current_resume_file_id
  → /api/v1/jobs/{job_id}/candidates/{candidate_id}
  → /api/v1/assessments/jobs/{job_id}/candidates/{candidate_id}
  → /api/v1/workflow-executions?run_id={run_id}
```

`ResumePostProcessor` 在明确目标岗位时会绑定候选人与岗位，然后创建 `resume_screening` assessment。评估自身仍由 assessment worker 异步完成，因此上传成功、绑定成功和评估成功必须分开判定。

`assessment_worker_service.go` 先保存成功的 evaluation，再完成用量记录并标记 task 成功；用量记录失败时仍会重试。因此需要评估完成的场景必须同时观察 `assessment.status=success` 与 `task_status=success`。`running/pending/processing/retry_wait` 或缺少状态保持 `inconclusive`；evaluation `failed` 或 task `failed/dead/cancelled` 才有明确失败事实。worker 成功也不能替代独立的计费幂等检查。

岗位关系必须提供同一 `current_resume_file_id/job_id/candidate_id`；评估详情还必须提供 `assessment_id` 和对应的文件、岗位、候选人身份。缺失事实不能通过；等待 capability 与独立 Oracle 分别读取接口，按相同规则判定并保存关联事实。workflow/file 上的绿色摘要不替代 assessment detail。

上传的 `target_job_ids` 使用 JSON 正整数数组（如 `[505]`），不能使用字符串数组。连接器保留字符串形式的 int64 ID，并直接序列化已验证的十进制整数，避免 JavaScript Number 丢失精度；未指定岗位时省略该可选字段。

workflow 完成事实必须同时匹配 `run_id`、`candidate.id`、`job.id` 和 `screening_stage=workflow_completion`。连接器按响应中的 `pagination` 最多扫描 20 页，找到相关完成事实后停止；缺少相关事实或超过扫描上限均保持 `inconclusive`。该公开投影没有文件 ID、评估 ID 或幂等键，因此仅证明对应 run/候选人/岗位存在完成事实，不能据此证明精确文件、评估关联或计费幂等。精确文件关联由岗位与评估接口分别验证，计费仍需独立验证。

## ProofKit 的第一条真实 Charter

参考 Charter 为 ProofKit 仓库的 `.proofkit/charters/aihr-resume-upload.yml`；实际接入时复制到外部测试工作区的同名相对路径。它覆盖：

1. 通过网关创建普通简历 collection run。
2. 使用与桌面端一致的 multipart 合约上传脱敏 PDF。
3. 轮询文件、候选人、岗位关系、评估和 workflow usage 公开事实。
4. 独立 Oracle 再次读取这些事实，要求 `extract_status=done`、`parse_status=matched`、候选人存在、岗位与评估身份精确关联，并按 Charter 决定是否必须同时 `assessment.status=success` 与 `assessment.task_status=success`。

`.proofkit/charters/aihr-online-resume.yml` 保留为在线阶段兼容流程，覆盖 online intake、结构化处理、PDF 生成和该文件的评估完成。它还核对 workflow、conversation、job、online file 和 candidate 的关联；`retryable_error` 或非空错误码本身不会提前判失败。`terminated` 必须有权威关系 `screen_reject`，筛选拒绝不等同于技术失败。

在线证据的 `acceptanceScope=online-resume` 与 `terminal` 只表示声明阶段的验收范围和判定是否确定。`wait_online_screening` 不代表整个会话完成。附件文件已绑定或 workflow 已 `completed` 时，后续处理可能合法替换 current file；连接器记录 `attachmentResumeFileId/scopeSuperseded` 并立即返回 `inconclusive`，不据此确认旧文件缺陷。尚未实现附件全生命周期及历史在线评估验收；测试候选人/岗位应隔离，在线阶段验收期间暂停附件推进。workflow 尚未暴露附件身份时的并发替换仍需额外观察事实。

普通上传和在线简历两个参考 Charter 目前都没有真实 UI 断言，因此不能直接登记为 `core` 目录用例，也不能把连接器执行称为完整 Web/Electron 验收。

`.proofkit/charters/aihr-resume-ui-quick.yml` 是只读页面检查，要求关键控件可见且“页面配置加载失败”不可见。此前一次本地快速运行只检查控件，页面同时显示该错误却被判为 `passed`；新增负向断言后，这种运行会明确失败。该 Charter 不证明简历获取业务终态，且运行目标必须与所声明的源码工作区一致。

证据只保存：run/task/file/candidate/job/assessment 的 opaque ID、状态、计数、错误码和稳定哈希。不会保存 source_text、原始 PDF、cookie、token、手机号或完整候选人资料。

## 失败边界必须单独验收

| 边界 | 失败证据 |
| --- | --- |
| 网关鉴权/租户错误 | HTTP 状态、业务错误码、request id |
| intake 重复提交 | 同一 workspace/workflow/source hash 返回同一任务，不重复生成文件 |
| 普通上传重复提交 | 同一命名空间 `client_item_key` 的第二次上传返回 `duplicate=true`，并复用同一 `file_id` 与文件哈希 |
| worker 重试 | attempt_count、next_retry_at、终态 error_code |
| 结构化失败 | structured_status、校验错误数量、workflow last_error_code |
| PDF/对象存储失败 | workflow 失败阶段、错误码、无绿色结果 |
| 候选人识别冲突 | parse_status=identity_conflict 或明确失败事实 |
| 岗位绑定失败 | parse_status=needs_job_sync/needs_manual_match |
| assessment 失败 | assessment task_status/error_code |
| 计费重复 | workflow-executions 与 billing usage 的数量和幂等键 |
| 取消/超时 | ProofKit verdict=cancelled，adapter/worker 清理事件存在 |

## 运行前提

### 2026-10-10 本地只读验收检查

对 `D:\code\Python\AIHR-Microservices` 与外部 `aihr-local-workspace` 执行环境检查时，`http://localhost:5174/` 返回 200，但 Windows 监听进程的代码路径属于 `D:/tmp/aihr-livekit-interview-voice`，因此 `source-binding` 和整体环境状态为 `blocked`；页面可达不能代替当前 checkout 的验收。首次显式 5 秒检查在冷进程查询时仅得到 `incomplete`，15 秒检查确认了不同 checkout；环境检查默认截止时间因此调整为 10 秒，再次使用默认值约 4.2 秒得到相同的 `blocked` 结论。检查只读取本地状态，未执行 AIHR 业务写入。

首次检查时，同一外部工作区没有登记的 Charter 或 workflow inventory。聚焦 `resume` 的有界源码扫描显示 195 个路由候选、零个已映射，且 `inventory.truncated=true`；这不是全项目路由总数或业务覆盖率。真实核心测试需要先启动与所选源码一致的隔离 Web/Electron 和后端环境，核实页面控件及业务 reader，再把经过验证的 Charter 登记到外部工作区。当前不能把参考上传 Charter 的接口验证称为 Web/Electron 端到端通过。

随后已把新版只读 `aihr-resume-ui-quick` Charter 登记到外部工作区；“快速检查简历获取页面”能按自然语言选中 `quick` Web 场景，默认 `core` 请求仍因缺少真实页面断言和业务 Oracle 而保留规划缺口。为避开占用 `5174` 的另一份 checkout，从当前 AIHR 源码在 `127.0.0.1:5274` 启动临时 Vite 页面，并将 API 基址指向未监听的本机端口。环境检查确认监听页面进程属于本次源码，但没有后端健康检查，整体只为 `incomplete`。只读页面执行看到了“页面配置加载失败”和 `AuthRequiredError`；工作区显式配置该鉴权信号为环境阻断后，Mission `mission-8d197863-5fd` 返回 `blocked`、`environment` Finding、零个已确认产品问题，相关页面和事件保留在外部工作区。此前 `mission-06e1007b-c8f` 曾仅凭页面断言快照误报已确认产品问题，是历史结果；ProofKit 已改为仅确认页面预期不匹配，不自动归责产品。临时 Vite 进程已停止，没有执行简历业务写入或改动 AIHR 源码。真实 `core` 简历业务验收仍待隔离网关、登录和异步 worker。

这次只读复现使用以下启动方式；它故意不连接业务网关，不能作为业务通过的环境：

```powershell
cd D:\code\Python\AIHR-Microservices
$env:VITE_API_BASE_URL = "http://127.0.0.1:9/api/v1"
pnpm --filter @aihr/micro-resume-collection exec vite --mode devlocal --host 127.0.0.1 --port 5274 --strictPort
```

在隔离 test/local 环境设置：

```powershell
$env:AIHR_PROOFKIT_API_BASE_URL = "http://127.0.0.1:8080/api/v1"
$env:AIHR_PROOFKIT_ACCESS_TOKEN = "<test-token>"
$env:AIHR_PROOFKIT_ENTERPRISE_ID = "<test-enterprise>"
$env:AIHR_PROOFKIT_WORKSPACE_ID = "<test-workspace>"
$env:AIHR_PROOFKIT_USER_ID = "<test-user>"
$env:AIHR_PROOFKIT_CONVERSATION_ID = "<test-conversation>"
$env:AIHR_PROOFKIT_WORKFLOW_ID = "<test-workflow>"
$env:AIHR_PROOFKIT_WORKFLOW_VERSION = "<current-version>"
$env:AIHR_PROOFKIT_JOB_ID = "<test-job>"
$env:AIHR_PROOFKIT_CANDIDATE_UID = "<test-candidate-uid>"
$env:AIHR_PROOFKIT_PLATFORM_ACCOUNT_ID = "<test-platform-account>"
$env:AIHR_PROOFKIT_SOURCE_TEXT = "<脱敏测试简历正文>"
$env:AIHR_PROOFKIT_SOURCE_CHANNEL = "boss"
$env:AIHR_PROOFKIT_FIXTURE_PATH = "fixtures/proofkit-resume.pdf"  # 相对于外部测试工作区根目录
$env:AIHR_PROOFKIT_TEST_SCOPE = "proofkit:resume-upload"
$env:AIHR_PROOFKIT_CLIENT_ITEM_KEY = "proofkit:resume-upload:case-001"
$env:AIHR_PROOFKIT_NEGATIVE_CLIENT_ITEM_KEY = "proofkit:resume-upload:duplicate-001"  # 仅重复上传 Charter 需要；两次上传使用同一个键
$env:AIHR_PROOFKIT_ALLOW_REMOTE_TEST_ENDPOINT = "false"  # only set true for an explicitly isolated remote test environment
```

运行 Charter 时必须显式允许写操作；默认配置仍是 `confirm`。

先确认 AIHR gateway、resume-collection、candidate、job、integration 和 assessment worker 都连接到隔离的 local/test 环境。AIHR `devlocal` 默认请求 `http://127.0.0.1:8080/api/v1`；如果使用共享测试环境，显式设置 ProofKit API 地址，不能把测试数据发到生产环境。

源码根目录与测试工作区必须分开。当前本地只读接入使用：

```powershell
$proofkitRoot = "D:\code\proofkit-ai"
$sourceRoot = "D:\code\Python\AIHR-Microservices"
$testWorkspace = Join-Path $proofkitRoot ".proofkit\aihr-local-workspace"
Set-Location $proofkitRoot
pnpm --filter @proofkit/cli dev -- doctor --root $sourceRoot --workspace $testWorkspace
```

此前的外部工作区快照中，`doctor` 已识别 AIHR 的 Web、Electron 和后端入口，连接器已加载 9 个受控 capability 和 3 个业务 Oracle。当前参考连接器另增加了 `aihr.manualCandidateIntake`，共 4 个 Oracle；使用新版时需一起复制 `.proofkit/integration.mjs` 与 `.proofkit/aihr-manual-intake.mjs`，再重新运行 `doctor`。三个参考 Charter 尚未登记为自然语言可执行目录用例。上述静态检查不启动 AIHR、不访问业务接口，也不修改 AIHR 源码。

真实业务验收还需要独立的 local/test 网关、异步 worker、脱敏 PDF、测试租户与账号，以及真实页面断言。先在 AIHR 仓库的终端启动隔离的桌面应用，并开放仅监听本机的 CDP 端口：

```powershell
$env:AIHR_ELECTRON_DEBUG_PORT = "9222"
pnpm dev:devlocal
```

在另一个终端确认 Electron 已提供 CDP，再切换到 ProofKit 仓库：

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
cd D:\code\proofkit-ai
pnpm build
pnpm test
```

脱敏 PDF 放在 `$testWorkspace\fixtures\proofkit-resume.pdf`；连接器把 `AIHR_PROOFKIT_FIXTURE_PATH` 解析到外部测试工作区，避免在 AIHR 源码中加入测试文件。当前普通上传 Charter 只定义网关 capability 和业务 Oracle，`assertions: []`。它可以作为连接器合约参考，却不能证明页面点击或 Electron 简历抓取成功。待真实页面路径与稳定断言核实后，应在外部工作区补充对应的 UI 动作/断言、登记 `core` Charter，再通过 MCP `run_test` 或 CLI Mission 执行。

真实上传应使用隔离测试环境。外部工作区的 `policies.sideEffects` 和 Charter 的 `sideEffectPolicy` 都需设置为 `allow`。通过 capability 上传时，CLI 还需 `--allow-capability-writes`，MCP 则由服务启动者设置 `PROOFKIT_ALLOW_CAPABILITY_WRITES=1`。连接器的 preflight 会解析这些上传 capability 的幂等键并检查其属于 `AIHR_PROOFKIT_TEST_SCOPE`；请求前再次校验，缺少变量或跨 scope 的键不会写入网关。

手动录入使用页面 `setInputFiles` 与 `captureResponse`，其 API 没有 `client_item_key` 幂等契约，不能套用上述 capability 的重试保证。它需要独立的测试 scope、actor 和岗位配置，通过本次提交的五个身份核对业务结果。具体配置见 [手动录入契约](aihr-resume-integration.md#manual-candidate-intake)。只有 UI 断言和独立业务 Oracle 都有证据并通过，才可认定核心链路通过；Run 结果保存在 `$testWorkspace\.proofkit\runs\<runId>\`。

## 下一阶段

1. 把普通上传 Charter 接入真实 Electron/CDP surface，并把 UI 操作与上述业务 Oracle 绑定到同一个 Run。
2. 在真实隔离环境中验证 `collection_run → file → extract → parse → assessment`。
3. 增加重试、重复提交、计费幂等和取消恢复场景。
4. 在外部工作区登记经过验证的 Charter，让自然语言请求直接选中它，不向 AIHR 源码写入 ProofKit 文件。
5. 继续改进基于代码/路由的测试建议，保持类型化动作、capability allowlist 和副作用权限校验。
