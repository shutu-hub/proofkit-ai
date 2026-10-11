# AIHR 简历链路测试地图

## 结论

AIHR 的核心验收对象是一个跨桌面端、网关、多个微服务和异步 worker 的业务事实链。ProofKit 只连接 AIHR 的公开网关契约，项目集成负责受控的测试数据和只读业务观察，ProofKit Runner 负责运行生命周期、证据、超时、取消和 verdict。

ProofKit 不复制 AIHR 业务代码，也不直接开放数据库、任意 SQL、shell 或内部服务调用。

## 2026-10-11 本地只读接入检查

ProofKit 使用外部测试工作区绑定 `AIHR-Microservices` 源码，检查 Web 5173 与网关 `/healthz`。两个 HTTP 端点当时返回 200，但 Web 端口的进程属于另一份 `aihr-livekit-interview-voice` 检出；`inspect_test_environment` 因 `different-project` 返回 `blocked`、`testVerdict: not-asserted`。本次没有连接页面、点击按钮或执行简历业务。端口可达不能替代当前源码的运行证明。

对当前源码执行 `inspect_test_scope` 的 `resume` 字面聚焦扫描，共检查 2110 个文件，保留 40 个匹配路由候选；`truncationReasons: [route-hint-cap]`，且外部工作区没有已审阅的业务流程清单或目录用例。这些数量仅是有界静态候选。下一次真实验收需要同一检出的隔离 Web/Electron 进程、测试租户及简历样本、连接器凭据与清理安排，之后才能执行页面动作和独立业务 Oracle。

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
`.proofkit/integration.mjs`、`.proofkit/aihr-manual-intake.mjs` 与 `.proofkit/aihr-desktop-acquisition.mjs`。
真实 Web/Electron 隔离样例已验证执行、缺陷注入与修复回放；真实 AIHR 页面与
worker 验收尚未完成。同摘要版本可以合法复用 ID 并改绑文件，这种当前状态变化
返回 `inconclusive`；缺失 reader 身份也不能确认缺陷。接口非原子且不能证明
历史终态，必须隔离候选人/岗位并避免并发上传。已有 capability 上传的环境变量样本路径
仍按该连接器契约使用，不与 `setInputFiles` 的工作区路径规则混用。

### 桌面端采集/上传

真实的“立即运行”入口不是普通上传参考 Charter 所执行的网关调用。源码链路为：

```text
apps/micro-resume-collection/src/App.vue 选择 BOSS 页签
  → BossResumeCollection.vue 的“立即运行”按钮
  → buildUploadConfig 检查登录令牌和工作空间
  → Pinia store.runNow
  → preload.cts 的 resume-channel:boss:runNow IPC
  → zhipinStandaloneManager.runNow
  → 可选的运行风险确认 / startRun / 子进程 worker
  → ShellHome 注册的 backend bridge 在 shell renderer 调用网关
```

按钮点击和 IPC 返回只证明启动请求已发出。`runNow` 可能因风险确认、更新中、
已有任务、手动浏览器接管、时间策略、账号状态、缺失鉴权或运行环境而没有启动 worker；
页面的“任务进度”、上传计数和 `completed` 文案也不能单独证明候选人、岗位、评估终态。
主进程创建 `clientRunId`，但 `getState()` 及公开的 collection-run 列表摘要均不返回它；
公开列表只返回按企业/工作空间限定的 `run_id`、来源、状态、时间与计数。

ProofKit 当前 `captureResponse` 只接纳所连接页面主 frame、动作时间窗内的唯一请求。
对“立即运行”的异步 worker 链路，可显式配置 `requestStartTimeoutMs`，在点击完成后
有界等待首个匹配请求，再用 `requestWindowMs` 检查首个请求后的重复请求；整个动作仍受
`timeoutMs` 限制。证据记录请求开始时间。时间关联不等于业务因果证明，观察窗外的
重复请求也不能据此排除，仍需独立业务读取和隔离测试账号。
参考 Charter 另声明一次可选 `clickIfVisible`：若风险确认按钮在有界时间内唯一可见，
就在同一请求监听期间点击，否则跳过，并把分支写入响应证据。真实按钮定位和弹窗时序
仍要通过隔离 CDP 核验；弹窗迟到、多个匹配按钮或没有新请求都不能判通过。
AIHR 网关请求由 shell renderer 的 backend bridge 发起。当前源码中 `ShellHome.vue`
初始化该 bridge，Garfish 将 `micro-resume-collection` 挂到同一 shell 页面内的
`#micro-app-stage`，且配置 `sandbox: false`；这提示按钮和网关请求可能同属一个
Playwright Page 的主 frame，但不能证明实际 CDP 目标选择或请求事件可见。能否观察到
`POST /resume-collection/runs`，以及它是否发生在合理的动作窗口内，仍须先用隔离 CDP
运行核实。未核实前不扩大 `captureResponse` 到其他页面，避免把无关请求绑定到点击。
`pnpm test:smoke:electron-ipc` 进一步用真实 Electron/CDP 和隔离 HTTP 服务复现
UI → preload IPC → 主进程通知 → shell renderer `fetch`：页面网络事件确实包含
该 POST，`captureResponse` 获取本次 ID，独立 reader 核对后 Run 通过。对照组改由
主进程 `fetch`，服务端仍创建对象，但页面没有 POST 事件，Run 为 `inconclusive`。
这验证 ProofKit 对两种请求归属的边界，尚未验证 AIHR 实际运行的 CDP 页签、
风险确认时序或真实网关请求。
不能从源码直接认定该捕获可用，也不能把连接器自己创建的 run
冒充“立即运行”产生的 run。若使用公开列表的前后差集关联本次 run，测试工作空间须独占、
自动调度须停止，并要求仅出现一个符合来源与时间的新增 run；零个或多个均为
`inconclusive`。即使唯一，仍需该 run 下新文件与独立业务 reader 的一致身份，
并保留前后读取证据；列表差集只是受隔离约束的关联线索，不是单独的因果证明。

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

