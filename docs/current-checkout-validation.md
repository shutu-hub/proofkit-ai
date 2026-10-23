# 当前构建的完整结账重复实测

本记录对应Mission概览修复前的构建。该阶段三次原始结果保留，汇总/渲染/结果快照位于 `outputs/late-actions-prior-checkout-review/`；原根目录是 `C:/Users/殊途/AppData/Local/Temp/proofkit-toolshop-checkout-current-8FIbDX`。当前指针和最新汇总已推进到后续构建，不再指向本文三次执行；新构建复验及34步概览验收见 `docs/late-actions-validation.md`。

北京时间 2026-10-21。承接用户要求的复杂网站测试，以及前两阶段的独立字段验收与意图力度修复。本阶段实际重跑完整业务链，没有以商品页通过替代订单验收。通用 Web 测试与证据闭环 Goal 保持 active。

## 范围与结果

目标为公开 Toolshop 测试演示站 https://practicesoftwaretesting.com/。使用独立浏览器上下文、访客购物车和各自冻结的合同，连续执行三次同一场景。每次正式 Mission 从已经通过 UI 准备、独立核对的两行购物车开始：重新登录、重开结算、等待保存地址与邮编响应、检查五个最终值、模拟货到付款、创建订单，随后独立读取当前订单。

| 样本 | Mission | Run | 订单 | 正式动作 | 正式耗时 |
| --- | --- | --- | --- | --- | --- |
| 1 | mission-588fd80a-287 | 20261020202624-03aa3e2c | INV-2026000012 | 34/34 通过 | 17.085 秒 |
| 2 | mission-e9e9d229-e8a | 20261020202731-cfee3379 | INV-2026000013 | 34/34 通过 | 17.537 秒 |
| 3 | mission-047fb2d3-476 | 20261020202846-45438ca0 | INV-2026000014 | 34/34 通过 | 16.429 秒 |

订单 ID 分别为 01m5dfx8hn0dqsmznpw0tz5ant、01m5dfz9hb03kt22t40cjwnmte、01m5dg1jkfnhmw8qe38kwjns5d；三个购物车和订单均不同。每个样本有七个 Mission，其中三条准备购物车并带独立业务检查，三条观察登录/账单/付款状态，最后一条正式完整验收。21 个 Mission 不是 21 个独立题型，不计算为 Agent 成功率。

本轮没有新增产品运行时代码；新增的是可复验脚本、独立审查与报告。所有浏览器动作经 ProofKit LocalRunnerService 的持续会话、原始观察绑定、Charter 规划/准入和正式 Mission 路径执行。宿主依据已知场景编写模板并用新观察绑定，不是未知站点首次自主规划证明。

## 未弱化的业务要求

- 两种商品：Combination Pliers 单价 $14.15，数量 3；Hammer 单价 $12.58，数量 1；最终总计 $55.03。
- 商品身份取自本次页面观察，并经正式运行前独立 GET 对照；不沿用过期目录 ID。名称、单价、数量和总额与原完整验收范围一致。
- 账单 street 为 ProofKit Demo Street；country 为 US；postal_code 为 94105。city/state 通过当前部署的执行前只读邮编接口冻结，结果为 Briannechester / Alabama。
- 每次使用独立购物车，要求 invoice POST 中的 cartId 等于该准备购物车，method 等于 cash-on-delivery。付款方式是提交合同检查，不声称独立账务持久化或真实付款。
- 身份必须是本次响应捕获的 invoice ID 和 invoice number。独立当前订单必须包含恰好两行商品、精确数量及预期金额，同时核对响应金额和五个请求/独立记录账单字段。
- 34 个动作、三个稳定值检查及国家/邮编检查、两个最终 UI 断言、独立 Oracle 名称、力度和允许的副作用均保留。审查将执行的动作列表与执行前 Charter、原34步模板比较，仅排除新观察标识/目标身份并允许执行前冻结的 city/state 值。

三个独立 reader 均报告 matchedItems=2、observedItems=2、totalMatches=true、responseTotalMatches=true、requestMatches=true、billingMismatches=[]。记录状态为 AWAITING_FULFILLMENT，验收范围是正确创建订单，不是发货完成。

独立 reader 没有保存原始账单值，只保存比较结果及独立响应正文 SHA-256。本报告分别展示冻结预期、捕获的请求值及独立比较结果，不补造独立地址原值。已有业务 reader 的三个 Node 保护性测试确认错误商品/数量/金额、地址覆盖、错误购物车和付款方式不能通过。

## 冻结与证据复核

每个样本的 frozen-intent-contract.json 与 frozen-formal-charter.json 在正式执行前保存，合同摘要进入正式 Charter。购物车准备按顺序经过：创建两个钳子、添加一个锤子、把钳子数量改为三、重开结算后读取核对。正式动作前再次独立 GET 确认完整两行与数量。

