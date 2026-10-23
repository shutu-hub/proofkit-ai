# Mission 检查结果概览验收

日期：2026-10-21。目标是让默认报告直接回答声明了哪些检查、记录到什么结果，以及对应证据在哪里。本阶段不宣称完成自主规划或新的完整网站业务验收。

## 产品变化

Mission HTML 首页新增 Expected outcomes and recorded checks，JSON 中为可选的 checkOverview。它从当前摘要哈希可核对的原始 Run 读取，而不相信调用方提供的旧概览或聚合通过数。

每项展示预期、验证来源、原记录判定、原记录说明及证据。按 failed、inconclusive、unverified、not-recorded、passed 排序，避免晚出现的失败被大量通过项淹没。页面检查、明确分类的独立业务检查、HTTP合同及未分类reader分别标识。

声明但无结果的项目标为 not-recorded；这不证明它从未执行。重复或不匹配的记录标为 unverified，不选择其中一个通过结果。业务读数为null时保持inconclusive。使用原始Run内冻结的检查声明，不能据此证明原自然语言意图已完整覆盖。

每行提供已核验的原摘要、原Run报告，以及在精简引用集合中可匹配且当前核验通过的直接检查产物。未链接的支持产物数量明确保留，不把“未被选入概览”与“文件损坏”混为一谈。截图与业务来源链接仍受原Run归属和摘要校验约束。

结果是保存记录的展示，不重新请求业务接口，不重算原业务结果。当前Mission验收仍由完整审计决定，概览中的一个passed不能覆盖当前inconclusive或failed。

## 有界读取与宿主输出

报告不再只读取前10个Run的检查；在已有单文件4MiB、总16MiB预算内读取已呈现Run集合（协议最多200个）。读取失败、源摘要变更、缺少摘要或超预算的Run列为不可用。动作详细视图仍限前10个Run，各自最多200个动作；它不是检查概览的覆盖边界。

概览最多100项，计数覆盖本次成功读取的摘要，另外记录被省略检查、不可用Run和原结果省略的Run。计数不是完整意图或全项目覆盖率。

MCP首个精简答复最多携带8项优先检查、5个不可用Run及各类省略数量。宿主需要其余项目时读取完整结果。增加检查导航后发现390px宽页面溢出，已修复窄屏导航换行，保留表格内部横向滚动。

## 工程验证

最终类型检查、工作区构建及分发bundle构建通过。全量1,608个Vitest与16个Node测试通过；本阶段增加10个概览测试和1个宿主精简输出测试。日志见 ../outputs/check-overview-typecheck.log、../outputs/check-overview-bundle.log、../outputs/check-overview-tests.log。

新增回归覆盖：页面通过与业务未知分离、缺失结果、按声明匹配乱序记录、重复/无声明结果、HTTP与业务分类、不可用摘要、超100项与晚失败、第11个Run、摘要篡改、描述脱敏/HTML转义、跨Run及路径跳转证据拒绝、首答省略计数。既有报告、归档、CLI和MCP测试也纳入全量。

## 原始 Notes 证据上的只读展示验收

脚本 tests/mission-check-overview-smoke.mjs 读取原 mission-2f36ec22-e6e 的已保存结果，生成明确标为 Saved evidence presentation review 的独立展示快照 mission-2f36ec22-e6e-check-review；这个ID不是一次新执行的Mission。原Mission摘要和所引用的原始Run产物字节前后核对不变，没有补写原判定。

实际展示2项原记录通过、1项失败。错误的“1/1 notes completed”页面预期排在首项；独立业务检查仍显示原通过记录，并能直接读取包含isolated=true的原事实产物。没有把这两项通过升级成整条Notes生命周期通过。会话录像仍未封存，原账号与笔记清理仍未确认。

真实Edge浏览器检查1280和390宽度均无页面横向溢出；3项检查及6个摘要/Run报告入口存在，独立事实链接可读取，Run报告4张截图解码成功。记录0次HTTP请求，既没有重放完成操作，也没有执行删除或账号变更。回执 ../outputs/check-overview-validation.json，截图 ../outputs/check-overview-desktop.png 和 ../outputs/check-overview-mobile.png。

## 剩余工作

该改进只解决默认结果中检查可读性的一部分。跨多个Mission还原一个原始意图、未知网站的有界自主规划、统一测试资源收尾、可恢复认证，以及中断会话的证据交付仍待实现或验收。Goal保持active。
