# Skill Agent 分发控制面设计

- Status: Review draft
- Date: 2026-08-24
- Scope: 本机个人版 CodeBridge；Codex / Claude Code / Cursor / OpenCode / Pi
- Related:
  - `docs/orchestration/DESIGN.md`
  - `docs/spec/RULES.md`
  - `docs/superpowers/specs/2026-08-24-mcp-agent-configuration-control-plane-design.md`

## 0. 定案摘要

Skill 是可被 Agent 发现的本机能力包，不是 Flow，也不是 MCP Server。

CodeBridge 使用市场兼容度最高的 `~/.agents/skills` 作为唯一启用实体目录：

```text
~/.agents/skills/<skill_id>/              # 已启用 Skill 实体
~/.agents/skills-disabled/<skill_id>/     # 已停用 Skill 实体

~/.codebridge/state/                      # ownership、assignment、transaction
```

分发规则：

1. Codex、Cursor、OpenCode、Pi 等原生读取 `~/.agents/skills` 的 Agent 自动获得其中全部 Skill，不创建重复软链接，也不提供虚假的逐 Agent关闭能力。
2. Claude Code 等不读取共享目录的 Agent，由 Target Adapter 在其原生目录创建或移除软链接。
3. 全局停用把 Skill 原子移动到 `~/.agents/skills-disabled`，并移除 CodeBridge 拥有的适配软链接；重新启用时移回并恢复期望分发。
4. CodeBridge 退出、重启或暂时不可用，不影响已启用 Skill 和现有软链接。
5. Agent 自己额外读取其他兼容目录属于 Agent 原生行为，不纳入 CodeBridge Assignment 的关闭承诺。
6. CodeBridge 不拥有整个 `~/.agents/skills`，只管理自己创建或用户明确 Adopt 的条目。
7. Skill、MCP 和 Flow 保持独立领域语义：Skill 分发知识包，MCP 配置工具连接，Flow 由 Runtime 确定性执行。

## 1. 第一性原理模型

系统只有三个核心事实：

```text
Skill Package      文件系统中的唯一内容
Desired State      CodeBridge 保存的管理意图
Observed State     共享目录和 Agent Target 的真实状态
```

必须始终成立：

- Skill 内容没有 CodeBridge 私有副本和 Agent 副本；
- Desired State 不冒充文件系统写入成功；
- 只有写后重新扫描才能更新 Observed State；
- 任何删除、移动或取消链接都必须先证明 CodeBridge ownership；
- 外部修改产生漂移时不静默覆盖。

## 2. V1 用户目标

用户可以在 Web 中：

1. 发现共享目录、停用目录和各 Agent 原生目录中的真实 Skill。
2. 按名称、说明、来源、全局状态和分发状态搜索、筛选。
3. 创建或导入一个完整 Skill Package。
4. 将用户自有的外部 Skill 明确 Adopt 到共享目录。
5. 全局启用或停用受管 Skill，不删除内容。
6. 为需要适配的 Agent 创建、移除或修复软链接。
7. 预览所有移动、链接、受影响 Agent 和冲突后再 Apply。
8. 查看断链、目标占用、外部替换、版本变化和恢复提示。
9. 取消纳管但保留 Skill 内容和 Agent 可用性。

V1 不包含：

- 在线 Skill 市场；
- Git clone、pull 或自动升级；
- 批量 Apply；
- 自动修改 Skill 内容或 frontmatter；
- Agent 热加载协议；
- Skill 级 ACL；
- 永久删除 Skill；
- 阻止 Agent 原生读取其他兼容目录；
- 把 Skill 自动批准为 Flow Capability。

## 3. 文件系统布局

### 3.1 启用目录

