# 意图力度范围识别：原始意图实测复验

北京时间 2026-10-21。本阶段承接 Toolshop 实测中的计划准入误判；通用 Web 规划、执行和证据闭环 Goal 保持 active。上一阶段是已验证的进展；本阶段进一步修改权威代码、增加失败回归并取得真实网站复验证据，不是重复状态汇报。

## 原始问题与事实纠正

原命令位于前一 Toolshop 字段会话的 final-live/host-commands/001-request.json。完整意图为：

> Review one currently published product page against this frozen public catalog baseline and an independent current-record GET. No cart, account, order or payment mutations. This is a targeted field-reader regression, not entire store acceptance.

旧的 substring 匹配器从 regression 推断 release，拒绝 core Charter。payment 并不是该匹配器的关键词；前阶段说明将支付排除文字当成触发原因不准确，现已纠正。原始请求、错误及先前另冻 v2 的记录均保留，不改写历史失败。

新增开发回归首次运行 36 条中有 19 条失败，日志为 outputs/intent-level-before-tests.log。后续增加七条保护性用例，最终为 43 条。选择的修改前源码、dist 文件、原请求摘要及失败日志摘要保存在 outputs/intent-level-baseline.json、outputs/intent-level-before-runtime/；这些副本不是完整可独立运行的归档或外部代码认证。

## 实现范围

packages/planner/src/test-levels.ts 共用同一候选提取逻辑进行默认力度推断与 Mission 冲突检测：

- 有限识别紧邻的中英文否定、简单否定列表、rather than、被动 out of scope 等排除结构。
- 已支持的“不要跳过发布测试”“Do not skip release”等双重否定仍保留发布要求；否定普通业务操作或错误出现不抹去后续正向发布要求。
- 限定的 targeted/focused/local/core 等局部 regression 描述不独自升级 release；full regression、上线、发布等明确要求仍保留。
- 英文按词边界匹配，URL 中的 quick/release/core 等不构成测试力度；文本中的其他正向要求仍参与判定。
- 原始 intent 不被改写，只在内部匹配过程中作规范化。默认仍为 core，显式力度的保存方式与多个正向力度时的宿主解释责任保持一致。

这不是完整的自然语言理解器，不能保证识别任意嵌套否定、引文、条件或命令。范围识别也不验证完整业务需求，不代表“禁止付款”等自然语言已自动成为运行时业务动作权限。

## 入口与保护性验证

packages/planner/src/test-levels.test.ts：43 条开发回归覆盖真实原意图、局部与完整回归、排除项、双重否定、混合力度、英文子串和 URL。

packages/local-runner/src/intent-level.test.ts：八条真实 LocalRunnerService 准入回归，其中四条验证可保存完整原文与所选力度，另外四条验证明确发布要求仍拒绝 quick。检查持久化 JSON 中的原文，准入本身没有运行浏览器，也不宣称产品通过。

43 条语言用例是开发回归，不是未见语言基准或 Agent 成功率。修改中发现并修正过后续 and run 命令与否定列表的边界，首轮补丁失败日志 outputs/intent-level-first-patch-tests.log 保留。

## 真实网站复验

- 站点：公开 Toolshop 演示站 https://practicesoftwaretesting.com/。
- Mission：mission-17d530f9-3f2；Run：20261020194622-bdcae2b0。
- 完整原始意图保持字节内容一致，不再删除 targeted field-reader regression 或移出排除说明来获得准入。
- 真实目录中的商品、品牌、分类 ID 已更新。先保留旧合同，再从本次页面观察到的商品入口与执行前独立 GET 冻结新合同；没有修改旧合同或旧 verdict。
- 当前商品 ID：01M5DAZ7CX985NTVGRFVWXJBJR；名称 Combination Pliers；价格 $14.15。
- 新合同 SHA-256：932e4d92c3c33aadf96f5692fdbaebd353f308d2d2c7ba8814b19a3ee65ab55c。
- 同样八个字段、pointer、留值策略全部保留，仅三个目录身份值随明确的新基线更新。原测试力度、模式、sideEffectPolicy、三个 UI 断言和 reader 的身份/成功/轮询合同均复核未弱化。
- 五个正式浏览器动作、三个 UI 断言及八个独立 GET 字段全部通过。使用有界持续会话，headful 执行；宿主根据观察提交 Charter，不是自主首次规划质量证明。
- 业务动作没有加购、注册、下单或支付。页面后台流量不能推断为全部 GET；这也不是完整结账复验，远端部署源码身份仍 unverified。

新会话从开始固定的关键构建列表包含 packages/planner/dist/test-levels.js。此前列表未覆盖该文件，旧关键摘要一致不能认证全部运行时代码一致。当前列表仍是选定关键文件，不是完整依赖供应链证明。

会话及辅助进程已终止。关闭前后执行摘要相同，封存补充派生报告后采用关闭回执中的最终 Run manifest；原首次回执仍保留。Run 与会话清单均 intact。路径指针为 outputs/toolshop-intent-root.txt，汇总复核在 outputs/intent-level-review.json。

## 报告、录像及工程结果

生成和渲染检查：

~~~text
node tests/intent-level-review-report.mjs   stageVerified: true
node tests/intent-level-report-smoke.mjs    passed
~~~

报告 outputs/intent-level-review.html 包含原始意图、新旧目录说明、八字段对照、截图、会话录像及原始 Mission/Run 入口。汇总复核检查原请求/合同、源事实、两份清单、关键构建及封存摘要；不得以重写意图或删字段使通过。

Edge 实际解码并播放录像，时长 212.96 秒，覆盖正式 Run 约 98.477–103.054 秒。定位按钮从约 96.49 秒实际播放超过正式结束时刻，保存商品页视频帧。偏移按墙钟估算，不是逐帧因果认证。网络仍 partial，关闭有六个未结请求。

1280/390 宽汇总报告均无页面横向溢出；窄屏字段表在自身容器内横向滚动。原始 Run 在 390 宽验证八字段及五张过程截图；汇总商品截图也成功解码。outputs/intent-level-render-verification.json、intent-level-review-desktop.png、intent-level-review-mobile.png、intent-level-video-frame.png 保留结果。

最终工程检查：pnpm typecheck、pnpm build、1,558 个 Vitest 测试与 13 个 Node 测试全部通过。日志为 outputs/intent-level-typecheck.log、intent-level-build.log、intent-level-workspace-tests.log。git diff --check 通过。工程检查和语言用例不计为真实业务任务成功率。

## 接下来的验收

Goal 尚未完成。下一阶段优先在当前构建重跑完整复杂工作流，继续验证原始业务要求、独立最终记录、重复执行和过程证据。意图规划仍需更广泛的正反用例及未见场景；有限力度规则不解决全面需求覆盖、复杂集合/跨记录事务、鉴权动态 reader、网络完整性或多站点自主规划稳定性。
