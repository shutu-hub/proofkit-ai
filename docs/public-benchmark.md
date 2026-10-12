# 公开基准：WebArena-Verified

先用 [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) 检验 AI 完成真实 Web 任务的能力，再用真实业务和植入缺陷评估测试判断质量。基准接入不需要修改 AIHR。

## 已实现与边界

已接入固定任务批次、Agent 输入投影、官方 Python 评判器、输入哈希校验和简洁 HTML/JSON 报告。官方依赖只安装在独立评测环境，产品 CLI/MCP 仍使用 TypeScript；没有复制或另写判分算法。

当前支持三个开发命令：`prepare` 准备任务并检查 Docker；`replay` 校验官方评判器；`grade` 评判外部响应与 HAR。另有开发用基准专用 MCP 入口，将隔离 Web HAR 采集贯通到现有 Mission/Runner，并审计运行关联。**尚未实现 WebArena 的宿主 AI 自动执行与 ProofKit 成绩认证**，这些命令不代表完成了一次产品测试。

2026-10-12 本地验证：

| 检查 | 实际结果 | 能证明什么 |
| --- | --- | --- |
| 官方评判对照 | 7/7 符合预期 | 官方接口能接受正确读取/导航，拒绝错误答案、错误路径和 HTTP 500；空 HAR 返回 error |
| 批次及输入回归 | 6 个测试通过，包括可选官方集成测试 | 缺失任务不被丢弃，畸形输入为 error，篡改任务被阻断，历史结果不被覆盖 |
| 准备首批任务 | 12 个，实际执行 0 个 | 数据接入正常；没有自主测试成功率 |
| 官方站点 | `docker-not-installed` | 真实站点测试未开始 |
| 真实 Chrome HAR 采集 | 4 个脚本控制的本地运行，覆盖成功、断言失败、HTTP 500、取消 | 初始导航、请求正文/头/Cookie、嵌入响应、关闭刷新与哈希校验正常；默认普通证据继续脱敏 |
| 官方评判真实 HAR | 3/3 对照符合预期：正确导航 success，500 和未访问目标页 failure | 任务 44 的评判协议能读取实际网络记录；站点为本地 fixture，不计入 WebArena 成绩 |
| 基准 MCP 与 Mission 关联 | 5 个真实 Chrome 脚本场景通过，含 core primary/negative 和 guided inspection | 内部任务绑定、失败/取消留证、原始 HAR 隔离和篡改拒绝正常；不证明 AI 自主完成任务 |
| 专用 MCP stdio 入口 | 子进程握手、工具发现与项目发现通过 | 开发入口可由 MCP 客户端启动；未验证宿主 AI 或跨进程来源认证 |
| 持续任务浏览器 | 本地脚本 fixture 共 5 个 Run，同一 Chrome 上下文完成探索、登录、失败尝试和最终导航；另验证真实取消及 stdio 断开清理 | Cookie、页面及存储状态跨 Mission 延续；最终 HAR 涵盖全部尝试，篡改被审计拒绝；不计入公开任务完成率 |
| 官方评判持续任务 HAR | 本地 fixture 的任务 44 返回 success | 证明完整任务录制可送入官方评判器；不是官方 GitLab 环境，也不是 AI 自主解题 |
| 四站点就绪探测 | 固定上游 CLI 与本地 HTTP fixture 集成通过 | 只核验应用入口与控制接口可访问；镜像身份、任务前重置和正式任务执行仍未验证 |

对照中只有任务 108 使用上游已有成功记录；正确导航对照为**合成 HAR**。任务 107 的上游示例响应是 NAVIGATE，而固定数据要求 RETRIEVE，作为过期示例负对照保留。7/7 是评判校准结果，不是 Agent 完成率。

真实 HAR 验证中的 HTTP 500 页面仍显示预期文字；普通 Runner 在 `runtimeQuality.mode=record` 下可以通过该文字断言，而官方评判器拒绝此导航。这说明页面文字不能替代业务或基准的独立判定。真实 HAR 对照与上述 7 个回放对照分开保存。

## 固定范围

上游提交：`6473f72db5dcefc97b5725b59e734504edc28a21`（Apache-2.0）。完整数据共 812 个任务，当前 pilot 为预先固定的 12 个任务，不能外推为全量成绩。

| 类别 | 任务 ID | 站点 |
| --- | --- | --- |
| 读取 | 0、21、27、108、132 | 商品、商城后台、论坛、GitLab |
| 导航 | 44、118、157 | GitLab、商品、商城后台 |
| 修改 | 389、399、423、431 | GitLab、论坛、商城后台、商品 |

