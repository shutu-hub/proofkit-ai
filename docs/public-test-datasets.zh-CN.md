# ProofKit 公共测试集选型与接入

检索日期：2026-10-14。下面的优先级依据当前项目的 Web/Electron 执行器、业务证据要求和移动端能力判断；不是各基准的官方排名。

当前自建评测集中在简历获取及其证据链。公共测试集可以补充不同页面、操作和任务结构，但只有实际运行并用可信的预期结果评分，才能发现能力缺口。下载任务、生成计划、脚本执行、真实宿主模型完成任务应分别报告。

## 值得使用的公开资源

| 测试集 / 官方入口 | 能补充什么 | 运行条件与项目适配判断 | 本次状态 |
| --- | --- | --- | --- |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | 100 多种小型网页交互环境，可变化文本、控件和布局 | 静态 HTML 可本地运行；本次直接复用官方页面和评分状态，通过现有 Playwright 适配器执行，不安装其 Python/Selenium 运行层 | 已接入 6 类任务的脚本回归 |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) | 812 个真实网站形态的任务、258 个困难子集；回答与网络轨迹的确定性评分 | 适合长期衡量检索、导航、写入任务；需要可重置站点及官方 evaluator，原始数据不能直接当成 Charter | 已下载、校验并导出无参考答案的任务输入，未执行站点任务 |
| [WorkArena / WorkArena++](https://github.com/ServiceNow/WorkArena) | ServiceNow 企业流程；L1 为 33 类任务 / 19,912 个实例，组合任务为 682 类 | 适合表单、列表、后台状态与多步业务流程；需要独立的 ServiceNow 实例及配置 | 已调研，待企业环境 |
| [Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) | 137 个网站、31 个领域、2,000 多项任务和人工操作序列 | 适合离线评测指令理解、元素定位与下一步操作；录制操作本身不能证明当前业务状态或缺陷发现能力 | 已调研，待规划/定位评测接口 |
| [VisualWebArena](https://github.com/web-arena-x/visualwebarena) | 依赖图片与视觉理解的网页任务 | 需要自托管站点及多模态代理；当前更适合作为未来截图理解与视觉定位的扩展 | 已调研，待视觉操作能力 |
| [AndroidWorld](https://github.com/google-research/android_world) | 20 个真实 Android 应用、116 类任务及参数变化 | 使用真实模拟器和应用状态评分；适合补齐当前假 WebDriver 夹具无法证明的真实设备链路，需适配 Appium/W3C 动作 | 已调研，待模拟器接入 |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | 完整桌面环境中的跨应用任务 | 需要虚拟机/桌面操作层；当前 Electron DOM/CDP 适配器不能直接执行整套原生桌面任务 | 已调研，待桌面适配器 |
| [TestGenEval](https://github.com/facebookresearch/testgeneval) / [数据](https://huggingface.co/datasets/kjain14/testgeneval) | 11 个 Python 仓库中的 1,210 对代码/测试文件，评测测试生成、覆盖提升及 mutation score | 适合以后加入单元测试生成能力；目前 ProofKit 主要执行系统 Charter。上游说明主体代码使用 CC-by-NC，第三方文件另有许可，应按所用文件核对 | 已调研，未纳入下载器或分发包 |
| [BugsJS](https://bugsjs.github.io/) / [数据与框架](https://github.com/BugsJS/bug-dataset) | 10 个 Node.js 项目中的 453 个可复现真实缺陷 | 适合验证“缺陷版能抓到、修复版能通过”；需要隔离老版本 Node/依赖及真实项目命令，不能等同于浏览器任务 | 已调研，待代码执行测试能力 |

[BrowserGym](https://github.com/ServiceNow/BrowserGym) 是多个浏览器基准的统一运行框架，可以参考其任务生命周期与接口；它不是另一个独立测试集。现阶段接入 MiniWoB 不需要增加 Python 运行时依赖。

## 本次接入方式

数据版本与每个文件的 SHA-256/字节数保存在 [sources.lock.json](../tests/datasets/sources.lock.json)。下载器只取固定提交中的锁定文件，保留上游 LICENSE，发现本地内容变化时停止，不覆盖缓存。总下载量 1,821,296 字节，约 1.74 MiB；没有下载站点 Docker 镜像、虚拟机或全量网页录制数据。

| 数据 | 固定提交 | 内容 |
| --- | --- | --- |
| MiniWoB++ | `33c3b4ddef8c6eb67c57a29663d844b1eda7e614` | 6 个官方页面、运行依赖与 LICENSE，20 个文件，879,912 字节 |
| WebArena-Verified | `6473f72db5dcefc97b5725b59e734504edc28a21` | 全量定义、困难子集 ID 与 LICENSE，3 个文件，941,384 字节 |

```bash
# 下载两份固定版本数据；已校验的本地文件会复用
pnpm benchmark:datasets:fetch

# 单独下载 MiniWoB，或离线校验已有缓存
pnpm benchmark:datasets:fetch --dataset miniwob
pnpm benchmark:datasets:fetch --check

# 检查 WebArena-Verified 数据、导出任务输入
pnpm benchmark:datasets:inventory

# 构建项目并执行 MiniWoB 回归
pnpm benchmark:miniwob

# 已构建时可直接执行，或缩小排查范围
node tests/miniwob-benchmark.mjs --tasks enter-text,login-user --seeds 42

# 校验缓存完整性和严格评分逻辑的测试
pnpm test:benchmark-datasets
```

Windows 默认使用 `C:/Program Files/Google/Chrome/Application/chrome.exe`；其他路径通过 `PROOFKIT_BROWSER_PATH` 设置。非 Windows 可使用 Playwright 已安装的 Chromium，或显式指定浏览器。下载缓存位于 `.proofkit/datasets/<数据名>/<提交>/`，不进入 Git 或 npm 分发包。下载之后，MiniWoB 回归与数据清单检查可以离线运行。

### MiniWoB：新增的可执行回归

包含 `click-test-2`、`enter-text`、`enter-password`、`login-user`、`click-checkboxes`、`click-option`。默认种子 `0,42,123`，每种任务/种子都跑正确提交、错误提交、未提交三种路径，共 54 个 Run。

脚本从页面公开指令和控件读取操作参数，所有待测操作通过真实 `WebAdapter` 与 `ExecutionRunner` 执行。初始化使用官方 START 生命周期和固定随机种子；不修改官方页面、评分函数或奖励变量。官方时间限制不变。预期分别为 `passed`、`failed`、`inconclusive`。

任务 Oracle 要求本次 episode 已终止、episode ID 为 1、原始奖励恰好为 1。勾选题只错一个选项可能仍得到正分，因此不能用 `reward > 0` 判通过；未提交时的零奖励不能判为缺陷。错误路径必须完成所有动作和页面断言，并有本次官方状态的来源证据；动作错误、超时和缺少证据会使回归检查失败。

每次运行保存 `.proofkit/benchmarks/miniwob-<时间>-<PID>/report.json` 及其 `runs/` 中的 Charter、动作记录、截图、事件、Oracle 来源和 Run 报告。汇总包括完成数量、未完成情况和错误路径被报通过的次数。Ubuntu CI 运行同样的 54 个案例，失败时上传证据。

2026-10-14 本地 Chrome 验证：默认矩阵 **54/54** 符合预期，错误/未完成路径误报通过 **0** 次。其中错误勾选案例的原始奖励分别为 `0.6`、`0`、`2/3`，均判为 `failed`；两个正的部分分数没有被接受。项目构建、5 个数据/评分测试、下载补齐与离线校验均通过；812/258 条导出输入也已核对不含 evaluator/参考答案字段。新增 Ubuntu CI 步骤尚未在远程执行。

**结果边界：**这是脚本驱动的兼容性与 verdict 回归，不是宿主模型任务成功率，也不是整个 MiniWoB 的基准成绩。Oracle 读取同一网页的官方评分状态，标记为 contract 证据，并采用 `quick` Charter；它不满足真实应用 `core` 验收所需的独立后台业务事实。

### WebArena-Verified：已获取，尚未执行

当前固定版本包含检索 `retrieve` 325 项、导航 `navigate` 113 项、写入 `mutate` 374 项。涉及购物前台/后台、GitLab、Reddit、地图和 Wikipedia；多站点任务在站点统计中会重复计数。

清单脚本校验 812 个唯一任务 ID 和 258 个唯一困难子集 ID，确保子集引用有效，并导出：

- `inventory.json`：版本、任务数量、站点、任务类型和 evaluator 统计，执行状态为 `not-run`。
- `task-prompts.jsonl`：812 条任务输入。
- `hard-task-prompts.jsonl`：258 条困难子集输入。

三个文件保存在 `.proofkit/benchmarks/dataset-inventory-<时间>-<PID>/`。任务输入只保留 ID、指令、站点、起始 URL 和版本；`eval` / 参考答案保留在原始数据文件，供外部评分器读取，避免提供给执行代理。原始 `__SHOPPING__` 等 URL 标记保留，配置站点之后才能绑定。

下一阶段应选择一个站点及少量任务，完成环境初始化/重置、ProofKit 原生执行、任务回答与网络轨迹记录，再调用官方确定性评分器。现有结构化网络证据经过脱敏，不等同于官方评分所需的完整 HAR；需要专门设计隔离测试环境内的轨迹输出，不能直接宣称已支持官方全量评分。

## 用测试集驱动改进

先固定任务和评分方式建立基线，再依据失败证据改进控件发现、动作计划、等待策略或结果验证，并重跑相同版本。新增任务应保留未用于调整的种子/任务作为留出集，分别统计环境失败、代理失败和产品缺陷发现。

后续真实宿主评测可复用 MiniWoB 环境，向宿主仅提供任务指令及允许的工具，隐藏脚本驱动器和评分状态。只有真实宿主通过 ProofKit 工具产生的操作与报告，才计入模型成绩。WebArena 进一步需要独立站点环境及官方评分结果。测试集用于发现和验证缺口；接入数据本身不会训练或修改模型权重。
