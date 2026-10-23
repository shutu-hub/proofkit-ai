# Mission证据归档：阶段验收

北京时间2026-10-21。上一阶段已经修复后半段动作展示并取得当前34步工作流重复证据，本阶段增加实际产品归档与独立离线验包。通用Web测试、规划及可追溯证据Goal继续active，不以归档通过替代未知项目测试能力。

## 产品入口

新增@proofkit/evidence的exportMissionArchive / verifyMissionArchive，以及分发CLI：

~~~bash
proofkit mission export <mission-id> --root <project> --workspace <workspace> --out <new-directory> --summary-sha256 <original-summary-sha256>
proofkit verify-archive <moved-directory> --archive-sha256 <original-archive-sha256>
~~~

summary摘要为可选输入，适合用独立保存的原快照固定来源；交付时应单独保留导出回执中的archiveSha256。未传原摘要的验包仅为self-described一致性检查，传入原摘要为pinned。两者都是本地完整性，不是外部签名。

命令不加载项目配置/连接器，不启动应用，不重新执行Oracle。导出保留终态Mission报告和summary、依赖Run的原始字节、截图、录像、事件、选定API事实以及原封存链，增加index.html与archive.json。保留.proofkit/missions与.proofkit/runs相对关系，JSON内原工作区身份保持为来源元数据，不改造成可执行工作区。

不复制浏览器认证状态、工作区配置、项目/连接器代码或无关目录；证据中既有值和录像不额外脱敏。静态包不提供加密、远端备份、自动保留期限或删除策略。

## 结论严格分开

export/verify的testVerdict始终not-asserted；savedTestVerdict是保存时的业务结论。savedScope明确返回快照中的declared/project/unverified验收范围、workflowCoverage、会话网络状态/完整性和前置Run/会话省略数。入口页也显示这些限制，不能把归档intact解释成全部需求/网络通过。

目录及描述文件分别有路径、文件/字节、依赖数量边界；上限128个Run、20,000个被索引文件、512MiB累计字节、64MiB单文件和16MiB描述文件。源Run原清单限额继续适用。已存在输出、目录/文件重定向、路径穿越、跨工作区、冲突/无摘要引用、活动Mission或Run、遗漏执行Run、不完整封存及预算超限拒绝完整导出。

先规划依赖和原摘要，再复制且逐文件重验；源在复制结束再次检查，最终发布描述文件后再独立验包。错误或取消只清理本操作新建且路径身份仍一致的输出目录，不覆盖已有用户目录、不改变源。CLI显式workspace保留原输入用于重定向检查，不让工作区解析先canonicalize后掩盖junction。

## 历史封存格式发现与处理

首次对真实Mission导出时失败：部分前置交互Run没有manifest。原错误保存在outputs/archive-live-missing-manifest.log。没有重新生成清单把历史缺失变成“原始清单完整”。

经核验，这些Run的summary/report摘要已在Mission前置快照内保存；summary中的eventLog固定原events.jsonl字节和SHA-256，封存日志的artifact.created事件覆盖全部声明产物字节和SHA-256。实现只对这类历史上下文允许event-log来源链，逐项核验且检查目录无额外文件；执行Run与已引用但缺失的manifest仍必须拒绝。归档内明确区分manifest和event-log，入口显示数量。

源summary、report、events或产物任一变化，封存不完整/哈希缺失，或者企图把event-log作为执行Run清单替身，都有拒绝回归。不会创建缺失的原manifest。

每个有manifest的Run还必须证明该清单来源：原manifest摘要已直接固定在Mission快照中，或者快照固定summary/report且原封存事件日志逐项覆盖清单中的全部文件。真实包的15份manifest中，7份直接固定、8份通过该额外快照封存链锚定。执行Run仍保留manifest原字节；缺清单不会用日志替代。对等长产物篡改后再重建清单的对抗测试确认仍拒绝导出。原日志中的response-observation通知不含字节/哈希，仅是元数据；同一路径已有的有效原字节记录继续参与核验，不能让仅有元数据或最终缺哈希的产物通过。

