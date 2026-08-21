# 飞书运行状态栏持久化设计

- Status: Review draft
- Date: 2026-08-21
- Scope: 飞书运行卡片的状态栏生命周期与终态展示
- Out of scope: Telegram 展示、Runtime 状态机、ChannelStreamProjector 正文合并规则

## 1. 问题

飞书卡片运行时会显示：

```text
🟢 执行中 · 已运行 1 秒
最近确认活动：1 秒前
当前阶段：任务启动
```

但当前主 SessionWatcher 和 legacy streaming 都会在终态把 `showLiveStatus` 设为 `false`，最终写入只保留正文。状态栏因此消失，用户无法从最终卡片判断任务是成功、失败、停止还是中断，也看不到总耗时。

## 2. 目标交互

状态栏在卡片整个生命周期中始终存在：

- 运行中持续更新运行时长、最近确认活动和当前阶段；
- 终态停止计时，将运行态切换为明确结果；
- 状态栏下方继续展示 `ChannelStreamProjector.finalText`；
- 终态卡片重写、恢复重放和 legacy 路径使用相同语义。

终态文案：

| 状态 | 标题 | 时间字段 |
| --- | --- | --- |
| succeeded | `✅ 已完成` | `总耗时` |
| failed | `❌ 已失败` | `总耗时` |
| cancelled | `⏹ 已停止` | `总耗时` |
| interrupted | `⚠️ 已中断` | `总耗时` |

## 3. 状态模型

扩展飞书展示层的状态模型，不修改 Runtime 领域事件：

```ts
type FeishuRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

interface FeishuLiveStatus {
  startedAt: number;
  lastActivityAt: number;
  phase: string;
  state: FeishuRunState;
  endedAt?: number;
}
```

规则：

1. 新卡片和恢复卡片从 `running` 开始。
2. `recordLiveActivity` 只更新 `running` 状态的活动时间和阶段。
3. 进入终态时设置 `state` 和 `endedAt`，之后不再变化。
4. 总耗时使用 `endedAt - startedAt`，不会随卡片后续重放继续增长。
5. 重复终态事件保持第一次终态，保证投影幂等。

## 4. 渲染合同

### 4.1 运行中

保留现有三行结构：

```text
🟢 执行中 · 已运行 12 秒
最近确认活动：2 秒前
当前阶段：工具执行：Read
```

超过 quiet 阈值时继续使用现有橙色连接保持提示。

### 4.2 终态

终态使用两行稳定结构：

```text
✅ 已完成 · 总耗时 18 秒
最终阶段：生成最终回复

---

最终答案正文
```

终态不再显示“最近确认活动”，避免把冻结时间误读为仍在运行。

若正文为空，仍使用 projector 的 `（本次无输出）`，状态栏不能被空正文移除。

## 5. 三条路径映射

### 5.1 SessionWatcher 主路径

领域终态直接映射：

| ChannelSessionEvent | FeishuRunState |
| --- | --- |
| `RUN_SUCCEEDED` | `succeeded` |
| `RUN_FAILED` | `failed` |
| `RUN_CANCELLED` | `cancelled` |
| `RUN_INTERRUPTED` | `interrupted` |

`FeishuRunCard.finalize` 接收终态，而不是通过关闭 `showLiveStatus` 删除状态栏。

### 5.2 delivering 恢复路径

恢复卡片重放 `AGENT_EVENT` 构造正文和活动阶段；收到领域终态后应用同一映射，再用原 `surfaceMessageId` 写入“终态状态栏 + finalText”。更新成功后才完成 delivery，保持现有确认顺序。

### 5.3 legacy streaming

legacy 没有完整的 `ChannelSessionEvent` 终态，按 AgentEvent/异常映射：

| 信号 | FeishuRunState |
| --- | --- |
| `done.exitCode === 0` | `succeeded` |
| `done.exitCode !== 0` 或普通异常 | `failed` |
| `AbortError` / 主动停止 | `cancelled` |

如果流在没有 `done` 的情况下正常结束，按现有成功语义收敛为 `succeeded`。第一终态生效，后续信号不覆盖。

## 6. 组件边界

- 状态生命周期属于飞书 adapter，不放入通道无关的 `ChannelStreamProjector`。
- Projector 继续只提供 `liveText` 和 `finalText` 正文。
- 飞书渲染函数统一组合 `renderRunStatus(status) + snapshot text`。
- 不修改 Session cursor、claim/ack/complete、Runtime Run 状态和原始事件。
- Telegram 当前只展示 placeholder 与最终结果，本轮不增加状态栏。

## 7. 异常与降级

- 卡片更新失败仍走现有普通消息降级；降级文本应包含终态标题和最终正文。
- 终态更新失败时，SessionWatcher 不提前 complete delivery，继续使用现有重连恢复机制。
- Bridge 重启后恢复中的卡片从重放时刻重新建立展示计时；V1 不新增持久化 `startedAt/endedAt` 字段。
- stop 与 failure 必须分开，不能把用户主动停止显示成失败。

## 8. 测试合同

新增或扩展测试覆盖：

1. 运行中每次正文刷新都保留状态栏；
2. `RUN_SUCCEEDED` 最终卡片包含 `✅ 已完成`、冻结总耗时和最终正文；
3. failed/cancelled/interrupted 分别使用正确标题；
4. 恢复路径终态保留状态栏，且更新成功后才 complete delivery；
5. legacy `done(0)`、非零退出、异常和 AbortError 映射正确；
6. 空结果仍显示终态状态栏和 `（本次无输出）`；
7. 已修复的 commentary 去重回归继续通过；
8. Telegram 行为不变。

## 9. 验收标准

- 飞书卡片从创建到终态从不丢失顶部状态区；
- 终态准确区分完成、失败、停止和中断；
- 终态耗时冻结，不继续增长；
- 最终正文保持统一投影层语义；
- 不改变 Runtime、delivery 或 Telegram 合同。
