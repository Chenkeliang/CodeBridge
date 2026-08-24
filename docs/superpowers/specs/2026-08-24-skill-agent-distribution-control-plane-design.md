# Skill Agent 分发控制面设计

- Status: Review draft
- Date: 2026-08-24
- Scope: 本机个人版 CodeBridge；Codex / Claude Code / Cursor / OpenCode / Pi
- Related:
  - `docs/orchestration/DESIGN.md`
  - `docs/spec/RULES.md`
  - `docs/superpowers/specs/2026-08-24-mcp-agent-configuration-control-plane-design.md`

## 0. 定案

Skill 是可被 Agent 发现的本机能力包，不是 Flow，也不是 MCP Server。CodeBridge 增加一个与 Flow 平级的 Skill 一级管理面，用于统一发现、搜索、登记和向不同 Agent 分发 Skill。

V1 采用“CodeBridge 私有实体目录、Agent 原生目录软链投影”的模型：

```text
CodeBridge Skill Store（包含 SKILL.md）
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
7. `~/.agents/skills` 是外部共享目录，不是 CodeBridge 受管 Skill 的默认实体目录，也不是 CodeBridge 的分发 Target。
8. Agent 是否额外读取其他兼容目录属于该 Agent 原生行为；CodeBridge 的开关只表达是否向所选 Agent 的原生 Target 创建直接投影。

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
9. 将用户自有的 Agent 原生 Skill 明确纳管到 CodeBridge Store，并保留原 Agent 的可用入口。
10. 区分“CodeBridge 已直接分发”和“Agent 可能通过原生兼容机制发现”，不把后者算作 CodeBridge Assignment。

V1 不包含：

- 在线 Skill 市场；
- Git clone、pull 或自动升级；
- 批量 Apply；
- 自动修改 Skill 内容；
- Agent 进程热加载协议；
- Skill 级 ACL；
- 把 Skill 自动批准为 Flow Capability。

这些入口不得以可点击但无后端闭环的形式出现在生产页面。

## 2. Store、外部 Source 与 Target

### 2.1 CodeBridge Skill Store

CodeBridge 受管 Skill 的唯一实体根目录是：

```text
~/.codebridge/skills/<skill_id>/SKILL.md
```

规则：

- `<skill_id>` 是稳定、唯一、路径安全的目录名；
- 一个受管 Skill 只有一份实体内容；
- Agent 原生目录只保存指向 Store 的 CodeBridge 软链；
- Skill 内容更新直接发生在 Store，所有已分发 Agent 读取同一份内容；
- Store 不放在任何 Agent 的默认发现根目录中，保证按 Agent 启停真实有效。

### 2.2 外部 Source

Runner 还扫描以下只读来源：

- `~/.agents/skills`：多个兼容 Agent 默认读取的共享广播目录；
- 五个目标 Agent 的原生 Skill 目录；
- 用户明确登记的额外 Source。

额外 Source 可以是：

- 自身包含 `SKILL.md` 的单个 Skill 目录；
- 直接子目录包含 `SKILL.md` 的 Skill 集合目录。

外部 Source 默认只读观察，不复制、不移动、不接管。只有用户明确执行 Adopt，才迁入 CodeBridge Store。

### 2.3 Target Adapter

V1 的目标路径由 Runner 侧静态 Adapter 定义：

| Agent | Target root |
| --- | --- |
| Codex | `~/.codex/skills` |
| Claude Code | `~/.claude/skills` |
| Cursor | `~/.cursor/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Pi | `~/.pi/agent/skills` |

Web 不维护这些路径。以后 Agent 路径变化时只改 Runner Adapter。

CodeBridge 只对 `targetRoot` 的直接投影负责。Adapter 可以报告已知兼容目录作为提示信息，但兼容目录不参与 Assignment 开关状态计算，也不作为写入目标。

### 2.4 共享广播目录语义

位于 `~/.agents/skills/<name>` 的 Skill 作为外部共享 Source 只读展示：

