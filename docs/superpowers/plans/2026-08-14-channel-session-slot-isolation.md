# Channel Session Slot Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复「按完整槽位隔离会话」的语义——`(surface, conversation, agent, workspace, generation)` 是 Session 唯一身份；同 Session 全局串行、不同 Session 跨 surface 并行；排队/流式/恢复的裁决统一落到持久层。

**Architecture:** Session Catalog（SQLite）是 `槽位 → session` 唯一绑定权威（原子 get-or-create），Router 只保存选择偏好；Channel 层为每个活跃 session 维持常驻事件订阅（watcher，delivery 表驱动）；Channel Delivery 独立于 Run 终态，开卡前原子 claim、`claim → send → ack → complete` 顺序、at-least-once 契约；Provider Session Lease 由 run-executor 单一裁决，全部收拢在 Task 9。

**Tech Stack:** TypeScript 5.7/5.9, Node.js 22 `node:sqlite`, Hono, Vitest 2, pnpm workspaces。

---

## 背景与根因

1. **错误一（通道层本地队列未删）**：`packages/channel-feishu/src/bridge.ts` 保留 `dispatching` / `pendingPrompts` / `chatStreamAbort`，以 `chatId|topicId` 为键。
2. **错误二（SessionKey 降级）**：`packages/session-catalog/src/index.ts` 的 `channel_session_bindings` 主键是 `(channel, conversation_id)`。
3. **连带**：`sessions.json`（Router）与 SQLite（Catalog）双重权威。

R2/R3 随本计划修；R1/R4 拆入 `2026-08-14-session-runtime-transaction-hardening.md`（**先执行**）。

---

## 状态机（必要设计）

### 图 1：Channel Delivery 状态机

```
                    submit(queued)                submit(dispatched)
                         │                              │
                         ▼                              ▼
                    ┌─────────┐   dispatchTurn     ┌────────────┐
                    │ pending │ ────────────────► │ dispatched │
                    │ run=null│                    │  run=R     │
                    └────┬────┘                    └─────┬──────┘
                         │                               │
                         └───────────┬───────────────────┘
                                     │ claimDelivery(CAS)
                                     │  条件: pending/dispatched
                                     │  或 delivering+surface_id=null+claim过期
                                     ▼
                               ┌────────────┐
                               │ delivering │◄── 重领(过期后)
                               │ owner,claim│
                               └─────┬──────┘
                                     │ ackDelivery(surface_id)  幂等(null→值)，send 返回后立即落库
                                     │ run_terminal → run_terminal_at（不 completed）
                                     │ completeDelivery(最终内容已渲染到卡片)
                                     ▼
                               ┌────────────┐
                               │ completed  │
                               └────────────┘
```

**terminal 无卡片路径 = `claim → 创建最终卡片 → ack(surfaceId) → complete`**（四步，不可跳过 ack）。

**各状态崩溃恢复（at-least-once 契约）：**

| 崩溃点 | 恢复动作 |
| --- | --- |
| `pending`（无 run） | watcher 订阅（MIN(accepted_sequence)），等 `TURN_DISPATCHED` → claim → 开卡 |
| `dispatched` 无卡片，run 活跃 | claim → 开卡 |
| `dispatched` 无卡片，run 已 terminal | claim → 渲染最终卡片 → ack → complete |
| `delivering` 且 `surface_id=null`（claim→ack 间） | claim 过期后重领 → 开卡 |
| `delivering` 且 `surface_id` 已写 | 用 surface_id 续卡；run terminal → 渲染最终 → complete |
| `completed` | 无动作 |

**重复发送去重**：渠道支持幂等键（如部分 Webhook/API）→ 用 `turnId` 作幂等键；飞书/Telegram 无幂等键 → **at-least-once**（重复窗口 = send 返回与 ack 落库之间），`ackDelivery` 在 send 返回后立即调用压小窗口。watcher 订阅起点 = 该 session 未完成 delivery 的 `MIN(accepted_sequence)`；事件处理按 `turn_id` 查 delivery 表幂等。

### 图 2：Provider Session Lease 状态机

