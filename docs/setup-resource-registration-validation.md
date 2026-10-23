# Setup 提前资源登记与中断恢复验收

日期：2026-10-21。此阶段补上“资源已创建，但整个setup还未返回清理句柄”时缺少恢复记录的窗口。采用既有资源日志、归属锁与恢复服务，没有新增另一套清理系统。

## 原始问题与复现

旧ExecutionRunner只在setup返回后调用IntegrationLifecycle.register。若连接器先创建隔离账号/命名空间，后续步骤失败或进程被终止，原资源可能没有已登记的归属和恢复入口。Notes辅助器还存在独立于Run创建账号、凭据仅在进程内存的问题；本次改动不自动修复该历史实例。

新增首批5条回归在修改前4失败、1通过，日志 ../outputs/setup-registration-before.log。它们复现失败setup没有触发已知资源清理、没有登记产物等现象。

## 接口与执行保证

Runner为setup提供registerResources(handle)。连接器在执行写入前检查该回调存在，准备完整的隔离范围和幂等cleanup，并await登记。回调先使用原有IntegrationLifecycle校验、登记和原子日志，再将登记产物写入Run摘要，成功后才返回。登记失败应停止后续写入。

只允许已经通过原环境、Charter副作用策略和操作者写入许可的write setup使用此接口。每个setup仅能登记一次完整句柄，仍受每Run最多32个唯一资源及标量事实约束。回调在setup结束或取消宽限期后关闭，不能用逃逸回调改写已结束Run。

setup可以自然结束或返回原句柄；同一对象不会重复登记或清理。返回式旧连接器继续支持。TypeScript上下文把新回调声明为可选，以兼容直接调用旧连接器的代码；需要此能力的连接器必须在写入前检查它。接入示例见 agent-integration.md 的 Scoped setup and cleanup。

setup后续失败时，已登记的清理句柄仍由Runner持有并尝试释放。取消后5秒内仍未settle的setup保留资源所有权，原清理结论保持unverified；setup迟到结束后额外尝试清理已登记范围，避免晚到写入逃过首次清理。这个异步补偿不会把旧结果改成已验证，也不补写冻结证据。可信连接器仍须响应取消、实现幂等删除，并在相同范围独立读回。

## 回归与构建

最终类型检查、所有工作区包及分发bundle构建通过，全量1,637个Vitest和16个Node测试通过。日志 ../outputs/setup-registration-typecheck.log、../outputs/setup-registration-bundle.log、../outputs/setup-registration-tests.log。

新增9个Runner用例，覆盖：写入前落盘、后续setup失败、返回同一句柄与不返回句柄、回调关闭、重复登记拒绝、read-only禁止登记、日志失败阻止写入但仍清理句柄、未await登记的执行器收敛，以及取消宽限期后的迟到写入。迟到用例同时核对Run归属锁持续有效，待补偿结束才释放，原run.json字节不变。

## 真进程终止与本地HTTP资源验收

可重复命令：

~~~text
pnpm test:smoke:setup-recovery
~~~

本次直接运行等价的构建后脚本tests/setup-registration-recovery-smoke.mjs。子进程通过真实LocalRunner开始setup，在准备好的隔离命名空间上登记；父进程用独立Runner检查活跃状态，确认活跃时恢复被拒绝，然后SIGKILL原进程，再由新服务执行原恢复入口。

| 中断点 | 原Run | 恢复结果 | DELETE次数 |
| --- | --- | --- | --- |
| 已登记，未创建数据 | 20261021133104-e4946465 | 独立GET404确认不存在，verified | 0 |
| 已创建且收到响应，setup未返回 | 20261021133105-dc60590b | 核对owner后删除，GET404，verified | 1 |
| 服务端已创建，故意不返回创建响应 | 20261021133105-7624d95b | 未依赖写入响应，按登记scope核对owner后删除，GET404，verified | 1 |

三例中外来sentinel资源均保留；重复恢复复用原已验证恢复记录，不再DELETE。最终只剩sentinel，原Run仍为中断时的running，不将清理成功变成产品通过。原run.json、events.jsonl和integration-setup.json字节前后相同，清理证明位于独立recoveries目录。恢复回执testVerdict保持not-asserted。

回执 ../outputs/setup-registration-recovery-validation.json 保存精确Run、清理证明、子进程退出信号、调用次数，以及Runner/lifecycle/recovery/contracts/脚本的5个执行前后匹配SHA-256。日志 ../outputs/setup-registration-recovery.log。原有恢复服务的tamper、并发、策略和归属回归也包含在全量测试中。

## 未解决的范围

- 这是受控本地HTTP命名空间的工程验收，没有新的公开网站业务执行，没有浏览器录像或真实远端账号认证恢复结论。
- 提前登记要求能在创建前确定隔离scope。只在创建响应后才知道ID、又不支持操作者命名空间的站点，仍有远端写入与登记间隔；本接口不提供跨系统原子事务。
- 故意忽略取消、永不settle或不幂等的可信连接器不能由Node强行停止；不把best-effort迟到清理当完成证明。
- 登记日志不存储凭据，也不能恢复遗失的内存令牌。旧Notes账号和笔记仍未确认清理，旧中断录像仍未封存。其辅助器必须迁移到受管理的生命周期并设计受控认证恢复后另行验收。
- 所有断言针对资源归属与清理；不证明未知项目自主测试规划、原意图完整覆盖或生产级目标完成。

Goal保持active；接下来仍需把真实测试数据接入现有生命周期，以及完善宿主规划续接、单一首次测试主路径和跨阶段意图结果汇总。
