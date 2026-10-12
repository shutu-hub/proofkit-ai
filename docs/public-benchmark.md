# 公开基准：WebArena-Verified

先用 [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) 检验 AI 完成真实 Web 任务的能力，再用真实业务和植入缺陷评估测试判断质量。基准接入不需要修改 AIHR。

## 已实现与边界

已接入固定任务批次、Agent 输入投影、官方 Python 评判器、输入哈希校验和简洁 HTML/JSON 报告。官方依赖只安装在独立评测环境，产品 CLI/MCP 仍使用 TypeScript；没有复制或另写判分算法。

当前支持 `prepare` 准备任务、`probe` 探测站点、`replay` 校验官方评判器、`grade` 评判响应与 HAR，以及单题宿主执行入口。基准专用 MCP 将隔离 Web HAR 采集贯通到 Mission/Runner，并审计宿主工具轨迹。**已在官方 `shopping_admin` 镜像上运行四题小批次；系统级答案隔离和 ProofKit 成绩认证仍未实现。**

2026-10-12 本地验证：

| 检查 | 实际结果 | 能证明什么 |
| --- | --- | --- |
| 官方评判对照 | 7/7 符合预期 | 官方接口能接受正确读取/导航，拒绝错误答案、错误路径和 HTTP 500；空 HAR 返回 error |
| 基准回归 | 23/23 通过，包括官方 Python 集成测试、批次重置准入/互斥和诊断工具 | 缺失任务不被丢弃，畸形输入为 error，篡改任务被阻断，历史结果不被覆盖；无提交时成绩显示未测量 |
| 固定任务批次 | `pilot-12` 十二题；`shopping-admin-4` 四题 | 四题子集独立计分，不能外推为十二题或全量成绩 |
| 官方单站点 | D 盘 WSL Docker 中固定摘要的 `shopping_admin`；每题重建容器 | 数据库探针在重建后恢复为 0；`/admin` 和控制接口可达，真实 Chrome 免登录进入仪表盘 |
| 四题真实执行 | 4 题均启动宿主；3 题提交并官方评判，2 成功、1 失败；另 1 题超时 | 官方合并报告按固定分母为 2/4；宿主失败须与官方缺失提交一起阅读 |
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

### 官方站点启动与真实任务准入

固定 pilot 的 12 道题每题只使用一个站点，因此可以按站点顺序运行，避免四个容器同时占用内存。上游固定提交的[环境说明](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/docs/environments/index.md)给出以下启动入口；在**独立 Linux 测试机**安装 Docker 和同一提交的 `webarena-verified` 后执行：

```bash
webarena-verified env start --site shopping_admin
webarena-verified env start --site shopping
webarena-verified env start --site reddit
webarena-verified env start --site gitlab
```

官方优化镜像分别为 `am1n3e/webarena-verified-shopping_admin`、`am1n3e/webarena-verified-shopping`、`am1n3e/webarena-verified-reddit`、`am1n3e/webarena-verified-gitlab`；上游文档标注的镜像大小约为 2.9、13.3、8.41、31.6 GB，GitLab 建议至少 4 GB RAM。可以按站点依次启动，但仍须预留镜像解包、站点数据和 HAR 空间。每次拉取后记录 `docker image inspect <镜像> --format '{{json .RepoDigests}}'` 的 digest，并在任务记录中固定实际 digest；仅记录可变 tag 不够。远程容器的应用和控制端口通过 SSH 隧道映射到本地回环地址，再运行下方 `probe`。不要把控制端口或原始 HAR 暴露给任务 Agent。

2026-10-12 从 Docker Hub `latest` 标签的公开 API 读取到以下 Linux/amd64 摘要。`shopping_admin` 已在本机拉取并用 `docker inspect` 核对实际镜像 ID、空挂载和容器 ID；其余三个摘要仅是仓库元数据观察，仍须在未来的测试机上核对。

| 站点 | 镜像摘要 `sha256:` |
| --- | --- |
| shopping_admin | `d0531dd27ed98d0c459ff9e88118bf2ed8b660b0ed99c38837db46c065a5be13` |
| shopping | `3e8cb9b945ea9b1c94ab26dba53e8d12dd0406abbf4bf686fd3bb2b6a5908feb` |
| reddit | `0594908059a03e5f610005689440a95c05e776e734006197c7b1eba12734cb46` |
| gitlab | `673ba94d757c5b3f4bb55751ad8b745a33bad2b987349322403cbc41035a92e0` |

