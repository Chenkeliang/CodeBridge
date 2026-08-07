# WorkItem 与 DSL 引擎规范

## 1. 引擎定位

WorkItem Engine 是 CodeBridge 内的轻量运行时，不是一个通用 BPM 平台。它只保证：

- 任务状态可持久化。
- 动态计划可暂停和恢复。
- 工具调用必须经过能力和权限检查。
- 生产动作必须可审批、可审计、可验证。
- 进程重启后可以从事件恢复。

Agent 可以提出计划，但不能直接改变 WorkItem 状态或绕过审批调用生产写能力。

## 2. DSL 与运行时

```text
Workflow YAML/Markdown
          ↓
      Schema Validator
          ↓
        Plan IR
          ↓
      WorkItem Runtime
          ↓
  Skill / MCP / CLI / HTTP Adapter
```

DSL 是定义和约束；Runtime 是执行和恢复。Workflow 文件不暴露 XState、Temporal 或其他执行引擎的内部格式，以保证未来可替换执行器。

## 3. 第一阶段 DSL 最小语法

只支持以下构造：

```yaml
schema_version: 1
workflow_id: price-change
kind: runbook
inputs:
  - sku
steps:
  - id: resolve_sku
    capability: datamaster.lookup
    mode: read_only

  - id: inspect_rule
    capability: price_rule.query
    mode: read_only

  - id: choose_path
    branches:
      - when: rule_exists == true
        next: update_rule
      - when: rule_exists == false
        next: use_default
      - otherwise: manual_review

  - id: update_rule
    capability: price_rule.update
    mode: production_write
    approval: required

  - id: verify
    capability: price_rule.query
    mode: read_only
```

`when` 只能读取结构化事实，不能执行任意代码。第一阶段不支持用户自定义脚本、无限循环、递归子流程和自动并行调度。

## 4. Plan IR

解析后的 Plan IR 是引擎内部的稳定接口：

```yaml
plan_id: plan_01J...
source: workflow | agent_generated
definition_revision: git:abc123
steps:
  - id: inspect_rule
    capability_id: price_rule.query
    risk: read_only
    depends_on: []
    guard: null
    approval: none
```

Agent 生成的探索计划也必须转换成同一 Plan IR，并标记 `source: agent_generated`。未经 Schema 校验的计划不能执行。

## 5. 事件模型

事件是任务状态的事实来源：

```text
WORK_ITEM_CREATED
MESSAGE_RECEIVED
RUN_CREATED
DISCOVERY_STARTED
PROJECT_CANDIDATE_FOUND
PLAN_PROPOSED
PLAN_VALIDATED
APPROVAL_REQUESTED
APPROVAL_GRANTED
STEP_STARTED
STEP_SUCCEEDED
STEP_FAILED
BRANCH_SELECTED
VERIFICATION_COMPLETED
WORK_ITEM_COMPLETED
```

事件至少包含：

```yaml
event_id: evt_01J...
work_item_id: wi_01J...
run_id: run_01J...
type: STEP_SUCCEEDED
occurred_at: 2026-08-07T10:00:00+08:00
actor: user | agent | system
target: capability_id
input_hash: sha256:...
result_ref: artifact://...
```

聊天消息只是展示层，不作为恢复或审计依据。

## 6. 执行规则

每个 Step 执行前依次检查：

1. WorkItem 是否处于允许该 Step 的状态。
2. Workspace 是否包含目标项目。
3. Capability 是否存在且允许当前环境。
4. 是否满足前置条件和幂等键。
5. 如果是高风险动作，是否有当前 Run 的审批令牌。

执行后必须写入成功或失败事件，并保存必要的输出 Artifact。外部系统超时不能被当成成功。

## 7. 暂停、重试和恢复

- 等待用户输入或审批时，状态为 `awaiting_input` 或 `awaiting_approval`。
- 可重试错误由 Adapter 标注 `retryable: true`，并使用幂等键避免重复写入。
- 不可重试错误进入 `manual_review` 或 `failed`。
- 进程重启时读取最后一个事件，恢复未完成 Run。
- Agent 后端切换时重新生成 ContextSnapshot，不要求恢复原厂商 Session。

## 8. 以后再增加的能力

只有有明确运行数据后，才考虑：

- 分布式 Durable Execution。
- 跨机器 Runner 调度。
- 并行 Step 和补偿事务。
- 复杂定时器和外部信号。

这些能力应接在 Plan IR 后面，不改变用户可读的 Workflow DSL。
