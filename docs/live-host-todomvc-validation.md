# TodoMVC 真实宿主样本

2026-10-20，Codex 在当前会话中根据真实页面观察编写 Charter，交给 ProofKit 的宿主提交、原始观察绑定和 Mission 执行路径。此次没有使用返回预制计划的模拟提供者，也没有调用第二个模型 API。

## 来源与范围

- 外部应用：TodoMVC 的 JavaScript ES5 示例，固定源码提交 `ff43b02e59dfa604386bb382034b2cd07c2bcd8a`。
- 运行目录位于操作系统临时目录，未改动应用已跟踪文件。使用提交中的 `examples/javascript-es5/dist`，没有重新生成或替换应用逻辑。
- 浏览器由测试辅助进程持有，ProofKit 通过 CDP 接入同一个应用上下文。
- 独立读数调用应用的 Store API，读取待办记录的 ID、标题和完成状态，而不是根据页面文案推断结果。
- 该版本明确使用内存 Store；本次不验证持久化、数据库或进程重启后恢复。
- CDP 附加模式有逐步截图和事件，不能使用新建自有上下文的录像模式。本次没有录像完成声明。

## 保留的执行记录

1. 首次新增一条待办成功，独立模型中出现 ID 为 1、标题匹配、未完成的唯一记录。
2. 随后的真实观察发现两个可见、启用的匿名复选框均没有 selector 或原生操作提示；宿主没有猜测定位器继续操作。记录见 `outputs/todomvc-host-blocker.json`。
3. 该发现触发通用原生控件 class 备用定位。新候选只来自实际观察，必须唯一；重复 class 不转换成顺序索引。正式操作仍执行原有身份检查。
4. 第一次修复后重跑遇到 CDP 监听不可用和已关闭页面，单独保留为环境中断，没有归为产品失败。
5. 新隔离实例中，新增、完成、只读 Completed 路由核验、清空分别通过四个有限范围的 Mission。每次有独立 Store 读数和完整清单；最后的运行时 Store 为空。

总记录在 `outputs/todomvc-live-host-validation.json`，包含报告路径、移交时清单摘要和实际执行的框架构建文件哈希。`outputs/todomvc-host-*.json` 是宿主当时编写的请求示例，包含只适用于原始实例的观察摘要，不能直接拿旧摘要重放到新实例。

**这个应用已经用于改进框架，修复后结果属于定向回归。** 四个分段检查不能算成四个独立项目，也不能给出总体完成率或未见项目盲测成绩。独立读数是运行时应用模型层的证据，不是外部后端终态或耐久性证明。

## 复核方式

先构建 ProofKit，准备上述提交的独立、干净 TodoMVC 检出和已经存在的测试工作区父目录，再启动辅助进程：

```powershell
node tests/todomvc-host-acceptance.mjs --project-root C:\qa\todomvc --workspace-root C:\qa\runs\fresh-host-sample --source-commit ff43b02e59dfa604386bb382034b2cd07c2bcd8a --headful
```

`--workspace-root` 必须是新的目录，防止覆盖先前样本。辅助进程只在回环地址监听，连接资料保存于新工作区的 `host-control.json`；请求使用该文件中的 Bearer key。

- `GET /inspect`：取得当前页面及其原始清单摘要。宿主根据此次结果规划，不直接使用历史请求中的定位器或摘要。
- `GET /state`：读取独立的运行时 Store 状态。
- `POST /run`：以 `application/json` 提交 `{ inspection, charter, oracleName, expect }`。`inspection` 为 `{ runId, manifestSha256 }`。测试辅助器仅注册 `todo-created`、`todo-completed`、`todo-cleared` 三个事先审核的业务读数。
- `POST /close`：释放隔离浏览器和本地服务。原始工作区与报告继续保留。

此辅助器仅属于源码仓库的验收工具，不是通用产品服务，也没有往测试内核加入 TodoMVC 分支。重复复核应保留失败和中断，冻结源码与框架版本；后续用其他未参与调试的应用单独建立保留集。
