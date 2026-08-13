# Agent 安装、配置与默认路由设计

- Status: Approved design
- Date: 2026-08-13
- Scope: `cursor` / `claude` / `codex` / `pi` / `opencode`
- Related: `docs/orchestration/agent-providers.md`, `docs/orchestration/agent-runtime-research.md`, `docs/orchestration/prompt-stability.md`

## 1. 目标

CodeBridge 必须明确区分“支持某个 Agent”和“本机已经可以运行该 Agent”：

1. Registry 展示所有受支持 Agent，并检测安装、配置和运行状态。
2. 未安装 Agent 显示安装入口；已安装但未配置 Agent 显示配置入口。
3. 每个 Agent 由自己的 adapter 管理安装诊断和配置，不复用 Pi Provider 页面。
4. 用户可以设置默认 Agent；刷新工作台时进入默认 Agent，并恢复它上次打开的 Session。
5. 未安装或未完成配置的 Agent 不能被设置为默认 Agent。

本设计不增加新的模型厂商 Agent。DeepSeek、Kimi、GLM、Qwen 等仍通过 Pi Provider 或相应 Agent 自己的 Provider 配置接入。

## 2. 第一性原理与边界

Agent 可用性由三个彼此独立的事实决定：

```text
Installed: 可执行程序或 SDK 是否存在
Configured: 认证和必需配置是否完整
Runtime: 当前运行时是否健康
```

不能继续用单个 `needs_setup` 同时表达三类问题，否则 UI 无法给出正确动作，默认路由也无法判断候选资格。

安装与配置属于 Control Plane，不属于 Session 或 Prompt：

- 检测、安装、配置不会启动 LLM 对话，也不会向 Prompt 注入任何文本。
- 默认 Agent 只决定新 Session 的 adapter 路由，不修改任何 Agent 的系统提示词。
- Agent Profile、安装日志、版本和健康状态禁止进入 Prompt 前缀，避免破坏逐字节稳定性和缓存命中率。
- 各 Agent 的模型、思考等级、速度和权限仍由 adapter 动态上报；Web 不写死能力。

## 3. 采用方案

采用 **Registry 驱动的统一 Agent 设置中心**：

- Rail 继续展示五个受支持 Agent。
- 设置页新增 `AGENTS` 分组，每个 Agent 使用相同状态卡和操作模型。
- 缺失 Agent 的 Rail 图标仍可进入只读说明/设置状态，但不能创建 Session 或运行。
- 安装、诊断和配置动作由 Agent manifest 声明，页面不包含 Agent 专有判断。
- OpenCode 是第一个完整落地样例，其他四个 Agent 使用同一契约逐步接入。

不采用以下方案：

- **只显示一段安装文档**：无法检测安装结果，也无法统一默认 Agent 资格。
- **页面直接执行任意 shell 命令**：不可审计且存在命令注入风险。
- **把所有 Agent 配置写入 Pi models.json**：配置所有权错误，且会污染 Pi Provider 语义。

## 4. Agent Setup Manifest

每个 adapter 提供静态 manifest 和运行时诊断：

```ts
interface AgentSetupManifest {
  agentId: string;
  displayName: string;
  adapter: "sdk" | "acp" | "cli";
  installStrategies: InstallStrategy[];
  configurationOwner: "codebridge" | "agent";
  configurationPath?: string;
  documentationUrl?: string;
  supportsManagedConfiguration: boolean;
}

interface AgentSetupState {
  installation: "installed" | "missing" | "unknown";
  configuration: "configured" | "needs_configuration" | "unknown";
  runtime: "healthy" | "unavailable" | "not_started";
  version?: string;
  executablePath?: string;
  diagnostic?: {
    code: string;
    message: string;
    details?: string;
  };
}
```

`AgentProfile.status` 继续作为兼容投影：

| Setup state | Profile status |
| --- | --- |
| missing / needs_configuration | `needs_setup` |
| installed + configured + healthy | `healthy` |
| installed + configured + unavailable | `unavailable` |

资格派生：

```text
can_select_default = installed && configured
can_create_session = installed && configured && runtime == healthy
```

运行时短暂不可用不会自动清除用户保存的默认 Agent；页面进入该 Agent 后展示真实诊断，并禁止创建或发送。只有确认未安装或配置缺失时，它才从默认候选中移除。

## 5. 配置所有权

| Agent | 配置所有者 | CodeBridge 行为 |
| --- | --- | --- |
| Pi | CodeBridge managed | 管理 `~/.pi/agent/models.json` 中的 Provider；保留现有 Providers 页面 |
| OpenCode | Agent owned | 检测 OpenCode 配置；提供安装、路径、诊断和打开配置入口，不写 Pi 配置 |
| Codex | Agent owned | 检测 CLI/ACP 与认证状态；展示对应设置入口 |
| Claude Code | Agent owned | 检测 CLI/ACP 与认证状态；展示对应设置入口 |
| Cursor | Agent owned | 检测 CLI/ACP 与认证状态；展示对应设置入口 |

OpenCode 的 Provider、模型、MCP 和认证继续由 OpenCode 自己的配置文件或命令管理。只有 OpenCode adapter 明确提供结构化配置 API 后，CodeBridge 才能通过 adapter 写入；禁止 Web 直接猜测并改写第三方配置格式。

## 6. 安装与诊断安全

安装策略是发布时内置的 allowlist，不接受服务端或用户输入拼接任意命令：

