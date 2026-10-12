# ProofKit 标准验收与失败诊断

状态：2026-10-12 的执行方案。已验证事实与拟建基准分开记录；不得把脚本 fixture、官方任务完成率和真实产品缺陷发现率相加。

## 为什么四题不够

当前 `shopping-admin-4` 是同一站点的四道任务。实际官方成绩为 2/4：0 的宿主 15 分钟超时未提交，108、157 通过，423 提交后失败。四份最终宿主轨迹共完成 83 次 MCP 工具调用，其中 9 次被工具入参契约拒绝；108 和 157 虽通过，也分别有 4、3 次拒绝。这个信号指向工具接口易用性和 Agent 编排成本，但不能单凭它断定任务失败的根因。新的 `benchmark:webarena:diagnose` 把官方报告、宿主超时和工具拒绝合并为紧凑报告，并把根因保留为 `unconfirmed`。

数据集本身也要验收。任务 157 的官方网络判分只检查客户列表路径，不证明逐个客户详情已读。任务 423 的固定预期同时要求商品保存 URL 和看起来属于订单报表的 POST 字段；上游评判器会比较这些字段。它本轮失败是因为 Agent 没有完成修改，尚不能据此断言官方判分误判。用受控的真实 UI 操作校验该题判分前，不将它当成可靠的商品修改质量门槛。

## 参照项目怎样验收

