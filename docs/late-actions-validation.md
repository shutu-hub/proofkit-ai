# Mission后半段动作展示：修复与真实复验

后续证据交付阶段已实现Mission导出与独立离线验包，原目录缺失时的真实回放、来源锚定和搬移验收见 `docs/mission-archive-validation.md`；命令/API见 `docs/evidence-archives.md`。本文后续的“未实现归档”保留为当时的审计记录，不代表当前入口。

北京时间2026-10-21。上一阶段已取得完整业务链重复证据，并发现Mission动作概览只显示前20项。本阶段直接修复产品报告，再用修改后的编译产物执行新的完整结账系列。通用Web测试与可追溯证据Goal保持active。

## 产品变更

packages/evidence/src/mission-report.ts 的原20项切片改为有明确常量的200项展示上限。34步结账的每个计划动作现在都出现在Mission概览中，可直接进入对应Run动作证据，包括第33步创建订单和第34步确认等待。

captureResponse 的概览描述使用已观察并绑定的trigger控件名称，经过既有reportSnippet与HTML转义；例如正式订单步骤显示“Submit and capture selected API facts · Confirm”。不展示填写值或原始selector。

完整性与展示分离：仍只从哈希核验通过的原始Run summary派生，源改变撤下展示；已有截图引用各自验证。不因增加动作入口就扩大截图证据收集或把动作成功当业务通过。超过200项时仍明确显示省略数量，完整Run报告保留原始计划。

## 回归证据

新增两条参数化回归覆盖34项和205项计划：第33步可见、后续未执行动作not-run、200项上限及5项省略、敏感填写值/selector不出现、源篡改撤下晚期操作。修改前2条新增回归失败、35条既有回归通过；修复后37条全部通过。

日志：outputs/late-actions-before-tests.log、outputs/late-actions-focused-tests.log。选择的修改前源码及dist副本位于outputs/late-actions-before-runtime/，并附摘要；该副本不是完整独立运行时归档。

最终pnpm typecheck、pnpm build、1,560个Vitest测试和13个Node测试通过，日志为outputs/late-actions-typecheck.log、late-actions-build.log、late-actions-workspace-tests.log。git diff --check通过。未修改无关时序断言或增加业务超时。

## 新构建真实完整复验

仍使用公开Toolshop演示站 https://practicesoftwaretesting.com/，同一已审阅34步业务要求：从独立核验的两行购物车重新登录、重开结算、完成地址/邮编回填检查、模拟付款、创建订单及独立读取。没有以商品页代替完整业务链。

| 最终系列样本 | Mission | Run | 订单 | 正式耗时 |
| --- | --- | --- | --- | --- |
| 1 | mission-5d6fd398-682 | 20261020212723-a70fe9d5 | INV-2026000005 | 17.228秒 |
| 2 | mission-2dea2322-5e9 | 20261020212833-64e1d0c6 | INV-2026000006 | 16.725秒 |
| 3 | mission-118d7b27-4b8 | 20261020212943-f523bf09 | INV-2026000007 | 16.656秒 |

三个新购物车与订单均不同；每条正式Run的34步、两个UI断言和独立业务reader通过。两种商品数量3+1、金额$55.03、提交购物车与付款方式、响应金额及全部五个请求/独立记录账单字段保持原合同；动作计划与原模板及冻结Charter比较未弱化。

全部215项编译JavaScript/脚本/reader/锁文件摘要保持一致，Run/准备/会话清单、冻结合同及封存前后执行摘要验证通过。场景由宿主模板结合新观察编写，不证明未知站点首次自主规划；远端部署源码身份、真实付款、发货及全面依赖身份不在证据内。

所有会话及辅助进程已结束。会话网络仍partial，三个最终样本关闭有10、13、10个未结请求。付款方式仍是提交合同检查，不是独立账务持久化。独立账单原值未留存，report保留比较结果和响应摘要，不补造原读数。

## 新构建首次尝试的真实异常

本阶段第一个系列在购物车准备阶段失败，后两个预定样本未运行，尚未进入正式结账。数量PUT返回200且捕获quantity=3，但等待$55.03超时。失败截图/快照显示：钳子行金额$42.45、锤子$12.58，总计却仍是旧的$40.88。

这是当时可观察的页面金额不一致，不能仅凭截图确定产品根因或永久缺陷。原Mission mission-ca58765d-2b1 / Run 20261020211603-808cb9d3 保持inconclusive，未重放已提交动作，也没有用后台后来正确来改判原页面流程通过。

事后单独GET确认该捕获购物车的当前两行数量为3+1；原清理尝试曾不可用，随后重新核验精确ID、商品及数量，再删除该专属购物车，DELETE204、GET404。post-failure-independent-cart.json和post-failure-cleanup.json在Run外保存，摘要加入尝试记录，与原判定分开复核。

失败根目录：C:/Users/殊途/AppData/Local/Temp/proofkit-toolshop-late-actions-tJrY89。原结果、执行脚本副本、录像/清单及单独读数/清理回执均保留。日志为outputs/late-actions-checkout-attempt-failure.log。随后只是创建新隔离根目录，用相同driver与未弱化计划执行上述三个最终样本。

因此只能称为“最终系列三个样本通过”；不得把首次失败或更早的就绪配置失败删除后，宣称所有尝试100%成功或形成广泛稳定性认证。

## 报告与回放

输出：outputs/toolshop-current-checkout-review.html / .json；执行脚本tests/toolshop-current-checkout.mjs、独立复核tests/toolshop-current-checkout-review.mjs、浏览器验收tests/toolshop-current-checkout-report-smoke.mjs。当前根目录由outputs/toolshop-current-checkout-root.txt记录。

最终真实Edge验收证明：

- 三份Mission概览各有34个动作证据链接，后14项不再被截断，第33步原始证据锚点可访问。
- 三份完整Run各34张过程截图、三张汇总截图和三个Mission各两张选择截图成功解码。
- 七个下单请求字段按JSON解析比值通过，不依赖格式空格；所有原业务要求仍可核对。
- 汇总、Mission及Run在390宽无页面横向溢出；汇总1280宽正常，窄屏表格在自身容器滚动。
- 实际播放三段视频越过正式Run结束，时长68.96、69.32、68.68秒；正式窗口分别49.965–67.193、50.462–67.187、50.121–66.777秒。墙钟定位仍是估算，不是逐帧动作因果认证。

outputs/toolshop-current-checkout-render-verification.json与outputs/late-actions-report-smoke.log保存详细回执。outputs/late-actions-invoice-overview.png截取真实第33步概览，已目视确认显示Confirm和证据入口。

前一构建的三个成功样本未改写，汇总/渲染/原结果副本位于outputs/late-actions-prior-checkout-review/，原始根目录C:/Users/殊途/AppData/Local/Temp/proofkit-toolshop-checkout-current-8FIbDX。旧成功只证明其记录的构建；当前新报告同时保留此前失败和历史成功。

## 归档审计与下一步

现有manifest构建/验证、静态相对报告和只读retention审计可以支撑归档，但代码中尚无产品Mission证据导出/离线验包入口。当前HTML仍依赖临时工作区；把汇总HTML放进outputs并不构成可搬移证据交付包。

本阶段已核对具体代码并在docs/evidence-delivery-acceptance.md定义原字节、依赖闭包、路径/预算、复制后重验、搬移后无原目录回放及CLI验收门槛；尚未实现，不能报告为已完成。

后续优先实现可长期保存并转交的Mission证据包，再继续未见场景的规划质量、广泛重复稳定性与网络完整性。Goal保持active。