```
resume 路径（run.providerSessionId 已知）：
  claim run(queued→running)
    → claimProviderSession(agentId, providerSessionId, runId, expiry)   [调 Runner 前]
        ├─ fail → finishRun(interrupted)                                [不进 Runner]
        └─ ok   → 调 Runner 驱动 provider session
                   → heartbeat(15s): renewProviderSession  [fail → 停止写入, interrupted]
                   → finishRun 事务:
                       ① releaseProviderSession(owner=runId)
                       ② (succeeded) dispatchNextTurn   ← release 在 dispatch 之前

fresh 路径（run.providerSessionId 未知）：
  claim run(queued→running)
    → 调 Runner（fresh session）
    → 首个 session 事件到达（persist 前 hook）:
         原子: updateRun(providerSessionId) + claimProviderSession
         ├─ fail → abort，finishRun(interrupted)，不 append AGENT_EVENT
         └─ ok   → append AGENT_EVENT → 继续
                   → heartbeat renew → finishRun 事务: release → dispatchNextTurn
```

---

## 关键设计决策

### D1：generation 存 Router，Catalog 只存绑定

按 `(chatId, topicId, backendId, cwd)` 键存 Router，默认 `0`。`/new` +1；`/backend` 不动。

### D2：`channel_session_bindings` 重建 + 事务迁移 + 路径规范化

- `SessionCatalogStore(databasePath, { defaultCwd })`——新增 `defaultCwd` 选项，供迁移回填 null-cwd。
- 迁移包 `BEGIN IMMEDIATE`；回填 `agent_id/cwd`、`generation=0`，**保留原时间**。
- 孤儿判定 `s.id IS NULL`；`cwd IS NULL` 是合法 session，其 `workspace_key = canonicalWorkspaceKey(defaultCwd).key`（**与消息入口的 `options.defaultCwd` 同一值，不得用进程 cwd**）。
- `canonicalWorkspaceKey()` 从 `packages/core/src/index.ts` 导出。
- **Workspace 契约统一**：wire/HTTP/`ChannelSessionMessage` 一律 `cwd`；`ChannelSlot.workspaceKey = canonicalWorkspaceKey(cwd).key`。

### D3：Ingress = `submit()` + `events()` + 常驻 watcher（delivery 表驱动）

- `submit()` 返回 `ChannelSubmitReceipt`（`eventSequence` + `queue_state`）；`events()` 流式返回 `ChannelSessionEvent`。
- dispatched 凭 `runId` 立即开卡；queued 只显示排队提示，后续 watcher 按 delivery 表唤醒。
- watcher 每 session 一个持久订阅，不维护内存 turn 登记（delivery 表即登记）。

### D4：Provider Session Lease —— owner-conditional，Executor 唯一裁决（全部在 Task 9）

- `claim/renew/release(…, runId)`，`release` 校验 owner；`renew` 同步 RunHeartbeat。
- 双 claim 点：resume → 调 Runner 前；fresh → 首个 `session` 事件 persist 前 hook。
- **release 放进 `finishRun` 事务，且在 `dispatchNextTurn` 之前**。
- **RunnerHost 不读 orchestration SQLite**，只保留进程内 SessionLease 防御；唯一裁决 = Executor。

### D5：`channel_turn_delivery` —— 与 Turn 同事务，claim 后开卡，ACK 后完成

列：`turn_id PK / session_id / channel / conversation_id / reply_to_message_id / surface_message_id / claim_owner / claim_expires_at / accepted_sequence / run_id / run_terminal_at / status / created_at / updated_at`。

- submit 事务末尾插入：dispatched → `run_id + dispatched`；queued → `run_id=null + pending`；`acceptedSequence` = 最终 sequence。
- `dispatchTurn` 同事务回写 `run_id + dispatched`。
- `claimDelivery` CAS：`pending/dispatched → delivering`，或 `delivering + surface_id IS NULL + claim 过期 → 重领`。
- `ackDelivery` 幂等（surface_id 仅 null→值）。
- `finishRun` 只写 `run_terminal_at`；Channel 渲染最终内容后 `completeDelivery`。
- `listDeliveries(channel)` 按 channel 过滤。

### D6：`/resume` —— insert/CAS，幂等先于建 Session，原子建+绑

Runner 列 Provider Session → 幂等检查 → lease 预检（UX）→ 需则 `incrementSlotGeneration` → `createAndBindHistoricalSession`（原子）。真 Claim 由 executor 在 Run 前执行。

### D7：Catalog 原子操作

`getOrCreateBoundSession(slot, input)`、`createAndBindHistoricalSession(slot, providerSessionId)`，`BEGIN IMMEDIATE` 内 check+create+bind。

---

## File Map

