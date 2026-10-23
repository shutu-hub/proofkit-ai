# 外部 Web 实测范围与执行责任

核对日期：2026-10-22。本文统计独立应用，不把同一网站的重复 Mission、工程故障夹具或修复后重跑当成新网站。当前包括三个远程演示站和三个本地运行的外部应用；后者不计为新增远程网站。

## 已覆盖范围

| 应用 | 部署 | 实测范围 | 结论与原始记录入口 |
| --- | --- | --- | --- |
| Toolshop — https://practicesoftwaretesting.com/ | 远程公开演示站 | 登录、多商品购物车、数量修改、异步地址就绪、模拟货到付款、订单创建与独立 GET | 限定的34步完整链路已有三次重复通过；参见 live-host-toolshop-validation.md、late-actions-validation.md 与 ../outputs/toolshop-current-checkout-review.html。后续 Notes 动作超时修改之后尚未重跑完整结账。 |
| Hotel booking — https://automationintesting.online/ | 远程公开演示站 | 日期、房型、客人表单、预订提交、独立记录读取与精确清理 | 完整业务保持 inconclusive：独立接口缺少 email/phone，不能凭页面确认与201判通过；参见 live-host-booker-validation.md、../outputs/booker-complex-review.html。 |
| Notes — https://practice.expandtesting.com/notes/app/ | 远程公开演示站 | 登录、私有笔记新增与刷新、编辑与分类、完成与搜索、另一账号访问隔离、打开删除确认 | 新增/编辑独立验收通过；完成/隔离独立事实通过，但原 Mission 文案断言失败，后续只读复核的 reader 不可用。删除未提交，整条生命周期未通过。下节保留细节。 |
| TodoMVC JavaScript ES5 | 外部源码、本地运行 | 新增、完成、Completed 路由、清空；独立 Store 读数 | 修复后四个分段 Mission 通过；内存模型，无持久化后端结论，CDP 模式无录像声明；参见 live-host-todomvc-validation.md。 |
| go-httpbin | 外部源码、本地运行 | 原生表单、中文与特殊字符、单选/复选、提交字段与服务端回显对照 | 修正后两个七步浏览器样本通过；只证明传输观察，不证明复杂业务持久化；参见 live-host-httpbin-validation.md。 |
| PocketBase v0.40.5 | 官方外部二进制、本地隔离运行 | 超管登录、集合与字段创建、正式新增和独立 API、编辑入口观察、精确业务资源清理 | 完整意图 incomplete：首次新增端点假设错误保持 inconclusive，修正后的5动作新增通过；编辑行不在控件快照，未执行。集合/记录删除有 GET404，服务停止；唯一超管数据目录和凭据文件尚留存，递归处置被策略拒绝。首次暴露60控件截断后已转开发调试样本，不是模型盲测成绩。参见 external-holdout-pocketbase-validation.md、../outputs/pocketbase-external-review.html。 |

PocketBase后续记录行复核：在原失败不变的前提下，两个正式Mission完成新增与同一记录编辑，标题更新及approved经独立API验证，业务清理GET404，服务停止；隔离超管数据库与凭据文件仍保留，因此不宣称所有资源清理或完整交付完成。此处是同一个开发调试应用的后续结果，不增加独立样本数，详见 `record-row-validation.md`、`../outputs/pocketbase-row-review.html`。

PocketBase单场核心级复核：同一已调试应用的额外样本用一份宿主人工Charter、一场Mission及一份17动作Run完成浏览器登录、同一记录新增与编辑；两个选定响应、最终独立读数和业务集合删除后GET404通过，17截图、录像、原manifest及可移动归档验证。集合本身由受控API setup准备，不是UI动作；未来控件缺少同会话规划pin，账号/数据库仍保留。因此这是通用执行和证据能力的正例，不增加陌生应用数，不构成模型自主规划或完整原始UI范围。详见 `pocketbase-one-run-validation.md`。

## 哪些工作由工具执行

当前宿主 Codex 根据实际页面观察编写结构化 Charter，并分状态提交。LocalRunnerService 的 inspectSurface/interactSurface 与 plan/createMission/startMission 路径承接真实页面操作；Web 适配器使用 Playwright 驱动浏览器。执行包含目标身份检查、动作结果、页面断言、选定请求/响应字段、逐步截图、支持模式下的会话录像和报告。部分调用直接使用 Local Runner 库，并不都经过 MCP。

