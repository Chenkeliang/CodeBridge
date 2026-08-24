# 通道终态结果持久化恢复设计

- Status: Review draft
- Date: 2026-08-24
- Scope: 飞书终态卡片在 Bridge 重启、Core SSE 断流或重连后的确定性恢复
- Amends: `docs/superpowers/specs/2026-08-21-feishu-run-status-reconciliation-design.md`
- Out of scope: 重新执行 Agent/Flow、为永久失效卡片发送普通消息、启用 Telegram、修改 Runtime 状态机

## 1. 问题与证据

Run `run_cd03401eaa4f450fbf6bba2529f929cd` 已产生完整回答：最终文本事件位于 sequence 783–793，`RUN_SUCCEEDED` 位于 sequence 796，Session 持久化时间线包含约 2081 字助手输出。

飞书卡片却显示“已完成 / 最终阶段：任务启动 / 本次无输出”，对应 Delivery 仍停在 `delivering`。因此失败点不是 Agent 或 Flow 执行，而是终态结果交付。

## 2. 第一性原理

一次可恢复的通道交付有三个彼此独立的事实：

1. **任务事实**：Runtime Run 决定 `running/succeeded/failed/...`；
2. **结果事实**：持久化事件日志及 Session Projection 决定用户应看到的正文；
3. **表面事实**：飞书 HTTP 写卡成功，决定结果是否已送达用户表面。

Core SSE、飞书 WebSocket 和进程内 projector 都只是加速实时体验的传输或缓存，不是事实源。任何一个断开都不能丢失已经持久化的结果。

唯一合法的终态提交条件是：

```text
Runtime 已终态
AND 持久化结果已重放到通道投影
AND 终态卡片写入成功
=> Delivery completed
```

缺少任一条件时，Delivery 必须保持可重试；不得把“内存暂时为空”解释成“本次无输出”。

## 3. 根因

当前 `reconcileDelivery()` 在恢复卡片时先应用 `runSnapshot`，随后立即调用 `writeResumedCard()`。新建的 `ChannelStreamProjector` 与 `ChannelFlowProjector` 都是空的，因此 terminal renderer 使用默认的“本次无输出”。

当前恢复路径又要求未来收到一次 terminal SSE event 才调用 `completeDelivery()`。若 Core SSE 在重启/重连期间未完成历史回放，就会形成永久悬空状态：

```text
Runtime succeeded
→ 空内存 projector 写出错误终态
→ SSE 未继续重放
→ 真结果不覆盖
→ Delivery 永久 delivering
```

## 4. 方案比较

### 4.1 方案 A：只调整写卡顺序

等 SSE 回放结束后再写终态。改动小，但正确性仍依赖长连接最终恢复，拒绝。

### 4.2 方案 B：从 Session 页面投影抓取最后一条助手消息

能恢复普通回答，但可能取错 Run，且无法完整恢复结构化 Flow 事件，拒绝。

### 4.3 方案 C：有限历史重放 + 幂等终态提交（采用）

为共享 `ChannelSessionIngress` 增加只读、有限的历史事件读取能力，复用现有 `/v1/sessions/:id/events` 非 live 合同。终态 Delivery 对账时按 `acceptedSequence` 读取持久化事件，只投影目标 `runId`，再写卡并完成 Delivery。

该方案同时恢复普通 Agent 文本、结构化 Flow 结果、阶段信息和审批状态，不创建第二套结果模型。

## 5. 目标数据流

```text
listDeliveries
→ 发现 Run 已终态
→ GET persisted history after acceptedSequence（非 live）
→ 只重放目标 runId 到现有 stream/flow projector
→ 应用 Runtime terminal snapshot
→ patch 原飞书卡片
→ patch 成功后 completeDelivery
```

正常运行中的低延迟更新仍走 SSE。有限历史读取只用于终态恢复，不与 live projector 重复消费。

## 6. 合同与边界

共享入口新增可选只读能力：

```ts
replayEvents?(
  sessionId: string,
  opts: { afterSequence: number },
): Promise<ChannelSessionEvent[]>;
```

- 这是 Bridge 的共享结果读取合同，不包含飞书 Markdown；
- Feishu/Telegram 不复制事件读取或领域规则；
- 本轮只接入飞书恢复路径，Telegram 启用时复用同一能力；
- 方法保持可选，避免一次性破坏所有 `ChannelSessionIngress` 测试替身；
- 若能力缺失或读取失败，显示“结果恢复中”，保持 `delivering`，下轮继续对账；
- 只有“历史读取成功 + Run 已终态 + 目标 Run 确无可展示事件”才能显示“本次无输出”。

## 7. 幂等与竞态

- 重放只处理 `event.runId === delivery.runId` 的事件；
- terminal recovery 不把重放事件送入 Session 的 live cursor，避免重复正文；
- 同一 Delivery 可重复恢复、重复 patch 同一张卡；
- `completeDelivery()` 继续以 `turnId + owner` 做幂等状态转换；
- SSE terminal event 与 reconciliation 同时到达时，二者都必须满足“终态写卡成功后再 complete”，先完成者清理内存状态，后到者成为无操作；
- 不重新 submit，不重新执行 Run，不触发任何业务写操作。

## 8. 错误处理

| 故障 | 用户表面 | Delivery |
|---|---|---|
| 历史读取暂时失败 | 已终态，正文“结果恢复中” | 保持 `delivering` |
| 飞书 patch 暂时失败 | 保留旧卡，下轮重试 | 保持 `delivering` |
| 飞书卡片永久失效 | 结构化告警 | 保持 `delivering`，不自动补发 |
| 持久化历史确认无结果 | “本次无输出” | patch 成功后 `completed` |
| 持久化历史包含结果 | 展示完整结果 | patch 成功后 `completed` |

## 9. 测试与验收

必须先写失败测试覆盖：

1. terminal snapshot 先于历史恢复时，不得显示“本次无输出”；
2. 重启后有限历史能恢复普通 Agent 最终文本；
3. 同一路径能恢复结构化 Flow 结果；
4. 历史读取失败时保持 `delivering`，并显示恢复态；
5. 卡片 patch 失败时不得 complete；
6. patch 成功后即使没有 terminal SSE event 也能 complete；
7. 历史读取已确认无结果时才允许显示“本次无输出”；
8. live SSE 与恢复对账竞态不会重复正文或重复执行；
9. 使用当前卡住的 Delivery 做恢复验收：只重放已持久化事件，不重新运行查询或 Flow。

完成标准：Bridge 重启、Core SSE 断流和飞书 WebSocket 重连三种情况下，Runtime 终态 Run 都能仅依赖持久化数据把原卡片恢复为完整终态，并最终把 Delivery 收敛为 `completed`。

## 10. Surface Matrix

| Surface | Entry | Read path | Write path | Terminal feedback | Planned |
|---|---|---|---|---|---|
| Bridge | Delivery reconciler | Delivery + Runtime snapshot + finite event history | complete Delivery | 可重试终态协议 | 本轮 |
| Feishu | 原运行卡片 | 共享事件投影 | patch 原卡片 | 完整结果/恢复中/真实无输出 | 本轮 |
| Web | Session timeline | 既有持久化 Projection | 无新增 | 已有完整结果 | 无改动 |
| Agent | Runtime | 无新增 | 无新增 | 不负责交付 | 非目标 |
| Telegram | watcher | 未来复用 replayEvents | 无新增 | 暂未启用 | 后续收尾 |