| File | Responsibility |
| --- | --- |
| `packages/core/src/index.ts` + `workspace-key.ts` | `canonicalWorkspaceKey()` |
| `packages/core/src/types.ts` | `ChannelSlot`、`ChannelSessionMessage`(+`generation`/`replyToMessageId`)、`ChannelSubmitReceipt`(+`queue_state`)、`ChannelSessionEvent`、`ChannelSessionIngress` |
| `packages/session-catalog/src/index.ts` | 全槽位 schema + 事务迁移（`defaultCwd` 选项）+ `bindHistoricalSession` + 原子操作 |
| `packages/session-catalog/src/index.test.ts` | 绑定/迁移/隔离/原子操作 |
| `packages/work-items/src/session-schema.ts` | `channel_turn_delivery`（Task 5）；`provider_session_leases` + `runs.provider_session_id` + `session_runtime.provider_session_id`（Task 9） |
| `packages/work-items/src/session-runtime.ts` | tx 接口 + delivery（Task 5）+ provider lease（Task 9） |
| `packages/session-coordinator/src/coordinator.ts` | `SubmitTurnInput.delivery`（Task 5）；provider lease release/termina 接线（Task 9） |
| `packages/session-coordinator/src/lease.ts` | provider lease claim/renew/release（Task 9） |
| `apps/bridge/src/session-api.ts` | 消息入口按槽位解析（Task 3）+ provider_session_id 同步（Task 9）+ `/continue` + reset + delivery 路由 |
| `apps/bridge/src/channel-ingress.ts` | submit + events + `resumeProviderSession` + `listDeliveries` + delivery ACK |
| `apps/bridge/src/cli.ts` | ingress 构造、`defaultCwd` 传 catalog、provider lease 接线（Task 9）、delivery 清理 |
| `packages/router/src/session-router.ts` | generation 存储 + `buildSlot`；sessions.json 标 deprecated（删在 Task 12） |
| `packages/router/src/slash-commands.ts` | `/new` `/backend` `/continue` `/stop`；`/status` `/cd` `/ws` `/clone` 迁移 |
| `packages/channel-feishu/src/bridge.ts` | 删本地队列；submit + watcher + 按 run 开卡 + delivery 恢复 |
| `packages/channel-telegram/src/telegram-bridge.ts` | 同上 |
| `packages/work-items/src/session-projector.ts` | R2：未知事件显式失败（Task 11） |
| `packages/run-executor/src/index.ts` | 双 claim 点 + persist 前 hook + renew（Task 9） |
| `packages/runner-host/src/server.ts` + `packages/backends/src/acp/*` | 进程内 SessionLease 仅防御；`acquire` miss 防御性拒绝（Task 10） |
| `docs/superpowers/specs/2026-08-14-session-reliability-design.md` | 补齐通道层槽位、delivery、provider lease |

---

## 里程碑 1 — 数据模型（可独立编译）

> 不删 sessions.json 方法、不改命令行为、**不引用任何 Provider Lease**。旧 ingress 继续可用。

### Task 1: 类型 + `canonicalWorkspaceKey()`

**Files:** `packages/core/src/types.ts`、`workspace-key.ts`、`index.ts`

`ChannelSlot` / `ChannelSubmitReceipt`(+`queue_state`) / `ChannelSessionEvent`；`ChannelSessionMessage` 加 `generation?`/`replyToMessageId?`（`cwd` 保持原名）。`canonicalWorkspaceKey(cwd)`。

### Task 2: `channel_session_bindings` schema + 事务迁移 + 原子操作

**Files:** `packages/session-catalog/src/index.ts` + test

`SessionCatalogStore(databasePath, { defaultCwd })`。迁移回填 null-cwd 用 `canonicalWorkspaceKey(defaultCwd).key`。方法：`bindChannelConversation` / `bindHistoricalSession`（insert/CAS）/ `getChannelBinding` / `getChannelSession` / `unbindChannelConversation` / `getOrCreateBoundSession` / `createAndBindHistoricalSession`。

### Task 3: 消息入口按槽位解析（不含 provider lease）

**Files:** `apps/bridge/src/session-api.ts` + test

```ts
const session = options.catalog.getOrCreateBoundSession(slot, { /* agentId, cwd… */ });
// 无 setSessionProviderSessionId —— 该同步在 Task 9 加
```

`/reset` 按 slot unbind；回执写入 `queue_state`。

### Task 4: Router generation + sessions.json 标 deprecated（不删）

**Files:** `packages/router/src/session-router.ts` + test

`getSlotGeneration` / `incrementSlotGeneration` / `buildSlot`；`getSessionRecord/saveSessionRecord/clearSession/bindSession` 标 `@deprecated`。

---

## 里程碑 2 — Ingress 重塑 + 删飞书本地队列 + 命令（不含 provider lease）

### Task 5: `channel_turn_delivery` 表 + coordinator delivery 接线

