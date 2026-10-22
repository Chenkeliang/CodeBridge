# MCP Agent 配置控制面设计

- Status: Review draft
- Date: 2026-08-24
- Scope: 本机个人版 CodeBridge；Codex / Claude Code / Cursor / OpenCode / Pi
- Related:
  - `docs/superpowers/specs/2026-08-13-agent-setup-default-routing-design.md`
  - `docs/orchestration/architecture.md`
  - `docs/orchestration/agent-providers.md`
  - `packages/mcp-runtime`
  - `packages/agent-registry`

## 0. 定案摘要

CodeBridge 增加一个本机 MCP 配置控制面，统一完成 MCP Server 的登记、分配、启停、认证引导、配置投影、状态对账、漂移检测和回滚。

采用以下架构：

```text
CodeBridge MCP Catalog（统一定义）
        ↓ Assignment（分配给 Agent / Scope）
Desired State + Projection Plan
        ↓
Agent-specific MCP Target Adapter
        ↓
原生 CLI / 官方配置文件 / Agent 扩展
        ↓
Codex / Claude Code / Cursor / OpenCode / Pi 自己连接 MCP
        ↓
Observed State 对账
```

核心定义：

1. CodeBridge 是配置控制面，不是所有 Agent 的 MCP 流量代理。
2. Agent 独立运行时仍应能使用已经成功投影的 MCP。
3. 不存在“通用配置文件编辑器”；每个 Agent 必须有独立 Target Adapter。
4. `configured` 不等于 `loaded`，只有原生探针验证后才能声称可用。
5. Web 不直接读写第三方配置文件；所有读写经 Bridge API 和 Target Adapter。
6. OAuth token 留在 Agent 原生凭据存储中；CodeBridge 不复制 token。
7. Pi 不自研第一套 MCP 客户端；V1 优先安装并管理固定版本的社区扩展 `pi-mcp-adapter`。
8. CodeBridge Runtime 的 MCP Capability 与 Agent 原生 MCP 配置是两个消费面，共用 Server Definition，但授权、执行和状态不能混为一谈。

## 1. 用户目标

用户在 CodeBridge 一个页面中可以：

1. 查看本机已发现和 CodeBridge 已管理的 MCP Server。
2. 新增或导入 MCP 定义。
3. 选择将 MCP 分配给哪些 Agent。
4. 选择用户全局或项目 Scope。
5. 启用、禁用或移除某个 Agent 上的 MCP。
6. 发起原生 OAuth 登录或看到静态凭据缺失原因。
7. 预览即将写入的文件、命令和差异。
8. Apply 后看到真实的配置、加载和连接状态。
9. 检测用户在 Agent 外部手工修改产生的漂移。
10. 回滚 CodeBridge 最近一次写入。

成功体验：

```text
登记 MCP
  → 分配给 Codex / Claude / Cursor / OpenCode / Pi
  → 预览差异
  → 用户确认 Apply
  → 各 Adapter 投影原生配置
  → 原生状态对账
  → 用户直接打开任一 Agent 也能使用
```

## 2. 第一性原理

### 2.1 配置控制与运行连接分离

CodeBridge 管理的是“这个 Agent 应该拥有哪些 MCP 配置”。实际 MCP 连接仍由目标 Agent 或其扩展建立。

因此默认链路不是：

```text
Agent → CodeBridge Runtime → MCP
```

而是：

```text
CodeBridge 管理配置
Agent → MCP
```

CodeBridge Runtime 仍可作为 Flow Capability 的 MCP 消费者，但那是另一个 Target，不是其他 Agent 的必经代理。

### 2.2 统一语义，不统一物理格式

统一的是：

- Server 身份与 revision；
- transport 和非敏感连接参数；
- 分配关系；
- desired state；
- 工具 allow/deny 策略；
- 认证需求摘要；
- apply、verify、rollback 和审计语义。

不统一的是：

- 各 Agent 原生文件结构；
- OAuth token 存储；
- CLI 命令；
- Scope 映射；
- 热加载能力；
- Agent 特有扩展字段。

### 2.3 期望状态与观察状态分离

页面上的开关表达 `desiredState`，不能直接冒充真实运行状态。

```text
desired: enabled
observed: configured | auth_required | connected | restart_required | drifted | error
```

Apply 是一次受审计的状态协调：计算差异、执行写入、验证、保存结果。失败时保留真实 observed state，不把开关强行显示为成功。

