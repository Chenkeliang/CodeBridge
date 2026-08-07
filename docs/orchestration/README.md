# CodeBridge Orchestration 设计基线

状态：Session-first 架构规范；当前运行时仍使用 WorkItem/Run 作为内部持久化和兼容 API，Web 的目标入口是 Agent 分组下的 Session，Workflow 是与 Agents 平级的可选资源。

本目录是 CodeBridge 多项目 Agent 工作台的设计规范入口，也是这套架构文档的唯一事实源。Orchestration 作为 CodeBridge 内部模块运行，与现有 Bridge、Runner、ACP 和 Channel 共享同一版本事实源。

## 目标架构

```text
CodeBridge
├── 现有能力
│   ├── Bridge / Conversation / Router
│   ├── Runner Client / Runner Host
│   ├── ACP Backends
│   └── Feishu / Telegram Channels
└── 增量能力
    ├── Agent Registry / Session Catalog
    ├── Flow / Workflow / Plan IR
    ├── Run / Event Runtime
    ├── Project Catalog / Discovery
    ├── Policy / Approval
    ├── Skill / MCP Capability Runtime
    └── Web Workbench
```

模块位于同一个仓库和版本周期内，通过领域对象、应用服务和事件互联；不建立模块之间任意直连的网状调用。

## 已确定的选择

- 核心后端继续使用 Node.js + TypeScript，先建设模块化单体；Runner Host 保持独立进程。
- Pi 优先通过 Node SDK 接入 Runner；`pi --mode rpc` 不是核心服务边界。Claude、Codex、Cursor 继续复用现有 ACP Backend。
- Pi Node SDK Adapter 已在 `packages/backends` 和 `packages/runner-host` 落地；配置 `backends.pi.type: pi-sdk` 后才进入可执行状态，未配置时 Registry 保持 `needs_setup`。
- 用户可以直接创建 Session；Agent、项目范围和 Flow 都由运行时或用户输入动态确定，页面和示例配置保持通用形状。
- Web 采用聊天优先入口：模式、模型和工作空间是输入框周边的可选上下文，省略时由 Agent/Discovery 判断，不要求用户手工填写项目范围。
- 页面导航严格采用 `Agent → Session`：Agent Profile 是分组，Session 是分组下的具体会话；二者不在同一级展示。
- `Flows` 与 `Agents` 平级。Flow 可在右侧主面板附加到当前 Session 的下一次 Run，不成为 Agent 或 Session 的子节点。
- Codex、Pi、Cursor、Claude Code 和其他 ACP/SDK/CLI Agent 都是一等 Agent Profile；适配器类型由 Registry 动态声明。
- 未知工作先由 Agent 为当前 Session 生成临时 Flow/Plan；只有用户确认或重复使用后才沉淀为可复用 Workflow。
- WorkItem 表和 API 作为后台 Task Record 的持久化实现，承载异步、审批、证据和恢复状态；用户主导航始终是 Agent 分组下的 Session。
- 每个 Session 固定绑定一个 Agent；不同 Agent 通过左侧分组分别打开独立 Session，跨会话资料通过显式上下文和产物引用传递。
- Skill 保持通行的 `SKILL.md` 结构，不强制脚本语言；CodeBridge 只负责加载、绑定、权限和审计。
- MCP、Skill、CLI、HTTP 都是 Capability 的实现适配器，不进入 Workflow 的业务语义。
- 多项目关系以轻量 Project Catalog、运行时证据和异步 Discovery Candidate 为事实来源，随代码和环境变化持续校准。
- 自生成先产生当前 Session 的临时 Flow，再按需提议 Project、Workflow、Skill/Eval 候选；经过 Review 和 Git 记录后才成为正式资产。
- 每个小功能都在独立特性分支上完成并提交；只有完成且获得用户明确授权后，才合并或提交到 `main`。
- 第一阶段使用轻量 Session/Run Runtime；未来通过稳定的 Plan IR 接入需要的 Durable Engine。

## 目录

```text
docs/orchestration/          架构、交互、引擎和治理规范
schemas/orchestration/       稳定 JSON 契约和 OpenAPI 基线
examples/orchestration/     非业务的配置形状参考（保持通用）
```

示例不是生产配置，不包含凭据，也不代表相关项目或 Agent 已经注册。仓库不提供可运行的业务流程示例；Workflow 由用户输入、Agent 发现或受控目录动态提供。

`/Users/keliang/mypy/orchestration/` 仅保留迁移指针；规范来源为本目录。

## 阅读顺序

1. [项目规范](project-conventions.md)
2. [架构基线](architecture.md)
3. [CodeBridge 集成边界](codebridge-integration.md)
4. [接口规范](api-contract.md)
5. [Flow、Run 与 DSL 引擎](engine.md)
6. [项目发现和自生成](self-generation.md)
7. [交互建议](interaction.md)
8. [设计规范](design-system.md)
9. [扩展性与移植性](extensibility-portability.md)
10. [多 Agent 运行时调研](agent-runtime-research.md)

## 已落地切片

当前代码已经按以下顺序实现并保留独立特性分支提交：

1. WorkItem、Event、Plan IR 和 SQLite Store。
2. Capability Registry、Policy 和 Approval。
3. 复用现有 Runner 执行 Agent，并回写事件。
4. Project Discovery、候选确认和 Catalog Store。
5. Web Workbench、幂等键和重启恢复。

每一步都以本目录的 Schema 和兼容性测试为边界。未来是否提取 Rust 核心或接入 Durable Engine，由运行数据决定，不提前建立第二套 Runtime。