数据 SHA-256：`315af52919d4afb5f5f168be58c796d35ff10d65cb49c9b762bf2b8b1c10b6cc`。运行报告记录上游提交、数据及脚本哈希、ProofKit 提交与工作树状态、Python/依赖版本；官方原始结果另含评判器校验和。

## 独立站点的只读探测

上游四个 pilot 站点的应用端口分别是商城 `7770`、商城后台 `7780`、论坛 `9999`、GitLab `8023`；环境控制端口分别是 `7771`、`7781`、`9998`、`8024`。在有足够资源的独立基准主机启动固定镜像后，可在运行 ProofKit 的机器上用本地端口映射或 SSH 隧道访问。配置中的 URL 必须是无内嵌凭据的回环地址：

```json
{
  "environments": {
    "__SHOPPING__": { "urls": ["http://127.0.0.1:7770"] },
    "__SHOPPING_ADMIN__": { "urls": ["http://127.0.0.1:7780"] },
    "__REDDIT__": { "urls": ["http://127.0.0.1:9999"] },
    "__GITLAB__": { "urls": ["http://127.0.0.1:8023"] }
  },
  "controlUrls": {
    "__SHOPPING__": "http://127.0.0.1:7771",
    "__SHOPPING_ADMIN__": "http://127.0.0.1:7781",
    "__REDDIT__": "http://127.0.0.1:9998",
    "__GITLAB__": "http://127.0.0.1:8024"
  }
}
```

```powershell
pnpm benchmark:webarena probe --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --config D:/bench/environment.json --output D:/bench/probe-001
```

`probe` 仅向四个应用入口发送 GET，并按上游 `HttpClient.status()` 契约读取控制接口的 `/status`；禁止跨站重定向，不执行 `init`、`reset`、登录或任务动作。输出是新目录中的 `environment-report.json`，并记录配置 SHA-256。退出 0 只表示四个应用入口和四个控制接口当时可访问；报告继续标记 `reset: not-verified`、`imageIdentity: not-verified`、`taskExecution: not-started`。上游文档提及 `/reset`，但固定提交的 HTTP 客户端未提供相应方法；正式任务重置必须先核对所用镜像的控制协议，再实测状态回到初始值。不能用此探测报告代替可评分环境证明。

## 本地使用

所有源码参考、Python 环境和评测结果放在独立目录。以下为 PowerShell 示例；目录可换成有足够空间的路径。需要 Git、Node.js 22+、pnpm 和 uv。

```powershell
git clone https://github.com/ServiceNow/webarena-verified D:/bench/webarena-verified
git -C D:/bench/webarena-verified checkout 6473f72db5dcefc97b5725b59e734504edc28a21
uv venv --python 3.11 D:/bench/evaluator
uv pip install --python D:/bench/evaluator/Scripts/python.exe D:/bench/webarena-verified

# 在 ProofKit 源码目录执行。每个 --output 必须是新的外部目录。
pnpm benchmark:webarena prepare --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --output D:/bench/pilot-001
pnpm benchmark:webarena replay --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --output D:/bench/controls-001
```

Linux/macOS 将 Python 路径换成 `evaluator/bin/python`。源码必须保持在固定提交且 tracked 文件无改动；已安装评判器的 Python 源码会逐一与该提交比对。依赖版本被记录，目前没有跨机器的完整依赖锁定。

Agent 输入在 `pilot-001/agent-input/`，只包含任务指令、起始 URL/上下文和输出格式，不包含 `eval` 或标准答案。响应遵循该目录的 `answer-schema.json`。每个提交放在 `submissions/<taskId>/agent_response.json` 和 `network.har`，HAR 须嵌入需要的响应内容；脱敏到无法判分的记录不能补造证据。

评判配置示例：

```json
{
  "environments": {
    "__SHOPPING__": { "urls": ["http://localhost:7770"] },
    "__SHOPPING_ADMIN__": { "urls": ["http://localhost:7780"] },
    "__REDDIT__": { "urls": ["http://localhost:9999"] },
    "__GITLAB__": { "urls": ["http://localhost:8023"] }
  }
}
```

```powershell
pnpm benchmark:webarena grade --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --batch D:/bench/pilot-001 --submissions D:/bench/submissions --config D:/bench/environment.json --output D:/bench/grade-001

# 默认只运行不依赖外部环境的回归；设置以下变量才执行官方集成测试。
$env:PROOFKIT_WEBARENA_UPSTREAM='D:/bench/webarena-verified'
$env:PROOFKIT_WEBARENA_PYTHON='D:/bench/evaluator/Scripts/python.exe'
$env:PROOFKIT_WEBARENA_RUNS='D:/bench'
pnpm test:webarena
```