2026-10-10 再次执行只读 `proofkit environment`：外部工作区仍指向已停止的 `127.0.0.1:5274`，页面端点不可达，状态为 `blocked`、产品结论为 `not-asserted`，检查快照保存在外部工作区。本机 `8080/8081/8082` 的网关与服务进程路径属于另一份 `D:/tmp/aihr-livekit-interview-voice` checkout，不能据此验收当前源码。此检查未执行简历提交或业务写入。

这次只读复现使用以下启动方式；它故意不连接业务网关，不能作为业务通过的环境：

```powershell
cd D:\code\Python\AIHR-Microservices
$env:VITE_API_BASE_URL = "http://127.0.0.1:9/api/v1"
pnpm --filter @aihr/micro-resume-collection exec vite --mode devlocal --host 127.0.0.1 --port 5274 --strictPort
```

### 2026-10-11 源码与部署归属复核

再次运行 `proofkit environment`，外部工作区仍指向已停止的
`http://127.0.0.1:5274/`，结果为 `blocked`、`testVerdict: not-asserted`；
证据文件为 `.proofkit/aihr-local-workspace/.proofkit/inspections/environment-20261010175406-eca7a02e.json`
（UTC 时间）。此检查未启动应用、浏览器或业务写入。

只读查询显示 `aihr-test` namespace 的 gateway、resume-collection、candidate、job、
assessment-service 和 assessment-worker Deployment 均有就绪副本，但镜像标签并不等于
当前本地 checkout `dc781c3763933d3062d4b3bd33491e38c2a82a44`：例如 gateway 为
`test-886a6bba634d`、resume-collection 为 `test-b299ae964fdc`、assessment-worker 为
`test-7772b1566cab`。本地 checkout 另有其他任务的未提交修改。此前用空闲端口 28080
临时转发 test gateway，`/healthz` 与 `/api/v1/gateway/status` 返回 200，转发随后停止；
这仅证明当时网关可达。`/api/v1/gateway/status` 当前源码返回 service、role、status、
routes 和 upstreams 数量，不含提交 SHA 或镜像 digest，不能用它证明部署版本。
此前只读排查发现本机 18080 被另一份 checkout 的进程占用，不可把该端口的响应当作 test gateway 证据。
上述部署观察均为环境事实，不是当前源码的产品验收。

### 2026-10-11 当前检出只读 Web 验证

在当前 `dc781c3763933d3062d4b3bd33491e38c2a82a44` 检出启动独立的
`micro-resume-collection` Vite 服务，绑定 `127.0.0.1:5274`，将
`VITE_API_BASE_URL` 指向不可用的本机 `127.0.0.1:9`，避免访问另一份检出或真实业务网关。
`proofkit environment` 观察到页面 HTTP 200，监听进程路径属于当前检出；由于未配置
后端健康端点，整体状态仍是 `incomplete`、`testVerdict: not-asserted`。

`proofkit inspect --ready-text 'BOSS直聘 简历获取'` 保存了真实 Chrome 页面快照：标题、
“立即运行”和“任务进度”可见，同时页面显示“页面配置加载失败”，控制台有
`AuthRequiredError`。已登记的只读 Charter `aihr-resume-ui-quick` 经完整 Mission
`mission-968b871a-58e` 执行，Run `20261010221235-407194e3` 的 5 个页面断言中
4 个通过，错误文案的不可见断言失败。最终 `testVerdict: blocked`，首个失败归于
测试环境，确认的产品缺陷数为 0；24 条 Mission 证据引用完整。报告保存在外部工作区
`.proofkit/aihr-local-workspace/.proofkit/missions/mission-968b871a-58e/report.html`。
这次运行未点击“立即运行”或写入业务数据；临时 Vite 进程已停止，AIHR 工作树未改变。

