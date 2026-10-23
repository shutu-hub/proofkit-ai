# Toolshop 复杂托管网站实测

2026-10-20，应用户要求改用真实托管网站，测试 `https://practicesoftwaretesting.com` 的 Toolshop 演示应用。所有浏览器动作均经 ProofKit 持续会话、原始观察绑定和正式 Mission 路径执行。当前 Codex 宿主根据实际页面逐状态编写计划，没有使用返回固定 Charter 的模拟模型。没有证明一条自然语言输入能自主规划并完成整条业务链。

## 最新构建：完整34步概览与新系列复验

北京时间2026-10-21，Mission概览从20项扩至200项上限，当前34步全部可见，包含下单步骤及其证据入口。类型检查/构建、1,560个Vitest与13个Node测试通过。修改后首次准备出现页面总计不刷新，保留inconclusive和独立事后读数；随后新隔离系列三次完整34步及独立订单验收通过，订单为 INV-2026000005、INV-2026000006、INV-2026000007。三个真实Mission各34动作链接、过程截图和正式视频窗口均验证。详见 `docs/late-actions-validation.md` 与最新 `outputs/toolshop-current-checkout-review.html`。网络仍partial，归档交付入口仍待实现。

## 前一构建：三次完整结账重复复验

北京时间2026-10-21，当前构建在三个独立访客购物车上各完成34步正式流程，订单为 INV-2026000012、INV-2026000013、INV-2026000014，均为两种商品3+1、$55.03。每次独立reader核对当前订单、精确商品集合/数量、最终及响应金额、提交购物车/付款方式与五个账单字段。正式Run、准备Run和会话清单、冻结合同及215项代码/输入摘要通过复核，三个录像实际播放覆盖正式窗口。详见 `docs/current-checkout-validation.md` 和 `outputs/toolshop-current-checkout-review.html`。

此前“当前构建未重跑完整结账”的缺口在这三个明确样本内已补证；下文的八次会话数量与归档构建说明仍是先前阶段的历史记录。首次新脚本的就绪配置失败也保留，没有宣称全部尝试一次成功。网络仍partial；Mission动作概览只显示20项、后14项需进入完整Run，属于接下来的产品改进。三次同一场景重复不证明未知站点自主规划或生产级完成。

## 当前版本追加：首次异常响应留痕

第八次隔离会话使用当前构建测试一次合成账号的拒绝登录。执行前声明预期 200、错误字段 `/error` 和请求 email；首个真实响应为 401 Unauthorized。`mission-a2870669-be1` / `20261020152622-cd72d540` 执行到第 3 步后保持 inconclusive，后续步骤及 Oracle 未执行。所选错误与请求事实保存在单独的 response-error 产物和 HTML 中，没有把拒绝登录改判为成功，也没有重放提交以获取响应体。

正式 Run 与原关闭回执固定的会话清单均 intact，当前关键构建与本次开始摘要一致。已收集日志只有一个 API 域名 POST，归属该 Run；日志中的 URL 路径脱敏，不能单靠元数据确定端点，也不宣称捕获完整。录像可播放，时长 287.88 秒；网络关闭有 6 个未结请求，状态仍为 partial。所有会话均已关闭。现在总计八次会话、36 个已收集 Mission，仍属于同一网站的诊断和定向回归。

新增诊断代码之后没有重跑完整订单。原 34 步执行对应构建在覆盖 dist 前归档，850 个文件逐一校验通过，关键文件匹配原会话摘要；其他文件为复核时补充，不能声称全部在执行前固定。汇总报告首页因此显示“归档版本的限定场景通过，当前版本待复验”。历史通过不认证当前版本，原失败也不重写。

