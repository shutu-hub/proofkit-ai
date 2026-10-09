# AIHR 简历链路测试地图

## 结论

AIHR 的核心验收对象是一个跨桌面端、网关、多个微服务和异步 worker 的业务事实链。ProofKit 只连接 AIHR 的公开网关契约，项目集成负责受控的测试数据和只读业务观察，ProofKit Runner 负责运行生命周期、证据、超时、取消和 verdict。

ProofKit 不复制 AIHR 业务代码，也不直接开放数据库、任意 SQL、shell 或内部服务调用。

## 已核对的真实链路

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

上传的 `target_job_ids` 使用 JSON 正整数数组（如 `[505]`），不能使用字符串数组。连接器保留字符串形式的 int64 ID，并直接序列化已验证的十进制整数，避免 JavaScript Number 丢失精度；未指定岗位时省略该可选字段。

workflow 完成事实必须同时匹配 `run_id`、`candidate.id`、`job.id` 和 `screening_stage=workflow_completion`。连接器按响应中的 `pagination` 最多扫描 20 页，找到相关完成事实后停止；缺少相关事实或超过扫描上限均保持 `inconclusive`。该公开投影没有文件 ID、评估 ID 或幂等键，因此仅证明对应 run/候选人/岗位存在完成事实，不能据此证明精确文件、评估关联或计费幂等。精确文件关联由岗位与评估接口分别验证，计费仍需独立验证。

## ProofKit 的第一条真实 Charter

参考 Charter 为 ProofKit 仓库的 `.proofkit/charters/aihr-resume-upload.yml`；实际接入时复制到外部测试工作区的同名相对路径。它覆盖：

1. 通过网关创建普通简历 collection run。
2. 使用与桌面端一致的 multipart 合约上传脱敏 PDF。
3. 轮询文件、候选人、岗位关系、评估和 workflow usage 公开事实。
4. 独立 Oracle 再次读取这些事实，要求 `extract_status=done`、`parse_status=matched`、候选人存在、岗位关系指向当前文件，并按 Charter 决定是否必须 `assessment.task_status=success`。

`.proofkit/charters/aihr-online-resume.yml` 保留为在线简历兼容流程，覆盖 online intake、结构化处理、PDF 生成和后续业务状态。普通上传和在线简历两个参考 Charter 目前都没有真实 UI 断言，因此不能直接登记为 `core` 目录用例，也不能把连接器执行称为完整 Web/Electron 验收。

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

`doctor` 已识别 AIHR 的 Web、Electron 和后端入口；外部工作区的连接器已成功加载，提供 9 个受控 capability 和 3 个业务 Oracle。三个参考 Charter 也已复制到外部工作区，但尚未登记为自然语言可执行目录用例。以上操作不启动 AIHR、不访问业务接口，也不修改 AIHR 源码。

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

任何真实上传都会写入隔离测试环境。执行前需要把外部工作区的 `policies.sideEffects` 设置为 `allow`，Charter 继续声明 `sideEffectPolicy: allow`，并在 CLI 运行时显式传入 `--allow-capability-writes`；MCP 则由服务启动者设置 `PROOFKIT_ALLOW_CAPABILITY_WRITES=1`。连接器的 preflight 会解析当前 Charter 每个上传动作的实际幂等键并检查其属于 `AIHR_PROOFKIT_TEST_SCOPE`；上传 capability 在请求前再次校验，缺少变量或跨 scope 的键不会写入网关。只有 UI 断言和独立业务 Oracle 都有证据并通过，才可认定核心链路通过；Run 结果保存在 `$testWorkspace\.proofkit\runs\<runId>\`。

## 下一阶段

1. 把普通上传 Charter 接入真实 Electron/CDP surface，并把 UI 操作与上述业务 Oracle 绑定到同一个 Run。
2. 在真实隔离环境中验证 `collection_run → file → extract → parse → assessment`。
3. 增加重试、重复提交、计费幂等和取消恢复场景。
4. 在外部工作区登记经过验证的 Charter，让自然语言请求直接选中它，不向 AIHR 源码写入 ProofKit 文件。
5. 继续改进基于代码/路由的测试建议，但所有写操作仍由 allowlist capability 承载。
