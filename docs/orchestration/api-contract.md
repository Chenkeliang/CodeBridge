# Orchestration 接口规范

状态：Session-first API 目标合同。当前 Bridge 已有 WorkItem/Run API；Session、Agent Registry、Folder 和 Flow Catalog API 按本规范逐步补齐，旧 WorkItem 路径作为内部执行记录和兼容入口保留。

## 1. 协议选择

| 场景 | 协议 |
|---|---|
| Web、外部飞书/Telegram CLI 或 WebSocket 网关查询、发送消息 | HTTP JSON API |
| Session、Run、Flow 和审批的实时更新 | SSE Event Stream |
| Runner 连接和任务执行 | 现有 Runner Protocol |
| Cursor、Claude Code、Codex 等 ACP Agent | ACP Adapter |
| Pi Agent | Node SDK Adapter；需要时再提供 ACP Adapter |
| 外部工具和资源 | MCP 或 Capability Adapter |

第一阶段使用 `POST message + SSE events` 支持 Web 直接对话，不要求 WebSocket。实时通道共享同一 Event Schema，断线后使用 Event Sequence 恢复。

Bridge 服务端持有 Runner 凭据；终端用户通过 Web、飞书或 Telegram 的身份映射获得权限，不直接接触 Runner Token。

外部渠道把稳定的渠道会话标识提交到
`POST /v1/channels/{channel}/conversations/{conversation_id}/messages`。服务端持久化
`channel + conversation_id → Session` 绑定，然后复用同一套 Message、Run、Flow、Approval
和 SSE 事件合同。仓库中已有的内置 Feishu/Telegram Router 路径继续作为兼容适配器运行，迁移时只替换入口，不改变 Runner 和 Agent 合同。

## 2. 资源接口

