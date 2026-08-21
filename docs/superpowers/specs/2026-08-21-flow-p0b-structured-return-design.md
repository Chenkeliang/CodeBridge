# Flow P0B 三表面结构化回流设计

**Status:** Accepted for P0B planning

**Date:** 2026-08-21

**Product source:** [2026-08-20-flow-three-channel-v1-final-alignment.md](./2026-08-20-flow-three-channel-v1-final-alignment.md)

## 1. 目标

P0B 补齐一次 Runbook Run 从 Runtime 领域事件返回 Web、飞书和 Telegram 的结构化反馈，使三端都能看到步骤、验证、产物、审批等待和最终 Run snapshot。

Web 同时补齐当前活跃 Timeline 中的 Runtime Step Approval 闭环；飞书和 Telegram 在 P0B 只读展示审批状态，不新增通道审批写操作。

## 2. 当前事实

- Runtime 已产生 `STEP_STARTED`、`STEP_SUCCEEDED`、`STEP_FAILED`、`STEP_RETRYING`、`STEP_SKIPPED`、`ARTIFACT_CREATED`、`VERIFICATION_FAILED`、`RUN_SNAPSHOT`、`APPROVAL_REQUESTED`、`APPROVAL_GRANTED` 和 `APPROVAL_REJECTED`。
- Bridge 已有 Runtime approval 查询、批准和拒绝 API：`GET /v1/runs/:run_id/approvals`、`POST /v1/runs/:run_id/approve`、`POST /v1/runs/:run_id/reject`。
- Session projector 已把 `APPROVAL_REQUESTED` 写成 Timeline `approval` block，但 `APPROVAL_GRANTED/REJECTED` 仍是 no-op。
- 当前 Workbench 使用 `SessionTimeline`；旧 `ProjectionItem/ApprovalCard` 没有挂载到生产入口，不能算 reachable。
- 飞书和 Telegram watcher 主要消费 `AGENT_EVENT`、`STEP_FAILED` 和 Run 终态，没有完整投影 Flow 事件。
- Session events SSE 使用 `run_id`、`occurred_at`、`result_ref`，但当前 Channel Ingress 测试伪造 camelCase，生产解析器按 `runId` 读取并丢弃 `result_ref`。P0B 必须先修复这一真实传输合同，否则 watcher 的结构化回流没有可靠输入。

## 3. 产品边界

### 3.1 P0B 包含

- 一个通道无关的 Flow 结构化事件投影器；
- 飞书现有单卡片中的紧凑 Flow 进度和最终摘要；
- Telegram 现有单消息中的紧凑 Flow 进度和最终摘要；
- Web 活跃 Timeline 的 Runtime approval 卡片、批准/拒绝动作和终态闭合；
- 飞书/Telegram 对 Runtime approval 的只读等待、通过和拒绝状态；
- 断线重放、重复事件和重复渲染的幂等验证。

### 3.2 P0B 不包含

- Flow Definition Review；
- 新增或修改 approval 写 API；
- 飞书/Telegram 内批准或拒绝 Runtime step approval；
- 把通道 `/approve` 改造成新的 Flow 命令；
- Flow 列表、选取、补参和确认卡；这些仍属于 P1 Channel UI；
- 自由 Guide 编辑、DAG 或自动推荐。

## 4. 统一事件投影

先统一 Channel event DTO：Ingress 必须把 SSE 的 `run_id`、`occurred_at`、`result_ref` 显式映射为 `ChannelSessionEvent.runId/occurredAt/resultRef`。测试必须使用生产 SSE 的 snake_case；禁止通过 camelCase fixture 掩盖转换缺口。

新增纯投影器 `ChannelFlowProjector`，输入只接受 Bridge 转发的 `ChannelSessionEvent`，不查询 Catalog，不执行 Flow policy，也不写业务状态。

投影状态至少包含：

```ts
type ChannelFlowProjection = {
  flowId: string | null;
  flowRevision: string | null;
  steps: Array<{
    stepId: string;
    capabilityId: string | null;
    status: "running" | "retrying" | "passed" | "failed" | "skipped";
    error: string | null;
    outputRef: string | null;
    verificationStatus: string | null;
  }>;
  artifacts: Array<{
    artifactId: string;
    stepId: string | null;
    name: string;
    mimeType: string | null;
    resultRef: string | null;
  }>;
  approvals: Array<{
    approvalId: string;
    stepId: string;
    capabilityId: string | null;
    status: "requested" | "granted" | "rejected" | "expired";
    expiresAt: string | null;
  }>;
  verificationFailure: {
    stepId: string;
    category: string;
    postcondition: string | null;
  } | null;
  outcome: "succeeded" | "failed" | null;
};
```

规则：

- 按 `runId + event.sequence` 重放时结果确定；重复消费同一语义事件不得重复增加步骤或产物；
- Step 使用 `stepId` upsert；Artifact 使用 `artifactId` upsert；Approval 使用 `approvalId` upsert；
- `RUN_SNAPSHOT` 是最终结构化证据，补齐 Flow/revision、每步 output ref 和 verification status，但不抹掉已知错误；
- 投影器只生成结构化 snapshot 和紧凑文本，不发送消息、不调用审批 API。

Agent 流式文本继续由现有 `ChannelStreamProjector` 管理。Flow 投影作为独立 section 与 Agent 文本合成，避免在 Agent presenter 中复制 Runtime 状态机。

## 5. Web Runtime Approval 闭环

### 5.1 Timeline 投影

`APPROVAL_REQUESTED` 必须生成可稳定定位的 approval block，metadata 至少保存：

