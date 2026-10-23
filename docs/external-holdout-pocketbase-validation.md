# 新外部应用 Web 验收：PocketBase 管理界面

冻结于 2026-10-22，执行前任务范围：用本地隔离的 PocketBase v0.40.5 管理界面，先验证只读首屏和目标归属；使用一次性合成超管账号登录、创建一个隔离业务集合，新增一条带唯一标题和状态的记录、编辑标题及状态；通过独立只读 API 核对当前记录 ID、集合、标题、状态。最后只删除本次创建的资源，并以独立 API/存储读回确认移除。不得更改已有其他数据，缺少身份或验证信息时结论为未知，不能把 UI 提示当作业务通过。可见浏览器执行时留存选定请求/响应、截图和封存录像；报告中区分主流程通过、清理与证据缺口。

后续记录行修复更新（2026-10-22）：原首次阶段未完成状态及失败证据保留。新增能力后，同一原业务目标已由两个受审阅正式Mission完成新增及编辑，更新标题/approved均独立核对，业务集合与记录清理GET404；隔离账号数据残留仍在，整体交付保持cleanup-partial。该结果不是一次自动规划完成。详见 `record-row-validation.md` 与 `../outputs/pocketbase-row-review.html`。

样本性质：这是一项**新外部应用但由本地控制和宿主人工规划**的工程验收，不是未知网站真实模型自主规划，也不是生产服务。应用下载、二进制摘要、执行尝试、人工介入、清理及未覆盖事项将在本次记录中追加，失败不得被后续调试覆盖。若外部下载或环境前置条件不可用，应保留真实阻断并继续推进其他可验证的改进。

## 应用与首次结果

应用为 PocketBase 官方发布的 Windows amd64 v0.40.5 二进制，实际命令回报版本一致。下载包 SHA-256 为 `d0980d1f3a8097ff4c03a876e8c98f3008a83c0d42cc03b636bc92b2d4788d1c`，执行文件 SHA-256 为 `a6d3fb3555b64655e22c797aab7f7c396e9a2c48d7de89135d868b1758734860`。全新临时数据目录、一次性合成超管账号与回环端口隔离；未连接真实业务服务。原始环境记录为 `outputs/pocketbase-download.json`、`outputs/pocketbase-runtime.json`。当前环境没有配置真实模型规划 provider，整个流程由宿主观察后人工选择动作；不读取或借用用户个人模型鉴权。

首次只读观察、登录和弹窗打开均通过 ProofKit；集合字段类型位于60控件截断之后，阻断了安全规划。因此该应用随即退出独立保留集，后续修复重跑是开发调试证据。初始会话达到10分钟录像预算，封存为 partial/duration-limit，不能补称完整录像。

## 从实际问题得到的通用改进

1. 观察入口新增 `controlOffset`：每次读取当前主框架60个控件，保存 offset/total/returned/nextOffset/allControlsObserved；未覆盖的控件和超过500偏移的预算仍明确，不能把最后一窗口当成完整页面覆盖。窗口来自原始 Run/manifest，绑定规则没有放宽。既有 readText/readTable 不得与控件窗口混用；移动端不支持。
2. 新窗口暴露了两个 Create 控件共享候选选择器的问题。现在每个候选除了唯一数量外，还核对是否匹配本次观察的原 DOM 元素；相同名称可以使用实际祖先 footer/header/form 等语义容器作为候选。没有引入全局 nth 或站点分支。
3. 新集合通过 UI 创建，独立 API 验证 collection ID、name、type 及 title/status 字段，记录于 `outputs/pocketbase-collection-created.json`。集合创建属于准备/观察操作，没有计成自动规划或正式 Mission 的完整验收。

## 正式记录验收的原始结果

