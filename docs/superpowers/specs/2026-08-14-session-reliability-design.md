# Session 可靠性与长会话架构设计

- Status: Pending user review
- Date: 2026-08-14
- Scope: `packages/work-items`, `packages/run-executor`, `packages/runner-host`, `packages/backends`, `apps/bridge`, `apps/web`
- Related: `docs/orchestration/architecture.md`, `docs/orchestration/api-contract.md`, `docs/superpowers/specs/2026-08-13-flow-design.md`
- Upstream references:
  - DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`
  - Oh My Pi `5535b5097ef80e4716bce7e6bdf4ae938cd48b70`
  - Pi / `earendil-works/pi` `9d2ec7ffabe927bfad2214c1cee25b6632a78dcf`

## 1. 背景与问题

当前 Session 运行时把同一个事实分散在四处：

1. Web 根据本地 Conversation/Work 投影猜测 Run 是否仍在运行。
2. Bridge 根据数据库 Run 状态决定是否可停止。
3. Runner Host 在进程内维护 Provider Session 是否忙碌。
4. Provider 原生历史在读取 Session 时被重新导入并写入 Event Store。

这会产生不可调和的竞争：

- 切换 Session 后，缓存快照、待提交消息和 SSE 增量的时序不同，导致用户消息先出现，Agent 消息稍后才恢复。
- 活动 Run 期间再次发送消息会创建第二个 Run，随后被 Provider Session 的单活动执行约束拒绝。
- Run 已经结束，但旧 Work 投影仍显示运行中，Stop 按钮因此与服务端冲突。
- `GET /v1/sessions/{id}` 在读取时导入 Provider 历史，可能把旧消息重新写入当前时间线。
- 单字符级 delta 持续写库并触发全量投影和 Markdown 渲染，使输入、切换和滚动成本随 Session 历史增长。
- Provider 流中断后缺少“确定失败”和“副作用结果未知”的区分，无法安全决定重试还是暂停。

这些不是独立 UI Bug，而是同一个根因：**Session 没有唯一的控制面事实源，事件读取和展示成本也没有上界。**

## 2. 目标与非目标

### 2.1 目标

1. 每个 Session 任意时刻最多只有一个活动 Run。
2. 活动 Run 期间发送的消息持久化为 FIFO 下一轮队列，可见、可取消、可恢复。
3. Run 只在成功后自动领取下一条队列消息；失败、取消或中断后暂停队列。
4. Stop、发送、队列和恢复操作只依赖服务端权威状态，不依赖聊天投影推断。
5. Event Store 是 CodeBridge Session 历史的唯一事实源；普通 GET 永不写入历史。
6. Provider 重试遵守副作用边界，结果未知时禁止盲目重放。
7. Session 打开、事件追加、命令查询、输入和渲染的热路径为 `O(1)` 或 `O(active window)`，不允许 `O(total history)`。
8. 浏览器断线、切换 Session、Bridge 重启和 Runner 异常后，都能从持久状态确定性恢复。

### 2.2 非目标

- 不实现跨机器分布式 Workflow Engine。
- 不把整个 Session 改造成通用 Actor Framework。
- 不改变 Flow、Capability、Approval 的业务语义。
- 不保证 Provider 原生 Session 能恢复正在执行到一半的模型请求。
- 不自动重放已经开始且可能产生外部副作用的工具调用。
- 不在本阶段实现全文检索；命令和时间线只做所需的索引化读模型。

## 3. 第一性原理与强制不变量

### 3.1 唯一事实源

服务端持久状态决定：

- 当前活动 Run；
- 队列是否暂停；
- 排队消息及其顺序；
- 最新 Session Event Sequence；
- 当前 Run 是否越过副作用边界。

Web 投影只负责展示。Provider 原生 Session 只负责模型上下文和 Provider 侧会话恢复，不能覆盖 CodeBridge 的 Run、队列或历史状态。

### 3.2 接受消息不等于立即执行

消息提交只有两种成功结果：

- `dispatched`：当前无活动 Run，消息已原子地绑定到新 Run；
- `queued`：当前存在活动 Run或队列处于暂停状态，消息只进入持久队列。

调用方收到任一结果后都不得再次创建 Run。网络结果不明确时，通过 `Idempotency-Key` 查询第一次提交结果，不通过恢复草稿来猜测是否接受成功。

### 3.3 持久化先于发布

任何会改变用户可见状态的操作必须先提交数据库事务，再发布 SSE 或唤醒执行器。进程在提交后、发布前退出时，客户端可以通过 `after_sequence` 补回；不能出现“浏览器看到了、数据库没有”的状态。

### 3.4 明确终态

Run 终态为：

- `succeeded`：目标完成并通过现有成功条件；
- `failed`：已知未成功，且结果不存在副作用不确定性；
- `cancelled`：取消已确认生效，不存在未知的外部执行结果；
- `interrupted`：执行连续性丢失，或者外部副作用结果可能未知。

`failed`、`cancelled`、`interrupted` 都暂停队列。只有 `succeeded` 自动推进队列。

### 3.5 未知副作用优先安全

重试必须证明不会重复副作用。不能证明时，默认不重试。

- Provider 请求失败且尚未开始副作用工具：允许在同一个 Run 内有界重试。
- 只读工具完成后：可以按 Adapter 的只读声明继续恢复。
- `side_effects: true` 的工具开始后，若执行结果无法确认：Run 进入 `interrupted`。
- 有幂等键也不自动推断成功；幂等键只能让显式恢复更安全。

### 3.6 热路径成本有界

以下操作不得扫描完整 Session 历史：

- 打开或切换 Session；
- 判断是否运行中；
- 发送、取消、恢复队列消息；
- Stop；
- 查询 Commands；
- 处理单个 SSE 事件；
- 输入一个字符；
- 渲染当前流式输出。

## 4. 目标架构

```text
Web
  ├─ Session Snapshot / Turn Window
  ├─ Queue Panel
  └─ SSE Incremental Projection
            │
            ▼