### 2.4 方案选择

评估三种方案：

| 方案 | 优点 | 根本问题 | 结论 |
| --- | --- | --- | --- |
| 通用配置文件编辑器 | 初期代码少 | 格式、Scope、认证、启停和热加载语义不同；无法证明已加载；容易覆盖用户配置 | 不采用 |
| CodeBridge Runtime 统一代理 | Agent 配置最少 | Agent 脱离 CodeBridge 后不可用；Runtime 成为单点；混淆 Flow Capability 与 Agent 工具 | 不采用 |
| 原生 Target Adapter + 配置投影 | 保留 Agent 原生能力；独立运行；可按目标验证 | 需要维护五个适配器 | 采用 |

## 3. 与现有 CodeBridge MCP Runtime 的关系

### 3.1 已有能力

当前仓库已经具备：

- `orchestration.mcpServers` 配置；
- stdio / HTTP MCP Server 定义；
- Server health、Tool discovery 和 Candidate；
- Candidate review；
- 批准后注册 `McpCapabilityAdapter`；
- Flow Runtime 通过稳定 Capability ID 执行 MCP Tool。

这些能力服务 CodeBridge Runtime，不会自动把 MCP 写进 Codex、Claude、Cursor、OpenCode 或 Pi。

### 3.2 新增能力

本设计新增 Agent Native Configuration Control Plane：

```text
MCP Server Definition
  ├── target: codebridge-runtime
  ├── target: codex
  ├── target: claude
  ├── target: cursor
  ├── target: opencode
  └── target: pi
```

一个 Definition 可以被多个 Target 使用，但每个 Target 拥有独立 Assignment、Projection 和 Observed State。

### 3.3 禁止混淆的授权

以下状态互不推导：

1. Server 已登记。
2. Agent 已配置该 Server。
3. Agent 已成功连接。
4. MCP Tool 已在 CodeBridge Runtime 中发现。
5. Tool Candidate 已批准为 Flow Capability。
6. 某次 Agent 或 Runtime Tool Call 获得操作审批。

把 MCP 分配给 Agent，不能自动批准其成为 Flow Capability；批准 Flow Capability，也不能自动修改任何 Agent 原生配置。

### 3.4 现有配置的事实源迁移

当前 `orchestration.mcpServers` 在 Bridge 启动时注册进 `McpServerRegistry`。V1 不能让 YAML/config、SQLite Catalog 和 Agent 原生文件同时成为可写事实源。

定案：

1. 新的 MCP Definition Catalog 是 Web 创建和 CodeBridge 管理定义的唯一可写事实源。
2. `orchestration.mcpServers` 保留为兼容 bootstrap source；启动时投影成 `source.type = orchestration_config`、`ownership = external_observed` 的只读 Definition。
3. bootstrap Definition 可以被只读引用和分配，但 Web 不回写原配置文件。
4. 用户选择 Adopt 后，在 Catalog 生成新的受管 revision；原 bootstrap entry 不被删除或修改。
5. 同 ID 且内容不同必须显示来源冲突，不按启动顺序静默覆盖。
6. Runtime 在迁移期读取合并后的 Definition View；同一 Server revision 只注册一次。
7. 完成迁移前，现有 `/v1/mcp/servers` 行为保持兼容；新 API 不复用该 endpoint 承担写入。

事实源优先级只用于读取和冲突展示，不用于自动覆盖：

```text
Catalog managed definition
  > explicitly adopted definition
  > orchestration_config bootstrap
  > agent_config external observation
```

出现同 ID / 不同 revision 时必须由用户选择 rename、Adopt 或保持独立。

## 4. 领域模型

### 4.1 MCP Server Definition

```ts
type McpCredentialRef =
  | { kind: "env"; name: string }
  | { kind: "keychain"; ref: string };

type McpAuthRequirement =
  | { kind: "none" }
  | { kind: "native_oauth" }
  | { kind: "static_refs" };

interface McpServerDefinition {
  id: string;
  displayName: string;
  revision: string;
  transport: "stdio" | "streamable_http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  envRefs?: Record<string, McpCredentialRef>;
  headerRefs?: Record<string, McpCredentialRef>;
  auth: McpAuthRequirement;
  toolPolicy?: {
    allowedTools?: string[];
    deniedTools?: string[];
  };
  source: {
    type: "catalog" | "orchestration_config" | "agent_config" | "registry";
    locator?: string;
  };
  ownership: "codebridge_managed" | "external_observed" | "native_managed";
  updatedAt: string;
}
```

