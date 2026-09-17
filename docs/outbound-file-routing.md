# 发送文件到当前聊天

Agent 使用 `fcb send /绝对路径/report.xlsx`。命令只传当前 FCB_RUN_ID 和文件路径。禁止查通讯录、猜测聊天 ID、修改 FCB_CHAT_ID 或另选历史会话来发送。

Bridge 校验 Run 正在运行，并按 Run ID + Turn ID 读取持久化 ChannelDelivery。唯一来源确定通道、聊天和话题；飞书只接受 oc_ 聊天 ID，Telegram 使用 telegram: ID。请求手填 chatId/topicId 不覆盖任务来源。文件沿用现有路径、大小与文件类型校验，然后上传并发送至确定的聊天。

缺少 Run、无来源、多来源或内部 conv_ ID 都在调用飞书前失败。Web 独立任务没有聊天来源时必须从目标聊天重新发起，不能搜索最近聊天作为回退。API 返回成功仅代表通道发送调用完成；失败时 fcb 非零退出，不得声称文件已送达。上传或发送结果不明确时先核对，禁止盲目重复发送。

## 本地定时任务（publisher 凭据）

launchd 之类的本地定时任务不是 Run，拿不到 FCB_RUN_ID，因此不能走上面的来源解析。它们改用 `<dataDir>/publisher-tokens.json` 里登记的独立凭据。

签发、查看和吊销都由 Bridge 自己的 CLI 完成，调用方不应手写这个文件：

```
codebridge publisher add --label stock-daily-trade --chat oc_xxx [--topic om_xxx] [--routes file,markdown,mention]
codebridge publisher list
codebridge publisher revoke --label stock-daily-trade
```

`add` 的 token 只在签发那一刻打印一次；同名 label 再 add 即轮换，旧 token 立即失效。`list` 永远不回显 token。文件按 0600 原子写入，Bridge 按文件指纹热加载，签发或吊销后**下一个请求即生效，不需要重启**；文件读坏时沿用上一份可用凭据并上报一次，不会因为一个笔误让投递全断。

`--routes` 省略时只授予 `markdown,mention`：**外发文件必须显式申请**。凭据只对已知的 `/outbound/<route>` 有效，越权路由返回 403、其余 API 一律 401；收件人取自登记而非请求体，请求里手填的 chatId 同样被覆盖。凭据不进入 runner 配置，也不随 FCB_TOKEN 注入任何 Agent 子进程，因此 Agent 不会自动持有它，runner token 本身也仍然必须带 runId。

边界要说清楚：Agent 子进程与 Bridge 是同一个系统用户，能读文件的 Agent 可以读到这份凭据并自行调用出站 API，把消息发进该 publisher 绑定的聊天。0600 只挡别的系统用户，挡不住同用户进程；本仓库没有沙箱。需要注意的是，任意 `$HOME` 文件经 `/outbound/file` 外发这一能力本来就存在（路径校验只限制在主目录内，见 `feishu-outbound-file.ts`），publisher 增加的只是"多一个固定收件人"，而默认不授予 `file` 路由正是为了让这条尾巴默认关着。要进一步收敛，得给 Agent 子进程做文件系统隔离，或把 `/outbound/file` 的路径白名单收窄到每个 Run 的工作目录。

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

## 生产验收结果（2026-09-16）

发布 20260916-155853-adb91f70，集成提交 24807c735d7454afc72d1a2d552bf354a6ec76f1，控制器终态 published。集成构建及 154 个测试文件、1565 项测试通过。

真实 Pi 验收最初暴露 SDK 未传递 extraEnv，导致 fcb 不在 PATH；补充 createBashToolDefinition 的逐任务 spawnHook，独立注入 PATH/FCB_RUN_ID 等变量并验证并发任务不串环境。

最终 Run 仅执行一次 fcb send，返回 ok:true。飞书历史消息回查确认该 xlsx 文件出现在原聊天，消息 deleted:false。具体 Run ID、聊天 ID、消息 ID 和文件名属于本机验收记录，不入公开仓库；复核时从 bridge.log 和飞书消息记录读取。该回查证明真实文件消息已生成，不等于用户已打开下载。

Surface 状态更新：Agent/Pi → 飞书原窗口已 reachable、closed-loop；飞书话题、Telegram 分支通过候选路由测试，未进行真实通道发送验收。
