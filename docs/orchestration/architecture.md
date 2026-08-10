# Agent 工作台架构基线

状态：Session-first 规范。CodeBridge 当前的 WorkItem/Run 实现仍作为后台执行记录和兼容 API 保留；新的 Web 交互、目录和对象模型以 Agent 分组下的 Session 为主。

本文定义 CodeBridge 内部扩展的多项目 Agent 工作台。它面向自然语言驱动的代码、配置、数据和受控操作；用户从 Session 开始，运行时动态补充模式、项目范围和 Flow。

## 1. 架构选择

推荐采用：

```text
Session-first Agent Workbench
= Agent Registry + Session Catalog
  + Folder / Workspace Catalog
  + 可选 Flow / Workflow
  + 轻量 Run Runtime
  + Skill/MCP 能力适配
  + 事件和证据审计
```

第一阶段采用轻量 Session/Run Runtime；当前已将编译后的 Plan IR 持久化并按依赖、分支和审批驱动执行。未来如果出现跨机器长任务、复杂定时器或分布式重试，再把同一 Plan IR 接入 Durable Workflow Engine，保持用户可读的 Flow/Workflow 定义不变。

## 2. 总体拓扑

```text
Web 工作台                         飞书 / Telegram
（会话、目录、Flow、证据、审批）     （消息、状态、快速审批）
          \                             /
           └────────── CodeBridge ─────┘
                    Node/TypeScript
                          │
     ┌────────────────────┼────────────────────┐
     │                    │                    │
 Agent Registry      Session Catalog       Flow Catalog
 Agent Profile       Session / Message     临时 Flow / Workflow
     │                    │                    │
     └────────────────────┼────────────────────┘
                          │
                    Run Runtime
              计划、状态、暂停、恢复、事件
                          │
                    Policy / Approval
                          │
                    Runner Host
              （独立进程、权限和目录隔离）
                          │
       Pi SDK / Cursor ACP / Claude ACP / Codex Adapter
                          │
       Skill / MCP / CLI / HTTP / Git / 项目和外部系统
```

### 组件边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| 渠道适配器 | 消息、身份、卡片、流式回传 | Agent 之间的委派和业务流程 |
| Agent Registry | Agent Profile、适配器、健康状态、模型和能力 | 某次会话的历史 |
| Session Catalog | Agent Session、目录、历史、恢复、分支和关闭 | Workflow 定义 |
| Flow / Workflow Catalog | 临时 Flow、候选 Flow、正式 Workflow 的版本 | 当前执行状态和权限授予 |
| CodeBridge | 会话、目录、Flow 关联、路由、事件投影 | 具体业务事实和工具实现 |
| Run Runtime | 一次执行的计划、状态、暂停、恢复、重试和事件 | 理解业务事实 |
| Policy / Approval | 风险、权限、审批、审计 | Agent 推理和工具实现 |
| Skill / MCP | 领域知识、外部资源和真实工具调用 | 跨会话状态管理 |
| Folder / Project Catalog | 目录、Git 身份、项目候选和证据 | 函数级永久依赖图 |
| Git | CodeBridge 定义、Skill Manifest、Workflow 和 Catalog 版本 | 运行时 Session、Run 和事件状态 |

CodeBridge 是物理上的单一主项目。Agent Registry、Session Catalog、Flow Catalog、Run Runtime、Policy、Skill Runtime 和 MCP Runtime 是内部模块；现有 Bridge、Runner、ACP Backend 和 Channel 继续复用，不复制第二套运行时。

目标包边界是：

```text
packages/core
packages/agent-registry
packages/session-catalog
packages/flow-catalog
packages/run-runtime
packages/project-catalog
packages/policy
packages/skill-runtime
packages/mcp-runtime
apps/bridge (Web、Discovery、API 装配)
```

现有 `packages/work-items`、`workflow-engine`、`run-executor` 继续作为内部实现包；对外合同使用 Session、Flow、Run 和 TaskRecord，存储迁移通过兼容适配完成。

## 3. 页面导航与对象层级

页面必须严格表达以下层级：

```text
Agents
  A Agent
    session3
  B Agent
    session1
    session2

Flows
  flow1
  flow2
```

其中：

- Agent Profile 是可用 Agent 的注册分组。Codex、Pi、Cursor、Claude Code 和其他 ACP/SDK/CLI Agent 都是一等 Profile。
- Session 是用户可见的会话窗口，固定属于一个 Agent Profile；点击 Agent 下的“新建会话”才能创建 Session。
- 页面不同时展示 `Conversation` 和 `Agent Session` 两个并列概念。内部可以保存厂商原生 `provider_session_id`，用户界面统一称为 Session。
- Flows 与 Agents 平级。Flow 不是 Agent 的子节点，也不是 Session 的子节点。
- 右侧主面板的 Flow 选择器只为当前 Session 的下一次 Run 建立关联；切换 Flow 不改变 Session 历史。
- 每个 Session 固定绑定一个 Agent；需要使用另一个 Agent 时，从左侧对应分组打开独立 Session。跨 Session 的资料通过显式上下文、目录和产物引用传递。

## 4. 核心对象

```text
AgentProfile
  └── AgentSession
        ├── Message
        ├── Run
        │     ├── FlowBinding（可为空）
        │     ├── Plan IR
        │     ├── Approval
        │     └── Evidence / Artifact
        └── ContextSnapshot

FlowCatalog
  ├── ephemeral Flow（当前 Session 临时生成）
  ├── candidate Workflow（待审核）
  └── published Workflow（Git 版本化）
```

