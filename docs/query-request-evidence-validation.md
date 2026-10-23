# 查询参数请求的证据边界

2026-10-22。问题：captureResponse 合同的 endpoint 禁止 query，避免敏感原始 URL 写入计划；但适配器原来只按 origin、pathname 和 method 匹配。同一路径不同租户查询参数的请求可能被误认为声明的 query-free 请求。失败复现见 outputs/query-capture-before-fix.log：带 tenant=other 的已写入请求形成了成功的 response observation。原失败保留，不追认为通过。

修复：response.url 仍无 query。实际请求带 query 而计划未声明 queryFields，则返回 request-query-unreviewed；声明时必须覆盖全部查询键，每个键以唯一单段 pointer 指向 string/id/identifier 标量。重复、缺失、额外查询键，无效编码或越界内容均不能形成成功的响应合同。仅保存明确选定且经过脱敏的字段，不保存原始 query 串。已写入后的捕获失败不会自动重试，应先独立核对当前业务状态。错误响应继续是 not-established；不能替代独立业务 Oracle。

真实 Edge 受控验收 tests/query-capture-smoke.mjs：单击建立 tenant=team42 记录，报告留存选定查询 tenant、请求 title、响应 ID/tenant；独立 GET 核对本次记录，Run passed、录屏 recorded、清单 intact。另一场 tenant=other 请求只写一次，但没有查询声明，Run inconclusive、failureCode=request-query-unreviewed、无 captured response、无重试。390px 报告展开后可见选定字段，未出现原始查询串和私有响应字段，也无整页溢出。结果和 Run ID 在 outputs/query-capture-validation.json。首次夹具因入口404连接失败，第二次因没有展开 details 而误判报告内容，原始失败分别留在 query-capture-browser.log 和 query-capture-browser-2.log。

已有 response-capture-smoke 与 AIHR 手动录入夹具的实际 POST 带 mode 查询键，已分别声明并核对；不能放宽检查以取得旧夹具通过。两套完整跨平台夹具仍需要外部 Electron 可执行文件，此环境未配置时不声称运行。当前 Edge 样本使用内存读数和宿主编写计划，不是陌生网站自主规划或持久数据库验收。Goal 保持 active。
最终补充第三个对照：已声明 tenant=other 并捕获选定查询事实，独立业务 reader 按原预期 team42 判为 failed；未声明 tenant 的相同提交保持 inconclusive，不能把信息缺口误判产品缺陷。三场各写一次，没有盲重试。最新浏览器回执 outputs/query-capture-browser-media.log / outputs/query-capture-validation.json 验证3张逐动作截图实际解码、1.44秒录像播放至结束及窄屏无横向溢出。此前两场阶段性结果保持在各自原日志中。
最终验证：outputs/query-capture-contracts-test.log、outputs/query-capture-adapter-test.log、outputs/query-capture-evidence-test.log 定向通过，outputs/query-capture-typecheck.log 和 outputs/query-capture-final-build.log 通过；outputs/query-capture-final-tests.log 共1,736项 Vitest 与16项 Node 测试通过。既有受控 Web-only release 正常样本 passed/12项检查，后台写错样本仍 failed/2项独立业务失败，见 outputs/query-capture-web-release.log、outputs/query-capture-web-release-defect.log。更新后的实际安装包 MCP 门禁通过，见 outputs/query-capture-distribution-final.log。此前 PocketBase 归档在新分发 CLI 下按原 SHA-256 验包 intact，见 outputs/query-capture-historical-archive.log。完整 Electron 双平台样本尚未运行，不能用单纯语法检查充数。
