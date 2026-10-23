# 单场记录生命周期试验

冻结于2026-10-22，已调试外部应用 PocketBase v0.40.5。任务范围：受控连接器在正式Run开始前注册并创建一个唯一隔离集合，字段为title/status；正式核心级Web Mission在可见浏览器中登录合成超管账号，创建固定ID记录，初始标题/状态为 `ProofKit one-flow 初始`/`draft`；从同一表格行打开编辑，更新为 `ProofKit one-flow 更新`/`approved`。选定两个请求/响应分别核对相同记录和字段；独立后台GET确认最终精确集合ID、记录ID、标题和状态。Runner结束后连接器只清理这个集合，必须有精确归属校验和GET404。录屏、逐动作截图、完整性清单和报告均为验收项，缺失时不得冒充充分证据。

这次只检验**同一场正式Mission内的新增与编辑**。集合本身通过受控API在setup创建，不计入浏览器UI任务；宿主计划依据上一轮已观察的PocketBase控件和接口人工编写。项目已经调试过，不是陌生项目盲测，没有真实模型规划provider。即使通过也不能追认首次失败，不能证明一次自主生成完整原始意图的规划。隔离数据库的唯一超管与合成凭据文件沿用前次残留，前次递归处置被策略拒绝，不换工具绕过。所有失败和人工修正将保留。

## 原始失败与修改

首次Mission `mission-aca7e7e4-ee3` 在正式Run前失败，未创建集合，摘要因没有可审计的Run而保持inconclusive。直接Run诊断也没有启动资源：验收驱动给setup配置的cleanupTimeoutMs=10000超过合同最大5000。原始泛化任务失败和具体配置错误分别在 `outputs/pocketbase-one-run-failure-1792669256656.json` 与 `outputs/pocketbase-one-run-direct-error.json`。将驱动策略改回5000后另建Mission，不修改原失败结果。

## 当前构建的单场执行与证据

新的 `mission-a8a6d19c-cd0` 仅有一个正式Web主Run `20261022114422-bab01738`，17个动作全部passed：登录、选定集合、创建固定ID/draft记录、由该ID的表格行进入编辑表单、更新标题/approved。两个选定HTTP响应及提交的title/status分别核对，独立GET验证最终collection ID、record ID、完整标题与approved。Run Oracle passed，连接器在setup写入前登记唯一集合，结束后按归属核对并DELETE，独立集合及记录GET404；业务数据无残留。原Run manifest完整。

报告 `outputs/pocketbase-one-run-delivery/mission-a8a6d19c-cd0/index.html` 为可移动归档入口，验证摘要在 `outputs/pocketbase-one-run-validation.json` 和 `outputs/pocketbase-one-run-delivery.json`。原始Run字节和五个执行/驱动摘要前后相符，17张逐动作截图实际解码，4.24秒Run录像播放至结束。1280/390桌面窄屏整页无水平溢出，报告下钻到全部17步和选定响应。Mission报告首屏“Evidence partial”指呈现层遗漏59个明细引用，当前Mission验收引用65/65完整；不应把呈现截断等同证据文件损坏，也不能称所有网络请求完整抓获。

## 字段选择器兼容性校准

真实动态表单可能在每次打开时生成新的ID。优先改用role选择器曾导致旧Charter使用的 `#id` 原始inspection pin失配：原Web-only发布套件在修复前回归得到surface-selector缺口，日志 `outputs/semantic-form-web-release-compat.log` 保留。现在保留原test-id/ID主选择器，并附带最多两个**同一DOM元素、唯一匹配**的alternateSelectors；规划绑定及原manifest审计两种选择器，执行仍复核当前唯一目标与身份。

控制本地网页每次打开表单都会重生ID；原ID变化而语义Title/Status备选保持不变。使用前一观察pin对第二次打开的表单成功填入，并在一场核心级Mission独立验证服务器准确保存一次，见 `outputs/semantic-form-validation.json`。原Web-only发布成功与后台写错导致的失败校准，在同一构建下重新通过，日志 `outputs/semantic-alternates-web-release.log`、`outputs/semantic-alternates-web-release-defect.log`。不能因新语义路径改善而破坏已有ID路径。

## 未完成边界

这个真实外部应用是宿主人工构造的已知流程。未来页面控件选择器取自之前调试观察，但本次一场正式Mission没有为它们保存一套同会话的完整原始多状态pin；唯一性、选定请求/响应和最终独立业务读数可证实本次实际结果，却不能证明规划来源充分，尤其不能推广为陌生应用的自主规划成功。集合UI创建不在这场Mission内，账号与隔离数据库仍按前次策略拒绝状态留存，整项交付仍是cleanup-partial。Goal继续active。

## 当前构建兼容与重复验收

ID优先路径与稳定语义路径不再互斥：主选择器保持test-id/ID，WebAdapter仅在实际DOM元素同一、全页唯一、文本通过已有脱敏检查时最多提供两个alternateSelectors。结构化规划绑定及原始manifest审计接受这两类已保存候选，执行阶段仍复核唯一当前元素与身份；失败定位与交互摘要也识别备选，不会误把它报告为消失。直接改成role优先曾使旧版Web发布套件出现surface-selector缺口，修复前失败原日志继续保留。

当前构建下，动态ID表单的ID主选择器每次打开都变化，绑定第一观察pin的role备选可以操作第二次表单，受控单Mission独立保存一次。原Web发布正常与注入后台错误两套各6个Run的验收都再次通过，后者仍保持failed/10通过2失败，不能随备选选择器被误判成功。重复PocketBase隔离样本 `mission-6668d411-01e` 使用同一已调试人工Charter，再次以一个17动作Run通过两个响应、终态独立GET和精确集合清理；17张截图、3.76秒视频及可移动归档核验完整。重复不计新应用、未知任务或模型自主成绩；前次归档及Mission字节保留。记录 `outputs/pocketbase-one-run-prior-alternates.json`、`outputs/pocketbase-one-run-prior-delivery.json` 与当前 `outputs/pocketbase-one-run-validation.json`、`outputs/pocketbase-one-run-delivery.json` 分离。

全量当前构建1,723项Vitest和16项Node测试通过，typecheck/build、实际npm安装后的CLI/MCP分发，以及控制窗口、记录行、八动作规划续接回归均通过。日志为 `outputs/semantic-alternates-final-tests.log`、`outputs/semantic-alternates-final-typecheck.log`、`outputs/semantic-alternates-final-build.log`、`outputs/semantic-alternates-final-distribution.log`。合成任务的全流程路径不能替代真实模型规划及多状态原始目标pin；剩余目标未缩减。