规则：

- `revision` 由标准化后的非敏感定义内容生成；不得包含 secret value。
- `stdio` 必须有 `command`；HTTP 类型必须有 `url`。
- `envRefs` / `headerRefs` 保存变量名或 `secret_ref`，禁止保存明文。
- Server ID 稳定；显示名可以修改。
- 外部发现的定义默认 `external_observed`，未 Adopt 前只读。

### 4.2 Agent Assignment

```ts
interface McpAgentAssignment {
  id: string;
  serverId: string;
  serverRevision: string;
  agentId: "codex" | "claude" | "cursor" | "opencode" | "pi";
  scope: "user_global" | "project";
  projectRoot?: string;
  desiredState: "enabled" | "disabled" | "absent";
  toolPolicyOverride?: {
    allowedTools?: string[];
    deniedTools?: string[];
  };
  createdAt: string;
  updatedAt: string;
}
```

规则：

- `project` 必须带规范化后的 `projectRoot`。
- Assignment 固定 Server revision；Definition 更新后不得静默升级 Assignment。
- Definition 出现新 revision 时显示 `upgrade_available`，用户确认后重新 Apply。
- `disabled` 保留配置但禁用；`absent` 表示从该 Target 移除 CodeBridge 管理的投影。

### 4.3 Projection Record

```ts
interface McpProjectionRecord {
  assignmentId: string;
  adapterId: string;
  adapterVersion: string;
  nativeScope: string;
  nativePaths: string[];
  desiredRevision: string;
  appliedRevision?: string;
  beforeHash?: string;
  afterHash?: string;
  backupRef?: string;
  observedState: McpObservedState;
  observedAt?: string;
  restartRequired: boolean;
  diagnostic?: {
    code: string;
    message: string;
    redactedDetails?: string;
  };
}
```

### 4.4 Observed State

```ts
type McpObservedState =
  | "unknown"
  | "agent_not_installed"
  | "extension_not_installed"
  | "configured"
  | "auth_required"
  | "loading"
  | "connected"
  | "disabled"
  | "restart_required"
  | "drifted"
  | "unsupported"
  | "error";
```

状态口径：

- `configured`：原生配置已存在，但尚未证明当前 Agent 已加载。
- `connected`：原生探针确认 Server 或其 Tools 可见。
- `restart_required`：投影成功，但 Agent 不支持当前会话动态加载。
- `drifted`：原生配置和最近一次投影 hash 不一致。
- `error`：写入、认证、加载或连接失败，必须包含脱敏诊断。

## 5. MCP Target Adapter 合同

现有 `AgentSetupManifest.supportsManagedConfiguration` 表达 Agent 整体配置所有权，不能直接用于 MCP。新增独立的 MCP Target Adapter 能力描述：

```ts
interface McpTargetAdapterManifest {
  agentId: string;
  adapterId: string;
  readMode: "native_cli" | "official_file" | "extension_api" | "managed_extension";
  writeModes: Array<"native_cli" | "official_file" | "extension_api" | "managed_extension">;
  scopes: Array<"user_global" | "project">;
  supportsEnableDisable: boolean;
  supportsHotReload: boolean;
  supportsOAuthLaunch: boolean;
  supportsToolPolicy: boolean;
  configPaths: string[];
}
```

每个 Adapter 必须实现：

```ts
interface McpTargetAdapter {
  detect(): Promise<McpTargetState>;
  import(): Promise<McpImportedDefinition[]>;
  plan(assignment: McpAgentAssignment): Promise<McpProjectionPlan>;
  apply(plan: McpProjectionPlan): Promise<McpApplyResult>;
  verify(assignment: McpAgentAssignment): Promise<McpVerifyResult>;
  rollback(projection: McpProjectionRecord): Promise<McpRollbackResult>;
  startAuth?(assignment: McpAgentAssignment): Promise<McpAuthStartResult>;
}
```

硬规则：

