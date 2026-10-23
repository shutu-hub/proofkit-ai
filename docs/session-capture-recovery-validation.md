# 中断会话录屏与网络证据恢复验收

2026-10-22。持续 Web 会话正常关闭时已有 sealed capture 和可播放录屏，但进程崩溃不能把 Playwright 临时 webm 可靠地当成完整视频。新的 recover_session_capture 只恢复非活跃的 session-network Run：重新计算原始事件数、未完成请求和有限上下文，删除未封存 recording-tmp，生成新的 partial capture、Run report、manifest 和 capture seal。若原会话请求过录屏，Run 明确保存 recording.status=unavailable，报告不生成 video 播放器；绝不把中断字节升级为 recorded。产品结果始终 inconclusive/not-asserted，恢复也不清理 connector 资源。

恢复拒绝活动所有者；必须先确认 OS 所有权已释放。原 manifest/摘要若已完成则只返回 already-completed 并再次校验完整性；其他项目、workspace、session 或不符合 session-network 形态的 Run 均拒绝。网络事件日志本身必须可读，缺失/损坏时恢复仍保持 partial/unavailable。恢复后的报告和归档仍可审计，但上下文不建立动作因果或业务成功。

当前新增单元验收 outputs/capture-recovery-unit-final.log：中断 Run 含未封存临时 webm，恢复后 capture partial、recording unavailable、报告无 video，manifest intact；活动 owner 仍拒绝恢复。真实浏览器资源准备验收 session-prep-interaction-browser.log 验证正常会话录屏，但不冒充崩溃录屏。真正的子进程强杀资源验收 outputs/session-prep-interaction-recovery.log 保留资源恢复，不覆盖浏览器进程本身。

未完成边界：当前尚未在真实 Chromium/Edge 子进程被强杀后，保证 Playwright 临时 webm 可恢复为可播放 partial；恢复策略安全地把它标 unavailable。若产品未来要交付崩溃前片段，需要单独验证浏览器写盘/容器损坏模型、重启时文件归属和跨平台播放器兼容，不能先改状态枚举。Goal 保持 active。
