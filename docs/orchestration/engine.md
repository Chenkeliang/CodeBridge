# Flow、Run 与 DSL 引擎规范

## 1. 引擎定位

CodeBridge 使用轻量 Flow/Run Runtime：

- Flow 描述可参考或可受控执行的步骤。
- Run 描述一次执行尝试及其状态。
- Event Store 保存恢复和审计所需的事实。
- TaskRecord（当前代码中的 WorkItem）在 Run 需要异步、审批、证据或恢复时提供持久化索引。

Agent 可以提出 Flow 和 Plan，但状态迁移、能力调用和审批都由 Runtime 控制。

## 2. Flow、Plan IR 与运行时

```text
用户目标 / Agent 输出
          ↓
   ephemeral Flow / Plan
          ↓
      Schema Validator
          ↓
        Plan IR
          ↓
           Run
          ↓
  Skill / MCP / CLI / HTTP Adapter
```

Flow 是用户可读定义，Plan IR 是执行器稳定接口，Run 是一次执行状态。Flow 文件不暴露 XState、Temporal 或其他执行引擎的内部格式，执行器可以替换而不改变用户定义。

## 3. Flow 生命周期

```text
ephemeral
   ↓ 用户要求保存或系统发现重复价值
candidate
   ↓ Schema / Eval / Review / Git
published
   ↓ 规则过期或被新版本替代
deprecated
```

- `ephemeral` 只绑定当前 Session/Run，随事件流保存，适合未知工作和临时分支。
- `candidate` 是待审核的可复用草案。
- `published` 是可被多个 Agent Session 选择的 Git 版本化 Workflow。
- `deprecated` 保留历史版本，新的 Run 不再默认选择。

Candidate 的 Review 由 `POST /v1/flows/{flow_id}/review` 完成。批准时必须提供已审核定义对应的 `git_revision`；服务端才会把状态切换为 `published`，并将 `definition_revision` 固定为 `git:<revision>`。拒绝只保留 Candidate 及其 `review_status`，不会覆盖已有正式 Workflow。

## 4. 第一阶段 DSL 最小语法

字段形状如下；具体业务流程由用户输入、受控目录或审核后的 Candidate 提供：

```yaml
schema_version: 1
workflow_id: <stable-id>
kind: guide | runbook
status: draft | published | deprecated
inputs: [<declared-input>]
steps:
  - id: <step-id>
    capability: <capability-id>
    mode: read_only | workspace_write | git_write | production_write | manual
    depends_on: [<step-id>]
    approval: none | required
    branches:
      - when: <structured-fact>
        next: <step-id>
```

`when` 只读取结构化事实，不能执行任意代码。第一阶段支持顺序步骤、显式依赖、有限分支和人工暂停；并行、循环、补偿和定时器等能力由运行数据证明需要后再增加。

## 5. Plan IR

解析后的 Plan IR 是引擎内部稳定接口：

```yaml
plan_id: plan_01J...
source: workflow | agent_generated
definition_revision: git:<revision-or-content-hash>
session_id: sess_01J...
run_id: run_01J...
steps:
  - id: <step-id>
    capability_id: <capability-id>
    risk: read_only
    depends_on: []
    guard: null
    approval: none
```

Agent 生成的临时 Flow 也必须转换成同一 Plan IR，并标记 `source: agent_generated`。未经 Schema 和 Policy 校验的计划不能执行。

## 6. 事件模型

事件是 Session/Run 状态的事实来源：

```text
SESSION_CREATED
MESSAGE_RECEIVED
FLOW_PROPOSED
FLOW_SELECTED
FLOW_SAVED_AS_CANDIDATE
RUN_CREATED
RUN_STARTED
DISCOVERY_STARTED
PROJECT_CANDIDATE_FOUND
PLAN_VALIDATED
APPROVAL_REQUESTED
APPROVAL_GRANTED
APPROVAL_REJECTED
STEP_STARTED
STEP_SUCCEEDED
STEP_SKIPPED
STEP_FAILED
BRANCH_SELECTED
VERIFICATION_COMPLETED
RUN_SUCCEEDED
RUN_FAILED
TASK_RECORD_CREATED
```

兼容现有 WorkItem Event 时，`WORK_ITEM_CREATED` 和 `WORK_ITEM_COMPLETED` 继续可读；新投影统一解释为 TaskRecord 生命周期事件。

事件至少包含：

```yaml
event_id: evt_01J...
session_id: sess_01J...
task_record_id: null
run_id: run_01J...
type: STEP_SUCCEEDED
occurred_at: <rfc3339>
actor: user | agent | system | adapter | channel
target: <capability-id-or-step-id>
input_hash: sha256:<hash>
result_ref: artifact://<id>
```

聊天消息是展示层；事件、Plan IR 和 Artifact 是恢复与审计依据。

## 7. 执行规则

每个 Step 执行前依次检查：

1. 当前 Run 是否处于允许该 Step 的状态。
2. Session 的 Folder 是否包含目标目录。
3. Capability 是否存在且允许当前 Agent、环境和风险级别。
4. 是否满足前置条件和幂等键。
5. 高风险动作是否拥有当前 Run 的审批令牌。

执行后必须写入成功或失败事件，并保存必要的输出 Artifact。外部系统超时会进入失败或结果未知状态。

## 8. 暂停、重试和恢复

- 等待用户输入或审批时，Run 状态为 `waiting`，事件中标明等待原因。
- 可重试错误由 Adapter 标注 `retryable: true`，并使用幂等键避免重复副作用。
- 不可重试错误进入 `manual_review` 或 `failed`，由用户在原 Session 继续处理。
- 进程重启时读取最后一个事件，恢复未完成 Run。
- Agent 原生 Session 可以 resume/fork；跨 Agent 继续时使用 ContextSnapshot、Folder 和 Artifact 恢复，不假设厂商 Session 可互换。

## 9. 以后再增加的能力

只有有明确运行数据后，才考虑：

- 分布式 Durable Execution。
- 跨机器 Runner 调度。
- 并行 Step 和补偿事务。
- 复杂定时器和外部信号。

这些能力接在 Plan IR 和 Run Runtime 后面，保持 Session、Flow、Run、Event 合同稳定。