站点验收辅助器准备隔离的合成数据，并提供经审核的独立业务 reader：例如重新 GET 订单/预订/笔记，或读取 TodoMVC Store。它们是站点专用验收接入，不是通用内核内的站点分支。独立 HTTP 读数不等同于第二账号浏览器 UI 流程。

这些样本证明了宿主规划配合 ProofKit 执行和取证的有限能力。尚未证明未知网站仅输入意图与地址即可首次自主产生完整计划、流畅执行并独立验收。失败、缺证据、修复后重跑及版本范围必须分别保留。网络覆盖仍可能 partial，不能宣称抓到了所有请求。

## Notes 原始阶段结果

原始根目录见 ../outputs/notes-host-root.txt；固定意图摘要 e28263fa7dd267886a03cc97e0e9132c1b4b71f66a6cff2a76935d5c4b46edfe。

| 第六次尝试阶段 | Mission | Run | 原判定 |
| --- | --- | --- | --- |
| 登录准备 | mission-203a07c9-fee | 20261021043414-88c614bd | passed，仅 quick 登录观察 |
| 新增与刷新 | mission-693eb0ba-72d | 20261021043746-0ed24a29 | passed，页面与独立当前记录一致 |
| 编辑、刷新与 Personal 分类 | mission-994788cf-0f1 | 20261021044123-588a3f1c | passed，独立记录核对标题、描述、分类、完成状态和归属 |
| 完成、搜索与隔离 | mission-2f36ec22-e6e | 20261021044351-8d8d4596 | failed，宿主错误预期数字文案；独立 reader 通过 |
| 只读复核 | mission-cfffbaee-e46 | 20261021044656-7ac2f598 | inconclusive，实际全完成文案断言通过，独立 reader 返回不可用 |

完成阶段独立证据记录当前 note 6ad8419ba4831302964033c4 的 completed=true 与期望内容，并验证另一已认证账号 GET404、列表200且不含该 note。原断言预期“1/1 notes completed”，实际页面为“You have completed all notes in the personal category”。不改写原 failed，不重复 PATCH。后续 reader 异常只有通用 unavailable，原因尚未证实。

最后收到的命令016仅观察删除确认框，看到 note-delete-confirm；没有017请求或 DELETE 成功记录。续接时执行句柄92882已不存在，当前 node 进程开始时间均晚于原会话，原 fixture 仍停在 ready，没有正常关闭或清理回执。原进程中认证资料没有持久化，不读取其他凭据、不猜测账号，也不盲目补发删除。第六次尝试的两个合成账号与该 note 清理未确认；早期 workflow 中断的两个合成账号清理也未确认。不能声称录屏正常封存、完整生命周期完成或全部测试数据已清理。

此前 attempt-3/4 的登录/阻挡中断，attempt-5 的 POST 尾斜杠投影失败均保留。attempt-3/4/5 的正常清理回执与第六次中断分别统计。

## 暴露的问题与下一步验收

1. 已修复普通 click/fill/press 的原生动作超时：10秒内返回，使外围30秒交互预算有机会保留失败截图和会话；受控遮挡回归确认零写入、失败截图、会话可继续，另行键盘动作仅写入一次。没有强制点击或隐藏广告。证据 ../outputs/blocked-click-validation.json。
2. 规划仍会错误推测页面文案与部署端点。规划须区分已观察事实、文档推断、独立可观察的预期结果，并在写操作前发现缺口；不得事后改预期以抹去失败。
3. reader 错误缺少具体阶段，暂不能诊断是何种可用性问题。需要有界且脱敏的阶段诊断；保持 unavailable 与业务不匹配分离，不因观测失败重放写入。
4. 宿主异常退出后的外部测试资源恢复仍不闭环。需要保留精确资源归属与非敏感清理状态，并设计受控认证恢复；强制中断验收应证明不会误删其他资源、不会泄露凭据，恢复结果不能伪造原业务通过。
5. Notes 尚缺删除独立验收、正常录像封存、最终清单校验和可移交归档；不能用已经通过的新增/编辑替代原完整意图。

本轮全量日志 ../outputs/notes-workspace-tests.log 保留1,597个 Vitest 与16个 Node 测试通过。工程测试通过不代表 Notes 完整业务通过，Goal 保持 active。
