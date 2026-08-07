# Agent 工作台架构基线

状态：Draft baseline

本文定义 CodeBridge 内部扩展的多项目 Agent 工作台。它面向代码调查、业务数据诊断、受控修改、发布计划和发布后观察，不是一个通用 BPM/DAG 平台。

## 1. 架构选择

推荐采用：

```text
WorkItem-centric AgentOps Workbench
= Adaptive Case Management
  + 轻量状态机
  + Git 管理的 Workflow DSL
  + Skill/MCP 能力适配
  + 事件和证据审计
```

不采用 LangGraph、Camunda、Temporal 作为第一阶段的核心依赖。未来如果需要分布式长流程，可以通过稳定的 Plan IR 接入 Durable Workflow Engine，而不用重写业务定义。

## 2. 总体拓扑

```text
Web 工作台                         飞书 / Telegram
（完整对话、Diff、证据、审批）       （消息、状态、快速审批）
          \                             /
           └────────── CodeBridge ─────┘
                    Node/TypeScript
                          │
     ┌────────────────────┼────────────────────┐
     │                    │                    │
 Conversation        WorkItem Engine      Policy/Approval
 渠道与会话路由       任务、计划、状态        风险、审批、审计
                          │
                    Runner Host
              （独立进程、ACP、权限隔离）
                          │
       Pi SDK Adapter / Claude ACP / Codex ACP
                          │
 Git / 项目代码 / Skill / MCP / DB / Logs / APM / DCP
```

### 组件边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| 渠道适配器 | 消息、身份、卡片、流式回传 | 业务流程和生产权限 |
| CodeBridge | 会话、WorkItem、上下文、路由 | 具体业务查询实现 |
| WorkItem Engine | 状态、步骤、暂停、恢复、重试、事件 | 理解业务事实 |
| Agent Adapter | 连接 Pi/Claude/Codex | 统一生产审批 |
| Skill/MCP | 业务知识和真实工具调用 | 跨任务状态管理 |
| Catalog | 项目身份、环境和入口 | 函数级永久依赖图 |
| Git | 代码、Skill、Workflow、Catalog 的版本事实源 | 运行时状态 |

CodeBridge 是物理上的单一主项目。WorkItem、Workflow、Catalog、Policy、Skill Runtime 和 MCP Runtime 是内部模块；现有 Bridge、Runner、ACP Backend 和 Channel 继续复用，不复制第二套。

目标包边界是：

```text
packages/core
packages/work-items
packages/workflow-engine
packages/project-catalog
packages/skill-runtime
packages/mcp-runtime
packages/policy-engine
```

这些包按实际实现需要逐步提取，不要求一次性拆分。ACP 继续由现有 `backends`、`runner-client` 和 `runner-host` 承担，不新增重复的 ACP Runtime。

## 3. 核心对象

```text
Conversation（长期对话）
└── WorkItem（一个明确任务）
    ├── ContextSnapshot
    ├── WorkspaceScope
    ├── WorkflowBinding（可为空）
    ├── Runs
    │   ├── Investigation
    │   ├── Change
    │   ├── Review
    │   ├── Release
    │   └── Observe
    ├── ChangeSet / ReleaseSet
    ├── ApprovalRecords
    └── Evidence / Artifacts
```

Conversation 只代表消息容器。WorkItem 才是目标、项目范围、权限和证据的事实中心。同一个会话可以创建多个 WorkItem，但不能把不同 WorkItem 的上下文自动混合。

### WorkItem 最小字段

```yaml
id: wi_01J...
title: 得到贝退款支持小数的影响评估
status: exploring
mode: investigation
conversation_id: conv_01J...
workflow_id: null
workflow_revision: null
workspace_scope: []
identifiers: {}
context_revision: 1
risk_level: read_only
```

Agent 后端的原生 session ID 只作为连接缓存保存。跨 Pi、Claude、Codex 的恢复依赖标准化的 ContextSnapshot，而不是依赖厂商私有 Session 格式。

## 4. WorkItem 生命周期

