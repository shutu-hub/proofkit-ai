# 原生表单传输与证据验收

2026-10-20，在隔离目录运行未修改的 go-httpbin，固定提交为 `8b1bc1433750404fefd2a419cda3720d3088701b`。当前 Codex 宿主根据实际保存的原始页面观察编写 Charter，经 ProofKit 持续会话、观察绑定、Mission 和报告路径执行，没有调用返回固定计划的提供者或第二个模型 API。

## 结果及实际修复

首次执行完成姓名、备注、单选和两个复选框操作，提交真实原生 HTML 表单后，参数采集因只接受 JSON 请求而得到 `request-content-type`。此结果保留为 inconclusive，没有因 HTTP 200 或页面成功而改判。

通用采集器现支持 UTF-8 `application/x-www-form-urlencoded` 请求的声明字段投影。单次字段为字符串，重复字段为数组，必须用明确的数组指针选择；不转换数值或布尔值，不保存原始请求体。非法百分号转义、非法 UTF-8、其他字符集及不支持的请求格式被拒绝。原有请求数量、大小、时限和响应 JSON 边界继续有效。

两次新的浏览器会话均完成 7 个步骤。姓名中的中文和加号、备注中的与号，以及 size、两个 topping 字段，在请求投影和服务端回显中逐项一致。主 Run 与会话捕获的清单完整，包含逐步截图、网络日志和录像。最后一次录像 31.48 秒，已在浏览器实际解码并播放；4 张首页截图解码，1280 像素和 390 像素布局无横向溢出，步骤深链接和展开后的参数证据可用。

报告复核另发现 quick Charter 没有业务 Oracle 时仍使用“业务结果有独立证据”的默认成功标准。单场景计划现按实际测试级别生成成功标准和核验任务文案，与已有 suite 路径一致；core/release 的独立业务证据要求保留。最后一次报告已确认展示业务终态和全项目覆盖未验证。

## 证据和复现

`outputs/httpbin-live-host-validation.json` 保留首次失败、修复后两次回归、固定源码提交、构建摘要、报告和原始产物路径，以及渲染复核。原始工作区中有 inspection、宿主请求、审核后的 Charter、Run 清单和完整媒体。临时路径不作为长期归档承诺。

先构建 ProofKit，准备上述提交的干净检出，编译并仅在回环地址启动 go-httpbin。运行：

`node tests/httpbin-host-acceptance.mjs --project-root C:/qa/go-httpbin --workspace-root C:/qa/runs/new-form-case --source-commit 8b1bc1433750404fefd2a419cda3720d3088701b --base-url http://127.0.0.1:8080 --headful`

工作区必须不存在。辅助器写入 `inspection.json` 后等待最多十分钟。宿主根据本次原始观察提交 `charter-request.json`，结构为 `{charter, expect}`。辅助器自动绑定本次观察摘要，执行 Mission，关闭会话封存录像，再生成报告与 `host-acceptance-result.json`。源码检出前后必须保持干净。非 Windows 环境应通过 `PROOFKIT_BROWSER_PATH` 指定浏览器。

## 边界

这是局部能力样本，已经用于修复框架，后续结果属于定向回归。HTTP 回显只证明传输观察，未验证业务持久化；没有业务 Oracle，不属于复杂网站验收或总体成功率。全部输入为合成数据，不宣称录像像素脱敏。用户要求的复杂网站流程仍须单独验证：多状态规划、登录、跨页数据、异常分支、独立接口读数和完整证据报告。