apps/bridge routes
            │
            ▼
SessionCoordinator
  ├─ submitTurn()
  ├─ cancelQueuedTurn()
  ├─ cancelActiveRun()
  ├─ resumeQueue()
  ├─ completeRun()
  └─ getSnapshot()
            │
            ▼
packages/work-items
  ├─ Session runtime state
  ├─ Session turns
  ├─ Runs + active-run constraint
  ├─ Events + sequences
  └─ Timeline / command read models
            │
            ▼
Run Executor → Runner Host → Provider Adapter
```

### 4.1 `SessionCoordinator`

新增独立的 `packages/session-coordinator`。它只负责 Session 控制面状态机，不执行 Provider、Flow 或工具。

依赖方向：

```text
apps/bridge
  → session-coordinator
    → work-items storage contracts

run-executor
  → session-coordinator terminal transition port
```

Bridge 路由不得直接组合“写消息 + 创建 Run + 更新 Session 状态”。Run Executor 不得自行领取下一条队列消息。所有跨对象状态变化必须经过 Coordinator 事务。

### 4.2 持久执行领取

新 Run 以 `queued` 状态提交。执行器从数据库领取，而不是依赖提交事务后的单次内存回调。Bridge 在提交后可以发送 wake-up 提示，但提示丢失不影响最终执行。

执行领取使用带租约的条件更新：

```text
queued → running
WHERE run_id = ? AND status = queued
```

同一个 Run 只能被一个执行器领取。未开始的 `queued` Run 可在重启后重新领取；已经进入 `running` 或 `waiting` 且租约失效的 Run 不自动重放，进入恢复判定。

## 5. 持久化模型

### 5.1 `session_runtime`

每个 Session 一行，作为协调事务的锁定点和权威快照：

```text
session_id             primary key
active_run_id          nullable
queue_state            ready | paused
queue_pause_reason     nullable failed | cancelled | interrupted
last_event_sequence    integer
version                integer
updated_at             rfc3339
```

`version` 每次控制面变化递增，供 API 条件操作和 UI 去重使用。

### 5.2 `session_turns`

一条用户提交对应一个 Turn：

```text
turn_id                primary key
session_id             indexed
queue_position         monotonic per session
status                 queued | dispatched | cancelled
message_json           normalized message + attachment refs
idempotency_key        scoped unique
dispatched_run_id      nullable unique
created_at
dispatched_at          nullable
cancelled_at           nullable
```

约束：

- FIFO 顺序使用服务端分配的 `queue_position`，不使用客户端时间。
- `queued` Turn 尚未进入 Conversation Timeline。
- Turn 变为 `dispatched` 时，才在同一事务中追加 `MESSAGE_RECEIVED`。
- `cancelled` 是终态，不能恢复或重新排序。
- 队列分页按 `(session_id, status, queue_position)` 索引读取。
- 每个 Session 最多保留 100 条 `queued` Turn；超过后返回 `409 queue_full`，防止 Snapshot、浏览器内存和误操作无界增长。

### 5.3 `runs`

Run 增加：

```text
session_id
turn_id
status
terminal_reason
replay_safety          safe | side_effect_started | outcome_unknown
lease_owner            nullable
lease_expires_at       nullable
```

数据库必须建立部分唯一约束：

```sql
CREATE UNIQUE INDEX runs_one_active_per_session
ON runs(session_id)
WHERE status IN ('queued', 'running', 'waiting');
```

该约束是最后防线。即使应用层并发判断失效，数据库也不能接受第二个活动 Run。

### 5.4 Session Event Sequence

每个 Session 的 Event Sequence 严格递增。控制面事务在同一个数据库事务中分配 Sequence、写事件并更新 `session_runtime.last_event_sequence`。

事件至少新增：

```text
TURN_QUEUED
TURN_CANCELLED
TURN_DISPATCHED
QUEUE_PAUSED
QUEUE_RESUMED
RUN_INTERRUPTED
RUN_RETRY_SCHEDULED
RUN_RETRY_STARTED
RUN_RETRY_FINISHED
```

未知事件不阻断客户端恢复。Reducer 以 `sequence` 幂等处理，`sequence <= last_applied_sequence` 的事件直接忽略。

### 5.5 时间线读模型

事件日志负责审计和恢复，页面不直接扫描事件日志构建全部历史。增量 Projector 维护按 Turn 分页的元数据：

```text
session_timeline_turns
  session_id
  timeline_index
  turn_id
  run_id
  started_sequence
  ended_sequence
  status
  updated_at