这次首次页面侦察把已观察到的文字标为 `readiness: unverified`，原因是之后的环境阻断
覆盖了准备状态投影。修正后对同一当前检出重新执行只读页面侦察，检查
`20261010221919-fb9bf793` 返回 `readiness: observed`、整体 `status: blocked`、
`testVerdict: not-asserted`，仍有配置失败文案和环境信号。历史 Run 证据未改写。

这个结果验证了当前检出的页面观察、源码进程关联、负向 UI 断言与环境阻断报告链路，
不证明已登录的桌面端、网关、异步 worker 或简历业务终态。下一次 `core` 验收仍需
同一源码对应的隔离 Web/Electron 目标、真实测试身份、脱敏简历、独立业务 Oracle
及清理安排；当前工作树有其他任务的未提交修改，`sourceStability` 仍为 `unverified`。

### 2026-10-11 测试范围与接入复核

只读 `scope` 记录当前 Git HEAD 为 `dc781c3763933d3062d4b3bd33491e38c2a82a44`，
工作树指纹完整但包含其他任务的修改。配置的 `127.0.0.1:5274` 页面未启动；
`environment-20261011025153-3654027c` 返回 `blocked`、`testVerdict: not-asserted`。
当前 5173/5174 与 8080–8082 的监听进程均属于另一份
`D:/tmp/aihr-livekit-interview-voice` 检出，不能替代当前检出的业务环境。

外部测试工作区的 AIHR 连接器已同步到仓库参考版，`doctor` 通过，静态范围现可看到
9 个受控 capability 和 6 个业务 Oracle。已登记的仍只有一个 Web `quick` 页面用例；
`core` 目录用例和工作流清单缺失，因此没有执行简历业务写入或产品通过判断。
ProofKit 的 Gin 扫描器补上同文件辅助函数调用展开后，对此检出扫描 2110 个文件，
保留 244 条原始路由线索、61 个入口；`scope` 去重后呈现 239 个路由候选，
路由诊断为 0，且未触及扫描上限。范围快照保存在外部工作区
`.proofkit/aihr-local-workspace/.proofkit/readiness/2026-10-11-aihr-scope.json`
（SHA-256 `14129568ea4463a7bb3e51c47f2945c00a39429a086a5c24158c697ae14cb942`）。
这提升了静态候选的完整度；244 条线索既不是业务流程总数，也不是已测覆盖率。

## 隔离业务验收的接入配置

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

此前的外部工作区快照中，`doctor` 已识别 AIHR 的 Web、Electron 和后端入口。当前参考连接器有 9 个受控 capability 和 6 个业务 Oracle，其中包括手动录入和桌面端立即运行验收；使用新版时需一起复制三个连接器文件，再重新运行 `doctor`。桌面端参考 Charter 尚未经过真实页面验证，不能登记为自然语言目录用例。上述静态检查不启动 AIHR、不访问业务接口，也不修改 AIHR 源码。

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

对于 UI 点击、填表、按键、选择文件或响应捕获，preflight 也会在连接页面前要求配置测试 scope、访问令牌及企业/工作空间/用户 actor；这些值的存在不证明它们属于隔离环境，仍须核对目标部署与测试身份。纯只读 `quick` 页面侦察无需这些业务凭据。

手动录入使用页面 `setInputFiles` 与 `captureResponse`，其 API 没有 `client_item_key` 幂等契约，不能套用上述 capability 的重试保证。它需要独立的测试 scope、actor 和岗位配置，通过本次提交的五个身份核对业务结果。具体配置见 [手动录入契约](aihr-resume-integration.md#manual-candidate-intake)。只有 UI 断言和独立业务 Oracle 都有证据并通过，才可认定核心链路通过；Run 结果保存在 `$testWorkspace\.proofkit\runs\<runId>\`。

## 下一阶段

1. 在与所选源码版本对应的隔离 Electron、网关和 worker 环境中侦察 BOSS 页签、风险确认和 `POST /runs` 的真实 CDP 可见性，冻结动作定位与响应身份策略。
2. 在真实隔离页面核验参考“立即运行” UI Charter 的按钮定位、风险确认分支和响应可见性，再登记为目录用例；当前隔离 Chrome/Electron 样例已经把点击后的 backend run、单份文件、候选人、岗位和评估事实绑定到同一 Oracle。
3. 在真实隔离环境中验证 `collection_run → file → extract → parse → assessment`，并分别处理零结果、待处理、风险确认和明确失败。
4. 增加重试、重复提交、计费幂等和取消恢复场景；登记经过验证的 Charter 供自然语言选择，不向 AIHR 源码写入 ProofKit 文件。
5. 继续改进基于代码/路由的测试建议，保持类型化动作、capability allowlist 和副作用权限校验。
