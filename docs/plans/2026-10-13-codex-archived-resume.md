# Codex 归档会话续聊

## 范围与验收

在 Runner 收到带 `resumeSessionId` 的 Codex 请求时，先取得已有会话锁并检查外部占用，再检查归档目录；仅对命中的原 ID 调用官方 `codex --no-daemon unarchive <ID>`，成功后仍将原 ID 交给 ACP。按 `profile.type === "codex"` 判断，覆盖 `codex` 和 `codex-alert`。不改新会话、其他后端、消息正文和权限设置。

新增 `codex-session-archive.ts`：现有 ownership 文件只处理进程占用；归档恢复调用官方 CLI，让 Codex 同步文件与元数据，不手工移动文件或修改数据库。沿用 Runner 环境中的 CODEX_HOME、CODEX_PATH，超时 15 秒。未归档直接继续；读取归档目录失败或 CLI 失败输出 fatal error/done，不发送 prompt。通过现有 finally 释放租约。

## 链路证据

1. `packages/channel-feishu/src/bridge.ts`：handleMessage 解析 topic；告警 prepareAlertReply 归一为原告警 root；submitAndStream 用原 conversationId/slot 提交。
2. `apps/bridge/src/channel-ingress.ts` 将提交交给 Session Runtime；`packages/work-items/src/session-runtime.ts` 保留 providerSessionId。
3. `apps/bridge/src/cli.ts` 的 RunRequest 构造器将 run.providerSessionId 传为 resumeSessionId。
4. `packages/runner-host/src/server.ts`：锁、占用检查、归档恢复、executeAcpRun；`packages/backends/src/acp/acp-active-session.ts` 用原 ID load/resume。
5. Runner error/done 由 RunExecutor 持久化，飞书 session-watcher 消费 Agent error 和失败事件并输出终态。

## Surface Matrix

此表区分源码接线、自动化验证与线上闭环。没有发送真实通道消息，也没有部署候选代码。

| Surface | entry/read/write | event/error/recovery/terminal | implemented | reachable | closed-loop | planned 落点 |
| --- | --- | --- | --- | --- | --- | --- |
| Agent/Runner | executeRun → 原 ID → 官方 unarchive → ACP | 恢复失败 fatal/done；租约释放；原 ID 重试 | 是 | 本地 Runner 测试 | 隔离 CLI 文件恢复已验证；未调用真实模型续聊 | 本次 Runner 修复 |
| 飞书 | handleMessage → 原话题 slot → Session Runtime → Runner | session-watcher 既有事件消费/失败回执；原话题可再回复 | 是 | 源码接线与普通/告警表面测试 | 自动化通过；线上未验证 | 发布后在原话题实际回复验收 |
| Web | 既有 Session API → 同一 RunRequest/Runner | 复用现有事件和失败处理，无 UI 改动 | 共享 Runner 已实现 | 未专项验证 | 未验证 | 本次无新 Web UI |
| Telegram | 既有 ingress → 同一 RunRequest/Runner | 复用现有 watcher，无通道改动 | 共享 Runner 已实现 | 未专项验证 | 未验证 | 本次无新 Telegram UI |

## 验证

- GitNexus：指定 `/Users/demo/projects/CodeBridge-deploy`，在基线 35d6fcb 重建索引；executeRunInner 上游 1 个直接调用、2 个受影响符号，LOW。
- 回归：暂时还原旧入口，新增的 3 项恢复测试全部失败；恢复修复后定向 29 文件 / 259 测试通过。
- `pnpm test`：最终 147 文件 / 1380 测试通过（包含飞书回复豁免新增 6 项）。
- `pnpm build`：通过；`pnpm lint`：通过，Web 既有 7 warning、0 error。
- 真实原生 CLI：临时 CODEX_HOME 中放置合成归档历史，调用编译后的恢复函数；确认移回 sessions、原 ID 和历史内容保留，再次调用无操作。没有模型调用、飞书发送或真实会话修改；临时目录已清理。
- `git diff --check`：通过。

## 飞书原话题的闲置轮换修复（用户已确认）

普通飞书在进入 Runner 前有自动轮换逻辑：默认闲置 12 小时或上下文增长超过 50% 后换新会话。当前 `/Users/demo/.codebridge/config.yaml` 未覆盖这些默认值。告警群豁免。用户已明确选择原话题回复保留原会话、跳过闲置换新。`submitAndStream` 根据群消息的 threadId/rootId/replyToMessageId 判断回复，仅本次调用共享 `sessionRotationReason` 时覆盖 idleHours=0；保留配置中的 enabled 与 maxContextRatio。私聊和群中新消息、上下文过满、告警群豁免均保持原逻辑。这里不新增共享轮换规则，只由通道把回复语义适配为现有策略参数。

新增 6 项飞书活跃入口回归：3 种回复形式在闲置 48 小时后保留原 conversationId、agentId、cwd 和 generation；私聊/群中新消息仍轮换；原话题上下文过满仍轮换。旧逻辑下 3 项保留绑定测试失败（其余 6 项通过），修复后该文件 9 项全部通过。GitNexus 将 rotateStaleSession / submitAndStream 标为 HIGH（分别 1/2 个直接调用，均涉及 3 条上游流程），已在修改前告知并用上述表面测试核验边界。

本地验证阶段：分支 `fix_codex_archived_resume` 基于已 fetch 的 origin/main，创建时独有提交数为 0。用户随后已授权上线部署；使用本地固定提交交给发布器，不附加推送或合并操作。部署结果以发布器记录为准。运行环境需具有 `codex unarchive` 子命令，本机已通过 `codex unarchive --help` 与隔离实测验证。

官方接口说明：https://learn.chatgpt.com/docs/app-server （thread/unarchive）。
