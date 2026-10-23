# Mission 检查证据入口验收

2026-10-22。问题来自已保存的 PocketBase 单场报告：Mission 总览每个 Run 只保留六个引用，记录了页面检查通过，却把该检查的 contemporaneous snapshot 和截图标为“supporting artifacts not linked”。完整 Run 报告和归档仍有原始文件；这是可发现性缺口，不是业务验收或完整性缺口。

改进只调整 bounded 投影：每个 Run 最多八个展示引用，原始 run.json 必须保留；在通常的报告、独立业务源之后，优先展示本次断言的 snapshot 和截图，再展示普通步骤截图。被省略的数量继续公开。仅经过原始 Run 证据哈希验证的引用能进入 Mission 检查表；文件缺失或内容改变则撤回直链，不据此改写保存时的业务结果，也不把选中的八项当作完整网络/全截图。

单元验收验证重排和上限、检查表的两份断言产物直链，以及截图被修改时撤回链接。当前构建下的受控 Web-only release 六个 Run 和12项检查通过；原始 Mission 报告中，页面检查现在直接链接 assertion-001-snapshot.json、assertion-001.png，独立检查直接链接 oracle-1-source.json、oracle-1.json，相关检查的 unlinkedEvidence=0。Mission 验收引用248/248 intact；实际在390像素浏览器打开断言图片直链并解码为1280×720。证据为 outputs/check-evidence-priority-browser.log 和 outputs/check-evidence-priority-browser-link.log。修复前 PocketBase 首屏有71条明细省略，其业务/视频结果和移动归档保持不变；本轮不改写历史报告或归档。

这仍是脚本构造的受控应用和宿主编写计划，不能证明陌生项目的模型自主规划、所有未来业务源、所有截图直链或生产级留存。更多检查竞争八个名额时仍可能部分未链接，Run 详细报告仍是完整时间线；省略和独立验收边界必须继续显式呈现。Goal 保持 active。
最终复核：后台笔记写错的6个 Run 仍给出 failed（10项检查通过、2项独立业务检查失败），两个失败行分别直达本次 oracle 来源和报告，验收引用248/248 intact，日志 outputs/check-evidence-priority-browser-defect.log。使用当前 CLI 新导出的 Mission 归档经摘要固定验证 intact，结果见 outputs/check-evidence-priority-export.log 与 outputs/check-evidence-priority-verify.log；移动包内的断言截图链接在离线390像素浏览器下解码为1280×720，布局无整页溢出，见 outputs/check-evidence-priority-offline-link.log。旧 PocketBase 归档仍以原摘要验证 intact，未改写原字节，见 outputs/check-evidence-priority-historical-archive.log。

最终验证：outputs/check-evidence-priority-targeted-after-build.log、outputs/check-evidence-link-targeted.log 的定向回归通过；outputs/check-evidence-priority-typecheck.log、outputs/check-evidence-priority-build.log、outputs/check-evidence-priority-distribution.log 通过；outputs/check-evidence-priority-final-tests.log 为1,727项 Vitest 和16项 Node 测试全通过。证据选择提高可发现性，但默认规划仍需宿主/模型编写业务步骤和独立 reader，不据此声称未知网站一次完成。
额外校准：原 Run 录像是 video 类别，原优先表漏列时被 indexOf=-1 意外排在摘要最前，挤占少量展示名额。现在明确把录像放在断言源/截图之后、普通步骤截图之前；所有当前证据类别都有确定顺序，未知类别回退到末尾。最终浏览器样本 outputs/check-evidence-video-browser.log 的首个 Run 依次展示原摘要、Run 报告、Oracle 报告/独立来源、断言 snapshot/截图、录像和首步截图；页面检查/独立检查均有双链接且 unlinkedEvidence=0，12项通过，验收引用248/248 intact。类型检查、构建、定向回归及全量测试日志以 check-evidence-video-* 为最终准绳，较早日志保留为修改历史，不提升未知项目成功率。
最终录像排序构建：outputs/check-evidence-video-typecheck.log、outputs/check-evidence-video-build.log、outputs/check-evidence-priority-video-targeted.log 全通过；outputs/check-evidence-video-final-tests.log 为1,727项 Vitest +16项 Node 测试通过。正常浏览器 release 样本仍 passed/12项检查，后台写错样本仍 failed/2项业务检查失败且失败来源双直链，见 outputs/check-evidence-video-browser.log 与 outputs/check-evidence-video-browser-defect.log。最终正样本从当前 CLI 新导出 outputs/check-evidence-video-delivery/，摘要钉住的验包完整，见 outputs/check-evidence-video-export.log 与 outputs/check-evidence-video-verify.log。历史 PocketBase 包的兼容验包也保持 intact，未改变原始报告。