`grade` 将完整提交复制到结果目录并记录哈希，评判器读取该快照；完整但畸形的输入也保留用于复核。只有全部计划任务成功才退出 0，其余退出 1；准备阶段即使环境被阻断，仍退出 0 并保存环境状态，不能把进程退出码当成站点就绪。空批次成功率为 null；开始提交后的成功率按固定 12 个计划任务计算，部分匹配不算成功，error 和 not-run 单列。导入结果始终标为 `proofkitEffectiveness: not-measured`。

## 隔离浏览器网络采集

可信基准控制器可以直接使用 Adapter API；目前没有在普通 CLI、MCP 或项目配置中开放原始 HAR 路径。

```typescript
const adapter = new WebAdapter({
  executablePath: browserPath,
  baseUrl: taskStartUrl,
  benchmarkHar: { directory: newAbsoluteExternalDirectory, runId },
});
const result = await new ExecutionRunner(adapter, { evidenceDir }).run(charter, runId);
const capture = adapter.benchmarkHarManifest();
```

采集从新建浏览器上下文开始，先于第一步导航，阻止 Service Worker 绕过录制；关闭上下文后才核验 `network.har`，并写入 `capture.json` 的 SHA-256、字节数和条目数。目录必须新建，Adapter 仅供一次采集使用。取消时晚到的资源仍会被释放，采集不会在连接尚未结束时提前确认。空文件、缺失、畸形、超过 32 MiB 或关闭失败都会留下明确缺口；结构检查只是基本有效性检查，完整判分继续交给官方评判器。

HAR 保留原始 Cookie、Header 和正文，调用者必须将其放在独立评测目录。普通 Run 的事件、响应投影与结果仍沿用脱敏策略。CDP 附加和 Electron 不支持此选项，因为已有上下文无法保证从任务起点开始完整录制。`runId` 当前只是调用者标签，**没有构成 Mission 来源认证**；采集成功也不等于任务成功。消费方必须重新核验文件哈希，不能仅信任标签或 manifest。

```powershell
# 先设置前文的官方环境变量；不设置时只验证浏览器采集，跳过官方判分。
$env:PROOFKIT_BROWSER_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
pnpm test:smoke:benchmark-har
```

该命令使用真实 Chrome 和本地脚本控制的 HTTP fixture，将 HAR、普通 Run 证据、可选官方判分与 `report.json` 保存到新的外部目录。没有让 AI 解题，`webArenaTasksExecuted` 为 0，`proofkitEffectiveness` 为 `not-measured`。

## 基准专用 MCP 与 Mission 来源

先运行 `pnpm build`，由评测控制器创建以下 operator JSON，再通过 stdio 启动：

```powershell
node scripts/webarena-mcp.mjs --session D:/bench/operator.json
```

```json
{
  "root": "D:/bench/source",
  "workspaceRoot": "D:/bench/workspace",
  "captureDirectory": "D:/bench/raw-capture-new",
  "taskId": 44,
  "publicInputPath": "D:/bench/pilot-001/agent-input/tasks.json",
  "publicInputSha256": "<tasks.json 的实际 SHA-256>",
  "browser": {
    "startUrl": "http://127.0.0.1:8023",
    "executablePath": "<Chrome 可执行文件的绝对路径>"
  }
}
```

路径必须为绝对路径；原始采集目录必须新建，并与源码、工作区和普通证据目录分离，目录校验包含 symlink/junction。`browser` 是可信控制器可选配置；`startUrl` 只允许无内嵌凭据的本地回环地址，须指向已初始化的测试站点。入口只读取经过 allowlist 投影的公开任务，核验输入摘要和选中任务唯一性，不读取上游答案或评判器；它仍是源码开发入口，没有作为发行命令打包。正式站点的部署、重置和 URL 映射尚未实现。

通过可信 embedding API 注入 `BenchmarkCaptureSession`，现有 Mission 的 inspection、primary、replay、negative Run 从内部工具上下文取得真实任务绑定。普通 MCP schema、项目配置和 Charter metadata 无法指定原始采集目录或伪造该内部绑定；standalone Run 仍留证，但没有 Mission 关联。该模式禁用 portable recovery，拒绝 CDP、Electron 和 mobile。

未配置 `browser` 时，会话保存 `session.json`、每 Run 的开始/结束记录、各自的 `capture.json` 和 `network.har`。进程内 `session.auditRun(runId)` 重读文件、校验摘要、真实 Run 上下文，以及 Mission 图节点、Observation、AgentStep 和既有执行审计。失败、取消或采集不可用均保留结果；缺失/篡改、孤立 Run 和缺失 Observation 返回 `incomplete`。