1. `plan` 只读，返回准确文件、命令和脱敏 diff。
2. `apply` 只能执行 `plan` 生成并由用户确认的 allowlist 操作。
3. 不允许 Web 传任意 shell 字符串。
4. 调用进程使用 `spawn(command, args, { shell: false })`。
5. 文件修改使用文件锁、内容 hash、临时文件原子替换和备份。
6. 只修改归属字段，保留未知字段、注释和用户配置。
7. Apply 前发现文件 hash 已变化时返回 `409 mcp_projection_conflict`，必须重新 plan。
8. `verify` 必须独立于 `apply`；写入成功不能直接返回 `connected`。
9. 日志、diff 和错误体必须对 token、header、env value、OAuth code 脱敏。
10. Adapter 不得读取或复制 Agent 原生 OAuth token。

## 6. 五个 Agent 的投影策略

| Agent | 持久投影 | 启停 | 验证 | 热加载口径 |
| --- | --- | --- | --- | --- |
| Codex | 原生 `codex mcp` CLI，必要时结构化修改 `~/.codex/config.toml` | 原生 server `enabled` | `codex mcp list` / tool status | 默认标记新会话验证，不承诺当前会话热加载 |
| Claude Code | 用户/本地 Scope 优先原生 CLI；项目 Scope 使用官方 `.mcp.json`；enable/disable 使用官方 settings | 官方 enabled/disabled server 设置 | `claude mcp list/get`，OAuth 经 `/mcp` | 已运行会话可能需要重连或新会话 |
| Cursor | `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`，配合 `agent mcp` CLI | `agent mcp enable/disable` | `agent mcp list/list-tools` | CLI 可动态启停；IDE 增删后必须对账，后续可加 Extension API |
| OpenCode | 检测版本后写对应 `opencode.json` schema | 原生 disabled 字段 | 原生 list/status 或启动探针 | 不承诺通用热加载；必要时重载 |
| Pi | 安装固定版本 `pi-mcp-adapter`，写 `~/.pi/agent/mcp.json` 或 `.pi/mcp.json` | 扩展的 enable/disable override | 扩展状态、工具发现或新 Pi 会话探针 | 配置变化后 `/reload`；无法触发时标记 restart_required |

### 6.1 Codex

- 用户全局配置位于 `~/.codex/config.toml`。
- 项目配置只在受信任项目中使用 `.codex/config.toml`。
- 优先使用原生 `codex mcp add/remove/login/list`；只有 CLI 不覆盖的受支持字段才做格式保留的 TOML 修改。
- 不覆盖其他 MCP Server、模型、sandbox、approval 或用户自定义字段。
- 原生 OAuth 登录由 Codex 完成，CodeBridge 只记录 `auth_required / connected / error`。

### 6.2 Claude Code

- 项目共享 Scope 使用 `.mcp.json`。
- 用户与 local/private Scope 优先调用 `claude mcp` CLI，禁止猜测性整体重写 `~/.claude.json`。
- `enabledMcpjsonServers`、`disabledMcpjsonServers` 和项目 MCP 授权按官方设置语义映射。
- V1 不使用 `managed-mcp.json`：它是管理员强制管理/锁定能力，不适合本机个人控制面。
- OAuth 必须由 Claude Code 原生流程完成。

### 6.3 Cursor

- 用户全局 Scope 使用 `~/.cursor/mcp.json`。
- 项目 Scope 使用 `.cursor/mcp.json`。
- 增删配置后调用 `agent mcp list` / `list-tools` 对账。
- enable/disable 优先调用 `agent mcp enable/disable`。
- 后续可以提供最小 Cursor Extension，通过 `registerServer/unregisterServer` 改善当前 IDE 会话热加载；V1 不依赖该扩展完成持久配置。

### 6.4 OpenCode

- 用户全局配置位于 `~/.config/opencode/opencode.json`，项目可有 `opencode.json`。
- OpenCode 不同大版本的 MCP schema 不相同；Adapter 必须先检测版本和有效 schema，无法确认时只读并返回 `unsupported`。
- Provider、模型和账户认证仍归 OpenCode 所有；本设计只管理明确 Adopt/Apply 的 MCP 子树。
- 这条窄授权覆盖旧设计中“CodeBridge 不写 OpenCode MCP 配置”的限制；旧设计关于其他 OpenCode 配置所有权仍然有效。

### 6.5 Pi

Pi 核心支持扩展和 Package 安装，但不内置统一 MCP 客户端。V1 采用：

```text
CodeBridge PiMcpTargetAdapter
  → 检测 Pi
  → 检测 pi-mcp-adapter 及版本
  → 用户确认后安装固定版本
  → 写 Pi 专属 MCP 投影
  → reload / 新会话验证
```