```json
{
  "approval_id": "approval_123",
  "step_id": "deploy",
  "capability_id": "deploy.production",
  "environment": "production",
  "target_resource": "service/demo",
  "expires_at": "2026-08-21T12:00:00.000Z"
}
```

`APPROVAL_GRANTED` 和 `APPROVAL_REJECTED` 更新同一 block：

- `requested` → Timeline status `waiting`；
- `granted` → Timeline status `granted`；
- `rejected` → Timeline status `rejected`。

新 block key 使用 `approval_id`。为了兼容部署前已经投影的 pending block，结果事件更新时允许按旧 key `approval:${event.target}` 回退查找；不做破坏性 Timeline 数据迁移。

### 5.2 活跃 Web 渲染

审批卡直接挂载在当前生产使用的 `SessionTimeline`，不能依赖未挂载的旧 `ProjectionItem`。

等待态展示：

- “Runtime 步骤需要审批”；
- step、capability、environment、target resource 和过期时间；
- “允许一次”和“拒绝并停止”两个动作；
- 提交期间禁用重复点击。

终态展示：

- granted：已批准，Run 正在继续或已经完成；
- rejected：已拒绝，Run 已停止；
- expired：审批已过期，提示重新发起 Run 或取消当前 Run，不再显示可操作按钮；
- API 返回 404/409：不猜测状态，刷新 Session，并通过现有 `GET /v1/runs/:run_id/approvals` 查询当前 approval record。若服务端状态为 `expired`，以只读 UI override 显示过期；Timeline 持久化 block 仍等待未来正式领域事件，不伪造 `GRANTED/REJECTED`。不得自动重试、自动批准或切换到 Agent permission。

### 5.3 写路径

Web 只调用现有 `api.approve(runId, approvalId)` 或 `api.reject(runId, approvalId)`。P0B 不新增 approval endpoint，不直接写 SQLite，不在 React 中实现 ApprovalService 规则。

成功响应后立即刷新 Session snapshot；正常情况下 SSE 中的 `APPROVAL_GRANTED/REJECTED` 会把卡片推进终态，refresh 作为丢事件/重连时的恢复保障。

## 6. 飞书和 Telegram 展示

两个通道都使用同一 `ChannelFlowProjector`，只负责适配 Markdown 长度、卡片或消息更新频率。

### 6.1 运行中

现有单卡片/单消息增加紧凑 section：

```text
Flow 进度 · 2 / 4
✓ 读取配置
● 发布服务（执行中）
```

不得为每个 Step 单独发送消息。更新必须走现有合并写/编辑机制，避免速率限制和消息刷屏。

### 6.2 审批

`APPROVAL_REQUESTED`：

```text
⏸ Flow 等待步骤审批
步骤：deploy
能力：deploy.production
请在 Web 打开当前 Session 完成审批。
```

`APPROVAL_GRANTED/REJECTED` 更新原卡片或原消息为已通过/已拒绝。P0B 不提供通道按钮，也不改变通道命令的写语义。

### 6.3 终态

`RUN_SNAPSHOT` 与 Run 终态合成最终摘要：Flow/revision、通过步骤数、验证失败、Artifact 名称和 ref。Agent final text 若存在继续保留，结构化摘要放在独立 section，不互相覆盖。

## 7. 恢复和幂等

- watcher 只有在投影和表面更新成功后推进 sequence cursor；
- 断线重连按旧 cursor 重放时，同一 Step/Artifact/Approval 不重复；
- 飞书 delivery recovery 和 Telegram delivering recovery 必须重建 Agent projector 与 Flow projector；
- 终态只有在最终卡片/消息成功更新后才 complete delivery；
- 表面更新失败不改变 Runtime Run、approval 或 Catalog 状态。

## 8. Surface Matrix（P0B 规划门禁）

| Surface | entry | read path | write path | event consumption | error/recovery | terminal feedback | planned 落点 | 当前四态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Session Timeline approval block | Session snapshot + approval metadata | 现有 approve/reject API | REQUESTED/GRANTED/REJECTED | API 错误 + Session refresh + SSE 重连 | approval 终态 + Run 终态 | P0B Task 3–4 | implemented，未 reachable/closed-loop；planned: Task 3–4 |
| Agent | Agent event stream | `AGENT_EVENT` | 既有 Runner permission path | 不消费 Runtime approval 写动作 | 维持现状 | 维持现状 | P0B 明确非目标 | implemented；本计划不声称 Runtime approval 闭环 |
| 飞书 | 当前 Run 卡片 | Channel events | P0B 无 approval 写路径 | Flow events + approval 三态 | sequence replay + delivery recovery | 原卡片结构化摘要 | P0B Task 1–2、5 | 部分 implemented，未 closed-loop；planned: Task 1–2、5 |
| Telegram | 当前 Run 消息 | Channel events | P0B 无 approval 写路径 | Flow events + approval 三态 | sequence replay + delivery recovery | 原消息结构化摘要 | P0B Task 1–2、6 | 部分 implemented，未 closed-loop；planned: Task 1–2、6 |

跨表面依赖：飞书/Telegram 的“前往 Web”提示只有在 Web Task 3–4 同阶段完成后才能上线；不得先合并悬空提示。

## 9. 验收

- Web 当前 Workbench 能看到并操作 Runtime approval，批准/拒绝后卡片进入终态；
- 已过期 approval 能通过现有查询 API 显示为只读 expired，不会永久伪装成仍可审批；
- 飞书/Telegram 能看到等待、通过、拒绝状态，但不能在 P0B 内操作审批；
- Step、verification、artifact、snapshot 在两通道中来自同一共享投影；
- Agent final text 与结构化 Flow 摘要均保留且不重复；
- watcher 重放不会产生重复步骤、产物或审批提示；
- 合同层测试和三个活跃表面层测试均通过。