```text
~/.agents/skills/<skill_id>/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

目录存在即表示该 Skill 对所有原生读取 `~/.agents/skills` 的 Agent 全局启用。

### 3.2 停用目录

```text
~/.agents/skills-disabled/<skill_id>/
```

它是 CodeBridge 的可恢复停用区，不是 Agent 发现目录。停用是移动，不是删除。

如果启用目录和停用目录同时出现相同 `<skill_id>`，状态为 `split_brain`，禁止自动合并或覆盖。

### 3.3 CodeBridge 状态目录

```text
~/.codebridge/state/
├── skill-index.json
├── skill-assignments.json
└── transactions/
```

- `skill-index.json` 保存 ownership、provenance 和最近观察到的 package revision；
- `skill-assignments.json` 只保存需要适配的 Agent 期望分发；
- `transactions/` 保存 Adopt、启停和恢复操作的持久事务日志。

状态文件丢失时，所有条目降级为 `external_observed`。CodeBridge 不根据路径猜测 ownership，也不删除任何内容或链接。

## 4. Agent 分发模型

### 4.1 Target Adapter

| Agent | Delivery mode | Native target | V1 开关语义 |
| --- | --- | --- | --- |
| Codex | `shared_native` | `~/.agents/skills` | 跟随 Skill 全局启停 |
| Cursor | `shared_native` | `~/.agents/skills` | 跟随 Skill 全局启停 |
| OpenCode | `shared_native` | `~/.agents/skills` | 跟随 Skill 全局启停 |
| Pi | `shared_native` | `~/.agents/skills` | 跟随 Skill 全局启停 |
| Claude Code | `symlink_projection` | `~/.claude/skills` | 独立创建/移除受管软链接 |

以后 Agent 的发现路径变化，只修改 Runner Target Adapter。Web 不硬编码目录。

### 4.2 共享原生 Agent

`shared_native` Agent 不创建 Assignment 软链接。页面状态只显示：

- `available_shared`：Skill 位于启用目录；
- `suspended_global`：Skill 位于停用目录；
- `external_visibility_possible`：Agent 可能从其他兼容目录发现，仅作为提示。

### 4.3 软链接适配 Agent

`symlink_projection` Agent 使用独立 Assignment：

```text
~/.claude/skills/<skill_id>
  → ~/.agents/skills/<skill_id>
```

全局停用时保留 Assignment 的 `desiredState = linked`，但移除真实软链接并显示 `suspended_global`。重新启用后按 Assignment 恢复软链接。

## 5. Skill 身份、版本和所有权

### 5.1 身份不变量

受管 Skill 必须满足：

```text
skill_id
= Package 目录名
= frontmatter.name
= Agent Target 软链接名
```

页面显示标题可以独立存在，但不参与身份、冲突和分发。

### 5.2 Package Revision

`packageRevision` 不能只散列 `SKILL.md`。它由标准化 Package Manifest 计算，至少覆盖：

- 所有受管文件的相对路径；
- 文件内容；
- executable 权限位；
- Package 内部软链接的相对目标。

CodeBridge 元数据、缓存、日志和临时文件不参与 revision。Skill Package 禁止保存凭据、`.env` 或 token 文件。

### 5.3 所有权

```ts
type SkillOwnership =
  | "codebridge_managed"
  | "external_observed"
  | "native_managed";
```

- `codebridge_managed`：CodeBridge 创建，或用户明确 Adopt；
- `external_observed`：用户或其他工具创建，默认只读；
- `native_managed`：Agent、插件、系统或企业策略管理，永远只读。

取消纳管只把 `codebridge_managed` 改为 `external_observed`，不移动或删除 Package。

## 6. 领域记录

```ts
interface SkillCatalogEntry {
  skillId: string;
  name: string;
  description: string | null;
  packageRevision: string;
  packagePath: string;
  globalState: "enabled" | "disabled" | "external" | "split_brain";
  ownership: SkillOwnership;
  provenance: {
    sourcePath?: string;
    adoptedAt?: string;
  };
  targets: SkillTargetObservation[];
}

interface SkillTargetObservation {
  agentId: string;
  deliveryMode: "shared_native" | "symlink_projection";
  targetPath: string;
  desiredState?: "linked" | "absent";
  observedState:
    | "available_shared"
    | "linked"
    | "absent"
    | "suspended_global"
    | "conflict"
    | "broken"
    | "detached"
    | "native";
  detail?: string;
}

