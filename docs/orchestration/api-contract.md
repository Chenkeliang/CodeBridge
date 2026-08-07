# Orchestration 接口规范

状态：v1 设计基线，未实现。

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

## 2. 资源和命令

接口前缀为 `/v1`：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/v1/work-items` | 在 Conversation 中创建 WorkItem |
| `GET` | `/v1/work-items/{work_item_id}` | 获取当前状态和固定的定义版本 |
| `POST` | `/v1/work-items/{work_item_id}/messages` | 发送用户消息或补充输入 |
| `POST` | `/v1/work-items/{work_item_id}/runs` | 开始调查、修改、Review、发布或观察 Run |
| `GET` | `/v1/work-items/{work_item_id}/events` | 订阅有序 SSE 事件流 |
| `POST` | `/v1/runs/{run_id}/approve` | 对指定动作授予短期审批 |
| `POST` | `/v1/discovery/tasks` | 创建异步项目发现任务 |
| `GET` | `/v1/catalog/candidates` | 查询待确认的项目候选 |
| `POST` | `/v1/catalog/candidates/{candidate_id}/accept` | 接受候选并生成 Catalog Diff |

完整草案见 [api.openapi.yaml](../../schemas/orchestration/api.openapi.yaml)。

## 3. 通用规则

- JSON 字段使用 `snake_case`，ID 使用带类型前缀的不透明字符串。
- 所有时间使用带时区的 RFC 3339；服务端同时保存单调递增的 Event Sequence。
- 创建或产生副作用的请求必须支持 `Idempotency-Key`。
- 客户端不得通过重复请求推断成功；以资源状态和领域事件为准。
- API 返回的 Workflow、Capability 和 Agent Profile 必须带定义版本或内容摘要。
- 生产凭据、Backend 私有 Session 和审批令牌不得进入 Event Payload 或 Artifact。

## 4. 创建 WorkItem

```json
{
  "conversation_id": "conv_01J...",
  "title": "排查会员权益未到账",
  "agent_id": "pi-investigator",
  "mode": "investigation",
  "workflow_id": null,
  "workspace_scope": ["equity-center"],
  "message": "用户 123 的权益为什么没有到账？"
}
```

`workflow_id` 可以为空。为空时 WorkItem 进入 `exploring`，由 Agent 提出临时 Plan；选择 Workflow 时，服务端固定其 Git revision。

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