```text
created
  ↓
exploring
  ↓
planned
  ↓
awaiting_input / awaiting_approval
  ↓
executing
  ↓
verifying
  ↓
completed / failed / cancelled
```

新任务可以没有 Workflow。Agent 在 `exploring` 阶段生成临时 Plan；Plan 通过 DSL Schema 校验后才能进入执行。发现未知分支时进入 `manual_review`，不能由模型猜测执行。

## 5. 多项目发现和注册

不维护一张假设永远正确的全局依赖图。维护轻量项目 Catalog，并由异步 Discovery Task 自动提出候选：

```text
WorkItem 执行
  → 发现 cwd、Git remote、import、HTTP URL、DCP 服务、SLS LogStore
  → ProjectDiscovered 事件
  → Candidate Builder 去重、补全、打置信度
  → Web/飞书/Telegram 提示
  → 用户确认后生成 Catalog Diff
  → Git Review/提交
```

候选字段必须带证据：

```yaml
project_id: equity-center
repo: gitlab.luojilab.com/rock/equity-center
deploy_service: rock/equity-center
log_service: equity-center
sources:
  - kind: current_cwd
    observed_at: 2026-08-07T10:00:00+08:00
  - kind: dcp_service
    observed_at: 2026-08-07T10:01:00+08:00
confidence: high
status: candidate
```

发现结果先可以临时加入当前 WorkItem；正式写入 Catalog 默认需要确认。字段变化时标记 `stale`，提示更新，不静默覆盖。

## 6. Workflow、DSL、Skill、MCP

```text
Workflow Guide = 用户选择的工作参考，允许自由探索
Runbook        = 稳定且有副作用的受控步骤
DSL            = Guide/Runbook 的机器可校验表达
Skill          = 某个领域或系统的可复用知识和操作合同
MCP            = 可被调用的外部工具/资源协议
```

一个 Skill 对应一个清晰的系统或领域，例如 `equity-center`、`datamaster`、`dcp`；不要为每一个自然语言任务都新建 Skill。

Workflow 只引用能力 ID，不写绝对路径和供应商 SDK：

```yaml
step:
  capability: price_rule.query
  mode: read_only
```

运行时将能力 ID 绑定到当前机器上的 Skill、MCP、CLI 或 HTTP Adapter。

## 7. 运行和审批

所有任务遵循统一外壳：

```text
Understand → Discover → Plan → Approve → Act → Verify → Record
```

权限模式不是常驻 Worker，而是 Run Profile：

| Run | 默认能力 |
|---|---|
| Investigation | 代码、DB、Logs、APM 只读 |
| Change | Workspace 写入、本地测试 |
| Review | Git diff、测试结果只读 |
| Release | 发布计划和状态只读 |
| Release Execute | 需要审批令牌 |
| Observe | 发布后 Logs/APM/Metrics 只读 |

每次工具调用都记录输入、目标环境、结果、耗时、审批和关联 Artifact。生产写入必须可预览、可确认、可验证、可回滚。

## 8. 部署和移植

第一阶段是模块化单体：

```text
CodeBridge Gateway + WorkItem Engine + SQLite
                         │
                   Runner Host 进程
```

核心层保持纯 TypeScript；macOS TCC、Windows 权限、Linux 进程和凭据放在 Host Adapter。Pi SDK Adapter 放进 Node Runner，不额外增加一个 Pi 服务。

持久化分工：

- Git：Workflow、Skill Manifest、Catalog、Agent Profile。
- SQLite：Conversation、WorkItem、Run、Step、Approval、Event。
- 文件/对象目录：Diff、日志快照、测试报告、上下文包。

Workflow 文件先经过 Schema/Plan IR，再由当前执行器运行。未来替换为 Temporal 或其他 Durable Engine 时，保持 DSL 和 Plan IR 不变。

## 9. 未来边界

只有出现以下证据才增加重型引擎：大量跨机器长任务、复杂定时器、分布式重试、多实例 Runner 或高并发发布。否则继续使用本地 WorkItem Runtime，避免把 Agent 对话变成固定业务流程平台。