规则：

1. 依赖包固定到 CodeBridge 验证过的版本，不自动使用 `latest`。
2. 安装命令、来源、版本和权限在执行前展示。
3. V1 评估基线是 `pi-mcp-adapter`；它是第三方组件，不被描述为 Pi 官方核心能力。
4. Catalog 和 Assignment 不依赖该扩展的内部 schema；Pi Adapter 负责转换，未来可替换实现。
5. 社区扩展运行在用户机器并拥有较高权限；升级必须重新做依赖、许可、恶意行为和兼容性检查。
6. 支持卸载和恢复安装前配置。
7. 默认使用扩展的低上下文 proxy tool 模式；需要直接暴露的 tools 由用户显式选择，不能把所有 Tool 定义无条件注入上下文。
8. 只有现有扩展不能满足安全或稳定性要求时，才 fork 或自研 CodeBridge Pi MCP 扩展。

截至 2026-08-24 的调研基线版本是 `pi-mcp-adapter@2.27.0`。该版本号只记录本次评估对象；实际实现必须在 CodeBridge 自己的 approved dependency lock 中固定通过安全与兼容测试的版本，不能把本文版本号当自动升级目标。

## 7. 配置所有权和导入

原生配置中的 MCP 分三类：

| Ownership | 含义 | CodeBridge 权限 |
| --- | --- | --- |
| `codebridge_managed` | 由 CodeBridge 创建或已明确 Adopt | 可 plan/apply/disable/remove/rollback |
| `external_observed` | 用户或其他工具创建 | 默认只读展示和健康检查 |
| `native_managed` | Agent/企业策略强制管理 | 只读；不得覆盖 |

Adopt 流程：

```text
扫描原生配置
  → 展示来源、Scope、冲突和凭据引用
  → 用户选择 Adopt
  → 创建 CodeBridge Definition + Assignment
  → 保存原始 hash 和 provenance
  → 后续修改才进入 CodeBridge managed
```

禁止：

- 扫描后自动接管；
- 自动复制明文 token；
- 同名 Server 静默覆盖；
- 把不同连接定义仅按名称错误合并；
- 删除 CodeBridge 不拥有的配置。

## 8. 认证和凭据边界

### 8.1 OAuth

- OAuth 由目标 Agent 或受管理扩展的原生授权流程完成。
- CodeBridge 可以发起登录并读取脱敏状态，但不能读取、导出或跨 Agent 复制 token。
- 一个 Agent 已登录不代表其他 Agent 已登录。
- 页面按 Assignment 展示认证状态。

### 8.2 环境变量

- Catalog 只保存环境变量名，例如 `GITHUB_TOKEN`。
- 投影时使用目标 Agent 官方支持的 env interpolation 或 env-var reference。
- CodeBridge 不把当前进程内的 secret value 写入配置。
- 若用户直接启动 Agent 时环境变量不可见，Assignment 不能标记 `connected`，必须提示补齐独立运行环境。

### 8.3 Keychain / Secret Vault

- 静态 secret 可保存在 macOS Keychain，Catalog 只保存 `secret_ref`。
- 只有目标 Adapter 能在 Agent 独立运行时安全解析该 `secret_ref`，才能将其计为可投影凭据。
- V1 不为了隐藏 HTTP header 而默认引入全局本地代理。
- 无安全注入路径时，状态为 `auth_required`，由用户配置原生 OAuth 或环境变量；禁止降级成明文。

## 9. Apply、Verify、漂移与回滚

### 9.1 Apply 两阶段

```text
POST plan
  → 返回命令、文件、diff、权限、restart 预期
用户确认
POST apply(plan_id)
  → 校验 plan 未过期和文件 hash
  → 原子写入/原生命令
  → 保存 Projection Record
  → verify
```

`plan_id` 必须绑定：

- Actor；
- Assignment revision；
- Adapter version；
- 原生配置 beforeHash；
- 过期时间；
- 脱敏操作列表。

### 9.2 验证层级

```text
L1 persisted   原生文件/CLI 状态存在
L2 loaded      Agent 报告 Server 或 Tool 已加载
L3 connected   MCP Server 可连接并完成 tools/list
L4 usable      受控 smoke tool 调用成功（仅无副作用 Tool）
```

页面必须显示当前达到的层级。L1 不能声称 MCP 可用。

### 9.3 漂移

触发：

