# ProofKit 标准验收与失败诊断

状态：2026-10-13 的执行方案。已验证事实与拟建基准分开记录；不得把脚本 fixture、官方任务完成率和真实产品缺陷发现率相加。

## 为什么四题不够

当前 `shopping-admin-4` 是同一站点的四道任务。实际官方成绩为 2/4：0 的宿主 15 分钟超时未提交，108、157 通过，423 提交后失败。四份最终宿主轨迹共完成 83 次 MCP 工具调用，其中 9 次被工具入参契约拒绝；108 和 157 虽通过，也分别有 4、3 次拒绝。这个信号指向工具接口易用性和 Agent 编排成本，但不能单凭它断定任务失败的根因。新的 `benchmark:webarena:diagnose` 把官方报告、宿主超时和工具拒绝合并为紧凑报告，并把根因保留为 `unconfirmed`。

诊断器现按预先固定的题目意图拆出能力组；历史四题的只读重算保存在 `D:/bench/admin4-capability-diagnosis-20261013/report.html`：读取 1/2（另 1 题超时，6 次入参拒绝）、导航 1/1（3 次入参拒绝）、修改 0/1（已提交但官方失败，0 次入参拒绝）。这只能指示优先调查读取流程的工具摩擦和修改任务的操作/评判，不足以从每组 1–2 题推断稳定成功率或产品根因。

数据集本身也要验收。任务 157 的官方网络判分只检查客户列表路径，不证明逐个客户详情已读。任务 423 的固定预期同时要求商品保存 URL 和看起来属于订单报表的 POST 字段；上游评判器会比较这些字段。它本轮失败是因为 Agent 没有完成修改，尚不能据此断言官方判分误判。用受控的真实 UI 操作校验该题判分前，不将它当成可靠的商品修改质量门槛。

## 参照项目怎样验收

