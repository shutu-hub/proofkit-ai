# 原生记录行观察与外部应用编辑验收

日期：2026-10-22。本轮承接 PocketBase 完整意图中的“编辑入口未被观察”缺口；修复针对通用 Web/Electron 的可聚焦原生表格行，没有在运行器中加入站点分支。

## 观察和执行契约

真实页面只读 DOM 探针确认记录项为没有显式 role、带 tabindex=0 和 onclick 的 tr。探针直接使用 Playwright 和独立API准备数据，结果仅是开发诊断，不计作 ProofKit 验收；其隔离探针集合已按ID及name核对删除，独立读回404。见 `outputs/pocketbase-row-dom-probe.json`、`outputs/pocketbase-row-probe-cleanup.json`。

WebAdapter 现在将非负 tabindex 的原生表格行纳入原有60控件窗口。行按 role=row、规范化可见行文本呈现，候选来自实际行名或前四个单元格中通过既有脱敏审核的文本。候选必须唯一，且匹配原观察元素；计划不使用行序号。执行时继续通过原 inspection manifest pin 绑定、复核角色/标签/行名/来源，并操作已核对的同一个元素句柄。

普通静态行、负tabindex且无角色的行不纳入新增类型；任意div、未渲染虚拟行、iframe或其他分页不由此自动支持。非负tabindex是明确的可聚焦线索，不证明业务点击必然成功；后续动作、页面断言及独立业务读数继续决定结果。

## 行定位真实浏览器回归

`tests/record-row-smoke.mjs` 使用真实可见Edge与相同原观察绑定链：

| 情况 | 结果 | 目标业务POST |
| --- | --- | --- |
| 唯一可聚焦行 | 打开成功 | 1 |
| 内容变更使原行名选择器消失 | surface-selector-drift | 0 |
| 稳定ID不变但行内容已改 | surface-target-changed | 0 |
| 出现两个相同行 | surface-target-ambiguous | 0 |

每次交互Run均封存并验证manifest，静态和负tabindex行不被误纳入。执行回执 `outputs/record-row-browser-validation.json` 保持这四个结果；它是通用控制回归，不是业务验收成绩。新增的选择器单元回归还检查敏感单元格内容不进入候选。

## PocketBase原目标的分阶段复核

继续使用固定摘要的PocketBase0.40.5隔离二进制。原历史已删除的集合重新由可见浏览器通过ProofKit创建相同独有name与title/status字段，独立API确认新建实例；准备会话录像封存。历史创建与端点失败未被改写。

新正式新增Mission `mission-46ea7763-776` 的5个动作，保存 `pkholdout000001`、标题 `ProofKit external review 初始`、状态 `draft`，UI/选定请求响应/独立API精确核对均通过。记录行以原快照返回的单元格选择器打开编辑界面。

宿主驱动随后错误假设提交按钮为Save。实际原观察是Save changes且修改前disabled；因此尚未提交编辑。失败记录保留于 `outputs/pocketbase-row-before-edit-resume.json` 和相应日志。根据新观察修正宿主计划后，先独立确认已创建记录仍为原始ID/collection/title/draft，从它续接，未重复新增。

正式编辑Mission `mission-1d0fd46d-6d5` 的4个动作，把同一记录改为 `ProofKit external review 更新`/`approved`，页面、选定PATCH字段/响应和独立API全部通过。部署请求日志仅按原Run时间区间统计，各为一次新增与一次编辑。首次日志统计错误包含旧尝试，修正前的诊断保留在 `outputs/pocketbase-row-cleanup-log-scope-failure.log`；没有因此重放写操作。

独立清理前确认最终标题/approved及唯一记录，再只删除精确集合；DELETE204后集合与记录GET404、默认users集合保留，服务PID停止。账号及数据库仍按上轮披露保留：PocketBase不允许删除唯一超管，前次递归目录处置被策略拒绝，本轮没有其他工具绕过。业务目标完成不代表全部测试资源清理完成。

## 证据交付与声明范围

`tests/pocketbase-row-evidence.mjs` 离线核验原Run字节不变、两个Mission的原规划观察和会话seal均完整，两个可移动Mission归档校验通过。九张正式动作截图成功解码，三段准备/新增/编辑录像实际播放至297.92/9.88/8.76秒结束。四个相关产品模块摘要与执行前固定值一致；两阶段宿主驱动版本存在上述修正，不能声称同一未改驱动一次执行成功。

面向用户的 `outputs/pocketbase-row-review.html` 保留原目标、预期/实际值、归档入口、原失败链接、人工修正和清理限制；1280/390视口无整页横向溢出，渲染请求0个HTTP。完整回执为 `outputs/pocketbase-row-validation.json`、`outputs/pocketbase-row-review-render.json`。

本样本已参与开发调试，由宿主人工观察和计划；新增、编辑是两个正式Mission及不同会话，集合创建是准备操作。它证明可在当前受控接入下达到原新增/编辑业务预期，不证明未知项目真实模型自主完成、一份自动完整计划及一次连续重放、全项目覆盖或完整网络抓取。Goal保持active，原远程Notes资源与录像限制仍未解决。

## 复核中的截图导航竞态

本阶段加入原有规划会话烟测后，有一次真实 Edge 登录导航的截图在默认5000毫秒内超时，正式业务仍通过但仅保存7/8张动作截图，原失败在 `outputs/planning-session-failure-1792668152285.json`；不能把业务通过替代已请求的完整截图证据。适配器现在把现有截图预算分为最多4000毫秒首次尝试和至少约1000毫秒剩余时间，只在同源页面确实导航且错误为 TimeoutError 或原已识别的上下文销毁/CDP页面附着错误时重试一次。仍使用相同敏感区遮罩，不跨域、不重放点击；普通静态页超时继续暴露缺口。单元回归在修改前失败，修改后通过。真实规划流程及整套回归以最后一次当前构建结果为准，不能用旧版成功覆盖本次失败。

最终当前构建验证：1,720项 Vitest、16项 Node 测试通过，typecheck/build及打包安装后的CLI/MCP分发验收通过。真实行回归覆盖唯一行通过、选择器漂移、稳定ID下内容变化、重复目标三种零误写；复杂控件窗口仍只写入一次。当前构建的8动作/四轮续接规划烟测再次通过，8张动作截图解码，两段录像可播放，唯一业务记录清理读回通过。日志为 `outputs/record-row-final-tests.log`、`outputs/record-row-final-typecheck.log`、`outputs/record-row-final-build.log`、`outputs/record-row-final-distribution.log`、`outputs/record-row-planning-regression.log`。它仍是已知本地夹具兼容性检查，不代表未知应用自主完成率。