接口前缀为 `/v1`：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/agents` | 获取 Agent Profile、健康状态和能力摘要 |
| `GET` | `/v1/agents/{agent_id}` | 获取 Agent 详情、模型和 Session 能力 |
| `GET` | `/v1/sessions` | 按 Agent、Folder、状态查询 Session |
| `POST` | `/v1/sessions` | 创建一个固定绑定 Agent 的 Session |
| `GET` | `/v1/sessions/{session_id}` | 获取 Session、目录、最近 Flow 和状态 |
| `POST` | `/v1/sessions/{session_id}/directories` | 授权并添加 Session 的附加目录 |
| `DELETE` | `/v1/sessions/{session_id}/directories` | 从 Session 移除附加目录 |
| `POST` | `/v1/sessions/{session_id}/messages` | 向当前 Session 发送消息 |
| `GET` | `/v1/sessions/{session_id}/runs` | 查询 Session 的 Run 状态投影 |
| `POST` | `/v1/sessions/{session_id}/runs` | 根据当前消息和可选 Flow 创建 Run |
| `POST` | `/v1/sessions/{session_id}/resume` | 恢复 Agent 原生 Session |
| `POST` | `/v1/sessions/{session_id}/fork` | 按 Agent 能力创建分支 Session |
| `POST` | `/v1/sessions/{session_id}/close` | 关闭 Session |
| `DELETE` | `/v1/sessions/{session_id}` | 删除 Session 元数据和可删除的本地历史 |
| `GET` | `/v1/sessions/{session_id}/events` | 读取或以 `live=true` 持续订阅 Session 和 Run 事件 |
| `GET` | `/v1/flows` | 查询 Flow/Workflow Catalog |
| `GET` | `/v1/flows/{flow_id}` | 获取 Flow 内容和版本 |
| `POST` | `/v1/flows/{flow_id}/apply` | 将 Flow 绑定到当前 Session 的下一次 Run |
| `POST` | `/v1/flows/candidates` | 保存当前 Session 生成的 Flow Candidate |
| `POST` | `/v1/flows/{flow_id}/review` | 通过 Review 决定 Candidate 是否发布，并记录 Git revision |
| `POST` | `/v1/discovery/tasks` | 创建异步项目或目录发现任务 |
| `GET` | `/v1/projects/candidates` | 查询待确认的项目候选 |
| `POST` | `/v1/projects/candidates/{candidate_id}/accept` | 接受候选并登记正式项目 |
| `GET` | `/v1/projects/drifts` | 查询已登记项目的待审核字段变化 |
| `POST` | `/v1/projects/drifts/{drift_id}/apply` | 显式应用已审核的目录变化 |
| `POST` | `/v1/projects/drifts/{drift_id}/resolve` | 忽略本次目录变化但保留审计记录 |
| `POST` | `/v1/directories/authorize` | 请求 Runner 验证并授权工作目录 |
| `POST` | `/v1/runs/{run_id}/approve` | 授予当前 Run 的单次审批令牌 |
| `POST` | `/v1/runs/{run_id}/reject` | 拒绝审批并取消当前 Run |

现有兼容接口：

```text
GET/POST /v1/work-items
POST      /v1/work-items/{id}/messages
POST      /v1/work-items/{id}/runs
GET       /v1/work-items/{id}/events
```

这些接口对应后台 `TaskRecord`，不定义新的页面导航层级。完整草案见 [api.openapi.yaml](../../schemas/orchestration/api.openapi.yaml)。

## 3. 创建 Session

创建 Session 时 Agent 是唯一的必要运行时身份；目录、模型和 Flow 都可以省略：

```json
{
  "agent_id": "<agent-id>",
  "folder_id": null,
  "model": null,
  "title": null
}
```

服务端从 Agent Registry 读取 Adapter，创建或恢复厂商原生 Session，并返回统一 Session 资源：

```json
{
  "session_id": "sess_01J...",
  "agent_id": "<agent-id>",
  "provider_session_id": "<opaque-provider-id>",
  "folder_id": null,
  "flow_id": null,
  "status": "idle"
}
```

用户首句话通过 `/messages` 发送；服务端根据消息和可选上下文创建 Run。

主工作目录保存为 `cwd`；跨项目上下文通过 `additional_directories` 管理。新增目录必须先由 Runner 授权并保存 canonical path，移除只改变 Session 上下文；两者从下一次 Run 开始生效，不修改历史 Run。

## 4. Flow 绑定和动态生成

Run 请求中的 Flow 可以为空：

```json
{
  "message": "<natural-language-goal>",
  "flow_id": null,
  "mode": "auto"
}
```

为空时，Agent 为当前 Session 生成 `ephemeral` Flow/Plan，并通过事件流返回 `FLOW_PROPOSED`。用户可以继续修改、确认执行，或选择保存为 Candidate。

选择已有 Flow 时，服务端在 Run 创建时固定其 `definition_revision`；后续 Flow Catalog 更新不影响已经创建的 Run。

`mode` 是运行提示，不是安全授权。安全权限由 Capability Policy 和 Approval 合同决定。

## 5. 幂等与恢复

创建 Session、发送消息、创建 Run、应用 Flow 和接受项目候选都支持 `Idempotency-Key`。Key 与操作作用域一起持久化在 SQLite；重复请求返回第一次结果，不会重复创建 Run 或写入副作用事件。

事件读取同时接受 `after_sequence` 和标准 `Last-Event-ID`：

- 同一个 Session 内 `sequence` 严格递增。
- Event Store 是恢复事实源，客户端只维护展示投影。
- Bridge 重启后将遗留的 `running` Run 重新放回 `queued`，再由 Runtime 继续执行。
- Agent 原生 Session 只负责厂商会话恢复；Run 和证据恢复依赖 CodeBridge Event Store。

## 6. 通用规则

- JSON 字段使用 `snake_case`，ID 使用带类型前缀的不透明字符串。
- 所有时间使用带时区的 RFC 3339；服务端同时保存单调递增的 Event Sequence。
- Agent Profile、Flow 和 Capability 返回定义版本或内容摘要。
- 生产凭据、Backend 私有 Session 和审批令牌不得进入 Event Payload 或 Artifact。
- 不同 Agent 的 Session 通过明确的 Session ID、Folder、Artifact 或用户消息关联；服务端不隐式改变当前 Session 的 Agent。

## 7. 审批合同

审批请求必须绑定：

```text
session_id + run_id + step_id + capability_id
+ environment + input_hash + expires_at
```

审批默认单次使用、短期有效。Step 输入、目标环境或 Capability 发生变化后，原审批失效。批准接口只产生 `APPROVAL_GRANTED`，不等同于 Step 已成功执行；拒绝接口产生 `APPROVAL_REJECTED` 和 `RUN_CANCELLED`。

审批记录固定绑定 `session_id + run_id + step_id + capability_id + environment + target_resource + input_hash`。`input_hash` 使用规范化后的完整输入、项目范围和 Step 定义计算，不再只依赖用户标题；任一绑定项变化都会产生新的审批请求。`GET /v1/runs/{run_id}/approvals` 返回该 Run 的当前和历史审批，供 Web 与外部 Channel 使用同一状态投影。

## 8. 错误合同

```json
{
  "error": {
    "code": "approval_required",
    "message": "该步骤需要生产审批",
    "retryable": false,
    "details": {
      "session_id": "sess_01J...",
      "run_id": "run_01J...",
      "step_id": "<step-id>"
    },
    "request_id": "req_01J..."
  }
}
```

错误代码稳定，`message` 可本地化。外部超时只能标记为失败或结果未知，不能当作成功。

## 9. Schema 兼容性

- `schema_version` 的 Major 变化允许破坏兼容，必须提供显式迁移。
- 同一 Major 内只能新增可选字段或新的枚举处理分支。
- 消费方遇到未知 Event Type 时应保存并忽略其投影，不应让整个流失效。
- Session、Flow、Run、TaskRecord 和 Event 的稳定合同分别位于 `schemas/orchestration/`；现有 WorkItem Schema 在兼容期内继续有效。
