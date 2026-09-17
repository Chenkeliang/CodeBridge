# 飞书收件人重启恢复

## 问题与修复

定时报告长期保存 `u1`，但 MentionRegistry 原来仅在进程内存登记收件人。Bridge 发布重启后，尚未收到新的入站消息时，`/outbound/mention` 在调用飞书之前返回“当前对话不存在可通知对象”。

修复分支 `fix_mention_restart_recovery` 从已核实的 `origin/main`（5273552）创建，未带入其他引用消息功能提交。注册器可选使用现有原子 JSON 存储；飞书入口启用持久化，恢复目标、原引用编号及 chat/topic 范围，并从已保存最大编号继续分配。跨会话、跨话题依然拒绝解析。Telegram 不启用新存储，保持原调用方式。

话题回复所需的最近入站消息 ID 同步持久化，避免恢复 @ 对象后把话题消息发到群主会话。

运行数据文件位于既有 dataDir：

- `feishu-mention-targets.json`：引用、用户/机器人目标及所属会话范围。
- `feishu-outbound-reply-targets.json`：会话/话题对应的回复消息 ID。

不猜测或重新绑定已经丢失的历史引用。新版本收到并接受消息后保存映射，之后重启能够恢复；首次部署前已丢失的引用由发送端的普通消息兜底处理。

## Surface Matrix

| Surface | Entry/read/write path | Event consumption | Error/recovery | Terminal feedback | 状态与验证 |
|---|---|---|---|---|---|
| 飞书 | handleMessage → dispatchToAgent → MentionRegistry.register → 原子文件；重建 Bridge → sendOutboundMention | 接受的入站消息登记身份及话题回复锚点 | 损坏映射拒绝加载；未知引用、跨会话及跨话题拒绝发送 | SDK send 接收正确 openId、replyTo、replyInThread | implemented；本地入口 reachable；模拟 SDK closed-loop；实际版本发布后才可核实线上闭环 |
| Agent | 现有 fcb → /outbound/mention → 飞书适配器 | 复用上述持久化身份 | API 继续返回明确400，不猜引用 | API 成功回执或明确错误 | 原入口 reachable；API合同与飞书恢复测试通过；无新增Agent协议 |
| Web | 无新增组件、操作或导航目的地 | 无新增Web事件 | 无新增Web恢复逻辑 | 无新增终态 | 本次不改变现有 reachable 路径；全项目构建通过；无 planned UI 工作 |
| Telegram | 保留无文件参数的 MentionRegistry 调用 | 保持内存登记 | 现有会话隔离语义不变 | 现有消息回执 | 原入口 reachable；通道回归通过；本次不宣称 Telegram 已有持久化恢复 |

## 验证与发布边界

- 重启回归先失败（新注册器无法解析原u1），修复后通过。
- 测试覆盖：编号不复用、用户和机器人编号分开、范围恢复、跨会话拒绝、跨话题拒绝；通过真实飞书入站处理函数登记后重建 Bridge，出站调用无需新的入站消息即可使用正确身份和话题回复锚点。
- 核心、飞书、Telegram、出站 API：30个测试文件、240项测试通过。
- `pnpm -r run build` 通过。
- GitNexus 索引对应修复基线5273552；类和方法影响分析结合源代码确认。该CLI不能直接识别新工作树，未声称其 detect-changes 检查通过；实际 diff 已人工核对。未提交、推送或部署。
- 当前运行版本另含4个既有引用功能提交。发布本修复时须保留当前版本功能，不能直接用旧主分支基线替换运行版本。

股票发送端另有本地修复：仅当 CodeBridge 明确返回“当前对话不存在可通知对象：原ref”的HTTP400时，在原chat/topic发送普通Markdown并继续发送附件。超时、403和其他400不自动重试，避免不确定结果导致重复消息。相应全量444项测试通过。
