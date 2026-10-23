# 显式平台范围与纯 Web 发布验收

日期：2026-10-21。本轮修复发布级目录测试强制同时配置 Web 与 Electron 的耦合，未降低独立业务检查、主路径回放或负向场景要求。

## 修复内容

- 发布计划显式声明的平台作为执行范围，支持 `surfaces: [web]` 的 Charter 和套件。选定平台必须包含在声明中。
- 目录声明在保存发布 Charter 时固化；文件声明与目录声明冲突时拒绝执行。用户意图明确要求的多平台范围仍不能省略。
- 未声明平台的旧发布计划保留 Web/Electron 默认矩阵。scope 根据匹配的有效目录/套件声明报告连接需求；无匹配时不凭空增加另一平台。
- contracts、planner、agent 与 LocalRunner 使用相同的平台语义；CLI/MCP 接入文档与生成的 Skill 文本同步。

## 原始失败与工程回归

修复前，本轮最初新增的五项 LocalRunner 回归中四项失败、一项通过，原日志保留于 `outputs/release-platform-before.log`。修复后发布平台、任务平台、scope 和 release suite 的 60 项针对性测试通过。后续增加目录与文件平台冲突拒绝用例，另有五项 contracts 回归。

第一次全量测试暴露 CLI scope 旧断言仍要求 Electron 检查同时返回 Web；已按实际选定平台修正，失败结论不作为通过依据。最终全量通过 1,688 项 Vitest 与 16 项 Node 测试；类型检查、构建及实际 npm 打包安装后的 CLI/MCP 分发验收均通过。日志分别为 `outputs/release-platform-tests.log`、`outputs/release-platform-typecheck.log`、`outputs/release-platform-build.log` 和 `outputs/release-platform-distribution.log`。

## 可见浏览器验收

`tests/web-release-smoke.mjs` 启动受控本地应用，以真实可见 Edge 执行两个仅 Web 的发布 Charter：私有笔记新增、刷新、编辑、完成及删除；异步任务提交、轮询及终态。分别具有禁止身份写入和无效任务输入的负向场景。每套执行两个主 Run、两个回放 Run、两个负向 Run。

独立只读后端检查验证笔记身份、归属、保存字段、状态历史与删除结果，或任务身份及终态。这里在最终读数中检查历史，不代表已实现通用中间业务检查点。

| 样本 | 原 Mission 结论 | 检查记录 | 具体校准 |
| --- | --- | --- | --- |
| 正常应用 | passed | 12 通过 | 六次运行的 UI 和独立业务检查均通过 |
| 后台写错标题，页面仍显示成功 | failed | 10 通过、2 失败 | 笔记主路径及回放 UI 断言通过，独立读数均发现存储标题错误 |

两个样本各自验证六份 Run 清单、播放六段录像至结束，并解码 46 张截图。报告在 1280 和 390 宽度下无页面横向溢出。每套六个隔离资源范围均完成归属核对、删除与 GET404 读回，外部哨兵保留，合成范围残留为零。八个驱动及执行模块摘要在每套运行前固定，结束后校验未变。

正常样本：`outputs/web-release-validation.json`，Mission `mission-e6372439-6b1`，工作目录 `C:/Users/殊途/AppData/Local/Temp/proofkit-web-release-acceptance-CobEE9`。

缺陷样本：`outputs/web-release-defect-validation.json`，Mission `mission-4a3f6fd6-365`，工作目录 `C:/Users/殊途/AppData/Local/Temp/proofkit-web-release-acceptance-a4fZsQ`。缺陷失败保持原样，不能被校准测试本身通过覆盖。

## 结论边界

这是宿主编写 Charter、受控业务 reader 与本地夹具的集成验收，证明显式仅 Web 发布可执行及错误业务状态可被检出。没有新增外部网站成绩，没有证明未知项目自主规划、真实多账号认证、完整网络捕获或全项目覆盖。后续说明文字更新后的构建也不能追认这些已固定执行摘要为新构建的重跑。旧远程 Notes 的资源清理和录像封存仍未确认。

Goal 保持 active；首次陌生项目从意图到可交付答案仍是下一阶段主要验收对象。