```ts
interface InstallStrategy {
  id: string;
  label: string;
  command: string;
  args: string[];
  available: boolean;
  requiresConfirmation: true;
}
```

要求：

1. 执行前展示完整命令、安装目标和来源，用户逐次确认。
2. 使用 `spawn(command, args, { shell: false })`，禁止 `exec` 和 shell 字符串拼接。
3. 安装完成后重新运行 adapter 的 detect/configure/health 探针。
4. UI 显示真实退出码、stderr 摘要和修复建议；不得只显示 `setup_failed`。
5. 日志对 token、API key、Authorization 和常见凭据格式做脱敏。
6. 页面加载时只做只读检测，绝不自动安装、升级或修改配置。

## 7. 默认 Agent

默认 Agent 是 CodeBridge 配置中的持久化字段，不使用浏览器 localStorage 作为事实来源。配置 schema 的候选值来自 Registry，不再使用固定枚举。

API：

```text
GET   /v1/agents
      → agents + default_agent_id + effective_default_agent_id

PATCH /v1/settings/default-agent
      { agent_id }
      → 保存前验证 can_select_default
```

保存规则：

- 未安装：`409 agent_not_installed`
- 未完成配置：`409 agent_not_configured`
- 未注册：`404 agent_not_found`
- 更新失败：返回真实持久化错误，不修改当前默认值

启动选择顺序：

1. URL 明确指定的有效 Session/Agent，用于深链恢复。
2. `effective_default_agent_id`。
3. Registry 顺序中第一个 `can_select_default` 的 Agent。
4. 没有候选时不自动选中，展示“安装或配置 Agent”空状态。

刷新普通工作台时，默认 Agent 优先于上一次临时浏览的 Agent。进入默认 Agent 后，使用现有 `codebridge:last-session:{agentId}` 恢复该 Agent 上次 Session；若 Session 不存在，则进入该 Agent 空 Session 状态。

如果保存的默认 Agent 后来被卸载或配置失效，服务端保留 `default_agent_id` 作为诊断事实，但返回其他可用 Agent 作为 `effective_default_agent_id`。设置页显示“默认 Agent 当前不可用”，不静默改写用户配置。

## 8. UI 交互

### 8.1 Rail

- `healthy`：正常选择和创建 Session。
- `unavailable`：可进入查看历史与诊断，创建和发送禁用。
- `needs_setup`：可进入 Setup 空状态，不能创建 Session。
- 状态通过 tooltip 和文字表达，不新增常驻小圆点。

### 8.2 设置页 / AGENTS

每张 Agent 状态卡展示：

```text
Agent 名称
安装状态 · 版本
配置状态
运行状态或真实错误
[安装/重新检测] [配置] [设为默认]
```

- “设为默认”只对 `can_select_default` 候选启用。
- 当前默认显示文字标记，不只使用颜色。
- OpenCode 未安装时主动作是“安装 OpenCode”；安装后若配置不足，主动作切换为“配置 OpenCode”。
- Pi 的“配置”进入现有 Providers(Pi)；其他 Agent 进入各自 setup adapter 提供的入口。

### 8.3 错误反馈

安装或配置错误必须留在当前 Agent 卡片/弹层内，包含：

- 稳定错误码；
- 人类可读 message；
- adapter 返回的安全 details；
- 失败阶段：detect / install / configure / health；
- “重新检测”动作。

全局 toast 只能做摘要，不能成为唯一错误载体。

## 9. 数据流

```text
Workbench / Settings
  → Bridge Agent Setup API
    → Agent Registry
      → adapter manifest
      → Runner Host detect/install/configure/health
        → local executable and agent-owned config
```

Bridge 保存默认 Agent ID 和非敏感 Setup 投影。Runner Host 负责本机命令、文件和凭据。Bridge 不读取或持久化第三方 Agent 的 API key。

安装/配置状态变化后：

1. Runner 返回最新 SetupState。
2. Registry 更新 AgentProfile 投影。
3. Web 重新获取 Agent 列表。
4. 模型和运行控件只从最新 adapter capabilities 生成。

## 10. 验收标准

1. 未安装 OpenCode 时，Rail 可进入 Setup 状态，设置页显示安装动作和检测错误。
2. OpenCode 安装后重新检测，状态从 `missing` 进入 `needs_configuration` 或 `ready`。
3. Pi、Codex、Claude Code、Cursor 复用同一状态卡和 manifest 契约。
4. 未安装或未配置 Agent 的“设为默认”不可用；API 绕过 UI 也会拒绝。
5. 设置 Pi 为默认后刷新工作台，进入 Pi 并恢复 Pi 上次 Session。
6. 普通 Rail 临时切换不改写默认 Agent。
7. 默认 Agent 被卸载后，工作台使用有效默认回退并展示原因，不静默覆盖保存值。
8. OpenCode 配置动作不会读取或修改 `~/.pi/agent/models.json`。
9. 安装失败时页面显示退出码和脱敏 stderr，不只显示通用错误码。
10. Setup 与默认路由测试证明发送给 Agent 的 Prompt 字节未发生变化。

## 11. 非目标

- 不做第三方 Agent 商店。
- 不自动升级 Agent。
- 不统一托管所有第三方凭据。
- 不为每个模型厂商新增 Agent。
- 不允许用户在 Web 中提交任意安装命令。
- 不因默认 Agent 设置而迁移或合并已有 Session。
