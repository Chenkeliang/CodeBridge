# Pi Node SDK Adapter

状态：已落地首个可执行切片。

CodeBridge 将 Pi 作为 Node Runner 内的原生 SDK Agent，不通过 `pi --mode rpc` 启动独立进程。

## 运行边界

```text
RunnerHost
  └── pi-sdk profile
        └── @earendil-works/pi-coding-agent
              └── AgentSession
```

Pi Adapter 对外只暴露 CodeBridge 的 `RunContext` 和 `AgentEvent` 合同。Pi 的 `AgentSession`、JSONL 文件路径和模型对象只在 Adapter 内部使用。

## 已支持

- `createAgentSession` 创建原生 Pi Session。
- `SessionManager.create` 创建新会话。
- `SessionManager.list` + `SessionManager.open` 按 provider session ID 恢复会话。
- `prompt`、`steer`、`abort` 和 `dispose`。
- Pi session ID 回写统一 `session` 事件。
- 文本、思考和工具执行事件映射到统一 Runner 事件。
- Pi session 列表、关闭和删除。
- Pi 模型目录探测，返回统一配置选项。
- SDK 可用性诊断，不启动 LLM 请求。

## 配置

在 `backends` 中将 Agent Profile 声明为：

```yaml
backends:
  pi:
    type: pi-sdk
```

`defaultBackend` 也可以使用 `pi`。模型默认遵循 Pi 的本地设置；显式模型使用 `provider/model` 或 `provider:model` 格式。

## 生命周期和持久化

CodeBridge 的 `Session.provider_session_id` 保存 Pi 的 `AgentSession.sessionId`。Pi 自己负责 JSONL transcript 的追加和树结构；CodeBridge 只保存统一 Session Catalog、Run 和事件映射，不复制 Pi transcript。

删除操作只删除匹配当前工作目录的 Pi JSONL session 文件。关闭操作释放 CodeBridge 侧的会话引用；Pi 当前每次 Run 使用独立 SDK Session 实例，不维护 ACP 式进程池。

## 有意保留的边界

- Pi 的模型认证、模型目录和 skills/extensions 仍由 Pi SDK 的本地配置负责；CodeBridge 不复制凭据。
- `additional_directories` 在 Runner 层完成绝对路径校验并保留在 RunContext；Pi 原生工具使用自己的绝对路径解析，暂不引入供应商特有的目录参数。
- Policy/Approval 仍位于 Runner/Bridge 之上；Pi 的 Prompt 不能单独授予生产能力。
- Pi 的 fork/clone/tree UI 和统一 Session 分支 API 是下一切片，不能把当前的 `SessionManager.open` 误认为已完成 Web 分支能力。

## 测试边界

单元测试使用注入的最小 `PiSession` fake，不连接模型、凭据或生产目录；真实 SDK 只在 Runner 运行时通过同一 Adapter 创建。
