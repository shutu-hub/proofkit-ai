# 酒店预订跨站实测

本轮覆盖北京时间 2026-10-20 23:45 至 2026-10-21 00:49 左右，目标是公开测试演示站 `https://automationintesting.online/`。它与上一轮 Toolshop 的电商业务不同。本次所有浏览器操作都经过 ProofKit 的持续会话、真实观察绑定与正式 Mission 路径；宿主根据观察编写计划，没有第二模型 API 或固定 Charter 提供者，也没有证明未知站点首次自主完整规划。

## 结论

两个通用工程缺口已修复并复验；完整预订业务验收保持 **inconclusive**。没有把操作成功、HTTP 201、页面确认或部分字段匹配当作完整业务通过。

初始页面有两个匿名日期框及三个同名 Book now，旧发现结果均无可用 selector。新增可见 label/legend/heading 的有限祖先范围定位后，真实日期框与 Single/Double/Suite 房间入口可以分别定位。受控浏览器回归把页面顺序反转，仍只选择原语义日期和 Single；重复上下文及敏感上下文保持 unbound，独立服务器确认一次正确写入。

真实日期 Mission `mission-9dfc9ce7-2e8` 的 8 个动作通过：填写并稳定核验 2026-11-10 / 2026-11-12、检查可用房型。后续真实预订页展示 2 nights、每晚 £100、总计 £240。该阶段没有独立业务 Oracle，Mission 仍为 inconclusive；总价只有 UI 证据，没有独立的持久化金额字段。

原正式预订 `mission-13cfadc7-e10` 在响应投影时停止：计划根据参考源码假设 `/booking/roomid` 等嵌套结构，当前部署不满足该投影。创建已发生，原框架却丢弃了先投影成功的 ID，不能据此重放写操作。事后独立按唯一合成访客找到预订 5，读取确认房间、姓名、日期正确。随后它在所有权重查前已为 404；没有发出 DELETE，不能断言由我们清理或确定消失原因。原失败保留。

## 当前构建的修复复验

新增 `ResponseCaptureError` 和 `responseError.kind: incomplete-fields`：在完整、有界 JSON 响应中，保留已选合法字段、每个缺失/非法字段、声明的请求事实及其 gap。步骤仍失败，`step.response` 仍为空，后续动作及 Oracle 不执行；不补发或重放请求。不合格 content type、缺失或过大的正文继续保留已有 gap，未扩大为保存原始正文。

独立冻结的新回归 `mission-71a70abe-1a7` / `20261020164019-0804fd83` 使用原完整验收要求，首个 201 响应保留预订 ID 7、八个请求字段和八个嵌套投影缺失项。正式 Run 归属的网络日志只有一个 POST；这是已收集日志中的次数，不证明网络捕获完整。原 verdict 为 inconclusive，后续确认等待与业务 Oracle 没有执行。

事后按这个保留下来的 ID 做认证 GET，确认房间、姓名、押金标记及入住/退房日期均符合原冻结意图；独立接口不返回 email 与 phone。`bookingAcceptance` 因此返回 `passed: null`、`mismatches: []`、`missingIndependentFields: [email, contactNumber]`。不会把缺少独立证据误判为产品缺陷，也不会把它默认为匹配。原业务合同未缩减，原 Mission 未改判。

本次预订 7 经确切合成姓名、房间与日期核验所有权后，只删除该 ID：DELETE 202，后续 GET 404。独立读取与清理回执位于 Run 外，摘要在复核时计算，不属于原始 Run 清单，也不补写原始判定。

最终会话录像 378.4 秒，实际播放无错误；网络仍 partial，关闭有 3 个未结请求。会话关闭会向报告补充封存录像入口，Run 清单随派生报告更新。关闭前后执行摘要一致，各次回执及清单摘要均保留；封存后核验采用关闭回执中的最终清单，原早期摘要不能继续认证更新后的报告。

## 所有尝试与版本范围

六次会话、三个已收集 Mission 均保留。一次宿主命令生成时漏了输入字段，在提交前被 schema 拒绝，没有创建预订；修正后另行冻结合同并在新会话运行，没有重写原错误。以上不是六个独立业务题或成功率。所有 helper 和浏览器会话均已关闭。

远端 Git 检出因传输中断不完整；部分官方文件以固定提交 `d36bd3f8647a091d406e53bad463c5e3e5d2ece1` 获取，仅作规则参考，没有证明与托管部署相同。初始未配置 readiness 的多次观察为空，后续复验使用已有 `readyWhen: {text: Single Room}` 得到 observed；这不等于任意状态都自动就绪。

构建、全量 1,469 个 Vitest 测试与现有 7 个 Node 测试通过；独立预订判定另有 4 个 Node 测试通过。通用 JSON/form/不完整投影浏览器回归确认一次提交、零后续写入与 Oracle、敏感正文不落盘、篡改撤回；匿名控件、观察绑定原生控件及导航响应回归通过。桌面 1280 和窄屏 390 无页面横向溢出，原始截图可解码，录像可播放；最新原始 Run 的 8 张截图也已解码。

## 产物与复核

- `outputs/booker-complex-review.html`：可读报告，明确完整业务未判通过、两个工程修复、全部尝试与录像。
- `outputs/booker-live-host-validation.json`：清单更新链、关键构建摘要、完整原始步骤、独立回执与范围限制。
- `outputs/booker-current-render-verification.json`：真实浏览器的布局、截图及视频检查。
- `outputs/scoped-controls-validation.json`、`outputs/response-error-validation.json`：通用浏览器工程回归。
- `outputs/booker-sample-root.txt`：原始临时工作区位置；这些链接不承诺长期归档。

先构建，然后运行 `node tests/booker-review-report.mjs` 和 `node tests/booker-report-smoke.mjs` 重建及验证汇总。`node --test tests/booker-live-oracles.test.mjs` 验证独立判定。`tests/booker-postrun-check.mjs` 是有副作用的本轮定向复核与清理器，不是只读报告工具；仅对它验证通过的原始捕获 ID 和完全匹配的合成归属执行清理。

## 下一步

提交前检查的后续已实现并单独实测：`docs/prewrite-observability-validation.md` 和 `outputs/readiness-prewrite-review.html` 保留了草稿阶段 blocked、执行前再次拒绝以及零被测页面动作的证据。它没有改变本页原预订验收的 inconclusive，也没有补出缺失的独立联系字段。

规划应显式区分参考源码、当前部署响应和独立业务记录的字段来源，提前识别必验字段不可观察的情况；不能要求任意 API 必须回显全部业务字段，也不能降低必验范围来通过。后续仍需新站点和重复样本、完整跨状态计划、认证恢复和更精确的过程证据关联。Goal 保持 active。