`TaskRecord` 是后台可选的执行索引。当前代码中的 `WorkItem` 就是这个索引的兼容实现，不是新的页面层级：

```text
TaskRecord / WorkItem
  ├── session_id
  ├── run_id
  ├── status
  ├── approvals
  └── evidence
```

普通聊天可以没有 TaskRecord；跨项目、异步、审批、证据或恢复需求出现时，Run Runtime 才创建或补充它。

### Agent Profile 最小字段

```yaml
agent_id: <stable-id>
display_name: <display-name>
adapter: sdk | acp | cli
status: healthy | unavailable | needs_setup
capabilities: []
models: []
session_features: []
```

Profile 不保存具体 Session 历史，也不通过固定枚举强行限制模型。模型和 Session 能力由适配器动态报告。

### Agent Session 最小字段

```yaml
session_id: <stable-id>
agent_id: <agent-id>
provider_session_id: <opaque-provider-id>
cwd: <canonical-directory>
additional_directories: []
title: <generated-title>
status: active | idle | closed | unavailable
last_seen: <rfc3339>
```

### Flow / Workflow 最小字段

```yaml
flow_id: <stable-id>
kind: ephemeral | guide | runbook
status: draft | candidate | published | deprecated
source: agent_generated | user_selected | git
definition_revision: <content-or-git-revision>
steps: []
```

临时 Flow 可以只存在于当前 Session 的事件流中；正式 Workflow 必须有稳定 ID、版本和 Schema 校验结果。

## 5. Flow 的生成、选择和执行

```text
用户输入自然语言
  ↓
Agent 判断上下文、风险和目录
  ↓
生成当前 Session 的 ephemeral Flow/Plan
  ↓
展示步骤、分支、待确认项
  ↓
Policy / Schema 校验
  ↓
Run 执行并记录事件
  ↓
用户可选“保存为 Workflow”
```

右侧选择已有 Workflow 时，服务端在 Run 创建时固定 `definition_revision`。没有选择时，系统仍可以生成临时 Flow，但不把它自动写入正式 Workflow Catalog。

`guide` 只提供参考；`runbook` 才允许进入结构化步骤、能力权限和审批。任何 Flow 都不能绕过 Policy，也不能因为由 Agent 生成就获得生产写权限。

## 6. 多项目发现和注册

Project Catalog 以运行时证据和异步 Discovery Candidate 为事实来源，持续提示目录、Git 和外部服务之间的关联变化：

```text
Session / Run 发现目录或外部资源
  → ProjectDiscovered 事件
  → Candidate Builder 去重、补全和打置信度
  → 在当前 Session 右侧显示候选
  → 用户确认后生成 Catalog Diff
  → Git Review/提交
```

候选字段必须带证据：

```yaml
project_id: <stable-id>
repo: <git-remote>
service: <service-id>
sources:
  - kind: current_cwd | git_remote | runtime_reference
    observed_at: <rfc3339>
confidence: high | medium | low
status: candidate
```

发现结果先只作为当前 Session 的临时上下文；正式写入 Catalog 默认需要确认。字段变化时提示更新，不静默覆盖；Catalog Store 保留候选和正式项目两张表。

## 7. Skill、MCP 和 Workflow 的层级

```text
Agent Profile / Session
          ↓
Run → Flow / Workflow → Capability ID
                         ├── Skill
                         ├── MCP
                         ├── CLI
                         └── HTTP
```

- Skill 是可复用的领域或系统能力，保持标准 `SKILL.md` 结构，不为每个自然语言问题新建 Skill。
- MCP 是工具/资源连接协议。
- Workflow 只声明能力 ID、顺序、分支、风险和审批，不关心能力由 Skill、MCP、CLI 还是 HTTP 实现。
- Agent Profile 决定可用的 Adapter 和能力集合；Session 继承 Profile 能力，但不能自行提升权限。

## 8. 运行、审批和恢复

所有 Run 遵循统一外壳：

```text
Understand → Discover → Plan/Flow → Approve → Act → Verify → Record
```

每次工具调用都记录输入、目标环境、结果、耗时、审批和关联 Artifact。生产写入必须可预览、可确认、可验证、可回滚。

Run Runtime 负责：

- `queued / running / waiting / succeeded / failed / cancelled` 状态；
- 事件持久化和断线恢复；
- 幂等键和重试；
- 将后台 TaskRecord/WorkItem 投影到 Web、飞书和 Telegram。

## 9. 部署和移植

当前 v1 是模块化单体：

```text
CodeBridge Gateway + Session/Run Runtime + SQLite
                                  │
                            Runner Host 进程
```

核心层保持纯 TypeScript；macOS TCC、Windows 权限、Linux 进程和凭据放在 Host Adapter。Pi SDK Adapter 放进 Node Runner，不额外增加一个 Pi 服务。

持久化分工：

- Git：Workflow、Skill Manifest、Catalog、Agent Profile。
- SQLite：Session、Message、Run、TaskRecord、Approval、Event。
- 文件/对象目录：Diff、日志快照、测试报告、上下文包。

Workflow 文件先经过 Schema/Plan IR，再由当前执行器运行。未来替换为 Temporal 或其他 Durable Engine 时，保持 Flow/Workflow DSL、Plan IR 和事件合同不变。

## 10. 未来边界

只有出现大量跨机器长任务、复杂定时器、分布式重试、多实例 Runner 或高并发发布等证据，才增加重型引擎。否则继续使用本地 Session/Run Runtime，避免把 Agent 对话变成固定业务流程平台。
