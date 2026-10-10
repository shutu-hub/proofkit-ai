# GitHub Action 接入

根目录的 `action.yml` 是可复用的 Composite Action。它从该 Action 的源码版本构建 ProofKit，使用同一 CLI 创建、运行或复核 Mission，输出当前证据审计后的结论。仓库的 `.github/workflows/action-smoke.yml` 已安排在 GitHub runner 上通过 `uses: ./` 验证完整 Action；当前本地提交尚未推送，因此该工作流还没有执行证据。以下配置是接入模板；本地回归已验证包装脚本和真实 Chrome 链路。

## 运行场景

先检出被测项目和单独维护的测试工作区，启动对应的测试环境，再执行 Action。外部工作区的 `.proofkit/config.yaml`、Charter 和连接器须绑定本次源码路径；在下方的并列目录布局中，配置可写 `project.root: ../app`，从工作区解析到本次 checkout。`core` 需要独立业务 Oracle。示例中的 `<reviewed-ref>` 应替换为已审核发布的固定提交或标签。

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      path: app
  - uses: actions/checkout@v4
    with:
      repository: your-org/app-proofkit-tests
      path: proofkit-workspace
  # 在这里启动与 app checkout 对应的隔离测试服务。
  - uses: shutu-hub/proofkit-ai@<reviewed-ref>
    id: proofkit
    with:
      project-root: app
      workspace-root: proofkit-workspace
      intent: 测试简历获取
      charter-id: resume-acquisition
      level: core
      surface: web
```

初次连通性测试可用 `level: quick`、`url` 和 `expect-text` 创建一个只检查页面文字的场景。复杂业务使用已审核 Charter 与独立 Oracle；一个 200 响应或页面文字不能代替业务终态。`charter-id` 与临时的 `url`、`expect-text`、`oracle-name` 输入互斥。要执行尚未结束的已创建 Mission，传 `mission-id`，不传 `intent`；已结束 Mission 只能用 `mode: check` 复核，不能借旧结果冒充新执行。默认 `mode: run`；`mode: check` 只接收现有 `mission-id`，不启动产品或导入工作区连接器。

Action 默认在运行模式安装 Playwright Chromium。测试现有 Electron/CDP 会话或已提供浏览器时可设置 `install-browser: 'false'`。本地已有 Chrome/Chromium 时，Web 适配器可从 `PROOFKIT_BROWSER_PATH` 读取可执行文件路径；工作区 `surfaces.web.executablePath` 优先。这个环境变量使新建外部工作区的 quick 检查无需先写浏览器配置。Action 不负责启动被测应用、登录、配置数据库、创建真实业务账号或上传报告。需要写入型连接器时，必须显式设置 `allow-capability-writes: 'true'`，同时通过工作区、Charter 和连接器各自的测试环境门禁。

## 门禁与证据

`test-verdict` 输出是当前审计后的结论；`saved-verdict` 仅是历史执行结论。退出码 0 表示有证据的 `passed`，1 表示已观察的 `failed`，2 表示 `blocked`、`cancelled`、`inconclusive`、`not-asserted` 或 Action 无法核对 CLI 结果。Action 还输出 `mission-id`、`summary-path` 和 `report-path`，并在 GitHub Step Summary 中显示简要状态。`summary-path` 指向带 `schemaVersion: "1"` 的 `MissionResult` JSON。

`mode: check` 要求 Mission 文件和 Run 证据仍在原工作区路径，且 `project-root` 与保存时的源码绑定一致。跨 Job 搬运证据可能改变路径或丢失文件，当前没有路径迁移协议；在同一 Job 内复核，或为新的 checkout 创建新的 Mission。

证据默认只保留在 runner 的测试工作区。截图和快照可能包含页面上的个人信息；如需跨 Job 保留，应由调用方明确选择上传哪些文件及保留期限。移动端需要调用方提供 Appium 兼容服务和设备；当前尚无真实设备验收证据。