配置 `browser` 后，任务控制器持有一个 Chrome 上下文和页面。所有 Run 串行借用同一页面；普通探索可得 `inconclusive`，断言失败也可继续，而取消或未完成的 Run 会封存上下文并禁止继续操作。专用 MCP 的 `submit_benchmark_task` 接收一次符合官方格式的最终答案，要求全部 Run 已结束，然后关闭上下文、刷出 `task/network.har`，保存 `agent_response.json` 和完整任务记录，并审计每次尝试。返回 `captured` 仅代表本地证据一致；不能冒充官方判分。客户端关闭 stdio 时会等待浏览器清理，不生成虚假的最终答案。

`associated` 和 `captured` 只代表本次进程内的运行与文件一致性，不是 AI 执行认证、公开任务成绩、跨进程签名或防止同账户篡改的证明。未配置 `browser` 时各 Run 仍使用不同浏览器上下文；配置后所有尝试进入同一任务轨迹，不能挑最后一次成功 Run 冒充完整执行。HTTP 500 下文字断言通过也不能替代官方判分。报告继续标为 `proofkitEffectiveness: not-measured`。

```powershell
# 设置前文的官方评判环境后，追加协议对照；未设置时只验证 MCP/Chrome fixture。
pnpm test:smoke:benchmark-mission
```

此 smoke 验证 quick、core、guided inspection 和 stdio 启动；primary/negative 的来源绑定已实测，replay 绑定尚无真实浏览器 smoke。现有 Web release 会要求 Web/Electron 矩阵，而原始 HAR 采集仅支持 Web，因此本阶段不声称完成 release 公测。全部场景由脚本作答，正式任务执行数仍为 0。

`pnpm test:smoke:benchmark-task` 使用真实 Chrome 验证持续登录状态、全部尝试入证、取消后封存、stdio 断开清理、篡改拒绝，并在可用时调用任务 44 的官方评判器。它仍只运行本地脚本 fixture，`webArenaTasksExecuted` 保持 0。

任务 MCP 退出后，可信评测控制器可以单独运行：

```powershell
# 先在 ProofKit 仓库运行 pnpm build；--session 指向运行时使用的同一 operator.json。
node scripts/webarena-audit.mjs --session D:/bench/operator.json
```

离线审计重新校验公开输入摘要、任务与浏览器上下文、捕获目录中**全部** Run 开始/结束文件、保存的 Run 和 Mission 关联、最终答案及完整 HAR 的摘要与结构。删除失败尝试，即使同时改写最终记录中的 `runIds` 和 `browserRunIds`，也会因目录清单不符被拒绝。输出 `consistent` 只表示本地文件链在可信输入锚点下自洽；`hostExecution: not-verified` 表示它仍未核验实际宿主工具调用、代理身份、独立站点初态或同账户改写，官方评分仍须另行运行。取消和没有最终提交的 stdio 弃置任务返回 `incomplete`。原始 HAR 不通过此命令输出。

## 下一阶段：真实执行的准入条件

1. 按[官方环境说明](https://servicenow.github.io/webarena-verified/environments/)部署四个隔离站点，记录镜像 digest、站点配置和任务前初始化结果。Docker 可以在另一台开发机运行；本机的检查目前只探测本地 Docker，不证明远端环境不可用。当前没有站点部署或重置自动化。
2. 在独立容器/账户中让 Codex、Claude Code 等宿主只读任务输入和已映射的站点 URL，经现有 MCP/CLI 发现页面、生成计划并创建 Mission。禁止事先替 Agent 写完成路径。当前只是文件内容分离，**同一宿主仍可能读取上游标准答案，尚无系统级答案隔离**。
3. 专用 MCP 入口、内部 Mission/Run 绑定、持续上下文、全任务 HAR 与最终提交已通过真实 Chrome fixture 验证。下一步将真实站点初始化、任务重置和宿主 AI 执行接入此生命周期，并复核多次运行的稳定性。已有 CDP 会话不能默认视为从任务起点完整采集。原始基准 HAR 留在隔离评测目录。
4. 独立评判进程在任务结束后读取响应/HAR；认证模式还需核验宿主工具轨迹、实际 Mission、运行来源、初始化状态和输入未变。人工导入或示例回放只能继续用 `grade`，不能升级成 ProofKit 自主成绩。
5. 先报告固定 12 个任务的完成率、阻断原因、耗时、模型用量与重复运行稳定性，再扩展全量和独立留出任务。在相同站点、模型、预算和重复次数下对比宿主直接使用 Playwright 的基线与宿主使用 ProofKit，避免把模型差异计入框架收益。

WebArena 衡量任务完成，不能直接衡量发现 Bug、误报和修复验证。后续还要独立的已知缺陷集与修复前后验证，计算缺陷召回、误报和证据充分率。WebArena 不覆盖 Electron 主进程、IPC 或移动端；这些继续保留各自的真实运行验证。
