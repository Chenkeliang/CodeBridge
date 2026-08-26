# Flow 待生成中心：跨 Session 发现与确认

状态：Review draft

日期：2026-08-26

关联设计：`2026-08-25-flow-save-intent-design.md`

## 1. 背景

Flow Save Intent 已经能够从 Agent 自然语言工具调用或 Web Turn 菜单产生持久化的
`FLOW_SAVE_REQUESTED` 事件，并投影为 Session Timeline 中的确认卡。用户确认后才会创建
Candidate Runbook。

当前缺口不在事件持久化或 Timeline 投影，而在跨表面发现：

- 飞书只提示“前往 Web”，没有说明请求位于哪个 Agent、Session 或入口；
- Web 只展示当前选中 Session 的 Timeline；
- Flows 区域只展示 Catalog 中的 Candidate、Published、Draft、Deprecated；
- pending Save Intent 尚未进入 Catalog，因此不会出现在 Flows 区域；
- Web 记住每个 Agent 上次选中的 Session。用户正在查看其他 Session 时，会误以为请求丢失。

2026-08-26 的真实链路验证中，`FLOW_SAVE_REQUESTED`、Session Timeline block 和
`GET /v1/sessions/:session_id` 返回均正确，但 Web 当时选中了另一个 Pi Session。切换到来源
Session 后确认卡可见。这证明当前问题是目的地发现缺口，不是数据丢失。

## 2. 目标与非目标

### 2.1 目标

1. 任意 Agent、任意 Session 产生 pending Save Intent 后，用户都能从 Web 的 Flows 区域发现。
2. 用户无需先知道来源 Agent 或 Session，即可查看来源并完成确认或忽略。
3. pending Save Intent 不写入 Flow Catalog，不伪装成 Candidate。
4. Flows 全局入口与 Session Timeline 卡读取同一 canonical 事件状态。
5. 确认后，待生成条目与新 Candidate 在同一交互中收敛。
6. 飞书只提供准确的目的地说明，不复制确认状态机。
7. Web 关闭时不提供自然语言保存工具，也不产生悬空的“前往 Web”提示。

### 2.2 非目标

- 不把 Save Intent 新增为 Flow Catalog 状态；
- 不自动切换用户当前正在操作的 Agent 或 Session；
- 不在飞书或 Telegram 中增加确认、忽略、创建 Candidate 的写操作；
- 不改变 Candidate Dry-run、Review、Published 生命周期；
- 不启用 Telegram；
- 不增加兼容旧自动 Guide proposal 的读取路径；
- 不建立第二套 Save Intent 数据库或状态机。

## 3. 第一性不变量

### 3.1 领域身份隔离

`FLOW_SAVE_REQUESTED` 表示待用户确认的保存意图；它不是 Flow，也不是 Candidate。

Flow Catalog 只保存真实的 Guide/Runbook 定义。未确认请求禁止以
`status = pending_generation` 等伪状态写入 Catalog。

### 3.2 唯一事实源

Save Intent 状态只由以下 canonical 事件决定：

- `FLOW_SAVE_REQUESTED` → pending；
- `FLOW_SAVE_DISMISSED` → dismissed；
- `FLOW_CANDIDATE_CREATED` → completed；
- `FLOW_SAVE_FAILED` → failed。

Session Timeline 卡和 Flows“待生成”列表是两个读取表面，不是两套领域状态。

### 3.3 全局发现不改变 Session 归属

每个请求仍必须保留并验证：

- `request_id`；
- `session_id`；
- `request_turn_id` / `request_run_id`；
- `source_turn_id` / `source_run_id`；
- `source_title`；
- `source`；
- `source_imported`；
- `intent_summary` / `name_hint`；
- canonical event sequence。

全局列表不得把请求重新归属到当前选中的 Session。

### 3.4 不抢占当前工作

后台出现新请求时，Web 只能更新 Flows 徽标和待生成列表，禁止自动切换 Agent、Session、
区域或滚动位置。

### 3.5 写边界不变

全局待生成详情复用现有 confirm/dismiss API。LLM、飞书 Adapter、Telegram Adapter 和读取
接口均不能创建 Candidate。

## 4. 方案选择

### 4.1 不采用：Catalog 伪 Flow

