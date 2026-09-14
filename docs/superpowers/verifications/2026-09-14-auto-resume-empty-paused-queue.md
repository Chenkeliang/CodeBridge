# 空暂停队列自动恢复验证

## 行为

普通新消息进入 Session 时，如果 Runtime 为 `paused`、没有 active Run，且提交前没有 queued Turn，则在同一事务内清除暂停状态并直接调度该消息。该行为等价于先执行 `/c` 再提交消息，但不产生中间的“消息已排队”提示。

如果暂停时已有 queued Turn，或仍有 active Run，则保持暂停；新消息继续入队，等待用户显式发送 `/c`，避免自动执行既有积压。

## 验证场景

- failed/cancelled/interrupted 后无积压：下一条消息返回 `acceptance=dispatched`、`queue_state=ready`、`queue_pause_reason=null`、队列总数为 0。
- 暂停时已有一条积压：下一条消息仍返回 `acceptance=queued`，队列保持 `paused`，两条消息均留在队列。
- 同一规则由 `SessionCoordinator.submitTurn` 维护，通道不复制状态判断。

## Surface Matrix

| Surface | Entry | Write path | Event/feedback path | Candidate state | Current production |
| --- | --- | --- | --- | --- | --- |
| Web | Session message submit | `POST /v1/sessions/:id/messages` → `SessionCoordinator.submitTurn` | 返回 dispatched Runtime，Web 连接继续观察 Run | implemented、reachable、自动测试 closed-loop | planned：候选发布后生效 |
| Agent | Runner dispatch | `dispatchNextTurn` 创建 queued Run，`observeExecution` 交给 Runner | AGENT_EVENT 与 Run 终态进入 timeline | implemented、reachable、自动测试 closed-loop | planned：候选发布后生效 |
| 飞书 | `FeishuBridge.submitAndStream` | Channel ingress 调同一 message API | dispatched 直接打开 Run 卡片；queued 才显示 `/c` 提示 | implemented、reachable、自动测试 closed-loop | planned：候选发布后生效 |
| Telegram | `TelegramBridge.submitAndStream` | Channel ingress 调同一 message API | dispatched 直接打开 Run；queued 才显示 `/c` 提示 | implemented、reachable、自动测试 closed-loop | planned：候选发布后生效 |

## 自动化证据

- `packages/session-coordinator/src/coordinator.test.ts`：空暂停队列自动恢复、有积压时保持暂停。
- `apps/bridge/src/session-runtime-api.test.ts`：生产消息 API 返回直接调度的权威 Runtime。
- `packages/channel-feishu/src/bridge-lifecycle.test.ts`：飞书 dispatched Run 进入 watcher 并完成卡片闭环。
- `packages/channel-telegram/src/telegram-bridge.test.ts`：Telegram 普通消息经共享 Session ingress 完成回复。
- `apps/web/src/lib/submit-session-message.test.ts`：Web 提交与不确定结果恢复路径保持可用。