```

内容按稳定 Block 和有界 Segment 保存：

```text
session_timeline_blocks
  block_id
  session_id
  turn_id
  run_id
  block_index
  kind
  status

session_output_segments
  segment_id
  block_id
  segment_index
  content
  byte_length
  sealed
```

约束：

- 唯一索引 `(session_id, timeline_index)`；
- 页面默认只读取最近 50 个 Turn；
- 向上滚动使用稳定 Cursor 分页；
- 当前活动 Turn 只追加或封存自身 Segment；
- 历史 Turn 一旦结束，不因新 delta 重新投影；
- 每个 sealed Segment 不超过 16 KiB，封存后不可变；
- Markdown 在段落、列表、标题或闭合代码块等安全边界封存；
- 16 KiB 内没有安全边界时强制封存为 continuation Segment，不允许活动尾部继续增长；
- 超长代码块按 continuation Segment 以虚拟化纯文本展示，不对整个代码块重复语法高亮；
- 时间线响应同时受 Turn 数和 1 MiB 内容预算约束；超出预算的 Block 返回内容 Cursor，由用户展开时按 Segment 分页读取；
- 旧数据回填按固定批次和持久 Cursor 执行，不在 GET 中触发。

Commands 使用独立的 `session_commands` 读模型，追加相关事件时同步更新。`GET /commands` 不允许 `listEvents().reverse()`。

## 6. Coordinator 状态机

### 6.1 提交消息

`submitTurn(sessionId, message, idempotencyKey)`：

```text
BEGIN IMMEDIATE
  read prior idempotency result
  lock/create session_runtime
  reject when queued count = 100
  insert SessionTurn(queued)

  if active_run_id is null and queue_state = ready:
    select FIFO head
    mark FIFO head dispatched
    append TURN_DISPATCHED + MESSAGE_RECEIVED
    insert Run(queued)
    set active_run_id

  if submitted Turn was selected:
    result = dispatched
  else:
    append TURN_QUEUED for submitted Turn
    result = queued

  increment runtime version
  persist idempotency result
COMMIT
publish committed events / wake executor
```

先插入再选择 FIFO 头，使 Coordinator 即使遇到迁移遗留或恢复中的旧队列，也不会让新消息插队。正常稳定状态下，`queue_state = ready && active_run_id is null` 时不存在旧的 `queued` Turn；该不变量由成功推进和 Resume 事务维持。

提交消息和创建 Run 不再是两个公开步骤。现有分离接口可以保留给内部 Flow/兼容路径，但 Web 普通消息入口必须调用这个原子操作。

### 6.2 Run 成功

`completeRun(runId, succeeded)`：

```text
BEGIN IMMEDIATE
  validate run is the session's active_run_id
  append RUN_SUCCEEDED
  mark run succeeded
  clear active_run_id

  if queue_state = ready and FIFO head exists:
    mark head dispatched
    append TURN_DISPATCHED + MESSAGE_RECEIVED
    create next Run(queued)
    set active_run_id to next Run

  increment runtime version