把 pending Save Intent 写入 Catalog 虽然能直接复用 Flows 列表，但会混淆“保存意图”和
“已创建定义”，破坏确认前不写 Catalog 的核心边界。

### 4.2 不采用：Web 扫描已加载 Session

Web 只拥有当前 Agent 的 Session 列表和当前选中 Session 的 Timeline。逐 Session 拉取会产生
N+1 请求、竞态与遗漏，也无法形成稳定分页。

### 4.3 采用：后端全局只读查询 + Web Flows 统一入口

Bridge 从 canonical 事件存储派生全局 pending Save Intent 列表。Web 在 Flows 区域显示
“待生成”分组；点击条目后直接显示确认详情。确认或忽略仍调用既有命令 API。

## 5. 后端读取合同

### 5.1 Endpoint

新增只读接口：

```http
GET /v1/flow-save-requests?state=pending&limit=50&cursor=<opaque>
Authorization: Bearer <token>
```

V1 只接受 `state=pending`。其他值返回 `400 flow_save_request_state_invalid`，避免提前承诺历史
收件箱。

响应：

```json
{
  "requests": [
    {
      "request_id": "fsr_...",
      "session_id": "sess_...",
      "agent_id": "pi",
      "session_title": "仓配中心-发货单下发异常",
      "request_turn_id": "turn_...",
      "request_run_id": "run_...",
      "source_turn_id": "turn_...",
      "source_run_id": "run_...",
      "source_title": "发货单下发异常排查与修复",
      "source": "agent_intent",
      "source_imported": false,
      "intent_summary": "...",
      "name_hint": "...",
      "created_at": "2026-08-26T04:53:40.922Z",
      "event_sequence": 1725
    }
  ],
  "next_cursor": null
}
```

`domain_events.sequence` 只在单个 WorkItem 内递增，不能作为跨 Session 的全局 cursor。
`next_cursor` 必须是不透明的 `(occurred_at, event_id)` 复合游标；单个请求返回的
`event_sequence` 仍用于该请求自身的事件身份和审计。

### 5.2 查询语义

请求满足以下条件才进入列表：

1. 存在合法 `FLOW_SAVE_REQUESTED`；
2. 同一 `request_id` 之后不存在 dismissed/completed/failed 终态；
3. 对应 Session 仍存在；
4. payload 中的 Session/Turn/Run 身份与持久事实一致；
5. 结果按 `(occurred_at DESC, event_id DESC)` 稳定分页。

损坏或身份不一致的事件不进入列表，并记录结构化告警；不得猜测或自动修复归属。

### 5.3 性能与索引

查询在 Event Store 内完成，不由 Web 遍历 Session。新增
`domain_events(type, occurred_at DESC, event_id DESC)` 索引支撑全局 requested 扫描；现有
`domain_events(target, sequence)` 索引支撑同一请求的终态排除。使用 opaque 复合 cursor，并用
大量历史终态请求验证查询不会退化为逐 Session N+1。

### 5.4 一致性

接口是 read-only read model。它不写 Timeline、不写 Catalog、不补领域事件。

confirm/dismiss 成功后，后端 canonical 事件立即决定该请求不再属于 pending；Web 本地可乐观
禁用按钮，但最终移除必须以命令响应或后续全局读取为准。

## 6. Web 信息架构

### 6.1 Flows 导航徽标

左侧 Flows 图标显示 pending 数量。数量为 0 时不显示徽标；超过 99 显示 `99+`。

徽标只表示待确认 Save Intent，不与 Runtime Approval、Agent Permission 或 Flow Definition
Review 合并。

### 6.2 Flows 分组

Flows 侧栏顺序：

1. `待生成 · N`；
2. `候选`；
3. `已发布`；
4. `草稿`；
5. `已停用`。

待生成条目显示：

- `name_hint ?? source_title ?? "未命名保存请求"`；
- Agent 名称；
- Session 标题；
- 相对时间；
- Imported 来源警示（如适用）。

条目必须带 `request_id` 稳定身份，不能用标题作为 React key 或动作身份。

### 6.3 待生成详情

点击待生成条目后，Flow 主区域显示：

- “待确认生成 Candidate”状态；
- 来源任务标题；
- Agent / Session；
- 保存意图摘要；
- 用户触发原话（与来源分开）；
- Imported 来源警示；
- “生成 Candidate”和“忽略”动作；
- “查看来源 Session”辅助入口。

