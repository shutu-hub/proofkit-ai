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

## ProofKit 的第一条真实 Charter

`.proofkit/charters/aihr-online-resume.yml` 覆盖：

1. 通过网关提交在线简历 intake。
2. 轮询 integration workflow projection。
3. 发现 `online_resume_file_id` 后读取文件状态。
4. 读取候选人和评估投影。
5. 独立 oracle 再次读取这些公开事实，要求 `extract_status=done`、`parse_status=matched`、候选人存在，并按 Charter 决定是否必须 `assessment.task_status=success`。

证据只保存：run/task/file/candidate/job/assessment 的 opaque ID、状态、计数、错误码和稳定哈希。不会保存 source_text、原始 PDF、cookie、token、手机号或完整候选人资料。

## 失败边界必须单独验收

| 边界 | 失败证据 |
| --- | --- |
| 网关鉴权/租户错误 | HTTP 状态、业务错误码、request id |
| intake 重复提交 | 同一 workspace/workflow/source hash 返回同一任务，不重复生成文件 |
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
```

运行 Charter 时必须显式允许写操作；默认配置仍是 `confirm`。

## 下一阶段

1. 把 AIHR Charter 接入真实 Electron/CDP surface，并把 UI 操作与上述业务 oracle 绑定到同一个 run。
2. 增加上传 PDF Charter，验证 `collection_run → file → extract → parse → assessment`。
3. 增加重试、重复提交、计费幂等和取消恢复场景。
4. 在 AIHR 自己的仓库加入极薄的 `.proofkit/integration.mjs` 代理文件，让用户只需执行 `proofkit run --charter ...`。
5. 再加入自动项目扫描和基于代码/路由/迁移的 Charter 建议，但所有写操作仍必须由项目集成的 allowlist 能力承载。