**Files:** `packages/work-items/src/session-schema.ts`、`session-runtime.ts`、`packages/session-coordinator/src/coordinator.ts` + test

tx 接口：`insertChannelDelivery` / `markDeliveryDispatched` / `markDeliveryRunTerminal` / `claimDelivery`（CAS+过期重领）/ `ackDelivery`（幂等）/ `completeDelivery` / `listDeliveries(channel)`。

`SubmitTurnInput.delivery?`。`submitTurn` 事务末尾插入 delivery；`dispatchTurn` 回写 `run_id + dispatched`（**不写 provider_session_id，Task 9 才写**）；`finishRun` 写 `markDeliveryRunTerminal`（**不 release provider lease，Task 9 才加**）。

### Task 6: Ingress = `submit()` + `events()` + delivery 操作

**Files:** `packages/core/src/types.ts`、`apps/bridge/src/channel-ingress.ts` + test、`apps/bridge/src/session-api.ts`

`ChannelSessionIngress`：`submit / events / resumeProviderSession / listDeliveries / claimDelivery / ackDelivery / completeDelivery / cancel / resumeQueue / reset / resolveApproval`。

### Task 7: 删飞书 chat 级本地队列 + submit + watcher

**Files:** `packages/channel-feishu/src/bridge.ts` + test

删 `pendingPrompts`/`dispatching`/`chatStreamAbort`。watcher 每 session 持久订阅（订阅起点 = 未完成 delivery 的 `MIN(accepted_sequence)`，按 turn_id 幂等）。queued 只回提示；dispatched 凭 runId 立即开卡。terminal 无卡片路径 = `claim → 渲染最终卡片 → ack → complete`。

命令：`/new` → incrementSlotGeneration；`/continue` → resumeQueue；`/stop` → cancel(sessionId, runId)；`/resume` → resumeProviderSession（Task 10）。

### Task 8: Telegram 对齐

**Files:** `packages/channel-telegram/src/telegram-bridge.ts` + test。同 Task 7 + `listDeliveries("telegram")`。

---

## 里程碑 3 — Provider Lease（全部收拢）+ `/resume`

### Task 9: Provider Lease schema + 同步 + dispatch/release + executor 双 claim

**Files:** `packages/work-items/src/session-schema.ts`、`session-runtime.ts`、`packages/session-coordinator/src/coordinator.ts`、`packages/session-coordinator/src/lease.ts`、`packages/run-executor/src/index.ts`、`apps/bridge/src/session-api.ts`

**本任务一次性完成：**

1. schema：`provider_session_leases` 表 + `runs.provider_session_id` 列 + `session_runtime.provider_session_id` 列。
2. tx 接口：`claimProviderSession` / `renewProviderSession` / `releaseProviderSession` / `findLiveProviderLease` / `setSessionProviderSessionId` / `getSessionProviderSessionId`。
3. 消息入口（回开 Task 3）：session 创建后 `setSessionProviderSessionId(session.id, session.providerSessionId)`。
4. `dispatchTurn`（回开 Task 5）：从 `session_runtime.provider_session_id` 读、写进 `runs.provider_session_id`。
5. `finishRun`（回开 Task 5）：事务内 `releaseProviderSession(owner=runId)` → `markDeliveryRunTerminal` →（succeeded）`dispatchNextTurn`（release 先于 dispatch）。
6. executor 双 claim 点（图 2）：resume 调 Runner 前 claim；fresh 首个 `session` 事件 persist 前 hook 原子 `updateRun + claim`；heartbeat renew；终态 release。

**测试：** claim 后第二 run 失败；过期重领；release 校验 owner；renew 延续长 Run / 失败中断；fresh 首个 session 事件原子 claim；release 先于 dispatch；消息入口同步 provider_session_id。

### Task 10: `/resume` 新链路 + ACP 防御

**Files:** `apps/bridge/src/session-api.ts`、`packages/runner-host/src/server.ts`、`packages/backends/src/acp/acp-session-runner.ts`、`packages/router/src/slash-commands.ts`

`resumeProviderSession` 路由 + `provider_session_busy`；RunnerHost 仅进程内 SessionLease 防御；`handleResume` 重写（D6）；ACP `acquire` miss 防御性 `provider_session_busy`。

---

## 里程碑 4 — R2/R3 硬化 + sessions.json 清理

### Task 11: R2 投影未知事件显式失败 + R3 agent 单一来源

**Files:** `packages/work-items/src/session-projector.ts` + test、`session-runtime.ts` + test

### Task 12: 删除 sessions.json 权威（所有调用点迁移后）

