# 原始多状态 pin 的单场业务重放

冻结于2026-10-22。应用仍为已调试的本地隔离 PocketBase v0.40.5，不能计新外部网站或模型盲测。任务：只在本次唯一集合内，先用同一持久 Web 会话对登录页、集合列表、新增表单、固定ID记录行和编辑表单分别做只读 inspection 并封存原清单；为观察未来状态而准备的种子记录须在正式执行前按ID独立删除并GET404，浏览器登出复位。最后一份带全部原始inspection pin的 Charter 在同一会话执行登录、新增draft、打开同一记录、编辑为approved，选定请求/响应与独立当前GET同时核对。资源、录像、截图、报告及失败尝试均明确记录。

这不是模型自动发现页面，也不是原始“通过UI创建集合”的全范围；集合由受控 API 在规划前准备、正式后精确删除，合成唯一超管数据库及凭据仍留存。任何动态控件未能从同会话原始观察绑定时，不降级成未pin的单场通过。目标仍为 Goal 的通用Web意图规划与证据闭环，不把这次夹具式集成试验当最终证明。
## 实际执行和原始失败

验收驱动为 tests/pocketbase-pinned-planning.mjs，每次尝试独立保存输入摘要、事件日志、失败或结果和最终收尾回执。前三次分别因录像模式冲突、准备阶段空资源登记、误用已脱敏的页面 URL 刷新而在正式 Run 前失败。原始日志为 outputs/pocketbase-pinned-driver.log、outputs/pocketbase-pinned-driver-2.log、outputs/pocketbase-pinned-driver-3.log，不追认通过。每次创建的集合均按归属核对后删除并独立 GET404。

改用持续会话录像、仅在正式阶段接管集合，以及通过页面观察到的 Refresh 控件刷新后，第四、第五次已调试场景各完成六份同会话原始状态 pin、精确删除勘探种子并 GET404、UI 登出复位、单场17动作核心级 Mission、本次 create/edit 两组请求响应字段和独立最终 GET、归属清理并 GET404。第四次日志 outputs/pocketbase-pinned-driver-4.log，第五次补齐移动归档后原始六份清单、17张解码截图、录像播放及1280/390布局，日志 outputs/pocketbase-pinned-driver-5.log。这是宿主人工编写的已知应用流程，不是模型自主规划成绩。

## 行身份和报告回归

原生表格行浏览器回归扩展到10类，复现隐藏表头与可见单元格错位时，用可变标题冒充 ID，记录被替换后仍会点击写入。修复前负向日志 outputs/row-identity-before-fix-2.log；修复后按原列位置配对，且只在单行表头、无 colspan/rowspan、唯一明确 ID/Identifier 表头时将行身份缩短到 ID，否则退回完整行文本。outputs/record-row-browser-validation.json 记录3个合法写入、7个目标漂移或歧义均零写入。这是通用 DOM 行身份处理，不包含站点专用分支。

报告首屏原来的“Evidence partial”可能仅表示 bounded 展示省略引用，与完整 Mission 验收证据混淆。现在分别显示“Acceptance evidence intact/partial/degraded”与展示省略条数，保留原业务判定和两套审计。受控回归覆盖完整、降级、超限和展示省略。最终构建与真实应用复验见 outputs/pocketbase-pinned-latest.json 和 outputs/pocketbase-pinned-report-final.log。

## 未完成边界

API 预备集合与勘探种子目前由验收驱动显式记录并在 finally 清理，不在产品可中断恢复的准备 Run 内；异常进程终止后的资源恢复仍待产品化。不能把本次试验算作新用户只给意图和地址即可一次完成。未知应用的真实模型规划、更多业务流程和账号、通过原始 UI 创建集合、网络正文完整性、长期交付，以及合成超管数据库残留仍待验收。Goal 保持 active。
最终同构建复验：mission-477321b9-484 的单场 Run 20261022124316-1c60b276，17动作通过，六份原始规划清单均保留在移动归档，17张原始及移动后截图逐一解码，17.24秒会话录像在移动归档离线播放完毕。Mission 验收引用完整；首屏另明确显示71条总览未展开引用。归档摘要 ec202c90b028c48c2c146d1a3bce4248ccd5b0e037aed93113c39046860ec633 验证 intact，报告1280/390无整页溢出。结果输出目录见 outputs/pocketbase-pinned-latest.json，移动包在同目录 delivered/。正式集合/记录 GET404，会话 closed，视频 sealed；合成账号/数据库整体仍 cleanup-partial。

最终静态检查：outputs/mission-evidence-label-targeted.log 的37项报告回归、outputs/mission-evidence-label-typecheck.log、outputs/pocketbase-pinned-final-build.log 均通过；outputs/pocketbase-pinned-final-tests.log 全量1,725项 Vitest 与16项 Node 测试通过。浏览器兼容：semantic-form、planning-session、distribution 均通过；Web-only release 正常样本6个 Run /12项检查通过，故障注入仍 failed、10项通过2项失败，日志 outputs/pocketbase-pinned-web-release.log 与 outputs/pocketbase-pinned-web-release-defect.log。当前试验 PocketBase 服务进程按 PID/二进制路径核对后停止，未尝试绕过先前拒绝的数据库/账号文件删除策略。