- 页面手动刷新；
- Agent 设置页进入；
- CodeBridge 启动；
- Apply 前；
- 可选的低频文件监听。

发现漂移后提供：

1. 查看原生差异；
2. 以 CodeBridge 重新 Apply；
3. 接受原生修改并生成新 revision；
4. 解除 CodeBridge 管理。

禁止后台静默覆盖用户手工修改。

### 9.4 回滚

- 每次文件写入保留受限数量的加密/权限收紧备份或结构化 inverse patch。
- 回滚前同样检查当前 hash；目标又被修改时必须重新确认。
- 原生 CLI 操作保存等价逆操作和结果。
- 回滚不还原 OAuth token。

## 10. Bridge API 合同

建议新增：

```text
GET    /v1/mcp/definitions
POST   /v1/mcp/definitions
PATCH  /v1/mcp/definitions/:server_id

GET    /v1/mcp/targets
GET    /v1/mcp/assignments
POST   /v1/mcp/assignments
PATCH  /v1/mcp/assignments/:assignment_id

POST   /v1/mcp/assignments/:assignment_id/plan
POST   /v1/mcp/projection-plans/:plan_id/apply
POST   /v1/mcp/assignments/:assignment_id/verify
POST   /v1/mcp/assignments/:assignment_id/rollback

POST   /v1/mcp/import/scan
POST   /v1/mcp/import/adopt
POST   /v1/mcp/assignments/:assignment_id/auth/start
```

现有 API：

```text
GET  /v1/mcp/servers
GET  /v1/mcp/candidates
POST /v1/mcp/servers/:server_id/discover
POST /v1/mcp/candidates/:candidate_id/approve|reject
```

继续服务 Runtime discovery/review。实施时可以共享 Definition Store，但不能改变其 Capability Review 语义。

错误体至少包括：

```ts
interface McpControlPlaneError {
  error: {
    code: string;
    message: string;
    agent_id?: string;
    server_id?: string;
    assignment_id?: string;
    retryable?: boolean;
    restart_required?: boolean;
  };
}
```

稳定错误码：

- `mcp_target_unsupported`
- `mcp_agent_not_installed`
- `mcp_extension_not_installed`
- `mcp_auth_required`
- `mcp_projection_conflict`
- `mcp_projection_failed`
- `mcp_verification_failed`
- `mcp_restart_required`
- `mcp_assignment_revision_mismatch`
- `mcp_external_config_read_only`

## 11. Web 信息架构

设置页增加 `MCP` 一级模块：

### 11.1 Catalog

- Server 列表；
- transport、来源、revision 和健康摘要；
- 新增、导入、编辑、停用；
- 不在列表中展示 secret value。

### 11.2 Assignments

使用 MCP × Agent 矩阵：

```text
                Codex  Claude  Cursor  OpenCode  Pi
order-query       ●      ●       ○        ●      △
browser-tools     ●      ○       ●        ○      ●
```

- `● connected`
- `○ not assigned / disabled`
- `△ auth_required / restart_required / drifted`

点击格子进入 Assignment Drawer：

- Scope；
- desired/observed；
- 工具策略；
- 认证状态；
- 原生配置路径；
- diff 预览；
- Apply / Verify / Disable / Remove / Rollback。

### 11.3 明确状态语言

允许：

- 已保存到 Codex 配置；
- Codex 新会话验证后生效；
- Cursor 已加载 8 个 Tools；
- Pi 扩展未安装；
- OpenCode 配置已漂移。

禁止：

- 只因 API 200 就显示“可用”；
- 只因文件存在就显示“已连接”；
- 将 `restart_required` 显示成成功终态；
- 将 Runtime Candidate 已批准显示为 Agent 已授权。

## 12. Surface Matrix

实施规划前和声明完成前都必须更新：

