# Orchestration 接口规范

状态：v1 implemented baseline；WorkItem、Run、Agent 执行、审批、Discovery、幂等恢复和 Web Workbench 已接入本地 Bridge。

## 1. 协议选择

| 场景 | 协议 |
|---|---|
| Web 和 Channel 发命令、查询状态 | HTTP JSON API |
| 对话、Step、审批和日志流式更新 | SSE Event Stream |
| Runner 连接和任务执行 | 现有 Runner Protocol |
| Claude、Codex、Cursor Backend | ACP |
| Pi Backend | Node SDK Adapter，必要时再提供 ACP Adapter |
| 外部工具和资源 | MCP 或 Capability Adapter |

第一阶段使用 `POST message + SSE events` 支持 Web 直接对话，不要求 WebSocket。只有出现浏览器到服务端的高频双向事件需求时再增加 WebSocket，并继续复用相同 Event Schema。

当前本地 Bridge API 复用现有 Runner Bearer Token；接入 Web、飞书或 Telegram 身份后，再在 Channel 层映射用户身份和权限，不把 Runner Token 暴露给终端用户。

## 2. 资源和命令

接口前缀为 `/v1`：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/v1/work-items` | 在 Conversation 中创建 WorkItem |
| `GET` | `/v1/work-items` | 获取工作台收件箱列表 |
| `GET` | `/v1/work-items/{work_item_id}` | 获取当前状态和固定的定义版本 |
| `POST` | `/v1/work-items/{work_item_id}/messages` | 发送用户消息或补充输入 |
| `POST` | `/v1/work-items/{work_item_id}/runs` | 开始调查、修改、Review、发布或观察 Run |
| `GET` | `/v1/work-items/{work_item_id}/events` | 订阅有序 SSE 事件流 |
| `POST` | `/v1/runs/{run_id}/approve` | 对指定动作授予短期审批 |
| `POST` | `/v1/discovery/tasks` | 创建异步项目发现任务 |
| `GET` | `/v1/projects/candidates` | 查询待确认的项目候选 |
| `POST` | `/v1/projects/candidates/{candidate_id}/accept` | 接受候选并登记正式项目 |

完整草案见 [api.openapi.yaml](../../schemas/orchestration/api.openapi.yaml)。

## 幂等与恢复

创建 WorkItem、追加消息和创建 Run 都支持 `Idempotency-Key` 请求头。Key 与操作作用域一起持久化在 SQLite；重复请求返回第一次的 JSON 结果，不会重复写入事件或创建 Run。事件读取同时接受 `after_sequence` 和标准 `Last-Event-ID`，适合 Web、飞书和 Telegram 在断线后恢复时间线。

Bridge 启动时会把上次进程遗留的 `running` Run 重新放回 `queued`，再由 Runner Executor 继续执行。Runner 输出先写入 Domain Event，再更新 Run 状态，因此客户端不需要依赖内存中的连接保持进度。

## 3. 通用规则

- JSON 字段使用 `snake_case`，ID 使用带类型前缀的不透明字符串。
- 所有时间使用带时区的 RFC 3339；服务端同时保存单调递增的 Event Sequence。
- 创建或产生副作用的请求必须支持 `Idempotency-Key`。
- 客户端不得通过重复请求推断成功；以资源状态和领域事件为准。
- API 返回的 Workflow、Capability 和 Agent Profile 必须带定义版本或内容摘要。
- 生产凭据、Backend 私有 Session 和审批令牌不得进入 Event Payload 或 Artifact。

## 4. 创建 WorkItem

聊天入口只要求会话 ID 和第一句话。`title`、`agent_id`、`mode` 和 `workspace_scope` 都是可选上下文；省略时分别生成标题、使用配置默认 Agent、使用 `auto`，并让 Agent/Discovery 判断项目范围。

```json
{
  "conversation_id": "conv_01J...",
  "mode": "auto",
  "workflow_id": null,
  "message": "用户 123 的权益为什么没有到账？"
}
```

`mode` 是 Agent 的初始提示，不是安全授权；`auto` 表示先判断工作模式、风险和项目范围。`workflow_id` 可以为空。为空时 WorkItem 进入 `exploring`，由 Agent 提出临时 Plan；选择 Workflow 时，服务端固定其 Git revision。

## 5. 事件流和恢复

`GET /events` 返回 `text/event-stream`。每个事件使用 `event_id` 作为 SSE `id`，Domain Event JSON 作为 `data`。客户端断线后使用 `Last-Event-ID` 恢复。

事件必须满足：

- 同一个 WorkItem 内 `sequence` 严格递增。
- Event 一经写入不可修改；修正使用新的补偿事件。
- UI 允许收到重复 Event，并按 `event_id` 去重。
- 订阅只负责展示和投影；Event Store 才是恢复事实源。

事件结构见 [event.schema.json](../../schemas/orchestration/event.schema.json)。

## 6. 审批合同

审批请求必须绑定：

```text
work_item_id + run_id + step_id + capability_id
+ environment + input_hash + expires_at
```

审批默认单次使用、短期有效。Step 输入、目标环境或 Capability 发生变化后，原审批失效。批准接口只产生 `APPROVAL_GRANTED`，不等同于 Step 已成功执行。

## 7. 错误合同

```json
{
  "error": {
    "code": "approval_required",
    "message": "该步骤需要生产审批",
    "retryable": false,
    "details": {
      "run_id": "run_01J...",
      "step_id": "release"
    },
    "request_id": "req_01J..."
  }
}
```

错误代码稳定，`message` 可本地化。外部超时只能标记为失败或结果未知，不能当作成功。

## 8. Schema 兼容性

- `schema_version` 的 Major 变化允许破坏兼容，必须提供显式迁移。
- 同一 Major 内只能新增可选字段或新的枚举处理分支。
- 消费方遇到未知 Event Type 时应保存并忽略其投影，不应让整个流失效。
- Workflow、Capability、WorkItem 和 Event 的基线分别位于 `schemas/orchestration/`。
