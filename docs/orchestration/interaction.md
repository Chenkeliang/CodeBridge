# 交互规范

## 1. 产品定位

Web 是完整工作台；飞书和 Telegram 是轻量入口、进度通知和审批通道。所有入口共享 Agent Profile、Session、Folder、Flow、Run 和 Event 的同一套领域合同。

用户的核心心智模型只有三层：

```text
Agent   = 由谁工作
Session = 与这个 Agent 的哪个会话窗口
Flow    = 当前工作可参考的流程
```

TaskRecord/WorkItem 是后台执行记录，在出现异步、审批、证据或恢复需求时由 Runtime 创建或补充，不作为新建对话的前置表单。

## 2. Web 导航层级

左侧导航严格采用 Agent 分组：

```text
Agents
  Codex
    Session 1
    Session 2
  Pi
    Session 1
  Cursor
    Session 1
  Claude Code
    Session 1

Flows
  Flow 1
  Flow 2

Tasks（可选）
  需要长期跟踪的执行记录
```

规则：

- Agent Profile 是会话分组；Session 只出现在所属 Agent 下。
- Codex、Pi、Cursor、Claude Code 和其他注册 Agent 使用相同导航结构。
- Flows 与 Agents 平级，是独立的流程资源库。
- 点击 Agent 的“新建会话”时，Session 自动固定绑定该 Agent。
- 点击已有 Session 时，右侧主面板恢复该 Agent 的原生会话、目录和消息历史。
- 点击 Flow 时打开流程详情；通过“应用到当前会话”将它作为下一次 Run 的上下文。

页面统一称为 Session。Conversation、provider session、ACP session 等内部名称不直接暴露给用户。

## 3. 主面板

右侧主面板是当前 Session 的持续对话窗口：

```text
┌──────────────────────────────────────────────┐
│ Agent 名称 · Session 标题                     │
│ [模型] [工作目录] [Flow：自动发现]             │
├──────────────────────────────────────────────┤
│ 对话消息、Agent 计划、运行状态、审批和产物      │
│                                              │
│                                              │
├──────────────────────────────────────────────┤
│ ＋  输入目标、补充上下文或调整计划          ↑  │
└──────────────────────────────────────────────┘
```

输入框周边的控件都是可选上下文：

- Agent：新建 Session 时由左侧分组确定，已有 Session 显示为只读身份。
- 模型：从当前 Agent Adapter 动态读取，可选覆盖。
- 工作目录：通过 Folder 选择器、目录授权或资源引用添加。
- Flow：选择已有 Flow、查看当前临时 Flow，或保持“自动发现”。

用户只需要输入自然语言目标。Agent 在时间线中说明它理解到的目标、所需目录、风险、临时 Flow 和下一步；用户可以直接继续对话调整。

## 4. Flow 选择和当前 Session 的关系

Flow 与 Session 是关联关系，不是页面层级关系：

```text
当前 Session
  ├── Run 1 → Flow A
  ├── Run 2 → 自动生成的临时 Flow
  └── Run 3 → Flow B
```

选择 Flow 的效果是：

1. 在下一次 Run 创建时固定 Flow 的 `definition_revision`。
2. 将 Flow 的步骤、分支、能力和风险显示在当前时间线或上下文面板。
3. 允许 Agent 根据实际证据提出偏离、补充或暂停。

Flow 本身不承载当前执行状态；执行状态属于 Run 和 Event。

## 5. 新建和恢复 Session

### 新建

用户可以通过以下入口新建 Session：

- 点击某个 Agent 分组旁的“新建会话”。
- 点击全局“新建会话”，再选择 Agent。
- 从目录或已有会话详情中选择“使用此 Agent 新建”。

新建时只需要 Agent 和可选目录。标题、模型、Flow、项目范围由用户输入或运行时动态补充。

### 恢复

Session 列表支持：

- 最近使用和按 Agent 筛选。
- 按目录、标题和更新时间搜索。
- 继续、关闭、删除、分支和复制（由 Agent Adapter 声明能力）。
- 显示 Agent 健康状态、Session 状态和最后活动时间。

切换 Agent 会打开另一个 Session。当前 Session 的消息、目录和 Flow 绑定保持不变。

## 6. 临时 Flow 和 Workflow 沉淀

未知工作进入 Session 后，Agent 先生成临时 Flow：

```text
自然语言目标
  ↓
理解上下文和风险
  ↓
生成 ephemeral Flow/Plan
  ↓
用户确认或调整
  ↓
Run 执行
```

当前 Flow 可以在右侧查看、编辑本次分支、暂停或继续。用户认为它值得复用时，选择“保存为 Workflow”；系统生成 Candidate，经过 Schema 检查、评测、Review 和 Git 记录后，进入 Flow Catalog。

## 7. 项目和目录

Folder 是独立资源，不要求用户在每次对话里手写项目路径：

- 通过目录选择器添加主目录。
- 通过授权接口确认 Runner 可以访问目录。
- 通过资源引用补充额外目录。
- Discovery 在 Session 运行中发现 Git remote、服务、日志或 APM 入口后，以候选卡片呈现。

发现结果先成为当前 Session 的上下文，用户确认后才登记到 Project Catalog。目录和项目字段的来源、置信度、观察时间都显示在证据面板。

## 8. 任务记录和运行状态

Run 是一次实际执行尝试，状态为：

```text
queued / running / waiting / succeeded / failed / cancelled
```

当 Run 需要跨项目、异步等待、审批、证据或重启恢复时，Runtime 创建 TaskRecord。TaskRecord 可以在左侧 Tasks 分组中显示，但它始终关联已有 Session，不取代 Session。

任务记录卡片只显示通用字段：

```text
目标标题
所属 Agent / Session
当前状态
最近事件
下一步
```

页面不预置任何业务字段或示例流程。

## 9. 飞书和 Telegram

消息通道使用与 Web 相同的 Session ID、Flow ID、Run ID 和 Event Sequence：

- 普通消息继续当前 Session。
- 需要新 Agent 时创建对应 Agent 的新 Session。
- 需要选择 Flow 时发送 Flow 引用或由 Agent 自动发现。
- 长内容、Diff、证据和目录选择回到 Web。
- 审批只针对具体 Run、Step、Capability 和环境。

通道只负责交互适配，不建立自己的 Agent、Session 或 Flow 状态机。
