# 扩展性与移植性

## 1. 稳定核心

核心层只依赖稳定的领域对象和事件：

```text
WorkItem
Run
Step
Plan IR
Capability ID
Approval
Evidence
Event
```

核心层不依赖 macOS TCC、具体 Agent SDK、具体数据库驱动或渠道消息格式。

## 2. Adapter 边界

```text
ChannelAdapter       Web / Feishu / Telegram
AgentAdapter         Pi / Claude / Codex
CapabilityAdapter    Skill / MCP / CLI / HTTP
HostAdapter          macOS / Windows / Linux
StoreAdapter         SQLite / PostgreSQL（未来）
```

增加一个 Agent、渠道或外部系统时，优先增加 Adapter 和 Profile，不修改 WorkItem 生命周期。

## 3. 迁移策略

Workflow 文件永远使用本项目 DSL，不暴露 XState、Temporal 或其他引擎的内部格式：

```text
Git DSL → Schema Validator → Plan IR → Executor
```

因此：

- 单机阶段使用 SQLite 和轻量 Runtime。
- 多实例阶段可替换 Store 和 Executor。
- 需要长时间、跨机器、强重试时再接 Durable Engine。
- Agent 后端更换不影响历史 WorkItem 的 ContextSnapshot 和 Evidence。

## 4. 不可完全移植的部分

以下能力必须通过 Host/Environment Adapter 处理：

- 本地 Shell 和进程启动。
- macOS TCC、签名和目录授权。
- Windows/Linux 的服务管理。
- 内网地址和生产凭据。
- DCP、SLS、APM 的具体认证方式。

它们不能进入 Workflow 的业务语义层。
