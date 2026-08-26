# CodeBridge 集成边界

## 1. 主项目关系

CodeBridge 是产品、运行时和协议实现的主项目。Orchestration 是 CodeBridge 内的一组领域模块，不是外部控制面，也不是另一个需要同步源码的仓库。

当前已有模块继续复用：

| 当前目录 | 保留职责 |
|---|---|
| `packages/core` | 配置、共享类型和基础领域能力 |
| `packages/router` | 用户、会话和 Backend 路由 |
| `packages/backends` | Cursor、Claude Code、Codex 等 ACP Backend，以及 Pi Node SDK Adapter |
| `packages/runner-client` | Bridge 到 Runner Host 的协议客户端 |
| `packages/runner-host` | 本机进程、工作目录和 Agent 执行边界 |
| `packages/channel-feishu` | 飞书通道适配 |
| `packages/channel-telegram` | Telegram 通道适配 |
| `apps/bridge` | 服务装配和对外入口 |

目标新增模块可在实现时逐步建立：

```text
packages/work-items
packages/workflow-engine
packages/agent-registry
packages/session-catalog
packages/flow-catalog
packages/run-runtime
packages/project-catalog
packages/skill-runtime
packages/mcp-runtime
packages/policy-engine
```

这是逻辑边界，不要求第一天拆出全部 Package。单一职责变得稳定、需要独立测试或依赖隔离时再拆包。

## 2. 调用方向

```text
Web / Feishu / Telegram
          ↓
       Bridge API
          ↓
 Session Application Service ← Event Store / Artifact Store
          ↓
 Flow / Workflow Plan IR + Policy / Approval
          ↓
 Run Runtime → Runner Client → Runner Host
                   ├── Agent Adapter: ACP / Pi SDK
                   └── Capability Adapter: Skill / MCP / CLI / HTTP
```

规则：

- Channel 将消息转换为 Session/Run 命令，再由 Bridge 统一调用 Capability。
- Workflow 不直接启动进程，只声明 Capability ID、风险和控制条件。
- Agent 可以提出 Flow、Plan 和工具调用请求，Run Runtime 决定能否执行。
- Policy/Approval 位于所有有副作用调用之前，不能只靠 Agent Prompt 约束。
- 模块状态变化写入 Event Store；UI 和 Channel 订阅事件，不各自维护状态机。

内置飞书和 Telegram 的普通文本消息也通过统一 Channel ingress 创建或恢复 Session、追加 Message、创建 Run，并从 Session SSE 读取 Agent 事件。`/stop`、审批回应和 `/new` 通过同一 Channel Conversation 绑定控制当前 Run/Session。Session Message 已支持持久化 Attachment 引用，Web 文件/图片与飞书图片/文件都会通过同一 Run Request 交给 Runner；旧 Router 仍作为兼容入口保留。

## 3. ACP、Pi、Skill 和 MCP 的位置

它们不是同一层：

| 概念 | 所在层 | 与 CodeBridge 的关系 |
|---|---|---|
| ACP | Agent Adapter 协议 | 复用现有 Backend 与 Runner；不是模块总线 |
| Pi SDK | Agent Adapter 实现 | 运行在 Node Runner 内，与 ACP Backend 并列 |
| Skill | Capability 实现和领域说明 | 保持标准目录；由 Skill Runtime 发现和加载 |
| MCP | Capability 工具/资源协议 | 由 MCP Runtime 建连并暴露为 Capability |
| Workflow | 计划定义层 | 只引用 Capability，不关心实现来自 Skill 还是 MCP |
| Agent Profile | 运行配置层 | 选择 Backend、模式和允许的 Capability 集合 |

因此，CodeBridge 的现有交互并非全部依赖 ACP。ACP 只解决一类 Agent Backend 通信；Web、飞书、Telegram 使用 Channel/API 边界，Skill 和 MCP 使用 Capability 边界。

MCP Runtime 使用官方 SDK 连接 stdio 或 Streamable HTTP Server。配置 Server 后会自动发现 Tool，
但只生成 Candidate；在 `/v1/mcp/candidates/{id}/approve` Review 之前，不会赋予 Agent 或
Workflow 执行权限。

## 4. 模块互联合同

模块之间只共享以下稳定合同：

```text
Session / Run / Step / TaskRecord
Plan IR / Capability ID
Approval / Evidence / Artifact
Domain Event / ContextSnapshot
```

不得让 Workflow 读取某个 Channel 的消息结构，也不得让 Channel 依赖某个 Skill 的返回 JSON。边界转换由 Adapter 完成。

建议的依赖方向：

```text
core ← work-items ← bridge/channel
core ← workflow-engine ← work-items
core ← policy-engine ← work-items
core ← project-catalog ← work-items
core ← runner-client ← work-items
```

领域包依赖稳定合同；Runner Host 通过 Runner Protocol 回传事件和结果，Bridge Runtime 负责 Session、Run 和 TaskRecord 的持久化。

## 5. 版本和同步

同仓库模块使用同一个 Git revision 和 CI，不存在复制 CodeBridge 后再同步的问题：

- 领域 Schema 使用显式 `schema_version`。
- HTTP API 使用 `/v1` 主版本路径。
- Runner 握手携带 `protocol_version`、`runner_version` 和支持的 Capability。
- Run 创建时固定 Flow 的 `definition_revision`，后续更新不改变正在执行的实例。
- Skill 和 MCP 记录来源、版本和内容摘要；默认不复制第三方 Skill 内容。
- 首个 SQLite Event Store 使用 Node 内置 `node:sqlite`；当前仓库因 Pi Node SDK 统一要求 Node.js `>=22.19.0`。若未来需要继续支持更旧 Node，由 Store/Agent Adapter 替换底层实现，不改变领域合同。

项目变更遵循特性分支规则：每个小功能先从生产基线创建独立分支，在分支上完成、验证并提交；只有功能完成且得到用户明确允许后，才合并或提交到 `main`。Orchestration 文档、Schema 和示例也遵循同一规则。

如果未来拆出远程 Runner 或独立服务，仍使用 OpenAPI、JSON Schema、SSE 和 Runner/ACP 协议，不共享数据库表或包内对象。

## 6. 兼容性检查

每次修改公共合同至少验证：

1. JSON Schema 和 OpenAPI 可解析。
2. 当前版本能读取上一兼容版本的 Session、TaskRecord、Event 和 Workflow。
3. Bridge 与 Runner 的版本握手能拒绝不兼容协议。
4. Workflow/Flow 中的 Capability、Step 依赖和 Branch 目标存在。
5. ACP、Pi SDK、Skill 或 MCP Adapter 的故障都会形成标准失败事件，而不是丢失在聊天文本中。
