# Skill Agent 分发控制面设计

- Status: Accepted for implementation
- Date: 2026-08-24
- Scope: 本机个人版 CodeBridge；Codex / Claude Code / Cursor / OpenCode / Pi
- Related:
  - `docs/orchestration/DESIGN.md`
  - `docs/spec/RULES.md`
  - `docs/superpowers/specs/2026-08-24-mcp-agent-configuration-control-plane-design.md`

## 0. 定案

Skill 是可被 Agent 发现的本机能力包，不是 Flow，也不是 MCP Server。CodeBridge 增加一个与 Flow 平级的 Skill 一级管理面，用于统一发现、搜索、登记和向不同 Agent 分发 Skill。

V1 采用“源目录唯一、Agent 目录软链投影”的模型：

```text
Skill Source（包含 SKILL.md）
  → Runner 扫描与校验
  → CodeBridge Skill Catalog View
  → 用户预览分发变更
  → Runner 向目标 Agent 原生 Skill 目录创建/移除软链
  → Runner 对账目标路径与 SKILL.md 可读性
  → Web 展示 observed state
```

核心边界：

1. Runner 是本机文件、软链和第三方 Agent 目录的唯一读写者；Bridge 只代理 API。
2. Web 开关表达待应用的分发意图，不能直接冒充写入或加载成功。
3. V1 验证“目标 Agent 目录可见且 SKILL.md 可读”，不声称已运行的 Agent 进程完成热加载。
4. CodeBridge 只删除自己创建且仍指向同一 Source 的软链；绝不删除普通目录或外部软链。
5. 外部文件、目录或不同目标占用同名位置时返回冲突，不自动覆盖。
6. Skill、MCP 和 Flow 保持三套领域语义：Skill 分发知识包，MCP 配置工具连接，Flow 由 Runtime 确定性执行。

## 1. V1 用户目标

用户可以在 Web 中：

1. 从默认源目录和各 Agent 原生目录发现真实 Skill。
2. 按名称、说明、来源和状态搜索。
3. 选择一个包含 `SKILL.md` 的本机目录并登记为 Source。
4. 查看每个 Skill 在五个 Agent 上的投影状态。
5. 预览创建或移除软链的变更。
6. 确认后应用单个 Skill × Agent 分发动作。
7. 查看断链、目标冲突、不可读和待重启提示。
8. 刷新扫描并看到真实 observed state。

V1 不包含：

- 在线 Skill 市场；
- Git clone、pull 或自动升级；
- 批量 Apply；
- 自动修改 Skill 内容；
- Agent 进程热加载协议；
- Skill 级 ACL；
- 把 Skill 自动批准为 Flow Capability。

这些入口不得以可点击但无后端闭环的形式出现在生产页面。

## 2. Source 与 Target

### 2.1 默认 Source

Runner 默认扫描：

- `~/.agents/skills`：用户共享主目录；
- Runner 数据目录中的 `skill-sources.json`：用户明确登记的额外 Source；
- 五个目标 Agent 的原生 Skill 目录：用于发现外部原生 Skill 和对账。

额外 Source 可以是：

- 自身包含 `SKILL.md` 的单个 Skill 目录；
- 直接子目录包含 `SKILL.md` 的 Skill 集合目录。

只保存规范化绝对路径，不复制 Skill 内容。

### 2.2 Target Adapter

V1 的目标路径由 Runner 侧静态 Adapter 定义：

| Agent | Target root |
| --- | --- |
| Codex | `~/.codex/skills` |
| Claude Code | `~/.claude/skills` |
| Cursor | `~/.cursor/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Pi | `~/.pi/agent/skills` |

Web 不维护这些路径。以后 Agent 路径变化时只改 Runner Adapter。

## 3. Catalog 记录

```ts
type SkillSourceKind = "shared" | "adopted" | "agent_native";
type SkillProjectionState = "linked" | "absent" | "conflict" | "broken" | "native";

interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  source_path: string;
  source_kind: SkillSourceKind;
  revision: string;
  tags: string[];
  updated_at: string;
  targets: Array<{
    agent_id: "codex" | "claude" | "cursor" | "opencode" | "pi";
    target_path: string;
    state: SkillProjectionState;
    detail: string | null;
  }>;
}
```

规则：

- `id` 基于 Source 真实路径生成，目录移动后视为新的 Source。
- `revision` 基于 `SKILL.md` 内容生成，不读取或散列凭据。
- `name` / `description` 优先读取 frontmatter，缺失时使用目录名和空说明。
- 同一真实路径只返回一条 Catalog 记录。
- 同名不同真实路径是两条记录，并在目标投影时形成冲突。

## 4. 状态语义

| 状态 | 含义 | 可执行动作 |
| --- | --- | --- |
| `linked` | 目标是软链，解析后等于 Source，`SKILL.md` 可读 | 移除 |
| `absent` | 目标路径不存在 | 分发 |
| `conflict` | 目标存在但不指向 Source | 查看冲突；禁止覆盖 |
| `broken` | 目标是无法解析的软链 | 查看；仅在确认其属于本次 Source 时处理 |
| `native` | Source 本身位于该 Agent 目录且不是受管软链 | 只读观察；禁止删除 |

“已验证”在 V1 只等价于 `linked` 且目标 `SKILL.md` 可读。页面文案使用“目录可见”，不使用“Agent 已加载”。

## 5. 写操作

### 5.1 登记 Source

`POST /v1/skills/sources`

```json
{ "path": "/absolute/path/to/skill-or-collection" }
```

Runner 验证：

- 路径必须为绝对路径；
- 路径必须存在且可读；
- 自身或直接子目录至少存在一个 `SKILL.md`；
- 规范化后去重；
- 原子写入 `skill-sources.json`。

### 5.2 预览

`POST /v1/skills/assignments/preview`

```json
{ "skill_id": "...", "agent_id": "codex", "enabled": true }
```

返回 `create_link | remove_link | noop | conflict`、Source、Target 和当前 observed state。冲突预览不允许 Apply。

### 5.3 Apply

`POST /v1/skills/assignments/apply`

请求与预览相同。规则：

- `enabled=true` 只在 Target 不存在时创建目录软链；
- 已正确链接时幂等返回 `noop`；
- `enabled=false` 只移除仍指向该 Source 的软链；
- 普通目录、文件、不同软链和 Agent native Source 一律拒绝；
- 写后重新读取 Target，返回真实状态。

## 6. 页面

Skill 使用 60px Agent Rail 中的一级入口，不放进设置页，不使用 Session Panel。

页面四个视图：

1. **技能目录**：指标、搜索、来源/状态筛选、目录卡和详情抽屉。
2. **Agent 分发**：Skill × Agent 矩阵；单元格显示 observed state 和待应用开关。
3. **软链对账**：冲突、断链、目标路径和恢复提示。
4. **活动记录**：V1 只展示当前浏览器会话内的扫描与写操作反馈；持久审计后续单独设计。

响应式规则：

- 外层始终 `overflow-hidden` / `min-w-0`；
- Catalog 3→2→1 列；
- 分发矩阵最小宽度 1080px，只在矩阵容器内横向滚动；
- 详情抽屉最大宽度不超过 `100vw - 60px`；
- 720px 下顶部动作只显示图标并保留完整 `aria-label`。

## 7. API 与所有权

```text
Web
  → Bridge /v1/skills/*
  → RunnerClient
  → Runner Host /skills/*
  → SkillControlPlane
  → 本机 Source / Agent Target directories
```

- Bridge 不读取 Home 目录、不解析 `SKILL.md`、不创建软链。
- Web 不枚举 Target 路径，不推导状态。
- Runner 返回结构化错误码：`skill_not_found`、`skill_source_invalid`、`skill_target_unknown`、`skill_target_conflict`、`skill_unlink_forbidden`。

## 8. 安全与恢复

- 所有路径先 `realpath` 或按父目录规范化，再进行包含关系判断。
- 软链目标名称来自 Source 目录名；拒绝空值、`.`、`..` 和路径分隔符。
- 不调用 shell 创建/删除链接，使用 Node `fs.symlink` / `fs.unlink`。
- Apply 前重复计算 preview，避免检查后目标被外部修改。
- 失败后不伪造 desired state；Web 重新扫描并展示 observed state。
- 删除动作不递归、不使用 `rm -rf`。

## 9. 验收

1. Web Skill 入口可达，Flow、Agent、设置入口无回归。
2. 默认主目录、额外 Source 和 Agent native 目录均可发现真实 Skill。
3. 搜索与筛选使用服务端返回的真实记录。
4. 分发前展示 Source、Target 和动作。
5. Apply 后真实创建软链并返回 `linked`；重复 Apply 幂等。
6. Disable 只移除同 Source 受管软链，外部目录和不同软链均拒绝。
7. 断链与冲突不会被自动覆盖或删除。
8. Bridge 没有本机 Skill 文件读写代码。
9. 1440、960、720 宽度下外层无横向溢出，矩阵局部滚动。
10. 合同测试、Runner 文件系统测试、Web 活跃表面测试和构建全部通过。