**Files:** `packages/router/src/session-router.ts`、`orchestrator.ts`、`slash-commands.ts`、`packages/channel-feishu/src/bridge.ts`、`channel-telegram/src/telegram-bridge.ts`

**逐调用点迁移表：**

| 调用点 | 迁移 |
| --- | --- |
| `session-router.ts:208-218` 定义 | 删方法 |
| `feishu bridge.ts:462` `getSessionRecord` | Catalog `getChannelSession(slot)` |
| `feishu:495` / `telegram:203` `bindSession` | Task 10 已删 |
| `slash-commands:117` `/new` | Task 7 改 incrementSlotGeneration |
| `slash-commands:229-230` `/status` | **通过 SlashCommandContext callback 注入 sessionId（`getSlotSession(slot)`），Router 不直接依赖 Catalog** |
| `slash-commands:299` `/cd` | 本任务删 clearSession |
| `slash-commands:320` `/backend` | Task 7 已删 |
| `slash-commands:557-653` `handleResume` | Task 10 已重写 |
| `slash-commands:957,980` `/ws` `/clone` | 本任务删 |
| `orchestrator:117-118,191,201` legacy `runAgent` | 本任务删 session 读写 |
| `orchestrator:335-340` legacy `bindSession` | 本任务删 |
| `orchestrator:358,386-401` `manageSession` | 本任务改 Catalog 检查 |

> `/status` 的 sessionId 通过 `SlashCommandContext` 新增回调 `getSlotSession(slot)` 注入，由 bridge 接线到 Catalog，避免 Router→Catalog 隐式耦合。

---

## 回归测试矩阵（spec §9 + Web 门禁）

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | Web Pi 与飞书 Cursor 同时执行 | 两 session 各一个 Active Run，互不阻塞 |
| 2 | 飞书同群 Pi/Cursor 同时执行 | 两 slot 两 session；两卡片并存 |
| 3 | 旧 Run 执行中 `/new` | 新消息 dispatched 到新 session；旧 run 仍 running |
| 4 | 同 Session 连发两条 | 第一条 dispatched，第二条 queued |
| 5 | `/resume` 占用中的 provider session | 返回 busy；旧 Run 不受影响 |
| 6 | 一个 Session interrupted | 仅该 session paused；其他 ready |
| 7 | `queued + paused` 不无限等待 | 返回 queued+paused；watcher 唤醒开卡 |
| 8 | Agent 切换不复用另一 Agent Session | `/backend` 后不同 session_id |
| 9 | Telegram 与飞书同隔离规则 | 两 agent 两 session |
| 10 | Bridge 重启后各 Session 独立恢复 | 队列/暂停态/绑定/delivery 不丢 |
| 11 | Web 首条发送 | dispatched，快照含 active_run |
| 12 | Web 连续排队 | 第二条 queued，队列可见可取消 |
| 13 | Web SSE 增量 | 断线按 sequence 补齐，不丢不重 |
| 14 | Web 成功后自动推进 | 上一条 succeeded 自动 dispatch 下一条 |
| 15 | Web Stop | 只停 active_run，终态后 Stop 消失 |
| 16 | Web 历史恢复 | 切换 session 时间线正确，无重复导入 |

---

## 执行顺序与提交边界

1. **先执行 R1/R4 计划**。
2. 里程碑 1（Task 1-4）→ 里程碑 2（Task 5-8）→ 里程碑 3（Task 9-10）→ 里程碑 4（Task 11-12）。

**编译保证**：Task 1-8 不引用任何 Provider Lease 符号（schema/方法/字段），各自可独立编译；Provider Lease 全部在 Task 9 落地。每里程碑 `pnpm vitest run` 不引入新红；只 `git add` 本任务列出的文件。

## 自审

- **spec 覆盖**：§1-4 → Task 1-8；§5 → Task 9-10；§6 → Task 6-7 + `/continue`；§7 → Task 7；§8 → Task 2+4+12；§9 → 回归矩阵（+ Web 门禁）；R2/R3 → Task 11；R1/R4 → 独立计划。
- **已闭合第五轮缺口**：Provider Lease 全收拢 Task 9（Task 1-8 零引用）；R1 per-facade scope closure（独立计划）；delivery `claim→send→ack→complete` + at-least-once 契约（D5/图1）；迁移 null-cwd 用 configured defaultCwd（D2）；`/status` callback 注入（Task 12）。
- **风险**：Task 7 watcher 与 Task 9 persist 前 hook 仍是两个最大单点，已各配状态图，实现按图逐转移写测试。