| 项目及可核对来源 | 公开可见的验收做法 | ProofKit 应借鉴的部分 |
| --- | --- | --- |
| [Playwright](https://github.com/microsoft/playwright/tree/main/.github/workflows) | 主测试矩阵覆盖 Chromium、Firefox、WebKit，测试目录含 Electron、Android、MCP、压力测试，CI 按系统和分片运行。 | 协议和适配器需跨浏览器、跨系统、真实进程测试；不能用 Agent 任务分数替代底层可靠性。 |
| [Cypress](https://github.com/cypress-io/cypress/blob/develop/guides/continuous-integration.md) | CircleCI 分单测、Chrome/Firefox/Electron/WebKit 驱动集成、跨浏览器系统测试、框架集成及构建后二进制验证。 | 发布验收要验证最终安装产物和真实宿主，不止源码测试。 |
| [Selenium](https://github.com/SeleniumHQ/selenium/tree/trunk/.github/workflows) | 按 Java、JavaScript、Python、.NET、Ruby、Rust 和 Grid 拆 CI；有定时运行与 flaky 报告。 | 分层记录兼容性、重复运行不稳定性和失败归属。 |
| [Appium](https://github.com/appium/appium/blob/master/.github/workflows/build.yml) | 构建流程发现各包的 `test:e2e`，另跑单测和 lint；实际设备驱动由对应生态验证。 | Electron 和未来移动适配器要有真实运行验收，协议 fixture 只是前置门槛。 |
| [Robot Framework](https://github.com/robotframework/robotframework/blob/master/.github/workflows/acceptance_tests_cpython_pr.yml) | `atest/robot` 验收集在 Linux/Windows、多个 Python 版本运行，失败保留产物。 | 用户级命令和报告本身也要被端到端验收。 |
| [browser-use](https://github.com/browser-use/browser-use/blob/main/.github/workflows/eval-on-pr.yml) | 公开 CI 有浏览器测试；PR 评测触发外部 `InteractionTasks_v8` 平台。该评测数据和结果接口不在该工作流内，不能据此声称可复现的公开门槛。 | Agent 任务能力需要独立评测，但公开基准、版本和原始分母应自己固定。 |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) / [MiniWoB++](https://github.com/Farama-Foundation/MiniWoB-plusplus) | BrowserGym统一多个 Web 基准；MiniWoB++ 提供 100 多个短交互环境和环境奖励。 | 用轻量任务频繁测点击、输入、选择器和恢复；它不能证明跨服务业务结果。 |
| [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) / [OSWorld](https://github.com/xlang-ai/OSWorld) | 前者提供可固定的 Web 任务和官方评判器；后者提供桌面环境任务、配置与评判程序，并有 Verified 更新。 | Web 与桌面任务分别用独立评判；固定镜像/任务/评判版本，审查有疑义的题。OSWorld 环境比当前四题重，待 Electron 基线稳定后引入。 |

这些框架没有一个通用的“自动测试项目标准数据集”或可以照搬的统一通过率。对齐的是验收方法：底层协议矩阵、真实用户任务、独立业务 Oracle、重复运行、失败产物和发布门槛。

## 三层基准组合

1. **引擎契约层，提交即跑。** 保留现有 Web、Electron、MCP、证据、回放、负例和失败注入测试；补跨浏览器/操作系统矩阵及真实 Electron 进程。确定性协议回归必须全绿，任何证据绑定绕过都阻断发布。这层测框架正确性，不产生 Agent 任务成功率。
2. **公开 Agent 任务层，固定分母。** WebArena-Verified 已新增 `shopping-admin-12`：同一 D 盘站点，预先固定 6 道读取、2 道导航、4 道修改题；它尚未运行，任务 0 与 108 是四题批次中的重复题，报告必须单独计分。再按四站点分层扩成至少 40 题的版本化集合。MiniWoB++ 另选一个固定的约 20 题轻量集，测页面操作与错误恢复。两者分别报告，不合并分数；WebArena 的其它站点镜像仍须按 D 盘容量逐个部署。每题至少重复 3 次，固定模型、提示、工具版本、动作/时间预算、站点初态和官方评判器，对比同宿主直接使用 Playwright 的基线。题目选择在运行前冻结，禁止事后剔除失败题。
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

生成流程复用现有的 `inspect_test_scope` 候选审计与外部 `.proofkit/workflows.yaml`：扫描页面入口、bridge/API、worker 状态和持久关系，给每条链路提出成功、拒绝、重试、取消与重复请求情景；再由领域负责人核对预期，导出版本化用例清单。ProofKit 只在外部测试工作区保存连接器、Charter 和合成 fixture，AIHR 源码仓库不需要加入专属测试代码。候选集与正式计分集分开；正式集需要可重建测试部署和独立读数才能晋级。

## 失败归因与回归闭环

一条任务可同时携带多个信号，但只给出一个**观察阶段**和单独的**已确认根因**。阶段依次区分：站点/模型/MCP 不可用、工具入参拒绝、浏览器定位/动作、Agent 超时、证据或提交缺失、官方评判失败、业务 Oracle 失败、评判器疑义。环境阻断、取消和评判器错误不计作产品缺陷；官方失败也不能自动等于 ProofKit 缺陷。报告同时展示固定分母、成功数、工具错误、耗时、证据完整性和每题下一步核查。根因只有经 trace、HAR、独立业务状态及相同条件重跑后才从 `unconfirmed` 升级。

修复流程：保存失败的不可变输入及轨迹 → 人工/自动复核并指定所属能力 → 编写最小复现与修复 → 跑该题 3 次及同类题 → 跑完整固定集并与修复前同预算基线比较 → 检查新失败、误报、耗时与成本。若变更了题目、模型或站点初态，另建新基准版本，不能把两次分数直接相减。

当前第一优先级是**工具契约和 Agent 循环**：四题轨迹中的 9 次工具入参拒绝，具体涉及 `await_test_result.timeoutMs` 上限、Charter 动作/断言 schema，以及 Charter 与临时规划参数互斥。应提供少量稳定的高级浏览器动作、可发现的参数约束、简短终态摘要和失败即明确报错的 MCP 启动检查，然后按完全相同四题重跑；之后才扩展分母。第二优先级是审计 157/423 判分有效性。AIHR 第一批正式用例以普通上传和 Electron “立即运行”两条真实链路为中心，先实现可重置测试租户与独立业务 Oracle。

## 分阶段验收门槛

| 阶段 | 必须交付的可核对结果 |
| --- | --- |
| A：工具可靠性 | Web/Electron 实进程回归与证据审计全绿；同版本四题重跑至少 3 轮，逐轮公开固定分母、工具入参拒绝、超时和耗时。先消除当前已知的入参契约摩擦，再判断任务完成率变化。 |
| B：公开任务 | `shopping-admin-12` 每题至少 3 轮，官方判分与宿主尝试合并、初态重置有记录；MiniWoB++ 固定轻量集另报分数；跨四站点集合在镜像和评判条件校准后运行。同预算直接 Playwright 宿主基线必须同场比较。 |
| C：AIHR 业务 | 隔离租户和合成数据可重建；普通上传与 Electron 立即运行各覆盖成功、预期失败、重试/超时；每个通过都关联本次 Run 和独立后端终态。已知缺陷种子的召回、误报、证据完整率逐项公布，修复前后同集回归。 |
| D：发布级 | 跨系统/浏览器协议矩阵、Electron 真实进程、受控 AIHR 核心流程和公开固定集无未解释的回归；任何新增失败都保留证据与根因状态。移动端待真实设备或模拟器验收后另设门槛。 |

没有行业统一的绝对通过率可直接照搬。第一次完整重复基线建立后再冻结数值阈值；在此之前不得把四题的 50% 或尚未执行的十二题写成发布目标。
