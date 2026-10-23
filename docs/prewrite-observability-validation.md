# 提交前的验收可观察性检查

2026-10-21，北京时间。承接酒店站真实实测：原完整预订在创建后才发现独立接口不返回 email 与 contactNumber。当前改进复用现有 readiness / preflight 路径，让草稿可以先报告这个已知缺口，并在执行前再次检查；没有新增测试平台或网站专用内核分支。

## 产品接口

`inspect_integration_readiness` 现在支持三种互斥输入：catalog `charterId`、已固定摘要的候选 `charterPath + charterSha256`、完整 `charter` 草稿。草稿必须声明 surfaces，接受的序列化内容最多 128 KiB。输出使用 `draftSha256` 标识规范化后的具体草稿，只包含检查结果与来源摘要；不保存草稿，不创建 Mission/Run，不调用 setup、Capability、Oracle 或 Run 生命周期 preflight。

草稿内容经过 JSON 隔离，防止调用方之后修改嵌套 metadata 影响已开始的检查；连接器修改所检查草稿时，结果不能为 ready。已有超时、取消、输出边界及凭据清理规则保持有效。CLI 的 `readiness --draft .proofkit/charters/draft.yml` 和 MCP 均已覆盖。摘要只绑定这次规范化内容，不能代替候选文件摘要、审批、业务事实或未来状态。

规划提供者与生成的宿主 Skill 提示现在明确区分意图必验字段、请求投影、响应回显、独立终态字段；源码示例不能直接充当部署响应结构证据。这个提示变更尚未证明未知站点自主规划成功率提高。

## 受控执行前回归

`tests/readiness-observability-smoke.mjs` 使用独立 HTTP 服务计数。代表样本不含联系字段时，草稿检查为 blocked，不产生执行记录；正式 Run 的 preflight 再次拒绝，步骤数 0、Oracle 数 0、被测浏览器连接 0、创建预订请求 0。草稿自报 confidence=1、空 gap 列表也不能越过实际 preflight。

受控样本补齐类型正确的联系字段后，准备状态为 ready，但 `testVerdict` 仍为 not-asserted，且 responseSchemaVerified=false；没有执行新业务或声明未来记录正确。样本读不到时，状态为 unavailable。缺少明确的已有合成样本 ID 时，不发网络请求，也不会为了让检查通过而创建一条新记录。

## 真实站点复核

当前构建在 `https://automationintesting.online` 对一个显式声明的已有演示记录检查。只调用演示认证 POST 和样本 GET；没有调用创建预订接口，也没有连接被测浏览器。完整八字段要求保持不变。

最终草稿检查返回 blocked，原因是该样本缺少 email / contactNumber 的独立字段。随后正式 Run `20261020173342-56f8bc00` 重新检查并保持 blocked，九个计划步骤全部未执行，Oracle 没有运行。原始 Run 清单 intact，草稿内容摘要与保存的输入一致，关键运行文件及连接器与执行前摘要一致。该实测不是被测网站缺陷，也不是业务通过。

执行前诊断并非全局强制的新策略：只有显式注册 readiness 的连接器会执行只读检查；真正阻止业务写入需要连接器同时注册 preflight。示例 `tests/booker-readiness-integration.mjs` 将同一个明确只读的检查绑定到两者。任意已有 lifecycle preflight 不会被当作只读函数调用。已有记录的字段类型只能提供准备条件样本，不能认证整个部署的 API 合同。

## 证据与复核命令

- `outputs/readiness-prewrite-review.html`：面向用户的结果说明，明确准备检查与业务通过的区别。
- `outputs/readiness-prewrite-review.json`：Run 清单、草稿摘要和当前关键代码摘要的复核结果。
- `outputs/readiness-observability-validation.json`：受控接口计数、ready/blocked/unavailable 三个边界与阻塞 Run。
- `outputs/readiness-observability-live-validation.json`：真实站点的请求路径、准备检查及执行前阻塞证据。
- `outputs/readiness-render-verification.json`：1280 / 390 宽度检查和原始 Run 的九条 not-run 记录。

本轮未执行被测页面动作，因此没有新的操作视频或被测页面截图。报告渲染检查另开的是本地报告浏览器，不能算被测应用连接。旧酒店操作报告与录屏仍保留为历史证据，不能用来认证当前新版本。

复核顺序：`pnpm build`，再执行 `node tests/readiness-observability-smoke.mjs`；指定 `--live-booker` 才会做上述真实站点只读检查和阻塞验证。之后运行 `node tests/readiness-review-report.mjs` 与 `node tests/readiness-report-smoke.mjs`。真实检查依赖此前保存的完整酒店意图合同和现有演示样本，样本消失时应报告 unavailable，不能自动创建产品数据来绕过。

所有产物保留在本机工作区或临时目录。局部哈希校验不是外部防篡改认证或长期归档承诺。整体 Goal 保持 active；未知项目的规则提取、部署合同证据、全流程计划质量及更广泛重复验收仍需完成。

## 工程检查记录

构建通过。全量重跑为 1,474 个 Vitest 测试及 13 个 Node 测试通过，日志为 `outputs/draft-readiness-verified-tests.log`。之后补充了失败结果仍保留原始 surfaces 的数组隔离，重新构建、35 个就绪检查测试及受控/真实站点验证均通过；最后一次真实验证采用上方 Run ID，记录在 `outputs/readiness-draft-isolation-tests.log` 和上述结构化验证产物。

首次全量暴露的旧 CLI 提示兼容性已修复，没有放宽输入约束。第二次全量中，一条 MCP 等待轮询测试出现预期 2 次调用、实际 3 次的时序差异；该等待逻辑及断言未修改，单独复核和随后完整重跑通过，具体波动原因未确认。保留 `outputs/draft-readiness-workspace-tests.log`、`outputs/draft-readiness-final-tests.log`、`outputs/readiness-wait-boundary-recheck.log`，不把失败删除或当作未发生。上述工程结果不计为未知项目自主规划成绩。