**设备规划（我们的建议，不是上游保证值）：**单站点顺序跑完整 pilot，使用 Linux x86_64、4 vCPU、16 GB RAM 和至少 120 GB 空闲 SSD；若四站点同时常驻，建议 8 vCPU、32 GB RAM、200 GB 空闲 SSD。前者已经把四镜像约 56 GB 的标称体积、Docker 解包/数据、浏览器、任务证据及重建余量算入；仍须在实际镜像拉取后核对占用。ProofKit 控制器还需 Node.js 22+、Chrome/Chromium，官方判分侧需 Python 3.11+。无需 GPU。只跑一个较轻的站点可降低起步需求，但不能据此宣称 12 题 pilot 已完成。

**最小真实站点试跑：** `shopping_admin` 是这四个站点中标称镜像最小的一个（2.9 GB）。固定 pilot 中的任务 0、108（读取）、157（导航）、423（修改）都在该站点。现已提供独立 `shopping-admin-4` 批次，分母固定为四；原 `pilot-12` 批次保持十二题。先跑任务 157 验证整条真实链路，再用四题覆盖不同动作。单独的 Linux 主机可从 4 vCPU、8 GB RAM、50 GB 空闲 SSD 起步，16 GB RAM 更稳妥；这是待实测的规划值。四题结果不能冒充十二题成绩。

后续新增同站点 `shopping-admin-12` 固定集：读取 0、11、77、94、108、119；导航 374、679；修改 453、470、496、501。结构检查确认这些任务均有官方评判配置，四道修改题的预期请求字段与任务意图表面一致；尚未用真实 UI 成功路径校准评判器，也尚未执行这十二题。它与 `pilot-12` 是不同集合，绝不合并计分。

**任务前初态不能只凭 `/status` 判定。** 固定上游源码的控制服务仅实现 `POST /init`、`/start`、`/stop`、`/restart` 和 `GET /status`；文档示例中的 `POST /reset` 在该提交里没有路由。上游 `env stop` 会删除容器，`env start` 会新建容器；四个 pilot 站点的默认配置没有外部数据卷。`shopping_admin` 已用数据库标记做过 0 → 1 → 重建后 0 的验证，每题前亦记录新容器 ID、固定镜像摘要和标记读数；这只证明该镜像的重建恢复，不证明其余三个站点。任何恢复失败的题只能标为环境阻断，不能计分。

2026-10-12 更新：Docker Engine 29.8.2 位于 `D:/bench/wsl-docker` 的独立 Alpine WSL 2 发行版；固定上游源码、Python 评判器、四题批次与全部原始证据位于 `D:/bench`。镜像解包约 4.49 GB，WSL 虚拟磁盘约 5.31 GiB。官方四题合并报告为 **2/4**：108、157 成功，423 失败，0 的宿主运行超时且没有提交；十二题 pilot 未运行。详见本机 `D:/bench/admin4-validation-summary.md` 和 `D:/bench/grade-admin4-final-20261012/report.html`。同账户可读取上游答案，结果不能称为认证成绩。

**任务判分边界：**157 的官方网络条件只要求访问客户列表路径，不能据此证明逐个客户详情都已核查。423 的固定数据同时要求商品保存请求和看起来属于订单报表的 `report_type`、`from`、`to` POST 字段；按上游网络评判器源码，这些字段会参与匹配。当前 423 因宿主未执行修改而失败，尚不能判断该判分条件是否会误拒绝正确的商品修改；正式将其作为质量指标前，需用真实 UI 操作验证评判条件，并保留数据集原文和判分器版本，不可私改答案来提高成绩。

本机四题批次的准备命令：

```powershell
pnpm benchmark:webarena prepare --profile shopping-admin-4 --docker-wsl proofkit-docker --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --output D:/bench/pilot-admin4-new
```

`--docker-wsl` 只核验该发行版中的 Docker daemon。`probe --profile shopping-admin-4` 只要求 `shopping_admin` 的后台 `/admin` 与控制 URL；未显式指定 profile 时仍使用十二题 pilot。探测登录页可达不等于认证成功，任务前还须验证真实 Chrome 到达后台仪表盘。

