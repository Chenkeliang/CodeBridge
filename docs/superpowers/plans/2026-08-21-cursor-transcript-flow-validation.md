# 真实经验 → 通用 Flow 验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不依赖特定 Session、UUID、文件路径或业务固定值，且不执行任何线上写操作的前提下，从真实 Agent 工作过程提炼一个参数化 Runbook，并证明其完整 Flow 生命周期和跨入口调用成立。

**Architecture:** 真实 Session 只用于人工确认业务步骤，仓库只保存匿名、参数化的 Flow fixture。执行复用现有 Catalog、Review、Runtime、Web 和通道控制器；新增能力仅位于既有 `demo` 内存适配器中，不连接业务网络、数据库、缓存或线上 Adapter。

**Tech Stack:** TypeScript、Vitest、CodeBridge Flow Catalog/Runtime/Policy、React Workbench、Computer Use。

---

## 硬边界

- 不读取或依赖固定 Cursor Session UUID；本机已有 Guide 只作为人工参考。
- Flow 中不得出现原 Session ID、原路径、真实订单号或 PID。
- 不建设 Cursor 导入器、LLM 服务、provenance migration 或新管理页面。
- 不调用任何线上写接口，不执行 upsert、缓存清理、SPU/depot/商品更新。
- 仅 `published + runbook` 可正式执行；Candidate 只 Dry-run。
- Telegram 本轮不启用，只记录后续收尾。

## Task 1：最小内存业务能力

**Files:**
- Modify: `packages/policy/src/demo-capabilities.ts`
- Modify: `packages/policy/src/demo-capabilities.test.ts`

- [x] 先写失败测试：同一个参数化流程用两组不同 `product_ids` 和目标值执行。
- [x] 增加 `demo.catalog.inspect`、`demo.catalog.plan_change`、`demo.catalog.simulate_apply`、`demo.catalog.verify`。
- [x] 所有能力只处理进程内数据；`simulate_apply` 必须明确返回 `simulation: true`。
- [x] 运行 policy 单测和类型检查。

## Task 2：真实 Flow 生命周期证明

**Files:**
- Create: `apps/bridge/src/flow-goal-validation.test.ts`

- [x] 使用匿名参数化定义创建 Candidate Runbook。
- [x] 通过真实 `/messages` 执行 Candidate Dry-run，并以真实事件作为 Review 证据。
- [x] 通过真实 `/review` 发布，再由 Runtime 用两组不同输入执行。
- [x] 断言两个 Run 均成功、输入冻结正确、结果含 `simulation: true`，Catalog 可消费列表只出现 Published Runbook。
- [x] 断言测试过程中没有 HTTP、数据库业务写或 Shell 更新能力。

## Task 3：本机真实界面与飞书入口验收

- [x] 构建并重启本机 CodeBridge，使 demo 内存能力可见。
- [x] 用 Computer Use 在 Web 完成：发现参考 Guide、创建/保存 Candidate、Dry-run、Review 发布、发现并执行、查看结果回流。
- [x] 使用两组不同输入重复执行同一 Published Runbook。
- [x] 用飞书 `/flow` 完成列出、选择、填参、确认并显式调用；不依赖 Session binding。
- [x] 若界面暴露真实缺陷，先增加回归测试，再做最小修复并复验。

## 完成门禁

- [x] `pnpm vitest run packages/policy/src/demo-capabilities.test.ts apps/bridge/src/flow-goal-validation.test.ts`
- [x] `pnpm lint`
- [x] GitNexus `detect-changes` 覆盖预期 Flow/Policy/Session/Channel 流程；HIGH 合同风险已用全量测试复核。
- [x] 仓库扫描不包含参考 UUID、真实 PID/订单号或用户绝对路径。
- [x] Web 与飞书均有用户可见终态证据；Telegram 记录为后续项。