| 尝试 | 结论 | 真实情况 |
| --- | --- | --- |
| 首次新增 Mission `mission-0d3744b0-a38` | inconclusive | UI 已创建精确目标记录，但 Charter 声明 collection ID 端点，实际管理界面使用 collection name 端点，捕获窗口未匹配，断言与独立 Oracle 未执行。随后独立读到初始记录，再核对 ID/collection/title/status 后 DELETE204、GET404，未盲目重复提交 |
| 修正端点后的新增 Mission `mission-f67a089a-396` | passed，仅新增阶段 | 5个正式动作保存 id/title/status，UI 结果、当前响应/请求投影及独立 API 的集合ID、记录ID、标题、draft状态一致 |
| 编辑同一记录 | 未执行 | 管理界面的可点击表格行没有按钮/链接角色，未进入已支持控件快照；宿主没有拿猜测的行选择器绕过目标绑定，保持完整任务未完成 |

正式新增前独立读数为404。固定记录ID `pkholdout000001`，初始标题 `ProofKit external review 初始` 和状态 `draft`，原编辑目标 `ProofKit external review 更新`/`approved` 没有实现，不能删掉这些要求改称整条生命周期通过。端点错误是验收驱动对部署契约的错误假设，不是 PocketBase 业务缺陷。原错误 Mission 和 Run 字节继续保留，后续通过不追认首次尝试。

## 清理与证据范围

集合删除前重新核对本次collection ID、独有name、字段以及唯一记录的ID/标题/状态；只删除这个隔离集合。独立 API 读回集合与记录均404，默认users集合ID保留，见 `outputs/pocketbase-final-cleanup.json`。只对匹配原二进制路径的PID停止服务。

清理仍有明确限制：PocketBase 拒绝删除唯一超管账号。停止应用后递归删除本次临时数据目录和合成凭据文件的操作被自动审批审查以 `blocked by policy` 拒绝，未换工具绕过。故本地隔离数据库与生成的凭据文件仍保留，不能声称所有测试资源已清理。本轮新样本的受控资源清理不修复此前远程 Notes 的残留和未封存录像。

完整原始范围依然是 incomplete：登录/集合创建准备及正式新增有证据，编辑未执行；不是新的自主规划完成样本。控件窗口与唯一定位修复适用于通用 Web/Electron 控件，但自定义点击行、跨状态全意图报告、首次自动规划仍需继续验证。Goal 保持 active。

## 最终工程和交付核验

全量1,716项 Vitest、16项 Node 测试通过，类型检查、构建及实际安装包的 CLI/MCP 分发验收通过。日志位于 `outputs/control-window-final-tests.log`、`outputs/control-window-final-typecheck.log`、`outputs/control-window-final-build.log`、`outputs/control-window-final-distribution.log`。

独立67控件浏览器回归验证初始60控件和后续7控件，后续窗口原 manifest 绑定的 footer Create 只触发一次写入，超范围窗口失败，录像封存与清单校验通过，回执 `outputs/control-window-browser-validation.json`。既有带登录、弹窗、四轮续接的8动作 MCP 流程在最终构建再次通过，仍只创建1记录且清理读回通过，8张截图和9.48/10.76秒两段录像核验通过；这是受控兼容性回归，不是 PocketBase 编辑通过。

离线核验原失败和新增通过的 Run 字节未变、两个 Mission 均可归档并通过完整性校验；9张正式动作截图解码，五段599.64/1128.52/419.32/11.44/6.80秒录像逐段实际播放至结束。599.64秒片段保持 partial/duration-limit；后续录像不补齐其缺失时段。核验时没有访问被测业务，正式任务结论仍未完成。已封存原始证据及可移动归档入口见 `outputs/pocketbase-evidence-review.json`。

人可读汇总 `outputs/pocketbase-external-review.html` 在1280/390视口验证无整页横向溢出，页面检查发送0个HTTP请求；截图为 `outputs/pocketbase-review-desktop.png`、`outputs/pocketbase-review-mobile.png`。汇总页单独说明新增通过、编辑未执行、原失败、网络/录像范围与残留账号，不靠成功阶段掩盖原意图缺项。