上游四个 pilot 站点的应用端口分别是商城 `7770`、商城后台 `7780`、论坛 `9999`、GitLab `8023`；环境控制端口分别是 `7771`、`7781`、`9998`、`8024`。在有足够资源的独立基准主机启动固定镜像后，可在运行 ProofKit 的机器上用本地端口映射或 SSH 隧道访问。配置中的 URL 必须是无内嵌凭据的回环地址：

```json
{
  "environments": {
    "__SHOPPING__": { "urls": ["http://127.0.0.1:7770"] },
    "__SHOPPING_ADMIN__": { "urls": ["http://localhost:7780/admin"] },
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
    "__SHOPPING_ADMIN__": { "urls": ["http://localhost:7780/admin"] },
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

可信控制器保存 Codex `exec --json` 或 Claude Code `--output-format stream-json` 的完整 stdout 后，还可以关联宿主工具轨迹：

```powershell
pnpm benchmark:webarena:host-audit --session D:/bench/operator.json --events D:/bench/host-events.jsonl --host codex --server proofkit_benchmark
```

此只读命令先完成上述离线审计，再核对同一 MCP server 的已完成工具调用：每个已绑定 Mission 都须有执行调用和终态读取，最终提交调用须仅成功一次，参数须等于保存的 `agent_response.json`，返回的任务 ID 和完整 Run 清单须与捕获记录一致；宿主回合须结束。Claude Code 可将 `--host` 改为 `claude-code`。输出的 `associated` / `hostExecution: trace-associated` 仅代表**所给 JSONL 与保存文件相互吻合**，不验证 JSONL 由可信进程产生、Agent 身份、是否还有其它工具、任务初态或官方得分。事件文件含模型对话和工具结果，必须放在独立评测目录并按原始 HAR 的敏感程度保管。脚本 fixture 已通过 Codex 和 Claude 两种事件格式的关联、篡改提交与缺少终态读取负对照；它仍不是 AI 自主成绩。

### 单题宿主执行入口

官方站点、准备批次和任务前初态到位后，可信控制器为**一题**创建新的 operator JSON（含该题映射后的回环起始 URL），然后启动已配置模型认证的 Codex 或 Claude Code CLI。商城后台必须映射到 `/admin`；其官方优化镜像可由可信控制器在 `browser.extraHTTPHeaders` 中传入免登录请求头，原始 HAR 会保留该头：

```powershell
pnpm benchmark:webarena:run-host --session D:/bench/operator-157.json --batch D:/bench/pilot-admin4-20261012 --output D:/bench/host-run-157-new --host codex
```

Codex 宿主需使用已登录、保留模型提供方配置的隔离 `CODEX_HOME`。入口先枚举可见 MCP；若另有已启用的 MCP 则在启动前拒绝，以免模型偏离基准专用工具。它仅将该题 allowlist 公开指令交给宿主，保存完整 JSONL，运行宿主轨迹和持久证据审计；只有关联通过，才将按摘要再次核验的响应/HAR 放进 `submissions/<taskId>/`，供独立的 `grade` 命令读取。失败、超时或没有最终提交的宿主不会生成可评判提交。`host-run.json` 始终标记 `officialScore: not-run`，官方判分须另行执行。当前四题实测中，任务 0 的宿主超时会在官方导入报告里显示为缺失提交，必须连同宿主报告一起统计。

四题早期批次中三份真实宿主轨迹与提交文件关联成功，另一份超时未提交。单题入口不负责站点部署或重置，也不构成系统级答案隔离：同一账户仍可能读取上游标准答案。正式可信评测须让 Agent 宿主运行在只含公开输入的独立账户或容器，评判器和完整上游数据留在另一个信任域；并记录模型用量、失败尝试与重复运行稳定性。

### 固定单站点批次执行

`benchmark:webarena:batch` 支持 `shopping-admin-4` 与 `shopping-admin-12`。先用 `plan` 只读核验已准备批次、上游提交/数据哈希和本地路径；`run` 只接受一个新的外部输出目录。下例的参数可分别用于 `plan` 或 `run`：

```powershell
pnpm benchmark:webarena:batch plan --profile shopping-admin-12 --batch D:/bench/pilot-admin12-20261012 --config D:/bench/environment-admin4.json --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --chrome 'C:/Program Files/Google/Chrome/Application/chrome.exe' --root D:/bench/benchmark-target --workspace D:/bench/benchmark-workspace --host claude-code --docker-wsl proofkit-docker
pnpm benchmark:webarena:batch run --profile shopping-admin-12 --batch D:/bench/pilot-admin12-20261012 --config D:/bench/environment-admin4.json --upstream D:/bench/webarena-verified --python D:/bench/evaluator/Scripts/python.exe --chrome 'C:/Program Files/Google/Chrome/Application/chrome.exe' --root D:/bench/benchmark-target --workspace D:/bench/benchmark-workspace --host claude-code --docker-wsl proofkit-docker --output D:/bench/admin12-batch-new
```

执行器仅会替换名称、镜像摘要、无挂载及回环端口均吻合的官方商城后台容器；每题新建容器，并核验新的容器 ID、固定数据库标记为零、站点控制接口和真实 Chrome 的后台仪表盘。同一 Docker 实例的批次使用临时互斥锁；若进程异常退出后留下锁，先核对锁内 PID 和容器状态，再由操作员处理。每次宿主执行保留独立 operator、HAR、轨迹和提交；全部任务结束后按固定分母运行上游官方评判并生成能力组诊断。若宿主认证或基础设施阻断，会停止后续题目并保留未运行状态。官方评判只读取已封存的提交答案和 HAR，因此可在逐题重建后统一评判。此工具仍依赖有效的宿主认证和独立答案隔离，不能单独认证 Agent 成绩。

2026-10-13 的真实批次演练见 `D:/bench/admin12-batch-run-20261013-002/`：任务 0 前重建和 Chrome 登录检查通过；Claude Code 在首次 MCP 调用前认证失败，执行器停止，12 题均未提交，`officialSuccess: null`、官方成功率未测量。互斥锁已释放，诊断页明确显示“官方成绩未测量”。这验证批次的重置、阻断保留和报告链路，不构成十二题 Agent 成绩。

将官方 `grade` 报告和每题 `host-run.json` 合并为观察阶段诊断，可运行：

```powershell
pnpm benchmark:webarena:diagnose --grade D:/bench/grade-admin4-final-20261012/report.json --host D:/bench/host-run-0-002/host-run.json --host D:/bench/host-run-108-001/host-run.json --host D:/bench/host-run-157-005/host-run.json --host D:/bench/host-run-423-001/host-run.json --output D:/bench/admin4-diagnosis-new
```

输出 `report.json` 和简洁的 `report.html`，固定分母同时显示已尝试但未提交的超时题、官方结果、工具失败/入参拒绝和待复核项。它只做基于现有报告和哈希一致的宿主 JSONL 的诊断，不把失败阶段冒充已证实根因。后续基准扩容、AIHR 合成用例与修复回归门槛见[标准验收方案](validation-program.md)。

## 下一阶段：从真实试跑到可信评测

1. 为宿主提供更少、更稳定的交互工具与终态摘要。四题试跑里曾出现 MCP 未加载、Charter 参数反复试错、选择器歧义和 15 分钟超时；应把启动检查、动作编排和受限结果读取做成高层协议，而非只增加提示词。
2. 将宿主尝试记录与官方结果合并到同一批次报告：无提交的超时题仍要显示“已尝试但未评判”，并列出耗时、模型用量、工具失败、证据缺口和官方分数。缩短大段证据回传，避免无关内容占用上下文。
3. 在独立账户或容器中隔离完整上游数据与评判器；复核每题任务前业务初态和宿主工具边界，再重复多轮四题以测稳定性。之后按[官方环境说明](https://servicenow.github.io/webarena-verified/environments/)顺序部署其余三个固定镜像，扩展十二题 pilot。
4. 在相同站点、模型、预算和重复次数下，对比宿主直接使用 Playwright 与宿主使用 ProofKit。已有 CDP 会话不能默认视为从任务起点完整采集；原始 HAR 留在隔离评测目录。

WebArena 衡量任务完成，不能直接衡量发现 Bug、误报和修复验证。后续还要独立的已知缺陷集与修复前后验证，计算缺陷召回、误报和证据充分率。WebArena 不覆盖 Electron 主进程、IPC 或移动端；这些继续保留各自的真实运行验证。