- CodeBridge 不自动迁移、删除或向该目录创建软链；
- 某些 Agent 可能原生发现它，但这不产生 CodeBridge Assignment；
- 删除 Agent 原生 Target 中的 CodeBridge 软链，只表示取消直接分发，不承诺阻止 Agent 从其他兼容目录发现；
- 如果用户需要逐 Agent 控制，必须先将该 Skill Adopt 到 CodeBridge Store；
- Adopt 后不在 `~/.agents/skills` 保留回链，而是按用户选择逐个创建 Agent 原生软链。

## 3. Catalog 记录

```ts
type SkillSourceKind = "codebridge_managed" | "shared_broadcast" | "agent_native" | "external";
type SkillProjectionState =
  | "linked"
  | "absent"
  | "conflict"
  | "broken"
  | "native";

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

- 受管 Skill 的 `id` 使用 `<skill_id>`；外部 Source 的观察 ID 基于真实路径生成。
- `revision` 基于 `SKILL.md` 内容生成，不读取或散列凭据。
- `name` / `description` 优先读取 frontmatter，缺失时使用目录名和空说明。
- 同一真实路径只返回一条 Catalog 记录。
- 同名不同真实路径是两条候选记录；向同一 Target 投影时形成目标名称冲突。
- 有效名称以标准化后的 frontmatter `name` 为准；只改目录别名不能消除同名 frontmatter 冲突。

## 4. 状态语义

| 状态 | 含义 | 可执行动作 |
| --- | --- | --- |
| `linked` | 目标是软链，解析后等于 Source，`SKILL.md` 可读 | 移除 |
| `absent` | 目标路径不存在 | 分发 |
| `conflict` | 目标存在但不指向 Source | 查看冲突；禁止覆盖 |
| `broken` | 目标是无法解析的软链 | 查看；仅在确认其属于本次 Source 时处理 |
| `native` | Source 本身位于该 Agent 目录且不是受管软链 | 只读观察；禁止删除 |

“已验证”在 V1 只表示所选 Agent Target 中的直接投影存在且 `SKILL.md` 可读。页面文案使用“已直接分发”，不使用“Agent 不可能从其他位置发现”或“Agent 已加载”。

硬约束：

```text
一个 Agent Target + 一个有效 Skill 名称 = 最多一个 CodeBridge 投影 Source
```

如果同一 Target 路径已被普通目录、文件或其他 Source 软链占用，状态必须为 `conflict`，不得覆盖。Agent 自己对其他兼容目录的发现和优先级不属于 Assignment 冲突裁决范围。

## 5. 写操作

### 5.1 登记外部 Source

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

登记仅增加只读发现来源，不等价于 Adopt，也不获得移动、覆盖或删除权限。

### 5.2 Adopt 原生或外部 Skill

`POST /v1/skills/:skill_id/adopt/preview` 返回：

- 原 Source、目标 Store 路径；
- 同名和 revision 冲突；
- 受影响 Agent 与当前可见路径；
- 将执行的移动、复制、软链和回滚动作。

确认 Apply 后：

1. 将用户自有实体迁入 `~/.codebridge/skills/<skill_id>`；
2. 写后验证 `SKILL.md` 和 revision；
3. 原 Agent 原生路径替换成指向 Store 的受管软链；
4. 按用户选择为其他 Agent 创建软链；
5. 如果来源是 `~/.agents/skills`，不在原共享位置创建回链；
6. 保存原始来源、revision、文件元数据和回滚 provenance。

系统、插件、企业策略、权限不明和未知外部软链不得 Adopt。

`POST /v1/skills/:skill_id/adopt/apply` 仅接受未过期的 preview ID；Apply 前必须重新校验 Source revision 和目标占用状态。

### 5.3 分发预览

`POST /v1/skills/assignments/preview`

```json
{ "skill_id": "...", "agent_id": "codex", "enabled": true }
```

返回 `create_link | remove_link | noop | conflict`、Source、Target 和当前直接投影状态。冲突预览不允许 Apply。

### 5.4 分发 Apply

`POST /v1/skills/assignments/apply`

请求与预览相同。规则：

- `enabled=true` 只在 Target 不存在时创建目录软链；
- 已正确链接时幂等返回 `noop`；
- `enabled=false` 只移除仍指向该 Source 的软链；
- 普通目录、文件、不同软链和 Agent native Source 一律拒绝；
- 写后重新读取 Target，返回真实状态。

### 5.5 同名冲突处理

安全默认是保留当前生效 Source，不执行写入。用户可以：

1. 保留当前；
2. Adopt 当前外部 Source；
3. 用新 `<skill_id>` 另存，并保证 frontmatter 有效名称也不同；
4. 查看语义 Diff 后替换受管 Source；
5. 忽略外部候选。

名称与 revision 都相同则在 Catalog 中去重展示；名称相同但 revision 不同不得静默覆盖同一 Target。

### 5.6 取消纳管

取消纳管必须由用户选择恢复目的地。Runner 移除仍指向 Store 的 CodeBridge 软链，将实体恢复到已确认的目的地，验证后删除管理记录。目标已变化、仍有其他 Agent 使用或恢复路径冲突时停止，不猜测处理。

## 6. 页面

Skill 使用 60px Agent Rail 中的一级入口，不放进设置页，不使用 Session Panel。

页面四个视图：

1. **技能目录**：指标、搜索、来源/状态筛选、目录卡和详情抽屉。
2. **Agent 分发**：Skill × Agent 矩阵；单元格显示直接投影 observed state 和待应用开关。
3. **软链对账**：冲突、断链、外部共享 Source、目标路径和恢复提示。
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
- Runner 返回结构化错误码：`skill_not_found`、`skill_source_invalid`、`skill_target_unknown`、`skill_target_conflict`、`skill_adopt_forbidden`、`skill_unlink_forbidden`。

## 8. 安全与恢复

- 所有路径先 `realpath` 或按父目录规范化，再进行包含关系判断。
- 软链目标名称来自 Source 目录名；拒绝空值、`.`、`..` 和路径分隔符。
- 不调用 shell 创建/删除链接，使用 Node `fs.symlink` / `fs.unlink`。
- Apply 前重复计算 preview，避免检查后目标被外部修改。
- 失败后不伪造 desired state；Web 重新扫描并展示 observed state。
- 删除动作不递归、不使用 `rm -rf`。
- Adopt 使用同文件系统原子 rename；跨文件系统使用 copy、fsync、revision 验证后再切换，任一步失败必须保留原 Source。
- 迁移前后都检查 Source/Target hash；发生并发修改时返回冲突。
- CodeBridge 必须保存软链 ownership 和迁移 provenance，不能仅凭路径位于 Agent 目录就判断可删除。

## 9. 验收

1. Web Skill 入口可达，Flow、Agent、设置入口无回归。
2. CodeBridge Store、共享广播目录、额外 Source 和 Agent native 目录均可发现真实 Skill。
3. 搜索与筛选使用服务端返回的真实记录。
4. 分发前展示 Source、Target 和动作。
5. Apply 后真实创建软链并返回 `linked`；重复 Apply 幂等。
6. Disable 只移除同 Source 受管软链，外部目录和不同软链均拒绝。
7. 断链与冲突不会被自动覆盖或删除。
8. Bridge 没有本机 Skill 文件读写代码。
9. 1440、960、720 宽度下外层无横向溢出，矩阵局部滚动。
10. 合同测试、Runner 文件系统测试、Web 活跃表面测试和构建全部通过。
11. 共享目录中的 Skill 作为外部 Source 展示，不自动产生任何 Agent Assignment。
12. 同一 Target 出现同名不同 Source 时显示 `conflict`，不覆盖目标。
13. Adopt 后实体位于 Store，原 Agent 路径为受管软链；取消纳管可以按 provenance 安全恢复。

## 10. 明确非目标

V1 不阻止 Agent 原生读取其他产品的兼容目录。例如 Cursor 可能读取 Claude 或 Codex 的 Skill 目录。CodeBridge 的关闭动作只移除所选 Agent Target 中由 CodeBridge 创建的直接软链，不修改其他 Agent 目录，也不声称目标 Agent 在所有原生发现路径中绝对不可见该 Skill。
