# Skill 共享目录控制面实施计划

> 按 `executing-plans` 逐项实施；每项先写失败测试，再写最小实现。

**目标：** 将现有 Skill 控制面归一为 `~/.agents/skills` 唯一启用实体目录，并让 Web 安全管理全局启停、Claude 适配软链、外部 Skill Adopt、冲突与恢复。

**第一性原理：** 文件系统是 Observed State；CodeBridge 只保存 Desired State、ownership、短期 plan 和 transaction journal。Codex / Cursor / OpenCode / Pi 原生读取共享目录，只跟随全局启停；Claude Code 通过 CodeBridge-owned symlink 独立分发。任何 Apply 必须绑定 Preview 时观察到的事实并在写后重扫。

**技术栈：** TypeScript、Node.js filesystem、Hono、React、Vitest。

## 交付边界

- V1 包含：共享/停用目录扫描、完整包 Revision、身份校验、全局启停、Claude 分发、外部 Skill Adopt、预览令牌、ownership、transaction journal、冲突展示与恢复。
- V1 不包含：Git、市场、自动升级、永久删除、批量 Apply、Agent 热加载、Skill ACL、MCP 管理。
- 不修改 Flow、Runtime、Agent 执行或飞书/Telegram 链路。

## Task 1：后端领域模型与完整包指纹

**文件：** `packages/backends/src/skill-control-plane.ts`、`packages/backends/src/skill-control-plane.test.ts`、`packages/backends/src/index.ts`

- [ ] 先写失败测试：身份三等式；完整包 Revision；active/disabled split-brain；shared-native 与 symlink-projection 两种 delivery mode。
- [ ] 运行 `pnpm vitest run packages/backends/src/skill-control-plane.test.ts`，确认新断言失败。
- [ ] 将公开模型收敛为：

```ts
export type SkillGlobalState = "enabled" | "disabled" | "split_brain" | "external" | "invalid";
export type SkillDeliveryMode = "shared_native" | "symlink_projection";
export type SkillOwnership = "codebridge_managed" | "external_observed" | "native_managed";

export interface SkillTargetView {
  agent_id: SkillAgentId;
  delivery_mode: SkillDeliveryMode;
  state: "follows_global" | "linked" | "absent" | "conflict" | "broken";
  mutable: boolean;
  target_path: string;
  detail: string | null;
}
```

- [ ] 实现确定性目录遍历和完整包 SHA-256；哈希相对路径、文件内容、可执行位、内部软链目标；拒绝越界软链、特殊文件及身份不一致。
- [ ] 运行后端测试并确认通过。

## Task 2：Desired State、Preview 令牌与事务写入

**文件：** `packages/backends/src/skill-control-plane.ts`、`packages/backends/src/skill-control-plane.test.ts`

- [ ] 为 plan 过期、actor 不匹配、package/source/target 指纹变化、状态丢失、重复 Apply 写失败测试。
- [ ] 在 `<dataDir>/skills/` 持久化 `ownership.json`、`assignments.json`、`plans.json`、`transactions.json`。
- [ ] 实现有时效的 plan：

```ts
export interface SkillMutationPlan {
  plan_id: string;
  actor_id: string;
  kind: "global_state" | "assignment" | "adopt" | "unmanage";
  skill_id: string;
  package_revision: string;
  source_fingerprint: string;
  target_fingerprint: string;
  expires_at: string;
  steps: SkillMutationStep[];
  can_apply: boolean;
}
```

- [ ] `apply(plan_id, actor_id)` 重新验证全部事实，不接受客户端重传 mutation input。
- [ ] 全局停用原子移动到 `skills-disabled` 并移除 CodeBridge-owned Claude link；重新启用时按 desired assignment 恢复。
- [ ] Adopt：共享目录内条目只登记 ownership；Claude/外部条目移动到共享目录并在原位置回链；冲突不覆盖。
- [ ] 写操作先记 pending transaction，写后重扫再标 completed；异常保留 journal。
- [ ] 运行后端测试并确认通过。

## Task 3：Runner、Bridge 与 Web API 合同

**文件：** `packages/runner-host/src/server.ts`、`packages/runner-host/src/server.test.ts`、`packages/runner-client/src/index.ts`、`packages/runner-client/src/index.test.ts`、`apps/bridge/src/skill-api.ts`、`apps/bridge/src/skill-api.test.ts`、`apps/web/src/lib/types.ts`、`apps/web/src/lib/api.ts`、`apps/web/src/lib/api.test.ts`

- [ ] 对 `RunnerHost`、`RunnerClient`、`createSkillApp` 分别做 upstream impact；HIGH/CRITICAL 时先停下报告。
- [ ] 先写失败合同测试：鉴权、actor 传递、404 plan、409 facts changed、422 invalid package、503 Runner unavailable。
- [ ] 以 Accepted spec 的路径替换旧直接 Apply：

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

- [ ] Bridge 只做鉴权、输入验证和 Runner 代理，不推导路径、不判断冲突、不写文件。
- [ ] 运行 Runner/Client/Bridge/Web API 聚焦测试。

## Task 4：Web 活跃表面

**文件：** `apps/web/src/components/skill-control-plane.tsx`、`apps/web/src/components/skill-control-plane.test.tsx`

- [ ] 对 `SkillControlPlanePage` 做 upstream impact。
- [ ] 先写失败交互测试：共享原生 Agent 仅显示“跟随全局”；Claude 有独立开关；全局启停 Preview→Apply；409 刷新；冲突可见；external 可 Adopt；受管 Skill 可取消纳管但不删除内容。
- [ ] 重构页面为“目录 / 分发 / 冲突 / 活动”四视图，所有写操作复用统一 Preview 对话框。
- [ ] 保留一级导航与响应式布局，只有矩阵内部允许横向滚动。
- [ ] 运行 Web API、页面、导航与 component-policy 测试。

## Task 5：对抗验证与提交

- [ ] 阅读并执行 `verification-before-completion`。
- [ ] 运行聚焦 Vitest 与五个受影响 package build。
- [ ] 用临时 HOME 验证：重复 Apply、状态丢失、目录占用、外部换链、断链、split-brain、Preview 后包变化、重启恢复。
- [ ] 在 `/workbench/` 验证 1440 / 960 / 720 三档，无页面级横向溢出。
- [ ] 运行 `npx gitnexus detect-changes -r CodeBridge --scope all`；出现 Flow/Runtime/Channel 执行链影响则停止提交。
- [ ] 仅提交本计划列出的文件，不包含现有 `AGENTS.md`、`.claude/`、生成物或无关 Flow 文档。

建议提交拆分：

1. `feat(skills): adopt shared skill directory model`
2. `feat(skills): expose transactional skill operations`
3. `feat(web): manage shared skills and claude projections`