COMMIT
```

领取下一条 Turn 和完成前一个 Run 在同一个事务中完成，因此并发提交不能插队，也不会出现两个 Run。

### 6.3 失败、取消与中断

```text
BEGIN IMMEDIATE
  validate active Run
  append matching terminal event
  mark Run terminal
  clear active_run_id
  set queue_state = paused
  set queue_pause_reason
  append QUEUE_PAUSED
  increment runtime version
COMMIT
```

此事务不领取队列头。

如果用户在副作用结果未知时点击 Stop，最终状态是 `interrupted`，不是 `cancelled`。

### 6.4 取消排队消息

`cancelQueuedTurn(turnId, expectedVersion)`：

- 只允许 `queued → cancelled`。
- 已经 `dispatched` 返回 `409 turn_already_dispatched`。
- 已经 `cancelled` 返回第一次取消结果，保持幂等。
- 取消后保留 `queue_position` 空洞，不重新编号其他 Turn。

### 6.5 恢复队列

`resumeQueue(sessionId)`：

```text
BEGIN IMMEDIATE
  require no active Run
  set queue_state = ready
  append QUEUE_RESUMED

  if FIFO head exists:
    dispatch head and create Run atomically

  increment runtime version
COMMIT
```

队列为空时，Resume 只清除暂停状态。暂停期间新提交的消息继续排队，不隐式恢复。

## 7. Provider 重试与中断恢复

### 7.1 尝试边界

一个 CodeBridge Run 可以包含多个 Provider Attempt。Attempt 必须有稳定 ID，并记录：

```text
attempt_id
run_id
attempt_number
started_at
ended_at
provider_error
side_effect_boundary
```

失败 Attempt 的部分文本可以保留为审计证据，但后续 Attempt 不得把它当成新的用户消息。展示投影可以标记该 Attempt 已重试，模型上下文由 Adapter 按 Provider 合同重建。

### 7.2 自动重试条件

同时满足以下条件才允许自动重试：

1. 错误被 Adapter 分类为瞬时错误，例如 429、连接重置、超时或可重试 5xx；
2. Run 尚未开始 `side_effects: true` 的工具；
3. 未超过 Adapter/Run 的最大尝试次数；
4. Run 未收到取消；
5. 重试等待没有超过配置的最大延迟。

重试使用有上限的指数退避和抖动。调度、开始、结束都写持久事件，用户可以在等待期间取消。

### 7.3 恢复分类

Bridge 或 Runner 重启后：

- `queued` 且从未领取：重新进入执行领取；
- `running` 但无任何副作用工具开始：关闭原 Attempt，Run 标记 `interrupted`，等待用户显式恢复；
- 副作用工具已开始且没有确定结果：设置 `outcome_unknown`，Run 标记 `interrupted`；
- 工具结果和后置条件都已持久化，只缺终态事件：通过确定性 Repair 补写终态；
- 不能从日志证明的情况一律不推断成功。

Repair 只根据持久事实生成缺失的结构化结束事件，不调用 Provider，不重新执行工具。

## 8. Provider 历史权威边界

### 8.1 一次性导入

Provider 原生历史只允许在以下显式操作中导入：

- 新建 CodeBridge Session 时采用已有 Provider Session；
- 用户执行明确的“导入 Provider 历史”操作；
- 经预览确认的历史修复操作。

导入记录：

```text
provider_session_id
provider_history_revision_or_digest
imported_through_provider_position
imported_at
```

导入完成后，CodeBridge Event Store 成为该 Session 的历史事实源。

### 8.2 纯读取

以下接口必须严格只读：

- `GET /v1/sessions/{session_id}`
- `GET /v1/sessions/{session_id}/events`
- `GET /v1/sessions/{session_id}/runs`
- `GET /v1/sessions/{session_id}/commands`
- Session 打开、切换和 SSE 重连

测试必须比较调用前后的数据库变更计数，证明 GET 没有追加事件、消息、Run 或导入记录。

### 8.3 显式修复

Provider 与 CodeBridge 历史不一致时：

1. 生成只读 Diff；
2. 展示将新增、忽略或冲突的条目；
3. 用户确认；
4. 通过带 Idempotency Key 的命令执行；
5. 写独立审计事件。

正常 Session 打开不自动修复。

## 9. 流式事件与背压

### 9.1 服务端聚合

Provider 原始 delta 先进入每个活动 Run 的单一聚合器。按 `(run_id, block_id, delta_kind)` 合并：

- 最长每 125 ms 刷新一次；
- 累计达到 4 KiB 立即刷新；
- Message、Tool Call、Tool Result、Attempt 和 Run 边界立即刷新；
- 同一个聚合事件只包含同一种语义 delta；
- 单个 Provider 的 1～3 字符 chunk 不直接成为领域事件。

因此，平稳输出时每个活动 block 的持久 delta 事件率不超过每秒 8 条，语义边界除外。

聚合事件提交 Event Store 后才通过 SSE 发布。进程异常最多留下尚未对客户端发布的内存 buffer，不会出现已展示但不可恢复的文本。

### 9.2 客户端批处理

SSE 事件先进入 Session 对应的外部 Store，再以浏览器 animation frame 为单位通知 React。每个事件只增量修改：

- 当前活动 Turn；
- 对应 Run/Work block；
- Session 控制快照；
- 队列列表。

不得为单个 delta 重新执行完整 `projectEvents(allEvents)`。

### 9.3 背压

- 客户端处理落后时，按 Sequence 从服务端补读，不无限扩张浏览器内存队列。
- 单次补读有固定事件/字节上限，并返回 `next_after_sequence`。
- 超出服务端增量保留范围时返回 `snapshot_required`，客户端重新获取时间线窗口和快照。
- 慢客户端不能阻塞 Provider 消费或其他 Session。

## 10. Session 打开与 SSE 恢复

### 10.1 权威 Snapshot

`GET /v1/sessions/{id}` 返回：

```json
{
  "session": {},
  "runtime": {
    "active_run": null,
    "queue_state": "ready",
    "queue_pause_reason": null,
    "queue": {
      "turns": [],
      "total": 0,
      "next_cursor": null
    },
    "version": 42,
    "last_event_sequence": 9182
  },
  "timeline": {
    "turns": [],
    "previous_cursor": null
  }
}
```

`active_run` 是 Stop 和发送行为的唯一依据。Conversation/Work Projection 不再包含决定控制按钮的权力。Snapshot 最多内联前 100 条队列消息和 1 MiB 时间线内容；Queue、Timeline 和 Block Content 都使用 Cursor，返回值不会随历史总量增长。

### 10.2 无竞争恢复协议

1. 客户端获取 Sequence 为 `S` 的 Snapshot 和最近 50 个 Turn。
2. 客户端订阅 `after_sequence=S`。
3. 服务端返回所有 `sequence > S` 的已提交事件，再进入 live。
4. 客户端按 Sequence 去重并检测缺口。
5. 发生缺口时停止应用后续事件，执行补读或 Snapshot 恢复。

### 10.3 Session 切换

- 每个 Session 的客户端投影按 `session_id` 隔离。
- SSE 到达时同时更新该 Session 的缓存投影，不只更新当前页面状态。
- 切回 Session 可以立即展示缓存窗口，但标记为同步中。
- 权威 Snapshot 到达后按 Sequence 合并，不能用旧 Snapshot 整体替换更新过的投影。
- `pendingEvents` 不再作为独立历史来源；待发送内容由服务端 Queue Snapshot 表达。

## 11. Web 交互与渲染

### 11.1 Composer

- Composer Draft 保持在独立组件或独立 Store。
- 输入字符只重渲染 Composer，不重渲染已完成的 Markdown Turn。
- 提交成功返回 `queued` 或 `dispatched` 后立即清空 Draft。
- 只有服务端明确返回“消息未被接受”时才恢复 Draft。
- 网络结果未知时，用相同 Idempotency Key 查询结果。

### 11.2 Queue Panel

队列面板位于 Composer 上方，显示：

- FIFO 顺序；
- 消息摘要和提交时间；
- 当前 `ready` 或 `paused` 状态；
- 暂停原因；
- 每项取消按钮；
- 暂停时的 Resume 按钮。

排队消息不进入 Conversation Timeline。被 Coordinator dispatch 后，从 Queue Panel 移除并作为用户消息进入时间线。

### 11.3 Stop

- 只有 `runtime.active_run != null` 时显示可用 Stop。
- Stop 请求绑定 `run_id` 和 Snapshot `version`。
- Run 已终态时返回其权威终态，客户端直接刷新 Snapshot，不显示“无可停止”后继续保留 Stop。
- WorkProjection 的 `running` 仅用于展示动画，不能控制 Stop。

### 11.4 时间线渲染

- 默认挂载最近 50 个 Turn。
- 旧 Turn 使用虚拟化或逐页挂载。
- 完成的 Markdown Segment 按稳定 Block/Segment ID memoize。
- 活动 Markdown 只重渲染未封存且不超过 16 KiB 的尾 Segment；更新频率不超过持久 delta 的每秒 8 次。
- 多个 Work block 必须由稳定 block ID 管理；Run 终态关闭该 Run 的所有未关闭 block，不能只关闭最后一个。

## 12. API 合同

### 12.1 提交

```text
POST /v1/sessions/{session_id}/messages
Idempotency-Key: <key>
```

响应：

```json
{
  "acceptance": "queued",
  "turn": {
    "turn_id": "turn_...",
    "status": "queued",
    "queue_position": 12
  },
  "runtime": {
    "active_run": {"run_id": "run_..."},
    "queue_state": "ready",
    "version": 43,
    "last_event_sequence": 9183
  }
}
```

### 12.2 队列操作

```text
DELETE /v1/sessions/{session_id}/queue/{turn_id}
POST   /v1/sessions/{session_id}/queue/resume
GET    /v1/sessions/{session_id}/queue
```

Mutation 使用 `If-Match: "<runtime.version>"`。版本冲突返回最新 Runtime Snapshot。

### 12.3 Run 操作

```text
POST /v1/runs/{run_id}/cancel
GET  /v1/runs/{run_id}
```

取消响应区分：

```text
cancelled
interrupting
already_terminal
```

### 12.4 时间线与事件

```text
GET /v1/sessions/{session_id}/timeline?before=<cursor>&limit=50
GET /v1/sessions/{session_id}/timeline/blocks/{block_id}/segments?after=<cursor>
GET /v1/sessions/{session_id}/events?after_sequence=<n>&limit=500
GET /v1/sessions/{session_id}/events?after_sequence=<n>&live=true
```

`timeline` 面向展示，`events` 面向增量恢复和审计，两者不能互相替代。事件补读默认最多 500 条且响应不超过 1 MiB；调用方可将 `limit` 提高到 2,000，但响应仍受 4 MiB 硬上限约束。

## 13. 兼容与迁移

本设计收紧 `docs/orchestration/api-contract.md` 第 5 节的旧恢复规则：Bridge 重启后，只有从未开始的 `queued` Run 可以重新领取；遗留的 `running` / `waiting` Run 必须先按第 7.3 节判定并进入 `interrupted` 或确定性 Repair，不能直接改回 `queued`。实现本设计时同步更新该基线文档和 OpenAPI Schema。

### 13.1 数据迁移

1. 为现有 Run 回填 `session_id` 和可确定的 `turn_id`。
2. 创建 `session_runtime`，根据数据库非终态 Run 初始化 `active_run_id`。
3. 如果同一 Session 已存在多个非终态 Run，迁移停止并输出冲突报告，不静默选择。
4. 创建部分唯一约束。
5. 创建时间线和 Commands Projector Cursor。
6. 旧历史按固定批次回填读模型；进度持久化，可中断续跑。
7. 删除 GET 路径中的 Provider History Hydration，替换为显式 Import。

迁移不删除原始事件。新旧事件消费者在兼容期内并存。

### 13.2 运行时切换

切换顺序：

1. 先上线存储约束和 Coordinator，不改 Web。
2. 所有消息入口切到原子 `submitTurn()`。
3. Run Executor 终态切到 Coordinator。
4. 上线 Snapshot、Queue 和新 Stop 语义。
5. 上线增量时间线、SSE Store 和渲染隔离。
6. 最后移除旧的本地运行状态推断和全历史扫描。

任何阶段都不允许同时存在两条可创建普通 Session Run 的写路径。

## 14. 验证与验收

### 14.1 状态机测试

必须覆盖：

- 两个并发提交只能产生一个活动 Run，另一个稳定排队；
- 相同 Idempotency Key 不重复创建 Turn、消息或 Run；
- Run 成功后自动领取且只领取 FIFO 头；
- Run 失败、取消、中断后队列保持顺序并暂停；
- 暂停期间新消息只排队；
- Resume 原子领取队列头；
- 取消已排队 Turn 成功，取消已 dispatch Turn 返回冲突；
- Bridge 重启后队列和暂停状态不丢失；
- 数据库唯一约束能阻止绕过 Coordinator 的第二个活动 Run。

### 14.2 恢复测试

- Snapshot 与 SSE 建连之间发生事件时不丢失、不重复；
- SSE 断线后使用 Sequence 恢复；
- Sequence 缺口触发补读或 Snapshot，不继续错误投影；
- 未开始 Run 在重启后可领取；
- 已开始且副作用未知的 Run 变为 `interrupted`；
- Repair 只补结构化结束事件，不调用工具或 Provider；
- Provider 429/连接重置仅在副作用边界前重试。

### 14.3 纯读取测试

对每个 GET：

1. 记录数据库 `total_changes`、事件数、消息数、Run 数和导入记录数；
2. 调用 GET；
3. 断言所有写入计数不变。

Provider 历史 Import 只在显式命令测试中允许变化。

### 14.4 长会话测试

使用至少 150,000 个历史事件和一个持续流式 Run 的 Fixture：

- Session 打开只读取最近 50 个 Turn 和 Runtime Snapshot；
- Snapshot 返回的队列不超过 100 条；
- Snapshot 和单页 Timeline 内容不超过 1 MiB；
- SQL Query Plan 对 Queue、Timeline、Commands、Run 状态使用索引，不全表扫描 Session Events；
- 应用一个新事件不重新回放 150,000 个事件；
- 输入字符不重新渲染完成的 Markdown；
- 活动 Markdown 每次只解析不超过 16 KiB 的尾 Segment；
- 平稳 Provider 输出的持久 delta 不超过每个 block 每秒 8 条；
- 浏览器内存中的历史范围由已挂载 Turn Window 决定，不随完整 Session 历史线性增长；
- 切换 Session 后立即可见缓存窗口，补齐期间不暂时丢失 Agent 消息；
- Run 终态后所有对应 Work block 都停止，Stop 同步消失。

### 14.5 故障注入

在以下边界终止 Bridge/Runner 并验证恢复：

- Turn 已持久化但 Run 尚未领取；
- Run 已领取但 Provider 尚未返回；
- 文本流式输出中；
- 只读工具结束后；
- 副作用工具开始但结果未落库；
- Run 终态已提交但 SSE 尚未发布；
- 前一个 Run 成功并原子创建下一 Run 后、执行器唤醒前。

## 15. 上游项目采用边界

### 15.1 采用

从 DeepSeek Harness 采用：

- 持久 Inbox 投影；
- next-turn / next-step 边界；
- 明确 Turn 开始和结束；
- `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 恢复分类；
- delta 存储聚合；
- 增量 Surface 投影。