这一补强首先对真实原日志拒绝了仅类型元数据通知，诊断后按生产格式区分哈希创建与通知，失败日志 `outputs/archive-manifest-anchor-metadata-failure.log` 保留；等长篡改回归避免只由大小上限提前拒绝，原尺寸拒绝测试记录在 `outputs/archive-reseal-size-rejection.log`。未修改原事件日志或清单以获得通过。

## 真实CLI搬移与断开原目录验证

使用已保存的真实Toolshop Mission mission-5d6fd398-682，正式Run为20261020212723-a70fe9d5，订单INV-2026000005。这是概览修复阶段已执行的34步结账，归档功能修改后没有重跑该网站业务；本阶段验证的是旧真实证据在新导出器中的完整交付，不声称新业务通过。

最终实际分发包bundle/main.js执行mission export，要求原summary摘要。先导出至staging，再rename到outputs/deliveries的新位置；临时移开原sample-1目录，明确lstat原路径为ENOENT，浏览器offline并拒绝HTTP(S)。在原目录缺失期间，API和实际分发CLI独立verify-archive都为intact。

最终交付目录：

~~~text
outputs/deliveries/mission-5d6fd398-682-76551a6d
~~~

原archiveSha256：

~~~text
7add36d2cfb236c33dd983e9e8368661af6e5aa1697236b48fe36d2d3bd05135
~~~

包共22个依赖Run、491个文件、14,686,659个被索引字节；其中15个原manifest Run、7个event-log历史上下文。保存结论passed，网络仍partial；声明场景declared，业务覆盖unmeasured，原快照省略13条更早前置Run。归档忠实保留快照依赖，没有声称保存所有历史。

原目录不可访问且浏览器离线时实际验证：

- index进入原Mission，34个动作证据链接都解析到搬移后的目录内。
- 下单第33步证据可打开，七个请求字段按JSON解析与原捕获一致。
- 完整Run的34张截图及归档全部102张PNG成功解码，无原目录或HTTP请求依赖。
- 归档会话录像68.96秒，实际从正式操作附近播放超过49.965–67.193秒窗口，无媒体错误；定位是墙钟估算，不是逐帧因果认证。
- 主动修改归档业务事实，验包changed；恢复原字节后重新intact。原描述文件不重建。
- 原目录在finally恢复，原summary和report摘要仍相同；导出器关键构建摘要在验证前后相同。

最终回执outputs/mission-archive-validation.json，日志outputs/mission-archive-cli-live-smoke.log；脚本tests/mission-archive-live-smoke.mjs。之前中间版本回执另存，不代替最终版本。最初导出缺清单失败、测试夹具文件名/身份/产物声明错误日志均保留，未通过放宽源完整性规则让测试变绿。

## 工程回归与展示

36个Evidence归档测试及1个CLI测试覆盖原字节与原清单、搬移后源删除、私有状态排除、篡改/缺失/额外文件、原摘要不一致、依赖Run移除、生命周期与外工作区、符号链接/穿越/已有输出、复制取消、预算描述、异平台原来源路径、历史封存日志链、清单重新封存绕过及保存范围改写。异平台路径测试在当前主机模拟原POSIX来源，不等同于Linux系统实际运行认证。

最终pnpm typecheck、pnpm build、1,597个Vitest测试与13个Node测试通过，git diff --check通过。日志为outputs/archive-final-focused-tests.log、archive-cli-tests.log、archive-final-typecheck.log、archive-final-build.log、archive-final-workspace-tests.log。新增测试不等同Agent业务任务成绩。

中文审查页outputs/mission-archive-review.html及同名JSON会重新核对交付包和当前导出器摘要，不满足时撤下交付入口。tests/mission-archive-review-smoke.mjs验证1280/390布局无横向溢出、图片解码、实际交付入口及declared/partial/13项遗漏可见；结果在outputs/mission-archive-review-render.json。

## 未完成的Goal项

本阶段满足了一个真实完整Mission的可搬移证据交付与离线验包，未提供自动上传/远端保留服务或未知项目全自动规划质量证明。原网络partial、前置历史省略、复杂鉴权/动态reader、广泛未见站点与错误恢复分支仍需继续；原业务需求不能因归档可交付而缩小。

接下来应在新的未见复杂业务场景中，以原意图、独立业务验收、可见执行和此次交付路径联合评估，计入所有失败/未知并区分宿主规划与框架执行表现。Goal保持active。
