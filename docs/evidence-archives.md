# 导出与离线核验证据

ProofKit可以把已保存的终态Mission及其执行、观察和封存会话证据导出为可搬移目录。导出读取原始字节，不启动测试网站、项目或连接器，不重新运行Oracle，也不改变保存时的业务结果。

## 导出

先结束仍保留的浏览器会话，让请求的录像完成封存，并确保所需Mission报告已保存。然后运行：

~~~bash
proofkit mission export <mission-id> --root /path/to/project --workspace /path/to/test-workspace --out /path/to/new-archive
~~~

输出目录必须不存在，父目录已经存在，且与源工作区分开。导出操作不读取项目配置或执行集成代码；root仅用于解析默认工作区，显式workspace更适合交付已有结果。

如果另存了原summary.json摘要，可增加：

~~~bash
proofkit mission export <mission-id> --root /path/to/project --workspace /path/to/test-workspace --out /path/to/new-archive --summary-sha256 <original-summary-sha256>
~~~

成功回执包含directory、index、archiveSha256、文件/字节/Run数量、savedTestVerdict及testVerdict。最后一项总是not-asserted：这是证据操作的结果，不是一次新的业务验收。把archiveSha256与证据目录分开保留，接收方才能检测描述文件是否一并改变。

导出和验包另返回savedScope：原快照的验收范围、业务覆盖、会话网络状态及省略的前置Run/会话数量。入口页同样显示这些值；intact归档不会把partial网络或declared场景改成全覆盖。

交付时复制整个目录，包括隐藏的.proofkit子目录。index.html是入口，原Mission/Run报告的相对截图、录像和动作证据链接保持可用。归档内JSON保留原工作区身份作为来源元数据；它不是可在新路径继续执行的测试工作区。

## 独立验包

在另一目录或接收机器安装同版兼容ProofKit CLI后，运行：

~~~bash
proofkit verify-archive /path/to/moved-archive --archive-sha256 <separately-retained-archive-sha256>
~~~

不需要原应用代码、原工作区、登录会话或网络。CLI核验描述文件摘要、文件清单与字节、原始封存链，以及保存Mission的依赖闭包。退出码0为intact，1为changed/missing，2为unverified。报告中的保存业务结论仍通过savedTestVerdict单独返回，验包testVerdict保持not-asserted。

不传原摘要时anchor为self-described，只检查目录相对于自身描述的一致性；传入原摘要后为pinned。二者都不是外部签名、可信时间戳、不可抵赖证明或测试覆盖认证。

## 证据来源

有原manifest的Run逐字节保留并按原摘要验证，执行Run必须走这条原清单链；缺少或不一致不会被重新封存来获得通过。

清单本身需由原Mission快照固定，或额外通过快照固定的summary/report与原封存事件日志核验其全部文件。仅在当前目录重新计算出自洽manifest不构成原证据来源。

部分历史观察/交互Run没有manifest。只有当Mission快照已固定其run.json和report.html摘要，且run.json内的原封存events.jsonl覆盖全部声明产物的字节和SHA-256时，才允许纳入；包内将其明确标为event-log来源。不会补造原manifest，也不能用该路径替换执行Run清单或缺失的已引用清单。入口页显示两种来源的数量。

导出不复制浏览器认证状态、工作区配置、项目/集成代码或无关目录。它保留被核准原证据文件中已经记录的内容，不额外脱敏。原报告中的网络partial、遗漏、视频敏感内容和覆盖边界保持原样，交付前应按实际内容控制访问。

## 边界与失败

当前入口支持标准工作区.proofkit/runs与已保存Mission快照。活动Mission/Run、遗漏执行Run的快照、无原引用摘要或封存链、外工作区引用、符号链接、已有输出、冲突路径、文件变化和预算超限均拒绝完整导出。对于显式省略的前置会话历史，归档保持快照已有的范围说明，不推断保存了全部历史。

归档上限为128个依赖Run、20,000个被索引文件、512MiB被索引字节、64MiB单文件及16MiB描述文件。源Run仍受其原清单限额约束。路径需要可搬移且不能越界。复制后再次核验源和目标；中断或错误仅清理本操作新建且仍属原身份的输出目录，不覆盖已有目录或改变源证据。

源摘要与报告可能随新的报告生成而更新。选择要交付的终态快照后导出，并保存此次回执；不要用后生成的新摘要替换接收方已有的原摘要。

API从@proofkit/evidence导出exportMissionArchive和verifyMissionArchive。exportMissionArchive接受workspaceRoot、missionId、destination、可选expectedSummarySha256和AbortSignal；verifyMissionArchive接受目录及可选原archiveSha256，独立工作且不执行项目代码。

真实34步结账的原目录移开、离线回放和篡改验证记录见docs/mission-archive-validation.md。归档能力不代表未知网站自主规划、全面网络采集或生产级Goal已完成。