从 Oh My Pi 采用：

- 并发 `prompt()` 明确拒绝；
- 可取消的 Retry 生命周期；
- 仅对可安全回放的 Provider 失败重试；
- 已完成工具结果不重复执行。

从 Pi 采用：

- 一个 Agent 只有一个活动执行；
- `followUp` 与 `steer` 的语义分离；
- Append-only Session 历史和稳定 ID。

### 15.2 不照搬

- Pi/Oh My Pi 的 Follow-up Queue 是进程内状态，不能作为 Web 多客户端的可靠队列。
- 本地 JSONL 全量加载不满足 CodeBridge 现有超长 Session 的查询上界。
- DeepSeek Harness 的本地 Session 模型不替代 CodeBridge 的 SQLite 事务、活动 Run 唯一约束和服务端 Snapshot。
- Provider 原生 Session 不能成为 CodeBridge 控制面事实源。

## 16. 完成定义

只有同时满足以下条件，Session 可靠性工作才算完成：

1. 控制面所有写入口经过 SessionCoordinator。
2. 数据库证明每个 Session 最多一个活动 Run。
3. 队列可持久化、展示、取消、暂停和恢复。
4. 普通 GET 零写入。
5. Provider 重试和 `interrupted` 遵守副作用边界。
6. Session Snapshot + Sequence 恢复通过故障测试。
7. 150,000 事件 Fixture 下所有热路径保持窗口化。
8. Composer 输入不触发历史 Markdown 重渲染。
9. Stop 只由 `active_run` 控制。
10. 旧消息不会因 Session 打开而再次导入或自动填回 Composer。
