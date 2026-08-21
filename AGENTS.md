<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **CodeBridge** (8156 symbols, 18465 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/CodeBridge/context` | Codebase overview, check index freshness |
| `gitnexus://repo/CodeBridge/clusters` | All functional areas |
| `gitnexus://repo/CodeBridge/processes` | All execution flows |
| `gitnexus://repo/CodeBridge/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## 端到端交互验证（End-to-End Interaction Verification）

适用：任何涉及 Web、后端、Agent、飞书、Telegram 交互的功能或缺陷。

### 1. 四态判定

- **implemented**：存在支撑代码或 API；
- **reachable**：当前生产入口确实调用它。必须检查 active caller/renderer；休眠、遗留、preview-only、test-only 或未挂载组件不算；
- **closed-loop**：用户能完成交互并观察到终态；
- **planned**：spec 有要求且有明确任务归属，包括阶段和任务 ID。

spec 有要求但无任务归属，或判定停在 implemented 却声称可用，均为缺陷，必须上报。

### 2. 完整链路追踪

必须追踪完整生产链路：用户入口 → 客户端/通道适配 → API 合同 → 领域/Runtime 事件 → 投影/状态持久化 → 活跃 UI 渲染 → 用户动作 → 终态。缺一环即不闭环。

### 3. 逐表面独立验证

Web、Agent、飞书、Telegram 必须各自验证，禁止从一方行为推断另一方行为。

### 4. 跨表面跳转验证目的地

任何“前往 Web”“跳转”或“复用 X”的设计，都必须验证目的地的入口、上下文、权限、动作和完成反馈已经存在且可用。跳转到缺失或不可用的 UI 是阻断缺陷。

### 5. 领域规则收敛于后端

共享业务规则与状态转换只在 Bridge/后端维护；通道只适配展示、参数采集、权限和传输，不复制领域逻辑或状态机。

### 6. 三种审批语义隔离

Agent Permission、Runtime Step Approval、Flow Definition Review 的产品语义必须分开，即使当前共用存储或 API 基础设施。

### 7. Surface Matrix 门禁

实施规划前和声明完成前必须产出 Surface Matrix，覆盖：

- Surface：Web、Agent、飞书、Telegram；
- 检查项：entry、read path、write path、event consumption、error handling、recovery、terminal feedback、planned 落点；
- 每个 Surface 必须标注 implemented、reachable、closed-loop、planned；
- 任何被其他 Surface 跳转来的能力，必须在同一阶段或更早阶段有明确任务落点；
- Matrix 必须成为计划或完成文档的一部分，不能只做一次性口头检查。

### 8. 测试双层级

必须同时具备合同层测试和活跃表面层测试。后端或 API 测试通过，不代表用户可见交互可用。

### 9. 汇报精确性

“API 存在”“绑定已持久化”“组件存在”不等于“功能可用”。未验证活跃端到端路径前，禁止声称能力已 reachable 或 closed-loop。