“查看来源 Session”是显式用户动作：选择对应 Agent/Session，并定位原 Timeline block。打开
详情本身不切换 Session。

### 6.4 状态收敛

确认成功：

1. 请求从“待生成”移除；
2. Catalog 列表刷新；
3. 同一 `flow_id` 出现在“候选”；
4. 主区域打开 Candidate 详情；
5. 提供 Dry-run / Review 后续入口。

忽略成功：请求从“待生成”移除，主区域回到下一个待生成请求或空状态；来源 Session 的
Timeline 卡仍保留 dismissed 审计状态。

### 6.5 刷新策略

Web 启动时读取 pending count/list。之后：

- Flows 区域打开时每 15 秒刷新；
- 其他区域只刷新轻量 count，周期不短于 15 秒；
- 切入 Flows、手动刷新、confirm/dismiss 后立即刷新；
- 页面恢复可见时立即刷新一次；
- 同一时刻只允许一个列表请求，陈旧响应不得覆盖新结果。

Web 用单调 request generation 判定响应是否陈旧，不比较不同 WorkItem 的 event sequence。

V1 不新增第二条全局 SSE。持久只读查询保证刷新和重启恢复；轮询只负责发现延迟，不承担
领域状态。

## 7. 命令、错误与恢复

### 7.1 Idempotency-Key

沿用现有命令身份规则：

- 首次 confirm/dismiss 生成新 key；
- 网络结果未知时重试复用同一 key；
- 已得到确定响应后清除；
- 不同 `request_id`、不同动作使用独立 key；
- 页面切换或同时操作多个请求不得覆盖其他请求的 key。

### 7.2 错误展示

- `404 flow_save_request_not_found`：移除陈旧条目并刷新；
- `409 state_conflict`：刷新 canonical 状态，不反向执行另一动作；
- `409 source_run_not_extractable`：显示 failed 终态和重新选择来源说明；
- `503 flow_catalog_unavailable`：保留 pending，允许同 key 重试 confirm；
- 网络未知：保留条目，只显示对应动作的重试按钮；
- 全局列表读取失败：保留上次成功快照，显示非阻断错误和重试，不显示虚假空列表。

## 8. 飞书与 Telegram

### 8.1 飞书

`FLOW_SAVE_REQUESTED` 仍只投影到原 Run 卡。提示文案改为：

> 已记录“存为 Flow”请求。请前往 Web → Flows → 待生成确认；尚未创建 Candidate。

飞书不新增按钮、不调用 confirm/dismiss API、不创建第二张卡、不等待 Web 终态后再完成
Delivery。

修改飞书 watcher 属于 HIGH 影响范围：`handle` 影响 live 与 recovery 两条生产流程。实施必须
独立覆盖 live、finite replay、restart recovery、foreign Run、duplicate event 和 terminal 后零写。

### 8.2 Telegram

Telegram 当前禁用。代码文案可与飞书保持一致，但只能标记 implemented/tested；真实 Bot
reachable/closed-loop 仍留待启用后的 T1 收尾验收。

## 9. 防溢出与可访问性

- 待生成条目、Session 标题、来源标题、摘要均使用 `min-width: 0` 与 anywhere wrapping；
- 不用页面级 `overflow-x: hidden` 掩盖组件溢出；
- 主按钮在 320px 下允许换行但不能裁剪；
- 状态不能只依赖颜色，必须同时显示文字；
- 徽标提供可读 label，例如“3 个待生成 Flow 请求”；
- 键盘可进入待生成分组、选择条目并执行动作；
- 焦点从条目进入详情后有可预测顺序；
- 100 个 pending 请求时侧栏内部滚动，不推动页面宽度或 Composer。