| Surface | 当前 implemented | 当前 reachable | V1 planned | V1 closed-loop 标准 |
| --- | --- | --- | --- | --- |
| Web MCP 管理 | 无生产 UI | 否 | Catalog、矩阵、Drawer、plan/apply/verify/rollback | 用户能完成新增、分配、应用、认证提示、验证和回滚 |
| Bridge Control API | 只有 Runtime servers/candidates API | 部分 | Definition、Assignment、Projection API | 所有写操作可审计、可冲突检测、可回滚 |
| CodeBridge Runtime | MCP discover/review/execute 已有 | 是 | 接入共享 Definition，不改变审批语义 | Agent 分配不会污染 Runtime Capability 状态 |
| Codex Target | 无 | 否 | CLI/TOML Adapter | 独立 Codex 新会话可发现已分配 MCP |
| Claude Target | 无 | 否 | CLI/.mcp.json/settings Adapter | 独立 Claude 会话可发现已分配 MCP |
| Cursor Target | 无 | 否 | mcp.json/CLI Adapter | 原生 list/tools 对账成功，IDE 状态诚实展示 |
| OpenCode Target | 无 | 否 | version-aware JSON Adapter | 支持版本闭环；未知版本 fail closed |
| Pi Target | 无 MCP 管理 Adapter | 否 | 安装固定扩展 + Pi 配置 Adapter | 独立 Pi 会话可调用无副作用 smoke MCP Tool |

任何“前往 Agent 完成认证”“重新加载 Pi”“打开 Cursor 检查”的跳转，都必须有可执行目标、必要上下文和返回后的 Verify 入口。

## 13. 安全规则

1. 页面加载只做只读检测，不自动安装、升级或修改配置。
2. 新增、Adopt、Apply、升级、卸载、回滚均需用户明确操作。
3. 安装来源必须在发布版 allowlist 中；用户自定义来源作为高级功能单独确认。
4. 禁止 shell 拼接和从 HTTP 响应直接执行命令。
5. 第三方 Pi 扩展安装前展示包名、固定版本、来源、许可和权限说明。
6. 所有配置路径经过 Scope 和真实路径校验；禁止目录穿越和符号链接逃逸。
7. 项目级配置只有在项目受信任时可写。
8. 文件权限不得因重写而放宽。
9. 日志和数据库禁止保存 secret value、OAuth token、Authorization header。
10. 导入配置包含疑似明文 secret 时，只显示脱敏告警；Adopt 前必须迁移到安全引用或明确保留为 external read-only。
11. Tool smoke test 默认只允许明确标记为无副作用的 Tool。
12. Agent 原生企业/managed policy 优先，CodeBridge 不绕过。

## 14. V1 范围与分期

### P0：领域底座和只读发现

1. Definition / Assignment / Projection / Observed State schema。
2. MCP Target Adapter 接口和五个 manifest。
3. 原生配置只读扫描、provenance、冲突检测。
4. plan 和脱敏 diff，不执行写入。
5. Web 只读 Catalog 和 Agent 矩阵。
6. 测试 fixture 覆盖五个 Agent 的配置格式。
7. 将 `orchestration.mcpServers` 作为只读 bootstrap source 接入合并 Definition View，并覆盖同 ID 冲突测试。

### P1：完整配置闭环

1. Codex / Claude / Cursor / OpenCode 原生投影。
2. Pi 固定版本扩展安装和配置投影。
3. Apply 两阶段确认、原子写入、备份和回滚。
4. enable / disable / absent。
5. Web Assignment Drawer。
6. verify、restart_required 和错误恢复。
7. 外部配置 Adopt。
8. 各 Agent 最小 OAuth 启动/原生登录引导和认证状态对账；没有闭环的 Target 必须保持 `auth_required`。

P1 完成后才可以声称“CodeBridge 能统一管理五个 Agent 的 MCP 配置”。

### P2：认证、漂移和体验增强

1. OAuth 重新授权、过期恢复、取消和回跳体验增强。
2. Keychain `secret_ref` 支持矩阵。
3. 低频漂移监听和通知。
4. Cursor Extension API 热注册。
5. Pi directTools 精细策略和上下文成本展示。
6. Server revision 升级向导。

### P3：市场和分发

1. 官方 MCP Registry / 私有 Registry 搜索。
2. 安装风险和来源信誉信息。
3. 多机器配置包导入导出。
4. 团队策略和远程节点。

P3 不改变 V1 的 Definition / Assignment / Projection 合同。

## 15. 非目标

V1 不做：

- 把 CodeBridge 变成所有 Agent 的 MCP 网络代理；
- 多用户 Flow/MCP ACL；
- 企业 MDM 或强制策略；
- 自动批准 MCP Tool 成为 Flow Capability；
- 自动复制 Agent OAuth token；
- 把 secret 明文写入配置；
- 保证所有 Agent 当前会话热加载；
- 自动接管所有现存 MCP 配置；
- 自研一套新的 Pi MCP 客户端；
- 完整 MCP 市场；
- Skill 管理和分发。

