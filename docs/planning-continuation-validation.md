# 保存引用规划续接：实现与验收

日期：2026-10-21。本阶段减少宿主每次补观察时重传原始要求和全部历史pin的负担，复用现有plan_test和CLI plan，没有新增另一套任务执行器。

## 用户路径变化

原来模型返回needs-observation后，宿主必须保留并重传完整intent、expect、oracleNames、力度、模式、权限、sessionId及全部观察pin；漏项可能改变规划范围。现在一个已独立核验原观察的模型请求会得到observationRequest.continuation，结构为{id, sha256}。

宿主仍审核并通过现有interact_surface执行必要的探索动作，之后inspect_surface取得新pin。续接只需：

~~~json
{
  "continuation": { "id": "<returned UUID>", "sha256": "<returned digest>" },
  "inspections": [{ "runId": "<new inspectionId>", "manifestSha256": "<original manifest.sha256>" }]
}
~~~

这是plan_test参数。CLI等价为：

~~~text
proofkit plan --continuation <id:sha256> --inspection <new-run-id:manifest-sha256> --root <source> --workspace <workspace>
~~~

续接可以省略原意图和其他要求；新计划仍要求intent。若显式重传要求，必须匹配保存值，预期文本/reader允许同一多重集合重排，不允许空列表、缺项或复制替换弱化。改需求需要新计划。

## 保持的要求与边界

保存的要求包含原始intent、目标URL、表面、expect、oracleNames、mode、sideEffectPolicy、level、coverage、headful与sessionId。原pin自动并入新pin；同一Run相同摘要去重，换摘要拒绝。每个原pin仍通过原有manifest、原始快照、项目、适配器及会话归属核验，然后才交给模型。保存引用没有取代原观察验证。

文件位于外部测试workspace的.proofkit/planning/UUID.json，保存projectRoot/workspaceRoot、时间、轮次与声明数据，限256KiB。使用独占创建、写入及sync，成功关闭后才返回引用；中断留下的不完整文件没有已返回的可用引用。加载核对ID、SHA-256、大小、普通文件/目录、重定向、读取期间文件身份及项目/workspace归属。它是本地摘要引用，不是外部签名、身份认证令牌或加密存储。保存原始请求文本，使用与Charter相同的访问控制责任；不保存浏览器cookie、令牌或模型密钥。

每条续接链最多保存10次缺失观察请求、合并10个不同观察状态；第11次模型输出仍请求观察时停止而不再保存。重用早先引用可以分支，此边界不是全局费用额度。文件没有时钟过期或自动清理；源文件丢失/改变、观察不可验证或原会话不可恢复时拒绝继续。

新进程能恢复规划记录，不意味着浏览器已认证会话自动存在；需要保留原session时，仍依赖既有显式加密会话恢复。没有该会话就拒绝，不能悄悄改用未认证新页面。规划、续接和保存记录都不自动点击、不创建Mission、不构成写入授权或业务验收。

## 验证

最终工作区类型检查、所有包及分发bundle构建通过；全量1,662个Vitest与16个Node测试通过。日志 ../outputs/planning-continuation-typecheck.log、../outputs/planning-continuation-bundle.log、../outputs/planning-continuation-tests.log。

新增18个存储/约束测试、5个LocalRunner续接/缺项测试、1个CLI和1个MCP传参测试。覆盖全部原要求冲突、重复pin与换摘要、超状态/轮次预算、篡改、过大文件、外国workspace/源码、目录重定向、Runner重建、原观察篡改、无意图新请求拒绝，以及CLI/MCP默认空值不覆盖原要求。

### 真实CLI独立进程

可重复命令pnpm test:smoke:planning-continuation，脚本tests/planning-continuation-cli-smoke.mjs。每条命令通过当前bundle/main.js启动新进程，调用本地HTTP模型fixture并打开真实headful Edge：

1. plan原始意图和要求，返回needs-observation，退出码2；
2. 独立inspect进程观察第二页；
3. 新plan进程仅给continuation和第二页pin，恢复原意图/模式/预期等，合并两个原观察，保存YAML，退出码0；
4. 原引用附加改写后的意图被拒绝，没有增加模型调用。

总计2次模型fixture调用、0次应用写入。模型第二次故意返回缩短intent，最终Charter仍保留用户原文。回执 ../outputs/planning-continuation-cli-validation.json，日志 ../outputs/planning-continuation-cli.log。

### 真实双页面与正式Mission

已有tests/multi-state-planning-smoke.mjs改用续接引用。最新headful运行在第二页仅补新pin，未重传intent、原pin、session或验收项。框架恢复core、allow、原placed-order读数和完整原意图。主动传expect空列表在模型和写入前拒绝。两页复用同一selector的身份绑定、错误/歧义状态和原观察篡改保护仍通过。

正式Mission mission-87d864f2-6c6，Run 20261021135507-72e5b727：探索阶段0个订单写入，正式阶段仅1个订单，选定提交字段/响应ID捕获及独立GET验收通过；录像封存与Run清单核验通过。脚本finally关闭会话和本地服务。

只读报告复核1280/390宽无页面溢出，2项检查可见，5张截图解码；3.8秒视频播放到结束、无媒体错误、视频摘要与封存引用匹配；查看阶段0次HTTP请求。回执 ../outputs/planning-continuation-render-validation.json，截图 ../outputs/planning-continuation-desktop.png和../outputs/planning-continuation-mobile.png。浏览器主回执 ../outputs/planning-continuation-browser.log。

## 尚未证明

这两条路径都使用本地受控应用与确定性模型fixture，是产品入口和执行保护的工程验收，不是未见网站自主理解、完整业务分支发现或生产级成功率。宿主仍需判断探索动作是否符合任务授权，获取缺失预期和认证接入；最终计划仍需正式执行与独立验收。

保存记录不等于多Mission统一意图状态，也不恢复遗失的Notes凭据或中断录像。未知项目规划质量、完整首次测试主路径、真实外部测试数据生命周期和跨阶段最终报告仍需继续推进。Goal保持active。
