# 失败检查的字段差异与窄屏摘要

2026-10-22。前一轮 Mission 总览已经能直达断言截图和独立业务来源，但真实后台写错样本的独立读数仍只给出笼统的检查消息。390px 页面要横向滚动到表格第四列才能找到失败字段；主路径和回放同一类错误的两个 Finding 易被误读为两个独立缺陷。

改进沿用既有 Oracle 和 Mission 报告，不引入第二套报告：受信任 connector 可在失败的 business Oracle 结果上声明最多八个唯一、有限长度的字段名 fieldMismatches，不携带原始期望/实际值。仅当原始 Run 摘要当前可核验、且该独立 Oracle 的源工件链接可核验时，Mission 检查投影才显示这些 Oracle 声明的名字。成功、未知、HTTP-only、重复声明或丢失源工件不能借此显示字段差异，也不能改变业务判定。报告在横向表格前新增最多四张失败/未知短摘要卡，直接提供原始来源和 Run 明细链接；其余仍在完整表格和 Run 报告中。首页 Finding 数字明确标为 occurrence，不冒充去重缺陷数。

真实 Web-only 故障注入样本仍是6个 Run、10项检查通过与2项业务失败。Oracle 根据独立当前历史记录声明 note.title 字段不同；有一次回放还观察到 note.description 也不同，原始严格只允许单一标题字段的验收断言失败保留在 outputs/field-diff-browser-defect.log，改为核对每次真实记录包含标题差异后重新运行，不追认旧断言。最终缺陷与正常样本分别见 outputs/field-diff-highlight-browser-defect.log、outputs/field-diff-highlight-browser-normal.log。390px 浏览器实际截图 outputs/field-diff-highlight-mobile.png 和文本/layout 摘要 outputs/field-diff-highlight-visual.json 显示无整页溢出，首张卡片不用表格滚动即可看到字段名、原始来源和 Run 明细；两次发生明确标 primary/replay。

受控源完整性回归先以原工件 SHA-256 显示字段，再修改源字节并重新生成报告：差异提示和源直链撤回，保存时判定不被篡改；见 outputs/field-diff-withdrawal-test.log。此机制仍依赖 connector 提供真实比较和可信字段名，不能从任意自然语言需求自动推导预期与实际。未知应用自主规划、准备资源中断恢复、长期存储真实性与生产误报率尚未建立。Goal 保持 active。
最终当前构建结果：outputs/field-diff-label-targeted.log 的报告用词回归、outputs/field-diff-final-build.log 与 outputs/field-diff-final-distribution.log 均通过。outputs/field-diff-final-browser-defect.log 保留6个 Run/46张解码截图/6段播放验证录像，10项检查通过、2项独立业务检查失败；正常样本 outputs/field-diff-highlight-browser-normal.log 仍 passed。当前 CLI 导出的移动包 outputs/field-diff-delivery/ 经独立摘要验包 intact，离线390px浏览器实际打开首屏失败卡和 oracle 原始来源，见 outputs/field-diff-verify.log、outputs/field-diff-offline-visual.json 与 outputs/field-diff-final-mobile.png。报告保存的业务结果 failed 与归档验包结果 intact 仍是两种不同结论。

第一次本轮最终全量测试 outputs/field-diff-final-all-tests.log 中，证据包与规划源两项在并行负载下超过Vitest默认5秒；没有断言失败。原测试在 outputs/field-diff-timeout-recheck.log 无并行压力下50/50通过，随后原样重跑完整套件 outputs/field-diff-final-recheck-tests.log：1,740项Vitest及16项Node测试全通过，未更改测试时限或放宽门禁。该超时记录继续保留，不能据重跑通过抹去运行时波动。