| 项目及可核对来源 | 公开可见的验收做法 | ProofKit 应借鉴的部分 |
| --- | --- | --- |
| [Playwright](https://github.com/microsoft/playwright/blob/main/.github/workflows/tests_primary.yml) | 主测试矩阵覆盖 Chromium、Firefox、WebKit，并按系统和分片运行；另有 [MCP 工作流](https://github.com/microsoft/playwright/blob/main/.github/workflows/tests_mcp.yml)。 | 协议和适配器需跨浏览器、跨系统、真实进程测试；不能用 Agent 任务分数替代底层可靠性。 |
| [Cypress](https://github.com/cypress-io/cypress/blob/develop/guides/continuous-integration.md) | CircleCI 分单测、Chrome/Firefox/Electron/WebKit 驱动集成、跨浏览器系统测试、框架集成及构建后二进制验证。 | 发布验收要验证最终安装产物和真实宿主，不止源码测试。 |
| [Selenium](https://github.com/SeleniumHQ/selenium/tree/trunk/.github/workflows) | 按 Java、JavaScript、Python、.NET、Ruby、Rust 和 Grid 拆 CI；有定时运行与 flaky 报告。 | 分层记录兼容性、重复运行不稳定性和失败归属。 |
| [Appium](https://github.com/appium/appium/blob/master/.github/workflows/build.yml) | 构建流程发现各包的 `test:e2e`，另跑单测和 lint；实际设备驱动由对应生态验证。 | Electron 和未来移动适配器要有真实运行验收，协议 fixture 只是前置门槛。 |
| [Robot Framework](https://github.com/robotframework/robotframework/blob/master/.github/workflows/acceptance_tests_cpython_pr.yml) | `atest/robot` 验收集在 Linux/Windows、多个 Python 版本运行，失败保留产物。 | 用户级命令和报告本身也要被端到端验收。 |
| [browser-use](https://github.com/browser-use/browser-use/blob/main/.github/workflows/eval-on-pr.yml) | 公开 CI 有浏览器测试；PR 评测触发外部 `InteractionTasks_v8` 平台。该评测数据和结果接口不在该工作流内，不能据此声称可复现的公开门槛。 | Agent 任务能力需要独立评测，但公开基准、版本和原始分母应自己固定。 |
| [Stagehand](https://github.com/browserbase/stagehand/tree/main/packages/evals) | 独立 eval 包区分 `act`、`extract`、`observe`、`agent` 和数据集；支持 WebVoyager、OnlineMind2Web、WebTailBench、Odysseys、HardBench，按任务重复和模型汇总。其 [CI 回归 job](https://github.com/browserbase/stagehand/blob/main/.github/workflows/ci.yml) 配置 3 次试验，并以该项目 Braintrust 主分数 80% 作为自身门槛；[HardBench](https://github.com/browserbase/stagehand/blob/main/packages/evals/datasets/hardbenchmark/README.md) 有 38 题核心集、102 题扩展集。 | 将 Agent 能力集与协议测试分离，固定任务选择、模型、试验次数、成本及可比较的基线；80% 只属于它自己的任务和评分规则，不能照搬成 WebArena 分数线。 |
| [Midscene](https://github.com/web-infra-dev/midscene/tree/main/.github/workflows) | 分开运行 AI 单测、Web E2E、Windows/macOS 桌面及 Android/iOS 模拟器流程；[Android CI](https://github.com/web-infra-dev/midscene/blob/main/.github/workflows/android-emulator.yml) 检查构建产物、模拟器 TodoMVC、诊断和 HTML 报告。 | Web/Electron 的真实进程与打包产物都应验收，未来移动端需要模拟器或真机任务；失败要保留可复核的产物。 |
| [Maestro](https://github.com/mobile-dev-inc/Maestro/blob/main/.github/workflows/test-e2e.yaml) | 发布前从构建产物运行 Web、Android、iOS E2E，并上传运行产物。 | 跨端能力应以可安装产物和真实目标环境的流程验证，不只验证适配器 API。 |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) / [MiniWoB++](https://github.com/Farama-Foundation/MiniWoB-plusplus) | BrowserGym统一多个 Web 基准；MiniWoB++ 提供 100 多个短交互环境和环境奖励。 | 用轻量任务频繁测点击、输入、选择器和恢复；它不能证明跨服务业务结果。 |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) / [OSWorld](https://github.com/xlang-ai/OSWorld) | 前者提供可固定的 Web 任务和官方评判器；后者提供桌面环境任务、配置与评判程序，并有 Verified 更新。 | Web 与桌面任务分别用独立评判；固定镜像/任务/评判版本，审查有疑义的题。OSWorld 环境比当前四题重，待 Electron 基线稳定后引入。 |

这些框架没有一个通用的“自动测试项目标准数据集”或可以照搬的统一通过率。对齐的是验收方法：底层协议矩阵、真实用户任务、独立业务 Oracle、重复运行、失败产物和发布门槛。

## 三层基准组合

1. **引擎契约层，提交即跑。** 保留现有 Web、Electron、MCP、证据、回放、负例和失败注入测试；补跨浏览器/操作系统矩阵及真实 Electron 进程。确定性协议回归必须全绿，任何证据绑定绕过都阻断发布。这层测框架正确性，不产生 Agent 任务成功率。
2. **公开 Agent 任务层，固定分母。** WebArena-Verified 已准备 `shopping-admin-12` 和多样性更高的 `shopping-admin-24`；后者为 10 道读取、4 道导航、10 道修改，各来自不同意图模板，结构审计和批次计划已通过，官方成绩尚未测量。24 题新增日期筛选及复杂表单，需校准真实 UI 正例后成为正式计分集。再按四站点分层扩成至少 40 题的版本化集合。MiniWoB++ 另选一个固定的约 20 题轻量集，测页面操作与错误恢复。两者分别报告，不合并分数；WebArena 的其它站点镜像仍须按 D 盘容量逐个部署。每题至少重复 3 次，固定模型、提示、工具版本、动作/时间预算、站点初态和官方评判器，对比同宿主直接使用 Playwright 的基线。题目选择在运行前冻结，禁止事后剔除失败题。
3. **AIHR 真实业务层，隔离测试租户。** 基于本地源码和现有外部工作区连接器构造合成简历、岗位、候选人和账务数据。记录 UI 动作、同次 Run 的网络响应、异步最终状态、候选人/岗位/文件身份、评估及计费的独立读数。另建已知缺陷种子和修复前后副本，衡量缺陷召回、误报、证据完整率与修复回归。真实平台账号、网关、数据库和 worker 的隔离初态未备齐之前，样例 Charter 只算候选用例，不算通过的业务验收集。

### AIHR 第一批候选用例

来源已核对：`apps/micro-resume-collection/src/components/BossResumeCollection.vue` 的“立即运行”按钮，经前端 bridge 调用 `POST /api/v1/resume-collection/runs`；`services/resume-collection-service/internal/http/router/router.go` 暴露 Run/File 接口，File 上传读取 `client_item_key`；现有 `tests/e2e/resume_collection_flow_test.go` 仅覆盖数据库支持下的创建 Run、上传和读取，不覆盖异步 worker 最终业务状态。ProofKit 已有五份 AIHR 参考 Charter 和独立网关 Oracle，但未在完整隔离部署上验收。

| 组 | 候选情景 | 必需的独立判定 | 当前准备度 |
| --- | --- | --- | --- |
| UI/桌面 | 页面可见性、手动运行确认、点击后创建本次 Run | 当前 renderer 的响应与 Run ID 一致，未借用历史成功 | 有参考 Charter；真实 CDP/测试账号待验 |
| 普通上传 | 合成 PDF → 抽取/解析 → 候选人 → 岗位绑定 → 评估 | 文件、Run、岗位、候选人和评估的身份与终态一致 | 有连接器与参考 Charter；完整 worker 待验 |
| 重复与重试 | 相同 `client_item_key` 重传、worker 先重试后完成 | 以实际契约核验幂等对象和一次计费；等待态不提前判成功 | 有幂等 Charter；初态/账务 fixture 待验 |
| 失败与取消 | 无效文件、评估失败、Run 取消、网关/worker 中断 | 区分产品失败、预期拒绝、用户取消和环境阻断 | 需分别固定注入点与终态预期 |
| 在线简历 | 会话在线简历初筛、附件接替当前文件 | 用阶段身份和历史事实核对；不把合法文件替换报成缺陷 | 仅在线阶段有参考 Charter；附件全链路待建 |
| 手工录入/计费 | 手工候选人录入、岗位关系、评估计费 | 独立读数和精确作用域；任何重试须先审查副作用 | 有参考 Oracle；不可直接对生产数据运行 |

每个正式用例必须有稳定 ID、固定合成输入、源码契约/业务预期、重置步骤、允许的副作用、时间上限、独立 Oracle、证据字段和清理检查。模型可以从源码提出新用例，但进入计分集前必须经人工复核 Oracle 与初态；“模型说成功”不能作为标准答案。

已保存 **[AIHR 候选 v0.1](aihr-core-candidates.json)（12 例，不计分）**：`W01` 简历页可见且配置错误可识别；`E01` Electron“立即运行”产生本次 Run；`E02` 登录失效/风险确认下不误报启动；`R01` PDF 上传到候选人、岗位和评估终态；`R02` 同一 `client_item_key` 重试幂等；`R03` 非法文件在写入前拒绝；`R04` worker 瞬时故障后恢复；`R05` worker 终态失败如实呈现；`O01` 在线简历阶段完成；`O02` 附件接替在线文件时保留正确阶段身份；`M01` 手工候选人录入及五个身份关联；`B01` 评估重试后恰好一次计费。清单记录源码快照、入口、合成 fixture、独立 Oracle 和当前准备缺口。`O02` 需要历史/阶段读数，`E01` 需要真实 CDP 与请求关联，`R04/R05` 需要隔离故障注入；这些条件满足前只保存候选，绝不把源码扫描结果写成已通过的测试。当前已有的 AIHR 参考 Charter、连接器和源码链路图可以作为生成起点，测试数据与执行工作区仍放在 AIHR 仓库之外。

生成流程复用现有的 `inspect_test_scope` 候选审计与外部 `.proofkit/workflows.yaml`：扫描页面入口、bridge/API、worker 状态和持久关系，给每条链路提出成功、拒绝、重试、取消与重复请求情景；再由领域负责人核对预期，导出版本化用例清单。ProofKit 只在外部测试工作区保存连接器、Charter 和合成 fixture，AIHR 源码仓库不需要加入专属测试代码。候选集与正式计分集分开；正式集需要可重建测试部署和独立读数才能晋级。

2026-10-13 的只读扫描已保存到 `D:/bench/aihr-scope-electron-core-20261013.json`：当前 AIHR Git HEAD 为 `dc781c3`，工作树另有未提交改动；ProofKit 扫描 2110 个文件，识别 61 个入口和 239 个去重路由候选，外部工作区有 6 个注册 Oracle、3 个未登记 core Charter。三份 Charter 均缺少明确 `surfaces` 且需要写入授权，其中两份还缺正向 UI 断言；`planningReadiness=authoring-needed`、`testVerdict=not-asserted`。这些是真实生成的**测试范围候选及缺口**，不是十二例可执行基准，更不是 AIHR 业务成绩。下一步先在隔离环境中修订 Charter、合成 fixture 和 Oracle，再冻结 v1 计分集。

## 失败归因与回归闭环

一条任务可同时携带多个信号，但只给出一个**观察阶段**和单独的**已确认根因**。阶段依次区分：站点/模型/MCP 不可用、工具入参拒绝、浏览器定位/动作、Agent 超时、证据或提交缺失、官方评判失败、业务 Oracle 失败、评判器疑义。环境阻断、取消和评判器错误不计作产品缺陷；官方失败也不能自动等于 ProofKit 缺陷。报告同时展示固定分母、成功数、工具错误、耗时、证据完整性和每题下一步核查。根因只有经 trace、HAR、独立业务状态及相同条件重跑后才从 `unconfirmed` 升级。

修复流程：保存失败的不可变输入及轨迹 → 人工/自动复核并指定所属能力 → 编写最小复现与修复 → 跑该题 3 次及同类题 → 跑完整固定集并与修复前同预算基线比较 → 检查新失败、误报、耗时与成本。若变更了题目、模型或站点初态，另建新基准版本，不能把两次分数直接相减。

当前第一优先级是**工具契约和 Agent 循环**：四题轨迹中的 9 次工具入参拒绝，具体涉及 `await_test_result.timeoutMs` 上限、Charter 动作/断言 schema，以及 Charter 与临时规划参数互斥。应提供少量稳定的高级浏览器动作、可发现的参数约束、简短终态摘要和失败即明确报错的 MCP 启动检查，然后按完全相同四题重跑；之后才扩展分母。第二优先级是审计 157/423 判分有效性。AIHR 第一批正式用例以普通上传和 Electron “立即运行”两条真实链路为中心，先实现可重置测试租户与独立业务 Oracle。

2026-10-13 已加入单步 Web/Electron 探索工具并通过真实进程回归；但随后两次 Codex 任务 423 和一次 Claude Code 任务 374 均在首次 MCP 调用前被宿主认证阻断，保留于 `D:/bench/host-run-423-regression-001`、`-002` 和 `D:/bench/host-run-374-claude-001`。这三次不产生官方提交或新成功率。恢复可用的独立宿主认证后，须从固定镜像逐题重建并完成同宿主四题回归，然后才运行十二题和三次重复；不能把本轮框架 smoke 的通过当成 Agent 改进证据。

## 分阶段验收门槛

以同类项目的公开做法为参照，先达到三个可核对门槛：**Playwright 式底层矩阵**（Web/Electron 的真实进程、跨浏览器/系统和可安装产物）、**Midscene/Maestro 式流程验收**（真实目标、失败产物与报告）、**Stagehand 式重复 Agent 评测**（固定任务、模型和三次试验）。ProofKit 目前仅完成部分底层真实进程检查与官方评判接口集成；固定四题有一次 2/4 的历史观测，24 题只完成准备和结构审计，尚无三轮重复、跨浏览器/系统矩阵或 AIHR 正式业务成绩。不能把其它项目各自的 80% 一类阈值挪到不同数据集上。

| 阶段 | 必须交付的可核对结果 |
| --- | --- |
| A：工具可靠性 | Web/Electron 实进程回归与证据审计全绿；同版本四题重跑至少 3 轮，逐轮公开固定分母、工具入参拒绝、超时和耗时。先消除当前已知的入参契约摩擦，再判断任务完成率变化。 |
| B：公开任务 | `shopping-admin-12` 每题至少 3 轮，官方判分与宿主尝试合并、初态重置有记录；MiniWoB++ 固定轻量集另报分数；跨四站点集合在镜像和评判条件校准后运行。同预算直接 Playwright 宿主基线必须同场比较。 |
| C：AIHR 业务 | 隔离租户和合成数据可重建；普通上传与 Electron 立即运行各覆盖成功、预期失败、重试/超时；每个通过都关联本次 Run 和独立后端终态。已知缺陷种子的召回、误报、证据完整率逐项公布，修复前后同集回归。 |
| D：发布级 | 跨系统/浏览器协议矩阵、Electron 真实进程、受控 AIHR 核心流程和公开固定集无未解释的回归；任何新增失败都保留证据与根因状态。移动端待真实设备或模拟器验收后另设门槛。 |

没有行业统一的绝对通过率可直接照搬。第一次完整重复基线建立后再冻结数值阈值；在此之前不得把四题的 50% 或尚未执行的十二题写成发布目标。