脚本执行前固定全部 packages/*/dist 下的 JavaScript、执行脚本、业务 reader 与 pnpm-lock.yaml，共 215 个摘要项；执行结束和报告复核时均一致。这覆盖本仓库选择的编译 JavaScript 和输入文件，不认证外部依赖、浏览器二进制、操作系统或远端部署。测试目标是 URL-only 宿主，不声称拥有远端源码部署身份。

所有会话及辅助进程已结束。关闭前后正式执行摘要一致；会话关闭向派生报告补充录像入口后，以关闭回执中的最终 manifest 复核。三个正式 Run、三个会话捕获以及九个准备购物车的 Run 清单均 intact。完整性只证明本地保存字节与固定清单一致，不构成外部防篡改认证。

每次正式 Run 捕获四个 action-window 响应：登录200、邮编200、模拟付款检查200、创建订单201；每个绑定窗口均只有一个匹配请求。订单捕获保留七个已声明请求字段、三个响应字段及正文摘要。这个计数不证明整个网站的请求总数，也不代表网络捕获完整。

三个会话网络均 partial，关闭分别有10个未结请求，已收集事件810、810、813。没有用可播放录像或 intact 清单覆盖这个缺口。订单后对各自购物车的独立 GET 均为404，没有再发 DELETE 伪装应用清理，也不声称订单被删除。

## 保留的首次失败

首次系列在样本1准备阶段失败，样本2和3未执行。原因是我在复验脚本中把 Combination Pliers 设为全局 readyWhen，Hammer 详情页不满足该条件，页面观察超时。此时尚未运行正式结账，也没有生成订单，不能称作产品业务缺陷。

保留整个失败结果、回执、录像、清单和执行脚本副本，副本摘要与首次开始记录一致。关闭会话后，独立重读当前访客购物车并核对本次商品/数量，再仅删除该捕获ID：DELETE204，随后GET404。修正只移除错误全局就绪条件并使用逐页等待，没有放宽正式业务验收；随后在新根目录从头执行三次冻结样本。

outputs/toolshop-current-checkout-attempts.json 保留两次系列及结果摘要，失败日志为 outputs/toolshop-current-checkout-attempt-1.log。首次失败不从开发记录中删除，也不并入三个最终样本伪造无失败成功率。

## 报告与实际回放

生成器 tests/toolshop-current-checkout-review.mjs 独立验证合同、动作计划、源事实、各份清单、版本摘要与封存 lineage，生成 outputs/toolshop-current-checkout-review.html 和同名 JSON。最终 stageVerified 为 true，goalComplete 为 false。

报告列出三次结果、五个账单字段对照、四个关键响应的动作入口、截图、各自会话录像及完整 Run/Mission。tests/toolshop-current-checkout-report-smoke.mjs 用真实 Edge 解码所有内嵌截图和实际视频帧，播放穿过三个正式 Run 的完整时间窗口：

| 样本 | 会话录像时长 | 正式 Run 窗口 |
| --- | --- | --- |
| 1 | 69.32 秒 | 50.568–67.653 秒 |
| 2 | 67.56 秒 | 48.132–65.669 秒 |
| 3 | 73.48 秒 | 54.805–71.234 秒 |

时间按墙钟估算，不是精确帧与动作的因果绑定。正式耗时不包含各自的准备和观察。

最终渲染检查：汇总报告1280/390宽无页面横向溢出，窄屏表格在容器内滚动；三张汇总截图、三个完整Run各34张截图、三个Mission各两张已选截图均解码成功。七个invoice请求字段按JSON解析比值，三个完整报告的第33步证据锚点可访问。结果在 outputs/toolshop-current-checkout-render-verification.json，截图在同前缀 desktop/mobile/video-1/video-2/video-3 PNG。

报告检查发现两个验证假设：请求 JSON 实际为紧凑格式，原测试错误地要求冒号后空格，现改为解析七个请求字段并按值核验；Mission 动作概览产品代码有意上限20项，后14项明确省略。第二项是仍需改进的产品可发现性问题，完整 Run 的34步与截图并未缺失。本报告为四个关键响应直接链接原始动作证据，包括第33步创建订单；没有改产品判定或伪造概览已展示全部动作。两个失败日志分别保存在 outputs/toolshop-current-checkout-report-first-failure.log 和 outputs/toolshop-current-checkout-overview-limit.log。

## 运行与工程验证

本轮命令：

~~~text
node tests/toolshop-current-checkout.mjs
node tests/toolshop-current-checkout-review.mjs
node tests/toolshop-current-checkout-report-smoke.mjs
node --test tests/toolshop-live-oracles.test.mjs
git diff --check
~~~

执行脚本默认从 outputs/toolshop-current-checkout-root.txt 读取专属根目录，依赖先前保存在该目录的 historical-templates.json、reviewed-target/ 和浏览器/FFmpeg；不应在已有 sample-1 目录上再次运行。需要新一次复验时，创建新的专属根目录并复制明确审阅过的模板；当前文件不是无环境依赖的一键通用测试器。不得在运行中的系列修改已固定脚本或编译产物。

最终浏览器实测、审查、报告渲染和三个 Node reader 测试通过。本阶段未改产品运行时代码，因此没有为文档和脚本重复整个编译/单测流程；上一阶段的 pnpm typecheck、pnpm build、1,558个Vitest及13个Node测试通过记录保持为历史工程基线，不冒称本轮新跑全量。

原始根目录由 outputs/toolshop-current-checkout-root.txt 定位；结构化结果和审查为 outputs/toolshop-current-checkout-validation.json、outputs/toolshop-current-checkout-review.json。原始媒体位于本机临时目录，尚未成为可长期转交的独立归档。

## 后续目标

本轮补上当前构建完整已知业务链的重复证据；仍不证明未知网站首次自主规划、需求完整覆盖、广泛跨站成功率、所有网络请求参数/响应完整或生产级就绪。

下一优先项是让产品 Mission 概览在有界条件下仍可发现晚期关键动作，并形成可长期保存、可转交复核的证据归档。之后继续未见业务场景、错误与恢复分支、复杂业务 reader 及多次稳定性验收。Goal 保持 active。
