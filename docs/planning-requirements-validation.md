# 规划原始要求保持：修复与验收

日期：2026-10-21。此阶段解决模型规划结果替换原意图、显式执行模式和独立验收选择的问题，不宣称自动理解了原意图的全部业务语义。

## 问题复现

共享StructuredPlanner原先保留模型返回的intent；即使原请求包含刷新、归属和账号隔离，返回的Charter也可能只留下缩短后的说明。LocalRunner原先已有副作用策略和大部分reader选择检查，但共享规划层没有统一检查显式mode，reader等长重复列表也不能只靠长度和包含关系判等。

新增首批16条回归在修改前15失败、1通过，日志 ../outputs/planning-requirements-before.log。修复中另补错误序列化保护、评测和Mission持久化回归；最终不把首批失败数描述为整个阶段的测试总数。

## 改动

- 生成的Charter使用调用方的完整原始intent，包括格式和排除说明；不让模型的缩写替换它。模型响应仍经过原有schema和目标绑定检查。
- 如果调用方显式指定mode或sideEffectPolicy，模型必须保持相同值。未指定时继续使用原有默认/输出语义，不额外推断权限。
- 显式oracleNames要求与最终选择多重集合一致：可换顺序，不能删减、增加、复制替换或绕过显式空列表。注册允许列表检查同时保留。
- 准入违例抛PlanningRequirementsError，正式Mission创建与动作执行停止。它不自动修改计划、放宽要求或重放写操作。被拒绝草稿只供结构诊断读取，不随普通错误JSON枚举输出。
- 评测保留被拒绝计划的动作、Oracle、选择器等细项诊断，但准入违例记零分且不算通过；admissionIssues与failureCounts.requirements单独表达该原因，不冒充模型服务连接故障。
- 模型请求提示同步要求原始意图、显式模式、副作用策略和独立检查保持一致。

这不是对自然语言的完整语义证明。保留“不分享”原文不等于框架已经推导并执行了全部业务禁止规则；检查点、权限、预期字段和验证来源仍需要可靠的规划与接入。

## 工程验收

最终工作区类型检查、所有包构建及分发bundle构建通过；全量1,628个Vitest与16个Node测试通过。日志 ../outputs/planning-requirements-typecheck.log、../outputs/planning-requirements-bundle.log、../outputs/planning-requirements-tests.log。

新增17个共享规划要求用例、1个评测准入用例和2个LocalRunner用例。涵盖完整中英文原文与换行、三种模式和副作用策略变更、reader缺失/增加/重复/空列表/重排、错误序列化、持久化原意图及正式执行前拒绝。

原观察请求正例原先省略sideEffectPolicy、默认confirm，却输入allow；现在显式保持allow，原页面预期检查未弱化。评测负例仍保留全部原结构诊断，没有通过删除不一致的请求条件来让它们通过。

## 真实浏览器与MCP回归

node tests/automatic-planning-smoke.mjs --headful --keep-artifacts

本次日志 ../outputs/planning-requirements-browser.log。真实Edge执行，三个MCP入口plan_test/create_test_mission/run_test对模式变更均返回错误，拒绝阶段写入计数和Mission目录不变。宿主请求较完整、fixture提供较短intent时，plan_test仍返回完整原文。原观察绑定、双账号会话隔离、篡改拒绝与取消回归同时通过。所有浏览器会话和本地服务在脚本finally中关闭。

node tests/multi-state-planning-smoke.mjs --headful --keep-artifacts

本次日志 ../outputs/planning-requirements-multistate.log。模型fixture请求第二状态后由宿主明确续接，两个页面复用同一selector但绑定不同身份；歧义、错误观察和篡改仍在写入前停止。正式阶段只创建1个本地合成订单，采集选定请求/响应字段并独立GET核对，Mission通过。会话录像封存和Run清单核验通过。

Mission mission-e73a9728-4b0，Run 20261021063145-e21ed527。另用真实浏览器只读打开报告：1280/390宽无页面溢出，2项原检查均呈现，独立事实直接可访问，5张Run截图解码；5.16秒录像实际播放到结束、无媒体错误且SHA-256与封存引用一致。展示复核0次HTTP请求。回执 ../outputs/planning-requirements-render-validation.json，截图 ../outputs/planning-requirements-desktop.png、../outputs/planning-requirements-mobile.png。

## 范围与剩余目标

上述浏览器场景是受控本地应用和确定性模型fixture的工程回归，不是新增外部网站成绩，也不是未知站点首次自主规划证明。多状态续接仍由宿主审核动作；框架没有自动探索并完成整条业务。没有补做Notes删除、恢复旧账号或封存旧中断录像。

原始意图和显式约束保持是可靠规划的必要条件；语义完整的检查点发现、跨Mission汇总原意图、受控测试资源生命周期和首次用户主路径仍待完善。Goal保持active。
