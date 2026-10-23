# ProofKit AI

**为 Web、Electron 测试提供可审查的计划、真实执行和可追溯的证据。**

ProofKit 是面向开发者和宿主 Agent 的通用测试骨架。通过 CLI、MCP 或 LocalRunner API，将测试意图组织成 Test Charter，驱动真实浏览器或应用，记录执行过程，并用独立业务检查支持最终结论。

默认规划器生成导航与观察草稿。完整业务流程由宿主 Agent 根据页面观察编写，或交给显式配置的模型规划器。业务预期、认证和独立验收来源仍需要项目提供。

> 当前处于早期开发阶段。已有真实浏览器回归、复杂应用的限定场景验证和安装包验收；尚未证明对任意陌生项目的一句话自主测试成功率。CLI 和数据格式仍可能演进。

## 目录

- [能力与边界](#能力与边界)
- [安装](#安装)
- [先完成一次页面检查](#先完成一次页面检查)
- [接入宿主 Agent](#接入宿主-agent)
- [配置模型规划](#配置模型规划)
- [执行业务测试](#执行业务测试)
- [留痕、报告与交付](#留痕报告与交付)
- [开发与验证](#开发与验证)
- [架构与文档](#架构与文档)

## 能力与边界

| 能力 | 当前支持 |
| --- | --- |
| 计划与审查 | 保留原始意图、级别、动作、断言、业务检查和缺口；通过页面观察与原始摘要续接多状态规划 |
| Web 执行 | Playwright 驱动，可见或无头浏览器；表单、文件选择、动态控件、多页面及弹窗选择 |
| 持续会话 | 跨调用复用认证状态；独立会话隔离；可选加密状态保存、会话资源准备与恢复 |
| Electron | CDP 连接；页面与应用进程分别检查；支持独立平台的 Charter 和套件 |
| Mobile | W3C WebDriver/Appium 适配器；协议样例已验证，真实设备验收仍待完成 |
| 业务验收 | connector、独立 HTTP reader、捕获身份绑定与字段比对；区分页面、HTTP 合同和业务事实 |
| 证据留痕 | 步骤时间线、截图、网络事件、声明字段的请求/响应投影、可选 WebM 录像 |
| 报告与移交 | Run/Mission HTML 和 JSON；本地摘要校验；离线证据归档及重新验包 |
| 故障恢复 | 资源创建前登记归属；受控清理与独立读回；保留中断和无法封存的证据状态 |

一次点击成功不能证明数据正确；一次 HTTP 200 不能证明最终业务状态。`core`、`release` 需要适当的独立业务检查。页面级 `quick` 通过仅覆盖声明的页面检查。缺少读数或必要证据时保留 `inconclusive`，不会补造通过结果。

## 安装

需要 Node.js 22+。当前通过 GitHub 源码安装；尚未发布 npm registry 版本：

```bash
npm install -g github:shutu-hub/proofkit-ai
proofkit --version
```

开发者从源码运行（pnpm 10）：

```bash
git clone https://github.com/shutu-hub/proofkit-ai.git
cd proofkit-ai
pnpm install --frozen-lockfile
pnpm build
node bundle/main.js --help
```

Web 需要可用的浏览器；可通过工作区 `surfaces.web.executablePath` 或 `PROOFKIT_BROWSER_PATH` 指向 Chrome/Edge。录像还需要 Playwright 对应的 FFmpeg。Electron 需要应用提供本地 CDP；移动端需要 Appium/W3C 服务。

## 先完成一次页面检查

启动自己的本地 Web 应用后，创建独立的测试工作区：

```bash
proofkit init --root ../my-app --workspace ../my-app-tests
proofkit scope --root ../my-app --workspace ../my-app-tests --surface web --level quick
proofkit inspect --root ../my-app --workspace ../my-app-tests --url http://127.0.0.1:3000 --headful
```

把下面的 `My application` 替换成页面实际预期出现的文本：

```bash
proofkit run "检查首页可见内容" --root ../my-app --workspace ../my-app-tests --url http://127.0.0.1:3000 --level quick --expect "My application" --headful --no-start
```

该命令使用默认草稿中的导航与观察，执行一项明确的页面断言。它能验证入口链路，不能作为新增、编辑、支付等业务流程的验收。CLI 输出 Run ID、verdict 和本地报告路径。

`--root` 指向被测源码，`--workspace` 指向配置、connector 和证据目录。新项目默认使用源码外的工作区；已有源码内 `.proofkit` 布局保持兼容。显式指定工作区能避免配置混用。

## 接入宿主 Agent

```bash
proofkit agent setup --harness codex --root ../my-app --workspace ../my-app-tests --install-skill
```

也支持 `claude-code`、`deepseek-harness` 和 `generic`。返回的 onboarding bundle 包含 Skill、MCP 配置和连接命令。按返回信息注册后，先调用 `inspect_test_scope` 确认项目绑定，再检查环境、观察页面、规划测试。

`--check-connection` 验证本地 MCP 连接；`--register-host` 可完成支持宿主的注册。连接成功不代表模型规划或业务测试通过。详细配置见 [Agent 接入](docs/agent-integration.md)。

## 配置模型规划

CLI/MCP 从测试工作区的 `.proofkit/config.yaml` 读取规划器配置。初始化后编辑并保留已有的 `project` 绑定，合并以下字段：

```yaml
planning:
  provider: openai-compatible
  baseUrl: http://127.0.0.1:4000/v1
  model: your-model-id
  apiKeyEnv: PROOFKIT_PLANNER_API_KEY
  timeoutMs: 30000
surfaces:
  web:
    baseUrl: http://127.0.0.1:3000
```

替换服务地址和模型 ID；不需要鉴权时省略 `apiKeyEnv`，需要时在启动 CLI/MCP 的环境中设置该变量。MCP 的模型端点须使用 loopback。`PROOFKIT_PLANNER_BASE_URL`、`PROOFKIT_PLANNER_MODEL` 是仓库模型评估脚本的输入，单独设置它们不会覆盖 CLI 的工作区配置。

```bash
proofkit plan "检查首页可见内容" --root ../my-app --workspace ../my-app-tests --url http://127.0.0.1:3000 --level quick --expect "My application" --format json --out .proofkit/charters/home.yml
```

| 规划状态 | 意义与下一步 |
| --- | --- |
| `needs-input` | 缺少检查、独立 reader 或观察目标；保留原意图并补齐计划 |
| `needs-observation` | 需要另一个页面状态；审查单步探索提案，观察后使用原始摘要续接 |
| `planner-not-ready` | 显式启用的模型规划器缺少配置；配置后重新规划 |
| `ready-for-review` | 结构检查未发现已知缺口；仍需审查认证、数据、环境和写操作范围 |

这些规划响应均为 `not-asserted`。规划阶段可能做只读页面观察，但不会自动执行探索提案或声明产品通过。CLI 的待补输入、待观察、配置未就绪响应退出码为 `2`。模型请求失败不会静默降级为模拟模型。

## 执行业务测试

新增、编辑、刷新持久化、多账号等业务需求，需要基于真实页面观察的 Charter，以及项目提供的认证、隔离数据和独立 reader。通过工作区 `.proofkit/integration.mjs` 注册能力、业务 Oracle 和生命周期检查。应用专属逻辑通过 connector 扩展通用 Runner。

审查好的 Charter 保存在测试工作区后：

```bash
proofkit mission create "新增记录并刷新验证持久化" --root ../my-app --workspace ../my-app-tests --surface web --charter .proofkit/charters/save-record.yml
proofkit mission run <mission-id> --root ../my-app --workspace ../my-app-tests --approve
proofkit mission evidence <mission-id> --root ../my-app --workspace ../my-app-tests
proofkit mission check <mission-id> --root ../my-app --workspace ../my-app-tests
```

`--approve` 批准本次已审查计划，写操作仍需 Charter、工作区策略和能力授权一致。`mission check` 审计当前证据：通过退出 `0`、已观察失败退出 `1`、未知或无法验收退出 `2`。

MCP 可用 `plan_test`、`create_test_mission`、`run_test`、`await_test_result` 和 `get_mission_evidence` 完成同一路径。跨调用登录和多页探索使用保留的 `sessionId`；关闭会话后刷新报告，才能交付已封存录像。完整协议见 [详细功能参考](docs/reference-guide.md) 和 [Agent 接入](docs/agent-integration.md)。

## 留痕、报告与交付

- **步骤与截图**：原始动作、结果、时间、关联截图和失败边界；揭示未执行步骤及省略项。
- **网络证据**：请求/响应 ID、状态与步骤关联；请求参数、响应字段须显式声明、限定来源并通过脱敏和预算检查，默认不保存任意完整敏感请求体。
- **录屏**：可选 `run.recordVideo` 或保留会话的 `sessions.recordVideo`；关闭上下文后封存。中断、超预算或不支持的模式明确为 partial/unavailable。
- **独立业务检查**：显示期望、实际值、身份关联和来源；页面提示、录像与网络元数据是辅助证据。
- **完整性**：Manifest、事件摘要和会话 seal 校验已保存字节；本地哈希不是外部签名，也不证明运行后的数据库状态。

报告保存在 `<workspace>/.proofkit/runs/<run-id>/report.html` 与 `<workspace>/.proofkit/missions/<mission-id>/report.html`。`testVerdict` 是当前审计结论，历史 `verdict` 单独保留；必需证据改变或丢失时不能继续声称通过。

```bash
proofkit mission export <mission-id> --root ../my-app --workspace ../my-app-tests --out ../evidence-archive
proofkit verify-archive ../evidence-archive --archive-sha256 <export-returned-sha256>
```

导出目录须是新目录且父目录存在；将返回摘要单独保存。录像和部分应用内容可能含敏感信息，分享前审核证据。详见 [证据归档](docs/evidence-archives.md)。

## 开发与验证

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:distribution
```

按目标选择真实浏览器回归：

```bash
pnpm test:smoke:web
pnpm test:smoke:planning-session
pnpm test:smoke:session-video
pnpm test:smoke:model-evaluation
```

最后一项使用受控 provider 检查评分器及成功/失败证据保留，不代表真实模型质量。真实模型评分需配置评估脚本的 `PROOFKIT_PLANNER_BASE_URL`、`PROOFKIT_PLANNER_MODEL` 和可选 API key，再执行 `pnpm test:evaluate:web:model`。外部任务使用摘要固定的 suite，详见 [外部 Web 任务验收](docs/external-web-evaluation.md)。

评估输出区分 `fixture`、`reviewed-external`、操作员声明的 `unseen-holdout`。布尔 attestation 只记录声明，不能证明应用未参与开发或提示调试。复杂站点样本支持限定的执行与证据结论，不能推广为陌生站点通用成功率。

`outputs/`、录像、临时日志、认证状态和本机调试产物保留在本地，不纳入 Git。历史文档提到的本机路径不是仓库自带的可移植证据包。

## 架构与文档

```text
CLI / MCP / Host Agent
         ↓
LocalRunner → Planner / Mission Agent
         ↓
Execution Runner → Web / Electron / Mobile Adapters
         ↓
独立 Oracles + Evidence Store → HTML / JSON / Offline Archive
```

保留单一本地执行与结果模型，复杂业务通过 connector 扩展。当前优先稳定通用 Web 的计划、执行、独立验收与证据交付。

- [中文架构概览](docs/architecture-overview.zh-CN.md)
- [详细功能参考](docs/reference-guide.md)
- [Agent 接入与 connector](docs/agent-integration.md)
- [执行前规划门禁](docs/planning-admission-validation.md)
- [外部 Web 评估](docs/external-web-evaluation.md)
- [模型规划收据与限制](docs/model-planning-receipt-validation.md)
- [验证计划](docs/validation-program.md)
- [开发者体验审查](docs/developer-experience-review.md)

## License

MIT，见 [LICENSE](LICENSE)。