Skill 管理可复用本设计的 Catalog、Assignment、Target Adapter、Projection、Observed State 和漂移模型，但 Skill 内容、软链和加载规则另立规范，不能和 MCP Server 连接状态混成一个领域对象。

## 16. 测试与验收

### 16.1 合同测试

- Definition 标准化与 revision 稳定；
- 不同 transport 合法性；
- Assignment revision 固定；
- desired / observed 分离；
- plan 过期和 beforeHash 冲突；
- secret redaction；
- external_observed 禁写；
- Runtime Capability 与 Agent Assignment 隔离。

### 16.2 Adapter fixture 测试

每个 Agent 覆盖：

- 空配置；
- 已有用户配置；
- 同名不同定义冲突；
- enable / disable / absent；
- 未知字段保留；
- 文件并发变化；
- 非法配置；
- Agent 未安装；
- 需要重启；
- rollback。

OpenCode 额外覆盖版本 schema；Pi 额外覆盖扩展缺失、版本不匹配、安装失败和 `/reload`。

### 16.3 活跃表面测试

不能只测文件输出，必须在本机测试 Agent 的真实入口：

```text
Web Apply
  → 原生配置出现
  → Agent 原生 list/status 能看到
  → 新建独立 Agent 会话
  → MCP Tool 可发现
  → 调用无副作用 smoke Tool
  → Web Verify 显示 usable
```

五个 Agent 独立验收，禁止从一个 Agent 推断其他 Agent。

### 16.4 完成定义

V1 完成必须同时满足：

1. Web 可管理五个 Agent 的 Assignment。
2. Apply 有预览、确认、冲突检测和审计。
3. 未覆盖非 CodeBridge 配置。
4. 五个 Agent 均完成真实独立会话验证；若某版本确实不支持热加载，页面准确显示重启要求。
5. Pi 使用固定、经过审查的扩展版本并能卸载回滚。
6. 无 secret value 进入 Git、SQLite、日志、diff 或 API 响应。
7. Surface Matrix 重新核对为 reachable / closed-loop。

## 17. 实施约束

1. 不直接把 `supportsManagedConfiguration` 改为 `true` 来代表 MCP 管理能力；新增 MCP 专属 manifest。
2. 不在 React 中维护 Agent 专属路径、schema 或命令。
3. 不一次性重写整个配置文件。
4. 不把 community extension 类型泄漏到通用领域模型。
5. 不以 CodeBridge 进程环境代替 Agent 独立启动环境做凭据验收。
6. 不因为 Pi 扩展能导入其他 Agent 配置，就跳过其他 Agent 各自的 Target Adapter。
7. 不把“保存配置”“Agent 加载”“Server 连接”“Tool 可调用”合并成一个布尔值。
8. 所有实现计划必须引用本规范中的状态、所有权和 Surface Matrix，不再引用旧文档中“OpenCode MCP 永不由 CodeBridge 管理”的绝对表述。

## 18. 资料依据

- Codex MCP: <https://developers.openai.com/codex/mcp>
- Claude Code MCP: <https://code.claude.com/docs/en/mcp>
- Claude Code settings: <https://code.claude.com/docs/en/settings>
- Cursor MCP: <https://prod.cursor.com/docs/mcp>
- Cursor CLI MCP: <https://prod.cursor.com/docs/cli/mcp>
- Cursor Extension API: <https://prod.cursor.com/docs/extension-api>
- OpenCode MCP Servers: <https://opencode.ai/v2/docs/mcp-servers>
- Pi extension/package management: <https://github.com/earendil-works/pi/issues/645>
- Pi MCP Adapter: <https://github.com/nicobailon/pi-mcp-adapter>
- MCP Authorization: <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- MCP Registry: <https://modelcontextprotocol.io/registry/about>

## 19. 最终边界

本设计锁定：

> CodeBridge 统一管理 MCP 的定义和期望状态，通过各 Agent 的原生 Target Adapter 投影到官方配置、CLI 或受管理扩展；Agent 自己建立连接，CodeBridge 再对真实状态进行验证。Pi 优先复用固定版本的成熟社区 MCP 扩展，不重复实现协议客户端。任何配置写入、扩展安装、接管、升级和回滚都必须可预览、可确认、可审计、可恢复，并且不能复制凭据或覆盖不属于 CodeBridge 的配置。
