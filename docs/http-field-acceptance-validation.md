# 独立 HTTP 标量字段验收：阶段验证

本轮于北京时间 2026-10-21 完成，承接真实 Toolshop 电商结账及酒店预订跨站验证暴露的缺口：页面确认、对象 ID 和成功状态不能证明所有必验业务字段正确。本轮扩展现有 HTTP reader、字段事实和报告，没有增加站点专用执行分支。通用测试与证据闭环 Goal 继续保持 active。

## 实现与判定

- 配置和 inline HTTP Oracle 共用 `expectFields`；1–16 个唯一名称/JSON pointer，预期为有界字符串、有限数字、布尔值或 null。
- 当前响应身份、成功状态和全部声明字段必须同时满足。严格比较数值与类型，不把缺失视为 null。
- 已到成功状态的确定值差异判失败；缺失/类型不符继续等待，到期仍为 inconclusive。确定差异与缺失并存仍失败。处理中暂态差异允许随后收敛。
- 身份不成立或响应状态不接受时，字段事实为 not-evaluated。HTTP 200 和 UI 成功均不能跳过字段验收。
- 只有显式 `retainValue: true` 才保存符合标量边界的观察值；否则记录名称、pointer 和结果。预期字面量仍保存在计划内，其他声明的请求/响应记录不受此选项脱敏。
- HTTP 轮询轨迹限制在 100 次观察及 60 KiB 序列化 source envelope 内，记录被省略的早期观察数。单次事实超限不能无证据通过。
- 标准 Run 报告分别验证源事实与 verdict 产物，再展示完整字段映射；源产物被改变后撤下事实展示。

## 六个冻结的浏览器场景

执行脚本 `tests/http-field-acceptance-smoke.mjs`；原始结果在 `outputs/http-field-acceptance-validation.json`。数据保存在独立服务端内存，不能称为数据库持久化验收。每个场景通过普通 Run 执行 12 个观察绑定的浏览器动作，只提交一次；保存八个声明请求字段、响应 ID、独立 GET、截图及录像。

| 场景 | 预期 / 实际 | Run |
| --- | --- | --- |
| matched | passed | 20261020184415-5db3ee3c |
| wrong-checkout | failed | 20261020184419-bff9da23 |
| missing-contact | inconclusive | 20261020184421-83e582a1 |
| wrong-type | inconclusive | 20261020184425-61756638 |
| pending-then-matched | passed | 20261020184428-25342608 |
| mismatch-and-missing | failed | 20261020184431-2866d50a |

八个固定要求为房间 ID、名、姓、邮箱、联系电话、押金标记、入住日期、退房日期。姓名和联系信息的观察值不留存于字段事实。

关键反例：页面提交 2026-11-12 并显示 Booking Confirmed，独立服务端记录却为 2026-11-13。HTTP reader 以当前响应 ID 查到该记录并判失败；没有因 UI 确认而通过。故意植入的差异不是实际网站缺陷。正例另验证修改源产物会撤下展示，随后恢复原始字节和报告，原 manifest 再次 intact。

## 真实网站的当前版本复验

公开测试站为 `https://practicesoftwaretesting.com/`。这是商品字段的只读定向复验，复杂结账的历史证据及构建限制另见 `docs/live-host-toolshop-validation.md`；不能以本次五步商品复验认证历史 34 步订单链在当前构建仍通过。

- Mission：`mission-524ce8bc-5ce`；Run：`20261020185504-fc8c700d`。
- 商品：Combination Pliers；ID `01M5D7HCBMCM5KQHSAF4YTBPM1`；冻结价格 `$14.15`。
- 冻结字段：商品 ID、名称、价格、库存布尔值、租赁布尔值、地区优惠布尔值、品牌 ID、分类 ID；全部来自公开数据，明确允许留值。
- 合同 SHA-256：`a2b961c86b0f1fb045f6152279487c937cde1c9901ed6f39ed4ba665b19e35ef`。
- 五个正式动作和三个 UI 断言通过；独立 GET 用本次页面捕获的商品 ID 匹配身份，八字段全部 matched。成功标记是已审阅的商品名称，不是异步订单终态。
- 没有执行加购、注册、下单和支付动作。页面后台流量可能包含 POST，不声称全站流量只读。
- 宿主根据实际观察编写计划；没有证明未知网站首次自主完整规划。目标是 URL-only 测试宿主，不是部署源码，远端部署身份仍 unverified。

