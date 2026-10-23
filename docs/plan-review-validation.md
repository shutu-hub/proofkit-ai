# 首次规划状态与下一步验收

日期：2026-10-21。针对开发者体验审查中“默认plan只生成导航/观察草稿，却以0退出”的问题，本阶段为现有CLI和MCP规划入口提供统一的结构状态，不引入新的执行入口，也不把规划就绪变成产品通过。

## 用户行为变化

~~~text
proofkit plan "新增私有笔记，刷新后验证保存内容" --root <source> --workspace <workspace> --url <target> --format json --out draft.yaml
~~~

上面仍默认core要求。若没有实际流程、正向页面结果或独立业务读数，返回needs-input，退出2；JSON包含原Charter、gaps、missingInputs和action/reason形式的next。默认deterministic模式会明确解释它仅提供导航/观察骨架，应由宿主根据观察编写流程或显式配置模型，不能通过添加一条页面文案就把业务要求改判通过。

| 状态 | CLI退出码 | 含义 |
| --- | --- | --- |
| needs-input | 2 | 草稿仍缺规划信息；补齐缺项，保持原意图 |
| ready-for-review | 0 | 声明的计划结构没有报告缺口；仍需审阅、环境/认证/数据与连接器前提检查 |
| needs-observation | 2 | 原有模型观察续接；按原来源取得新观察，不生成最终Charter |

前两项共享scope=plan-structure、testVerdict=not-asserted、executionStarted=false。后一项保留原观察回执语义。没有产品测试通过状态。needs-input和ready-for-review都带有notEstablished，列出本结果不能建立的环境、认证、数据、业务结果、请求证据可用性及意图语义完整性；这不否认规划前可能已经发生的只读页面观察。

默认stdout继续只输出可解析YAML；状态、缺口、缺项和下一步写到stderr。--format json返回统一JSON；--out始终保存可编辑YAML，包括未完成草稿。needs-observation仍不覆盖请求的Charter输出。调用方不得继续以“plan退出0”解释产品通过，也不得丢弃退出2后的草稿。

## 实现范围

新增共享summarizePlanReview，读取规划路径已经重算的缺口，补查正向断言、core/release独立读数、release负向场景和观察中未绑定的目标。不靠置信度提升状态，旧版未评估计划保持needs-input，未知缺口保留。此摘要是面向审阅的结构投影，不另建一套业务验收规则，也不取代Mission readiness或执行时独立证据审计。

MCP plan_test继续返回charter，同时增加上述状态和下一步；未新增工具。随安装生成的宿主Skill、README及接入说明同步解释这三个阶段，并指引按缺项修正计划而非强行批准Mission。

## 工程检查

最终类型检查、所有包/分发bundle构建通过；全量1,677个Vitest与16个Node测试通过。新增9个规划状态用例、4个CLI输出/退出码用例和2个MCP状态用例。覆盖默认骨架、只有页面正例的quick、core独立业务读数、release负向场景、缺少断言/仅负向断言、未评估与未知缺口、未绑定观察、不修改输入、JSON与YAML、无效输出格式在加载配置前拒绝等。

日志 ../outputs/plan-review-typecheck.log、../outputs/plan-review-bundle.log、../outputs/plan-review-tests.log；定向日志plan-review-planner-tests.log、plan-review-cli-tests.log和plan-review-mcp-tests.log保存前一接口命名阶段结果，最终全量使用notEstablished字段。

## 真实命令入口验收

脚本tests/plan-review-entry-smoke.mjs从全新源码/workspace调用bundle/main.js和独立stdio MCP进程：

- core新增笔记请求的JSON和默认YAML均退出2；YAML草稿确实保存，JSON说明author-workflow、define-surface-outcome和connect-business-check。
- 明确的quick正向页面计划退出0并显示ready-for-review，保持not-asserted和executionStarted=false；不声称业务终态已验证。
- MCP计划返回与CLI一致的两种状态。将缺项core请求交给run_test仍停在awaiting-approval、readiness.ready=false、running=false、not-asserted；next不建议approve或start绕过缺口。
- 所有步骤目标HTTP请求0、项目start脚本未执行、没有执行Run目录；未就绪Mission的保存本身不是执行。

命令pnpm test:smoke:plan-review。最终回执 ../outputs/plan-review-entry-validation.json，日志 ../outputs/plan-review-entry.log。它证明规划状态和门禁衔接，没有打开浏览器、验证业务或测量新用户完成率。

## 安装包与既有流程

pnpm test:distribution实际npm pack、全新目录安装，仅用安装包的CLI和stdio MCP验收。新增检查确认CLI JSON草稿/待审状态，完整项目规划返回2且保留覆盖缺口，MCP给出同样范围和未执行声明；旧接入、Skill安装、原生配置、环境检查和源文件不变等门禁也通过。日志 ../outputs/plan-review-distribution.log。

变更后另跑两个既有流程：

1. tests/planning-continuation-cli-smoke.mjs跨独立CLI进程保存并恢复原意图和两个观察，初次缺观察退出2、完成规划退出0，只有2次fixture模型调用和0次应用写入；改写原意图拒绝。日志 ../outputs/plan-review-continuation-cli.log，脚本回执outputs/planning-continuation-cli-validation.json指向本轮新实例。
2. tests/multi-state-planning-smoke.mjs的真实headful Edge、MCP、两个复用selector的页面仍通过；探索订单写入0，正式写入1，独立GET、所选请求/响应事实、录像封存及清单核验通过。Mission mission-d8634db0-d4a，Run20261021143444-2fe57da3，日志 ../outputs/plan-review-browser.log。这个阶段没有重新做该新录像的媒体播放验收，故只声明脚本验证的封存和摘要事实。

两者均为本地受控应用与确定性模型fixture的工程回归，不是新公开网站、未见应用自主规划或生产级成绩。

## 剩余目标

默认规划输出现在能解释草稿缺什么、下一步做什么，但仍未替开发者生成完整可靠的业务流程。未知站点的语义规划和分支覆盖、少量必要澄清、真实外部测试资源/认证收尾、多Mission原始意图汇总、完整首次测试体验和可移交证据仍需持续推进。不能以ready-for-review替代这些要求；Goal保持active。