本轮 `pnpm build`、全量 1,462 个 Vitest 测试及 7 个 Node 测试通过；JSON 和 URL-encoded 真实浏览器回归确认各只提交一次、零后续写入/Oracle、敏感正文不落盘、篡改撤回。导航响应、观察绑定控件和值检查浏览器回归通过。`tests/toolshop-report-smoke.mjs` 核验了 1280/390 宽度、原截图解码、两段视频实际播放和正式执行附近跳转，记录在 `outputs/toolshop-current-render-verification.json`。这些工程检查不计为网站任务成功率。

## 已封存构建：完整冻结范围的正负例验收

第七次会话将验收扩大为一条正式 Mission：从独立接口核对的两行访客购物车初态开始，重新登录、重开购物车、等待地址初始化与邮编响应、核验五个最终字段、模拟付款、创建订单并独立读取。`mission-8aa59eb1-7b9` 的 34 步全部通过；新订单 `INV-2026000024`，ID 为 `01m5ctzamqmffz5241d46czmnq`，两种商品数量为 3+1，总额 `$55.03`。独立读数确认匹配两条商品、最终金额、响应金额、提交的购物车和付款方式，以及请求/最终记录中的五个地址字段；`billingMismatches` 为空。这里的付款方式是请求合同核对，不宣称真实支付完成或付款方式的独立账务持久化。

这次纠正了测试前提：我之前把任意手填城市/州当作合法正例，但上游校验要求城市、州与国家/邮编查询一致。最初冻结的手工城市正例在第 33 步得到 422，原记录与合同保留。随后另行声明的负例 `mission-1dd3c3f0-fc6` 捕获实际 422 错误，明确为城市不属于所选国家；这证明拒绝分支，不证明全项目正确或独立的“没有创建任何订单”。合法正例才使用执行前独立查询得到的城市和州，街道仍为单独填写的 `ProofKit Demo Street`，执行前再次冻结新合同。没有改动原合同来把失败变绿。

合法正例的预期城市为 Briannechester、州为 Alabama、国家 US、邮编 94105。34 步正式执行耗时约 21.1 秒，之前的环境准备、逐状态观察与宿主规划不计入这个耗时。七次会话共收集 35 个 Mission，属于同一网站的诊断和定向回归，不是 35 个独立题型、成功率、未见集或生产级认证。完整自主初次规划、广泛重复稳定性和其他网站泛化仍未证明。

该会话的 `frozen-acceptance-contract.json`、`frozen-valid-acceptance-contract.json` 和 `full-acceptance-result.json` 保留原错误前提、拒绝分支及合法正例。开始时固定的关键构建、连接器、两份合同摘要均复核一致；正式 Run 和会话原始清单 intact。浏览器及辅助服务已关闭，订单后购物车独立 GET 为 404，没有额外发出 DELETE 来代替应用清理。会话录屏 1102.08 秒，可播放；关闭时有 16 个未结网络请求，所以捕获仍标 partial。

`outputs/toolshop-complex-review.html` 保留上述正例和原订单的扩大地址验收失败；新代码加入后首页已标明历史构建与当前版本的区别。原始正式报告在上述正例 Mission 的工作区内，截图可解码，桌面和 390 像素布局无横向溢出；原复核在 `outputs/toolshop-full-acceptance-render-verification.json`，本轮复核另存为 `outputs/toolshop-current-render-verification.json`。

规则参考为固定检出中的 `sprint5/API/app/Http/Requests/Invoice/StoreInvoice.php`：其校验器查询 postcode 后比较城市和州，明确不比较街道。托管部署与检出身份仍未被证明；这里还有实际 422 和合法正例作为运行时证据。Git 稀疏检出的远端 blob 拉取曾遇到 TLS 错误，改为读取同一固定提交的官方原始文件，没有变更应用源码。

## 首轮覆盖与历史结论

已实际执行商品搜索、价格排序、两个商品详情、访客购物车、多行数量修改、重开结算后状态保持、错误登录的 401 拒绝、公开演示账号登录、账单地址、模拟货到付款、订单生成与独立订单 GET。普通搜索和排序属于有记录的探索，不冒充已独立校验的正式业务用例。订单阶段使用演示站内模拟付款，没有真实支付。