正式前的计划命令因 targeted field-reader regression 中的 regression 被按关键词推断为 release，与 core 冲突，在创建 Mission 前拒绝。此前把 payment 排除项描述成触发原因不准确；原始匹配器并无 payment 规则。原命令、合同及失败回执保留。另行冻结 v2 将正向意图与排除说明分别保存，八字段和对照未改变。本字段验收阶段未修改解析器；后续在 docs/intent-level-validation.md 记录有限范围识别修复及原始意图复验。

所有初探及正式会话已关闭。封存派生报告会补充录像入口并更新 Run manifest，采用关闭回执中的最终摘要复核，同时保留早期回执；执行摘要跨封存保持一致。完整信息和临时产物路径由 `outputs/http-field-review.json` 保存。

## 录像、报告与完整性验收

`tests/http-field-review-report.mjs` 复核六条受控场景与真实场景的合同、当前关键构建、原始 manifest、字段映射、可留值范围及封存 lineage，生成 `outputs/http-field-review.html`。最终 stageVerified、controlledVerified、liveVerified 均为 true；goalComplete 为 false。

`tests/http-field-report-smoke.mjs` 用真实 Edge 解码截图并播放视频，输出 `outputs/http-field-render-verification.json`：

- 汇总报告 1280 和 390 宽均无页面横向溢出，三张嵌入截图成功解码。
- 正例及日期差异录像时长分别为 2.88、2.44 秒，实际播放有解码帧，无媒体错误。
- 真实会话录像 950.04 秒，覆盖正式 Run 约 746.168–750.890 秒。点击估算定位按钮从约 743.18 秒播放至超过正式结束时间，并保存实际商品页视频帧。时间按墙钟估算，不是逐帧的动作因果绑定。
- 七份原始 Run 报告在 390 宽逐一核验八字段、留值限制及判定；共解码 77 张过程截图。日期差异展示 12 日与 13 日；缺失/类型不符仍显示 inconclusive。
- 真实会话网络仍 partial，关闭有六个未结请求；可播放录像和 intact 清单不代表网络完整。

报告截图：`outputs/http-field-review-desktop.png`、`outputs/http-field-review-mobile.png`；正式窗口视频帧：`outputs/http-field-live-video-frame.png`。

## 资源问题和工程回归

本轮复现轮询等待的取消监听器泄漏：20 次观察结束仍残留 19 个。通过 finally 清理监听器与计时器后，等价回归残留为 0。原复现及修复日志在 `outputs/http-field-listener-repro.log`、`outputs/http-field-listener-fixed.log`。

最终验证：

```text
pnpm typecheck                         passed
pnpm build                             passed
pnpm test                              1,507 Vitest + 13 Node tests passed
node tests/http-field-review-report.mjs stageVerified: true
node tests/http-field-report-smoke.mjs  passed
git diff --check                       passed
```

日志为 `outputs/http-field-final-typecheck.log`、`outputs/http-field-final-build.log`、`outputs/http-field-final-workspace-tests.log`、`outputs/http-field-report-smoke.log`。新增合同/reader/报告定向测试 33 项通过。

首次全量失败日志 `outputs/http-field-workspace-tests.log` 保留：新增测试错误地假定最后一个轮询项必有 HTTP facts，但临近 deadline 可以是传输超时。仅调整测试为检查所有实际收到的 HTTP 响应，仍要求至少一个响应、完整 not-evaluated 字段和未知结论；未延长超时或放宽业务规则。最终全量重跑通过。较早 MCP 轮询次数的时序失败见前阶段记录，本轮未修改该断言。

## 仍未证明的能力

这是显式标量业务要求的通用验收补强。它不自动找齐需求，不证明复杂集合、跨记录事务、鉴权/动态路径 reader、多角色场景或通用规划稳定性。真实完整工作流的当前构建复跑、未见网站、重复执行及缺陷召回/误报仍需继续。酒店独立接口缺少邮箱/电话的问题也未被这里的六个受控场景解决，原酒店结论继续证据不足。

后续优先验证意图否定范围和真实完整工作流，保留原始意图、失败、版本与证据边界。只有在当前构建对更广泛场景取得重复证据后，才能评估生产级目标。
