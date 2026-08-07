# 多 Agent 运行时调研与 CodeBridge 取舍

这份记录用于校准架构，不是生产配置，也不包含可运行的业务流程示例。结论来自 2026-08-07 对公开仓库源码和文档的阅读；其中 [xintaofei/codeg](https://github.com/xintaofei/codeg) 是与 CodeBridge 目标最接近的主参考。

## 1. 开源项目采用的对象关系

| 项目 | Agent 如何协作 | 会话/状态如何保存 | 对 CodeBridge 的启发 |
|---|---|---|---|
| [OpenHands Agent Canvas](https://github.com/All-Hands-AI/OpenHands) | Agent Server 是统一入口，前端可以切换多个本地、远程或云端 backend；自动化由独立 Automation Server 触发 | Conversation 是前端主对象，Agent Server 负责运行时和事件；工作目录由 backend/sandbox 提供 | Agent 是可替换的运行时 backend，不应把每个 Agent 写成 WorkItem 类型 |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | 一个 starting agent 通过 handoff 或 agents-as-tools 委派；委派发生在一次 Run 内 | Session 负责跨 Run 的对话历史，Tracing 负责运行观测；handoff 不等于新的顶层任务 | 多 Agent 协作是 Run 内部关系，顶层仍是一条对话/目标，不需要给每个 Agent 建顶层 WorkItem |
| [AutoGen](https://github.com/microsoft/autogen) / Microsoft Agent Framework | Team/GroupChat Manager 通过消息和 topic 路由多个 participant；Team 也可以作为另一个 Team 的 participant | Runtime 管理 topic、participant 和 Team state，支持 `save_state`/`load_state` | 需要一个明确的 Agent Registry 和运行时事件/消息边界，不能让 Agent 之间任意直连 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Crew 提供角色协作，Flow 提供事件、状态、分支和路由；可用 manager 进行委派和校验 | Flow state、checkpoint、tracing 与任务输出分开管理 | Workflow/Flow 是可选控制层；不能把所有自然语言输入都强制转换成固定流程 |
| [Pi coding agent](https://github.com/earendil-works/pi) | Pi 本身是单个 coding-agent runtime，默认不内置 sub-agent；扩展或上层系统负责组合 | `AgentSession` 统一 interactive/print/RPC；JSONL session 按工作目录保存，支持 resume、fork、clone、tree 分支 | Pi 应作为一个 Agent Adapter；`AgentSession` 是一等会话，不应只当作 ACP session 的别名 |
| [Codeg](https://github.com/xintaofei/codeg) | 提供 Agent Registry、按 Agent 聚合会话、目录管理和独立任务板；CodeBridge 采用其会话主界面和资源分组思路 | `Folder` 管理项目目录，`Conversation` 聚合 Agent 历史，`WorkTask` 是可选的目录绑定任务板；数据库持久化会话、工作目录、状态和事件 | 左侧使用 `Agent → Session`，`Flows` 与 `Agents` 平级；Flow 通过右侧主面板关联当前 Run，TaskRecord 保留后台执行状态 |

## 1.1 Codeg 的关键对象

Codeg 的源码把几个容易混淆的概念拆开了：

```text
Folder（项目目录/工作区）
└── Conversation（Agent 会话，按 agent_type 聚合）
    ├── regular / chat（用户直接会话）
    └── session history / branch（会话历史和分支）

WorkTask（可选任务板条目）
└── folder_id + config + status + worktree + conversation_id
```

- `Conversation` 是用户日常操作的主对象：可搜索、导入、恢复、分支、分屏和跨 Agent 聚合。
- `Folder` 是显式目录资源，负责主目录、Git 分支和 worktree 关系；不是 WorkItem 的自由文本字段。
- `WorkTask` 是需要队列、并发、worktree、Review/Merge、重试和事件的工程任务，与普通聊天会话并列共存。
- Agent Registry 同时列出内置 Agent（包含 Codex、Pi、Cursor）和用户注册的 ACP Agent；安装、诊断、能力和版本都是 Registry 的职责。

## 2. CodeBridge 的对象定位

CodeBridge 的用户导航和运行时对象采用以下关系：

```text
Agent Profile
  └── Session（固定绑定一个 Agent）
        └── Run（一次执行尝试）
              └── Flow Binding（可为空）

Flow Catalog（与 Agents 平级）
  ├── ephemeral Flow
  ├── candidate Workflow
  └── published Workflow

TaskRecord / WorkItem（后台可选执行索引）
  └── 关联 Session、Run、Approval、Evidence
```

几个边界必须保持：

- Agent Profile 是注册和能力描述；Session 是该 Agent 的具体会话。
- Session 页面只显示在所属 Agent 分组下；用户通过另一个 Agent 分组打开新的 Session。
- Flow 是可复用或临时的步骤定义；同一个 Flow 可以被多个 Agent 的多个 Session 使用。
- Run 固定本次使用的 Flow revision，记录实际执行、分支和结果。
- TaskRecord/WorkItem 只在异步、审批、证据或恢复需求出现时建立，不承担 Session 或 Flow 的页面层级。

## 3. Pi / Cursor 在 Web 中应如何管理

Web 不应把“工作模式”“项目范围”做成必填表单，但需要提供可选的运行时上下文：

1. `Agent`：从 Agent Registry 读取 Codex、Pi、Cursor、Claude Code 等 Profile，显示健康状态、模型和 Session 能力。
2. `Session`：按 `agent_id + cwd + additional_directories` 查询和恢复本机 Session；支持新建、继续、分支/复制、关闭和删除。Pi 使用自己的 JSONL Session API，ACP Agent 使用各自的 session/list 与 session/load 能力。
3. `Workspace`：用户通过目录选择器、资源引用或加号添加目录。Bridge 保存 canonical path 和授权状态，再把目录作为 Session context。
4. `Flow`：查询 Flow Catalog；右侧主面板选择 Flow 并绑定到下一次 Run。没有选择时，Agent 生成当前 Session 的 ephemeral Flow。
5. `TaskRecord`：当 Run 需要异步、审批、证据或恢复时，由 Runtime 自动创建后台记录；用户可在 Tasks 视图中查看，但不需要先创建它。

当前 CodeBridge 已有 Runner 的 session/list、session close/delete、目录授权和 ACP additionalDirectories 能力，也有 Channel 侧 `/resume`、`/cd`、`/root`、`/backend` 逻辑；缺口是把这些能力通过统一 Web Session API 暴露，并建立 Pi SDK Adapter。当前配置和 Runner 只注册 Cursor、Claude、Codex，尚未真正注册或执行 Pi，这也是 Web 中看不到 Pi 的直接原因。

## 4. 对 CodeBridge 的落地结论

CodeBridge 保持模块化单体，页面和 API 采用：

```text
Agents
  Agent Profile
    Session

Flows（平级资源）

Session → Run → 可选 Flow → Capability
                    ↓
              TaskRecord（按需）
```

不同 Agent 通过左侧分组打开独立 Session；目录、Flow、Run 事件和产物通过明确 ID 关联。该模型保留 Codeg 的会话聚合和目录管理优势，同时让 Flow 成为独立可复用资源。

## 5. 参考源码

- Pi RPC 明确建议 Node/TypeScript 应直接使用 `AgentSession`：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md>
- Pi 会话按工作目录保存，并支持 resume/fork/clone/tree：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md>
- Pi Server 通过 session `list/create/attach/detach` 管理连接租约：<https://github.com/earendil-works/pi/blob/main/packages/server/src/sessions.ts>
- OpenAI Agents 的 Runner 说明 handoff 在一次 Run 内切换 starting agent：<https://github.com/openai/openai-agents-python/blob/main/src/agents/run.py>
- AutoGen Team 将 participant 映射到 topic/runtime，并以 TaskResult 作为一次运行结果：<https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py>