首轮生成订单 `INV-2026000010`，ID 为 `01m5ckyr5nqmc9a4qc63cp3vzs`。独立接口确认两件 Combination Pliers 和一件 Hammer，共 `$40.88`。原始订单 Oracle 验证身份、商品、数量和金额，未验证手动填写地址；该有限范围的 Mission 为 passed。

**扩大到地址验收后为 failed，整体验收不得宣布通过。** 实际 POST 中的 street/city 与填写的 `ProofKit Demo Street / San Francisco` 不同。新增独立读数复核同一原始订单，保留原 Mission，不覆写其判定。state/postal_code 没有被原计划选为请求字段，因此这部分还存在请求侧证据不足。地址页源码同时有保存地址加载与异步邮编回填；目前没有隔离是哪条异步路径覆盖输入，不能直接宣称已确认上游产品缺陷。

另保留：提示文案出现前就断言的失败、重复 GET 导致的歧义拒绝、上游 OpenAPI 的 success 字段与实际 result 字段不一致、disabled 按钮等待超时导致会话释放、登录 300 秒后提交的 401、正常登录导航后的响应体丢失、账户名称异步加载晚于页面标题，以及辅助器策略错误。这些均不从分母或记录中删除。

## 本次推动的通用修复

1. 工作区可显式声明 `surfaces.web.apiOrigins`，允许对应独立后端的响应采集和 HTTP 业务读数。只接受最多八个确切 HTTP(S) origin，不接受通配域名、路径或凭据。API 来源配置不会放开浏览器导航。候选发现、计划、Mission 准入和正式执行使用一致规则。
2. 证据脱敏区分合法的字段投影/读数绑定声明与运行时值。名为 tokenType 的声明保持对象类型；敏感运行时字段继续遮盖，避免脱敏破坏 Run schema 并使报告不可读。
3. 选定 JSON 响应立即获取；在支持的 Chromium 中，于采集期间启用有界 durable response buffer，避免页面完整跳转使响应体不可读取。保留协议不支持、大小越界、重复请求、取消和超时的拒绝语义。三次真实浏览器整页跳转回归通过；真实站普通登录跳转的响应采集已通过，但同一原计划仍因账户名称尚未加载而断言失败，不能整项改称通过。
4. 独立订单读数现在必须声明并验证完整预期地址，同时检查请求投影与服务端记录；已加入金额、商品都正确但地址错误仍拒绝的单测。

## 审查入口

- `outputs/toolshop-complex-review.html`：明确呈现整体验收未通过，含录屏、订单截图、选定参数、扩大验收读数及所有收集到的 Mission/错误链接。
- `outputs/toolshop-live-host-validation.json`：五次会话尝试中的 22 个已收集 Mission、命令错误、清单校验、请求/响应事实和证据路径。它们属于同一网站的诊断及定向回归，不能算 22 种独立业务场景或总体成功率。错误登录、数量修改等也有先前会话的独立记录。
- `outputs/toolshop-review-render-verification.json`：报告真实渲染、图片解码、录像播放和桌面/窄屏检查。
- 原始工作区根在 `outputs/toolshop-sample-root.txt`。所有原始观察、计划、失败、截图、录像、网络日志与清单保留在独立临时目录，浏览器及辅助服务已关闭；临时目录不是长期归档承诺。

参考源码检出固定在 `ae7caecb811dd8952c09d997e69be7cb946ecd44`，未修改应用源码。托管部署和检出源码身份未被证明。较早尝试未在开始时固定完整框架构建摘要，必须明确保留该限制；辅助器现在会在开始时固定关键 dist 文件摘要。manifest intact 只证明当前文件和原清单一致，不能证明原始测试覆盖完整。