interface SkillAssignment {
  skillId: string;
  lastAppliedPackageRevision: string;
  agentId: string;
  desiredState: "linked" | "absent";
  targetPath: string;
  createdLinkTarget?: string;
  createdAt: string;
  updatedAt: string;
}
```

Assignment 只用于 `symlink_projection` Agent。共享原生 Agent 的可用状态从 Package 全局位置直接计算。

Assignment 不固定 Skill 版本。软链接按设计跟随同一 Package 的最新内容；Package 更新后无需重新分发，只更新 Catalog 的 `packageRevision` 和 Assignment 的观察摘要。`lastAppliedPackageRevision` 仅用于审计和判断链接建立后内容是否变化。

## 7. Observed State

软链接适配 Target 使用：

| 状态 | 含义 |
| --- | --- |
| `linked` | 目标是受管软链接，解析后等于启用 Package，`SKILL.md` 可读 |
| `absent` | 目标不存在 |
| `suspended_global` | Assignment 期望链接，但 Package 当前全局停用 |
| `conflict` | 目标被其他文件、目录或不同软链接占用 |
| `broken` | 受管软链接无法解析 |
| `detached` | Assignment 存在，但外部安装器把受管链接替换成实体或其他目标 |
| `native` | Target 中存在外部原生 Skill，CodeBridge 只读观察 |

V1 的“已验证”只表示文件系统投影正确且 `SKILL.md` 可读，不声称运行中的 Agent 已热加载。

## 8. 写操作

所有写操作统一采用：

```text
Preview
  → plan_id
  → 绑定 actor、packageRevision、source fingerprint、target fingerprint、动作和过期时间
Apply(plan_id)
  → 任一事实变化返回 409
  → 持久事务
  → 写入
  → 重新扫描
  → 返回 Observed State
```

### 8.1 Adopt

#### 已在共享目录

如果 Package 已位于 `~/.agents/skills/<skill_id>`，Adopt 不移动内容，只记录 ownership、provenance 和 revision。

#### 位于 Agent 原生目录或外部目录

```text
原实体
  → staging
  → 校验 packageRevision
  → 移入 ~/.agents/skills/<skill_id>
  → 对需要保持入口的 symlink_projection Agent 创建软链接
  → 写后验证
```

同文件系统优先原子 rename；跨文件系统先 copy、fsync、revision 验证，再切换。任一步失败必须保留或恢复原 Source。

系统 Skill、插件 Skill、企业策略 Skill、权限不明 Source 和未知外部软链接不得 Adopt。

### 8.2 全局停用

```text
~/.agents/skills/<skill_id>
  → ~/.agents/skills-disabled/<skill_id>
```

事务同时：

1. 校验 ownership 和 packageRevision；
2. 检查停用目标不存在；
3. 移除 CodeBridge 拥有的适配软链接；
4. 原子移动 Package；
5. 保留 Assignment desired state；
6. 重新扫描并返回 `disabled / suspended_global`。

### 8.3 全局启用

执行停用的逆过程：移回启用目录，验证 revision，并按 Assignment 恢复适配软链接。

### 8.4 适配 Agent 分发

- `desiredState = linked`：仅在目标不存在时创建目录软链接；
- 已正确链接时幂等返回 `noop`；
- `desiredState = absent`：只移除 ownership 记录证明由 CodeBridge 创建且仍指向同一 Package 的软链接；
- 普通目录、文件、不同软链接和外部原生 Skill 一律拒绝覆盖或删除。

### 8.5 取消纳管

取消纳管不等于停用或删除：

1. 保留 Package 当前启用/停用位置；
2. 默认保留当前有效软链接；
3. 删除 CodeBridge ownership 和可写 Assignment；
4. 后续仅作为外部 Source 只读发现。

### 8.6 永久删除

V1 不提供永久删除。后续若实现，必须是独立危险操作，默认移动到系统废纸篓，不直接不可恢复删除。

## 9. 冲突处理

安全默认始终是保留当前，不执行写入。

### 9.1 同名导入

- 名称和 packageRevision 相同：去重或原地 Adopt；
- 名称相同但 revision 不同：展示完整 Package Diff，允许保留、替换或使用新合法名称导入；
- 修改名称必须由用户修改 Package，使目录名和 frontmatter.name 同时匹配；CodeBridge V1 不自动改内容。

### 9.2 启用/停用双实体

启用目录和停用目录同时存在相同 Skill 时进入 `split_brain`，禁止自动选择。用户必须查看 Diff 后保留一方或另存为新 Skill。

### 9.3 外部更新替换链接

CLI 或安装器把适配软链接替换成实体时显示 `detached`，提供：

- 接受外部更新：比较 Diff，将新内容作为共享 Package 的新 revision，再恢复软链接；
- 恢复共享版本：保留外部备份，再恢复软链接。

受 CodeBridge 管理的 CLI/Skill/MCP 能力包，其 Skill 安装和更新目标必须直接指向 `~/.agents/skills/<skill_id>`，避免产生脱离副本。

## 10. 持久事务与恢复

Adopt、全局启停和外部更新吸收使用持久阶段：

```text
planned
→ staged
→ source_switched
→ links_reconciled
→ verified
→ committed
```

Runner 重启后必须根据 transaction journal 安全继续或回滚，不能留下实体丢失、半数链接更新或状态假成功。

## 11. API

```text
GET  /v1/skills
POST /v1/skills/sources

