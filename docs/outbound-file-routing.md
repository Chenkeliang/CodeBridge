# 发送文件到当前聊天

Agent 使用 `fcb send /绝对路径/report.xlsx`。命令只传当前 FCB_RUN_ID 和文件路径。禁止查通讯录、猜测聊天 ID、修改 FCB_CHAT_ID 或另选历史会话来发送。

Bridge 校验 Run 正在运行，并按 Run ID + Turn ID 读取持久化 ChannelDelivery。唯一来源确定通道、聊天和话题；飞书只接受 oc_ 聊天 ID，Telegram 使用 telegram: ID。请求手填 chatId/topicId 不覆盖任务来源。文件沿用现有路径、大小与文件类型校验，然后上传并发送至确定的聊天。

缺少 Run、无来源、多来源或内部 conv_ ID 都在调用飞书前失败。Web 独立任务没有聊天来源时必须从目标聊天重新发起，不能搜索最近聊天作为回退。API 返回成功仅代表通道发送调用完成；失败时 fcb 非零退出，不得声称文件已送达。上传或发送结果不明确时先核对，禁止盲目重复发送。

## Surface Matrix

| Surface | entry/read/write | event consumption | error/recovery | terminal feedback | 验证状态 |
|---|---|---|---|---|---|
| Agent | fcb → Run → delivery → outbound API | 读取现有 Run/Turn 投递记录 | 无确定来源直接失败；从目标窗口发起 | JSON 成功或非零退出 | implemented，候选合同/CLI测试；生产未发布 |
| 飞书 | 当前聊天任务来源 → oc_ + topic | 沿用持久化 delivery | 禁止内部 ID/通讯录回退 | 原聊天文件消息 | implemented，生产 closed-loop 待发布验收 |
| Telegram | 当前任务来源 → telegram: + topic | 同上 | 与飞书来源不混用 | 原聊天文件消息 | implemented，候选路由测试；真实发送未验证 |
| Web | 无来源任务不提供飞书发送目标 | 不从最近会话推断 | 明确无来源错误 | API 错误反馈 | implemented，拒绝路径测试；无新增 UI |

发布需同时更新 Bridge 和 Runner，重新生成 fcb；旧 fcb 缺 Run ID 时明确失败。生产验收：在飞书单聊及话题任务中发送一份测试文件，核对目标窗口/话题和最终文件消息。候选测试不代表真实飞书已送达。

## 候选验证

2026-09-16：pnpm build 通过；pnpm lint 通过（Web 原有 8 个 warning）；全量 vitest 与最终针对性路由/CLI测试通过。GitNexus detect-changes 判定低风险。ACP 进程复用键包含 FCB_RUN_ID，防止跨 Run 继承旧发送身份；重建进程后继续按 provider session 恢复原会话。

发布集成必须保留当前生产 e810514 的空队列自动恢复变更；此功能分支从 origin/main 5273552 创建，不能直接替换生产而遗漏该提交。