会话录像包含真实操作与宿主规划间隔。最后一次订单回归录像 312.72 秒，已实际播放；网络捕获在关闭时仍有未结请求，因此状态为 partial，不能写成网络记录完整。全部使用公开演示账号及合成输入，不声称视频像素已脱敏。

## 复核命令

先构建。按站点文档准备只读源码目录及外部工作区配置，显式配置 API origin。运行辅助器：

`node tests/live-web-host-acceptance.mjs --project-root C:/qa/toolshop-source --workspace-root C:/qa/runs/new-complex-attempt --url https://practicesoftwaretesting.com --config-json C:/qa/toolshop-config.json --integration tests/toolshop-live-oracles.mjs --headful`

工作区必须不存在。初始原始观察保存在 `initial-inspection.json`。宿主向 host-commands 依次写入 `001-request.json` 等命令，支持 inspect、interact、plan、run、close；每次等待对应 response 再继续。所有状态都需新的真实观察，不能把旧会话 pin 复制到新实例。`toolshop-live-oracles.mjs` 是仓库验收连接器，不是测试内核的网站分支。可用环境变量 `PROOFKIT_TOOLSHOP_EMAIL` 和 `PROOFKIT_TOOLSHOP_PASSWORD` 指定隔离的演示账号；认证 token 仅在内存用于独立读数。

`node tests/toolshop-review-report.mjs C:/qa/original-artifact-root` 重建本次固定尝试目录的审查记录。`node --test tests/toolshop-live-oracles.test.mjs` 校验独立订单判定，`node tests/response-navigation-smoke.mjs` 复核导航响应采集。

## 追加：真实地址阶段值核验

新增 `waitForValue` 后，在第六次隔离会话中复现了回填边界。先填写手工地址，再通过唯一的 GET `/postcode-lookup` 捕获完成的响应，选定返回值为 `Mollie Inlet / Briannechester / Alabama`。随后预期街道值核验未通过，Mission `mission-ffba8cf9-32a` 为 inconclusive，12 个计划步骤只执行到第 10 步；后面的继续和付款步骤没有执行。失败截图可见街道和城市已被回填。

在同一会话中，等待这条已完成响应后重新填写最终街道、城市、州。三个值检查分别采样匹配 803、752、775 ms，然后才进入付款页。Mission `mission-59e1458c-073` 的 8 步通过。此次只验地址阶段，没有创建新订单，专属访客购物车通过清理接口返回 204。原订单的地址验收失败没有被改判，完整订单的所有字段重验仍待执行。

原始记录在第六次工作区的 `value-regression-result.json`，关键构建文件在会话开始时已固定摘要。汇总报告现包含六次会话、26 个已收集 Mission；仍属于同一网站的诊断和定向回归。新值检查仅承诺有限采样窗口匹配，不保证之后永远不变，更不替代提交后的独立业务核对。

通用浏览器工程回归保存于 `outputs/form-value-validation.json`：覆盖异步覆盖、控件身份变化、重复定位的零错误写入；正例由独立服务器运行时状态读取最终值。还覆盖初次身份记录后发生的变化、取消、非支持控件、运行时环境值不进入结构化证据，以及篡改检查产物后报告撤下该结论。早期测试曾有一次没有标出具体场景的意外通过；之后补足持续唯一性/身份检查及确定性反例。另一次测试因既有歧义错误分类为 failed 而非 inconclusive 失败，调整为接受这两种有明确拒绝码且零写入的结果，没有放宽为允许通过。

## 下一步仍需完成

已有值核验、历史构建的完整单场景订单验收，以及当前构建的首次异常响应留痕。错误字段仍须预先声明，不能事后追溯未选定的正文。下一步继续完善业务规则来源、状态等待、过期认证恢复、无 href 的明确交互控件发现，以及意图到必验字段的覆盖检查；完整订单需在新版本复验。后续仍需更多独立网站和重复样本，整体 Goal 保持 active。
