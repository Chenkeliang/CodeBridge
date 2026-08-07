# CodeBridge Orchestration 设计基线

状态：首个可运行基线；WorkItem、Domain Event、SQLite Event Store、Workflow DSL/Plan IR、Capability Policy、Approval Record、Runner 执行闭环、Project Catalog/Discovery、幂等与重启恢复、WorkItem API、queued Run API 和 Web Workbench 已落地。

本目录是 CodeBridge 多项目 Agent 工作台的设计规范入口，也是这套架构文档的唯一事实源。CodeBridge 是主项目；不再维护一套独立的 orchestration 服务，也不复制现有 Bridge、Runner、ACP 或 Channel 实现。

## 目标架构

```text
CodeBridge
├── 现有能力
│   ├── Bridge / Conversation / Router
│   ├── Runner Client / Runner Host
│   ├── ACP Backends
│   └── Feishu / Telegram Channels
└── 增量能力
    ├── WorkItem Engine
    ├── Workflow / Plan IR
    ├── Project Catalog / Discovery
    ├── Policy / Approval
    ├── Skill / MCP Capability Runtime
    └── Web Workbench
```

模块位于同一个仓库和版本周期内，通过领域对象、应用服务和事件互联；不建立模块之间任意直连的网状调用。

## 已确定的选择

- 核心后端继续使用 Node.js + TypeScript，先建设模块化单体；Runner Host 保持独立进程。
- Pi 优先通过 Node SDK 接入 Runner；`pi --mode rpc` 不是核心服务边界。Claude、Codex、Cursor 继续复用现有 ACP Backend。
- 用户可以直接创建对话、选择 Agent，也可以选择 Workflow；不选 Workflow 时进入探索模式。
- Web 采用聊天优先入口：模式、模型和工作空间是输入框周边的可选上下文，省略时由 Agent/Discovery 判断，不要求用户手工填写项目范围。
- Conversation 是消息容器，WorkItem 是目标、项目范围、计划、权限、证据和执行状态的事实中心。
- Workflow 是可选参考或受控 Runbook，不把未知工作强行固化为流程。
- Skill 保持通行的 `SKILL.md` 结构，不强制脚本语言；CodeBridge 只负责加载、绑定、权限和审计。
- MCP、Skill、CLI、HTTP 都是 Capability 的实现适配器，不进入 Workflow 的业务语义。
- 不维护一张假设永久正确的全局代码依赖图；使用轻量 Project Catalog、运行时证据和异步 Discovery Candidate。
- 自生成只产生 Project、Workflow、Skill/Eval 候选，经过 Review 和 Git 记录后才成为正式资产。
- 每个小功能都在独立特性分支上完成并提交；只有完成且获得用户明确授权后，才合并或提交到 `main`。
- 第一阶段不引入 LangGraph、Temporal、Camunda 或通用 DAG 引擎。

## 目录

```text
docs/orchestration/       架构、交互、引擎和治理规范
schemas/orchestration/    稳定 JSON 契约和 OpenAPI 基线
examples/orchestration/   Agent、项目、能力和 Workflow 示例
```

示例不是生产配置，不包含凭据，也不代表相关项目已经注册。

旧的 `/Users/keliang/mypy/orchestration/` 只保留迁移指针，不再作为规范来源。

## 阅读顺序

1. [项目规范](project-conventions.md)
2. [架构基线](architecture.md)
3. [CodeBridge 集成边界](codebridge-integration.md)
4. [接口规范](api-contract.md)
5. [WorkItem 与 DSL 引擎](engine.md)
6. [项目发现和自生成](self-generation.md)
7. [交互建议](interaction.md)
8. [设计规范](design-system.md)
9. [扩展性与移植性](extensibility-portability.md)

## 已落地切片

当前代码已经按以下顺序实现并保留独立特性分支提交：

1. WorkItem、Event、Plan IR 和 SQLite Store。
2. Capability Registry、Policy 和 Approval。
3. 复用现有 Runner 执行 Agent，并回写事件。
4. Project Discovery、候选确认和 Catalog Store。
5. Web Workbench、幂等键和重启恢复。

每一步都以本目录的 Schema 和兼容性测试为边界。未来是否提取 Rust 核心或接入 Durable Engine，由运行数据决定，不提前建立第二套 Runtime。