## 10. Surface Matrix

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned 落点 |
|---|---|---|---|---|---|---|---|---|
| Web | Flows → 待生成 | 全局 pending API + Catalog API | 既有 confirm/dismiss API | 当前 Session SSE + 全局只读刷新 | 命令错误矩阵 + 列表读取错误 | 刷新/可见性恢复/15s 轮询 | pending 移除并打开 Candidate，或显示 dismissed/failed | WFI-3/4/5 |
| Agent | 自然语言保存工具 | dispatch-time availability | 只产生 Save Intent 请求 | AGENT_EVENT → canonical Save Intent | 固定领域错误码，不承诺 UI 状态 | tool replay 幂等 | 只声明请求已记录、尚无 Candidate | WFI-6 回归 |
| 飞书 | 原 Run 卡提示 | canonical channel event | 无确认写路径 | live + replay/restart | 原卡错误处理 | Delivery reconciliation | 指向 Web → Flows → 待生成；不等待 Web 终态 | WFI-7 |
| Telegram | 原 pending/terminal message | canonical channel event | 无确认写路径 | live + recovery tests | 原消息错误处理 | Delivery recovery | 与飞书同语义；真实 Bot 后置 | WFI-8 / Telegram 启用收尾 |

完成前必须重新核对四态：

- Web：implemented、生产入口 reachable、活跃表面 closed-loop；
- Agent：implemented、真实 ACP/Pi 工具链 reachable；
- 飞书：implemented、真实卡片入口 reachable，但确认闭环由 Web 完成；
- Telegram：禁用时只能是 implemented/tested/planned。

## 11. 测试策略

### 11.1 合同层

1. pending 查询只返回无终态请求；
2. dismissed/completed/failed 均不返回；
3. malformed identity fail-closed 并告警；
4. 多 Agent、多 Session 稳定排序与 cursor 分页；
5. 事件重放不重复；
6. pending 查询不写 Catalog、Timeline 或领域事件；
7. 大量历史请求下无 N+1 Session 查询；
8. `state != pending` 返回准确 400。

### 11.2 Web 组件与状态

1. 待生成分组和 Flows 徽标计数；
2. 来源标题与用户请求分开展示；
3. imported 警示；
4. confirm/dismiss 独立 key 与未知结果重试；
5. 并发 A/B 请求互不覆盖；
6. 陈旧列表响应不污染新快照；
7. confirm 后 pending → Candidate 原子视觉收敛；
8. “查看来源 Session”精确定位 Agent/Session/request block；
9. 100 条 pending 和长文本防溢出。

### 11.3 活跃表面 E2E

关键对抗用例：

1. 飞书 Pi Session A 发起 Save Intent；
2. Web 当前停留在 Codex Session B；
3. Web 不自动切换；
4. 15 秒内 Flows 徽标增加；
5. Flows → 待生成可见 A 的请求；
6. 点击请求直接打开详情；
7. confirm 只创建一个 Candidate；
8. 待生成条目消失、Candidate 出现并可打开预演；
9. 刷新/Bridge 重启后结果一致。

另需独立验证飞书 live/replay/restart 提示文案，以及 Telegram disabled 状态不被误报为
reachable。

## 12. 实施阶段

- **WFI-1**：Event Store 全局 pending 查询与索引；
- **WFI-2**：Bridge `GET /v1/flow-save-requests?state=pending` 合同；
- **WFI-3**：Web API/types/query state，含竞态和轮询；
- **WFI-4**：Flows 待生成分组、徽标和详情；
- **WFI-5**：confirm/dismiss 收敛、查看来源 Session、E2E 与防溢出；
- **WFI-6**：Agent availability/声明回归，Web disabled 门禁；
- **WFI-7**：飞书提示与 live/recovery/restart 验收；
- **WFI-8**：Telegram 合同测试和启用后真实 Bot 收尾记录；
- **WFI-V1**：完整 Surface Matrix、全构建、GitNexus detect、活跃部署版本与 PID 证据。

## 13. 完成定义

1. pending Save Intent 在未选中来源 Session 时仍能从 Flows 发现；
2. 点击待生成条目无需切换 Session 即可确认或忽略；
3. 确认前 Catalog 零写；
4. 确认后只创建一个 Candidate；
5. 待生成与 Candidate 列表收敛且刷新/重启一致；
6. 飞书明确指向 `Web → Flows → 待生成`；
7. Web disabled 时工具不注入、请求不产生、通道不声称前往 Web；
8. Session Timeline 原确认卡继续可达并读取同一事件；
9. 320–1536px、100 pending、长标题/摘要无横向溢出；
10. 合同测试与活跃 Web/飞书表面测试均通过；
11. Telegram 禁用状态如实记录；
12. 部署后记录构建版本、artifact、PID/start time，并验证真实跨表面链路。
