# 持续 Web 会话的测试资源准备与恢复

2026-10-22 冻结验收约束。当前 inspect_surface 只读；interact_surface 的写操作逐 Run 执行 connector setup/cleanup，不能把由 connector 创建的集合、账号或种子自然保留到多状态探索和最后正式 Run。PocketBase 多状态验收由外部驱动在 Runner 外创建集合与种子，进程异常结束时产品资源日志无法负责该准备阶段。不能将外部驱动 finally 清理误称为可恢复产品能力。

最小产品路径：仅新增一个显式写操作，为已打开的受控 Web 会话准备独立测试资源；它不能由 inspect_surface、plan_test 或用户给的任意 metadata 隐式触发。必须同时具备隔离环境、配置 sideEffects=allow、受信任且带版本/recover 的 connector、operator 写入许可、准确 Web 会话和独立 Test Charter。setup 必须在首次外部写入前调用 registerResources 完整登记归属；产品保存持久 Run/事件/原始 SHA-256 登记，整个会话持有 OS 所有权锁。准备本身永远 not-asserted，不能替代业务 Run 或独立 Oracle。

会话正常关闭：先终止浏览器所有权，再让 connector 只清理由完整登记的资源，逐个 readback 为不存在，封存 cleanup 工件、原始 Run 和会话视频；原业务结果保持原样。进程崩溃：OS 锁释放，重开同版本 connector 后原有 inspect_run_resources 显示 recoverable，recover_run_resources 使用同一登记范围精确清理并再次 readback；外部资源不可识别或权限缺失则保持 unverified，不自动重跑原写入。准备 Run 活跃时恢复必须拒绝；外国资源哨兵保持。

为了避免两个拥有者在正式 Run 时竞争删除，正式 connector setup 只能幂等接管已登记的相同归属；准备所有者锁保持到正式 Run 完成及会话关闭，恢复不应清理仍有活跃 owner 的资源。普通 Run 仍按原有 cleanup 门禁验收。必须在受控 Web 夹具中分别强杀注册后、业务写入后、录像未封存时的子进程，保留原始失败和未封存状态，恢复不误删外国资源。当前产品还没有该跨 Run 准备合同；在实现并验证前，不宣称异常结束能清理 PocketBase 勘探阶段的资源。Goal 保持 active。
## 当前受控实现和实测

现在 prepare_surface_session 为显式写工具：仅在已存在、空闲、受控的 Web 会话中，用版本化 connector 的早登记 setup 分配资源。准备 Run 持有 OS 所有权锁和原始 journal，不是产品测试结果。已准备会话的探索点击/导航复用该所有者而不重复 setup；正式 Run 则在受信任的 setup context 收到真实 preparationRunId，由 connector 验证并幂等接管相同范围。正常会话关闭清理且独立 readback；原正式业务结果不被改写。加密跨进程浏览器存储当前显式拒绝与准备资源组合，避免恢复后形成无主数据。

真实 Edge 受控回归 outputs/session-prep-adoption-browser.log：准备一个隔离 scope，仅一次 POST；同会话导航和再次观察后，Core 正式 Run 的独立 reader 验证相同 owner 并 passed，正式 Run cleanup verified；会话关闭时准备 Run 对已删除资源再次读回 verified，外国哨兵保持。会话网络 sealed，4.84秒录屏实际播放至结束，正式与准备清单均 intact。此前探索导航被旧的逐 Run setup 阻断、初次夹具根路径与轮询造成的失败均保留在 outputs/session-prep-browser.log、session-prep-browser-final.log，不追认为成功。

进程级验收 outputs/session-preparation-recovery-validation.json：注册后未写入与已写入后两处强杀子进程；活动期间 inspect_run_resources 为 active，原进程退出后为 recoverable，同版本 recover_run_resources 对原范围分别以 GET404 或 DELETE+GET404 验证移除。两次原 run.json/events.jsonl 字节与 SHA-256 保持不变，恢复结果是新独立工件；外国哨兵未删除，也没有重放 POST。取消时原 setup 收尾即便已移除资源也保持 unverified，之后须用独立 recovery readback 转为 cleaned；失败和修正留在 outputs/session-prep-final-targeted.log、session-prep-final-targeted-3.log。

边界：这是受控 connector 和合成内存资源，不是 PocketBase 残留账号的实际恢复，不是未知应用的自主规划。暂未验证在真实有录屏的浏览器进程被强杀时，视频与资源如何一起呈现未封存/可恢复；不能把正常关闭录屏成功外推为崩溃时完整视频。Goal 继续 active。
最终构建验证：outputs/session-prep-final-targeted-3.log 中准备生命周期17项测试通过，outputs/session-prep-mcp-final-targeted.log 中 MCP 工具51项测试通过，outputs/session-prep-final-typecheck.log、outputs/session-prep-final-build.log、outputs/session-prep-final-distribution.log 通过；outputs/session-prep-final-tests.log 为1,742项 Vitest 与16项 Node 测试通过。分发包包含 prepare_surface_session，且无写权限时返回明确拒绝。当前实现不替代普通 Run 的 setup/cleanup，也不自动让未知网站获得业务 Oracle。