POST /v1/skills/:skill_id/adopt/preview
POST /v1/skills/adopt-plans/:plan_id/apply

POST /v1/skills/:skill_id/global-state/preview
POST /v1/skills/global-state-plans/:plan_id/apply

POST /v1/skills/assignments/preview
POST /v1/skills/assignment-plans/:plan_id/apply

POST /v1/skills/:skill_id/unmanage/preview
POST /v1/skills/unmanage-plans/:plan_id/apply
```

Bridge 不读取 Home 目录、不解析 `SKILL.md`、不移动文件、不创建软链接。所有本机文件操作只在 Runner 完成。

稳定错误码至少包括：

- `skill_not_found`
- `skill_package_invalid`
- `skill_identity_mismatch`
- `skill_target_unknown`
- `skill_target_conflict`
- `skill_split_brain`
- `skill_revision_mismatch`
- `skill_plan_expired`
- `skill_adopt_forbidden`
- `skill_unlink_forbidden`
- `skill_transaction_recovery_required`

## 12. Web 页面

Skill 与 Flow、MCP 平级，不放进设置页。

页面包含：

1. **技能目录**：启用、停用、外部、冲突和版本摘要；
2. **Agent 分发**：共享原生 Agent 显示“跟随全局”，适配 Agent 显示直接软链接开关；
3. **对账与恢复**：断链、detached、split-brain、事务恢复和 Package Diff；
4. **活动记录**：当前会话反馈。

页面必须区分：

- 全局启用/停用；
- 适配 Agent 软链接开关；
- 取消纳管；
- 永久删除（V1 不提供）。

持久 ownership、Assignment、provenance 和 transaction 不属于“活动记录”，即使活动页面 V1 不持久化，它们也必须持久化。

## 13. 安全规则

1. `~/.agents` 和 `~/.codebridge` 根目录默认权限不得放宽；
2. 所有路径规范化并进行目录包含关系判断；
3. 拒绝空名称、`.`、`..`、路径分隔符和身份不匹配；
4. 不调用 shell 创建/删除链接，使用文件系统 API；
5. 删除动作不递归、不使用 `rm -rf`；
6. Package 内软链接逃逸根目录时拒绝 Adopt；
7. Apply 前校验 plan 中所有 revision 和 fingerprint；
8. CodeBridge 只删除自己拥有且目标仍匹配的软链接；
9. 外部普通目录、文件和软链接默认只读；
10. 系统、插件和企业策略管理的 Skill 永远只读。

## 14. 验收标准

1. `~/.agents/skills` 是唯一启用实体目录，没有 CodeBridge Skill 内容副本；
2. 共享原生 Agent 不创建重复软链接，页面显示“跟随全局”；
3. Claude 等适配 Agent 可以创建、移除和修复 CodeBridge 软链接；
4. 全局停用原子移入 `skills-disabled`，内容不删除，适配链接被安全移除；
5. 全局启用移回并恢复期望适配链接；
6. Package revision 覆盖脚本、引用、资源和 executable 位；
7. 同名不同内容、split-brain、目标占用和 detached 都不会被静默覆盖；
8. Adopt、启停和恢复在 Runner 崩溃后可以继续或回滚；
9. 取消纳管保留内容和当前 Agent 可用性；
10. CodeBridge 退出后已启用 Skill 继续被 Agent 使用；
11. Bridge 和 Web 不直接读写本机 Skill 文件；
12. 合同测试、Runner 文件系统测试、Web 活跃表面测试和响应式布局验证全部通过。
