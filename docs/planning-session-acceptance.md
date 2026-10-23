# 持续观察、规划续接与浏览器证据验收

日期：2026-10-22。本轮补齐 MCP 的只读 Web 会话起点，并以一个有登录、导航、弹窗、异步保存和独立后端读数的受控本地应用验收。它不构成陌生网站模型自主完成率。

## 问题与实现

原 `inspect_surface` 可以复用 `sessionId` 却不能只读创建会话。宿主若想从首次观察继续多页规划，须先调用一个探索动作，增加了错误导航或写入风险。现在 `inspect_surface({ keepSession: true })` 创建归属明确的 Web 浏览器并返回 `sessionId`、inspection pin；`plan_test({ keepSession: true })` 也可从只读观察启动。两者仅支持 owned Web，不支持 CDP、Electron 或移动端。已存在会话的规划仍按原有 `sessionId` 使用。

规划请求保存原意图和要求，续接只补充新观察摘要；返回的 sessionId 可用于该浏览器下一轮只读观察、经审阅的交互及正式 Mission。新建会话在异常规划失败后关闭，调用方已有会话不被误关。标签是人可读名称，不是账号认证。CLI 的跨进程 plan 仍依赖显式配置的加密会话持久化，不应把 MCP 进程内会话能力解释为默认跨进程持续。

实际浏览器流程揭示另一个入口阻断：项目连接器有写入型 setup 时，原只读观察会触发该 setup，导致观察被策略阻断。现只在受信任的只读观察、纯等待路径跳过产品 setup/preflight/postRun；正式 Run 和可能写入的探索点击仍走原生命周期和授权门禁。用户自行提交带 `purpose: surface-inspection` 的 Charter 不能冒用内部标记。项目运行时的启动/目标归属检查未绕过。

导航中的截图先后遇到 Playwright `Execution context was destroyed` 和 CDP `Not attached to an active page`。适配器只针对这两种同源导航中断，在同一时间预算内再尝试一次，并重复使用原敏感区域遮罩；跨源、页面关闭、其他遮罩错误或二次失败仍记录截图缺口。恢复后的截图如果成功，Runner 额外保存导航后页面快照；该快照失败时不抹掉已保存截图，也不把旧快照冒充最终状态。

## 实际验收与边界

`tests/planning-session-smoke.mjs` 通过进程内 MCP client 调用真实工具，使用可见 Edge 和一个人工编写的观察感知 provider：

1. 新建只读会话观察登录页，未触发登录或业务写入。另建隔离浏览器并验证仍未登录。
2. 四轮 `needs-observation` 提议与原始 inspection pin 绑定，分别填入合成用户、登录、打开弹窗和填写标题；每轮在同一个浏览器观察并从不可变续接恢复原意图。此阶段不提交业务记录。
3. `ready-for-review` 只代表计划结构；正式 Charter 从登录页重放八个动作，仅提交一次业务记录。独立后端 GET 以本次响应 ID 检查归属、标题和终态，Mission 才判通过。独立未登录会话始终隔离。
4. 连接器在正式 Run 注册归属资源，清理有独立 GET404 读回；外部哨兵记录保留。两条持续会话关闭后才有封存录像。用浏览器实际播放两段视频至结束，校验原 manifest，解码八张正式动作截图，复核报告桌面与窄屏均不发生整页横向溢出。

原始诊断没有抹除：首次真实运行因只读观察触发写入 setup 被阻断，原日志保留于 `outputs/planning-session-before-lifecycle.log`；后续验收驱动曾错误读取不存在的清单哈希（`outputs/planning-session-manifest-driver-failure.log`），并误将懒加载图片当成损坏；另两次导航竞态少一张截图，失败细节保留在 `outputs/planning-session-failure-*.json`。最终验收以最近一次实际运行的 `outputs/planning-session-validation.json` 及 `outputs/planning-session-smoke.log` 为准。

首次 Mission 报告在会话尚活跃时不能声称录像已封存。关闭会话后再次 `get_mission_evidence`，才可交付带有原始 seal 和播放链接的最终报告。MCP 默认摘要现在显示每个相关 capture 的完整性、状态和原因；不能把已通过的业务结果与尚缺失的录像混为一谈。

这仅证明一个设计者已知的受控应用、脚本化观察提议与受控独立 reader 可以通过 ProofKit/MCP 完成完整流程。没有证明真实模型的陌生站点规划成功率、跨进程默认持续、生产级多账号授权或对所有网络请求的完整抓取。视频像素不做脱敏，需要使用隔离测试数据并按组织保留策略处理。Goal 保持 active。

## 最终回归记录

当前源码的全量 `pnpm test` 为 1,709 项 Vitest 与 16 项 Node 测试通过；`pnpm typecheck`、`pnpm build` 及实际 npm 打包安装后的 CLI/MCP 分发验收通过。日志分别保存在 `outputs/planning-session-final-tests.log`、`outputs/planning-session-final-typecheck.log`、`outputs/planning-session-final-build.log`、`outputs/planning-session-final-distribution.log`。`git diff --check` 无空白问题。

本次实际 MCP/browser 接受样本的 Mission 为 `mission-5005e0a8-7da`，工作区位于 `C:/Users/殊途/AppData/Local/Temp/proofkit-planning-session-naXTQp`。五次 provider 调用、四轮原始观察续接、八个正式动作，唯一合成业务记录经独立读数通过并清理；外部哨兵保留。两段封存录像实际播放至 6.28/7.52 秒终点，八张正式动作截图成功解码。关闭会话后重新生成的 Mission 报告在 1280/390 视口下均无整页横向溢出，录像完整性和视频播放器可见。产物为 `outputs/planning-session-validation.json`、`outputs/planning-session-desktop.png`、`outputs/planning-session-mobile.png`。五个执行/驱动摘要于运行前后匹配；该 fixture 由脚本和本地 HTTP 后端提供，不是外部真实网站成绩。
