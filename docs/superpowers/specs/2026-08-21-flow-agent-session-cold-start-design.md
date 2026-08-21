# Agent Session → Flow 冷启动设计

Status: Accepted for implementation

## 1. 目标

让 Web 能扫描 Cursor、Claude、Codex、Pi 等 Agent 的真实 Session/Run，判断成功经验是否具备可复用结构，并在用户明确确认后保存为可追溯的 `Guide Draft`。只有后续补齐 Capability、Adapter、inputs 与 `success_when` 并编译通过，才能转换成 `Candidate Runbook`。

这条路径补齐的是 Flow 冷启动，不改变既有“Published Runbook 成功 Run → 新 Candidate revision”的迭代路径。

## 2. 事实与边界

- 当前 `POST /v1/flows/candidates` 只接受来源本来就是 Published Runbook 的成功 Run；普通 Agent Run 返回 `run_not_solidifiable`。
- 本机真实 Session 数量覆盖 `cursor / claude / codex / pi`，但结构化 `FLOW_PROPOSED` 目前只由能产生结构化 plan 事件的 Agent Run 提供。
- 普通 Agent 工具调用不等于已注册 Capability。当前 Catalog 中只有少量 Capability，禁止把任意 shell/tool trace 伪装成可执行 Runbook。
- Agent 不能直接写 Catalog。所有保存均经 Bridge API，并由用户点击或明确通道命令确认。
- P2 冷启动产物是 `guide × draft`；不可绑定、不可 Dry-run、不可执行。

## 3. 提案读取模型

Bridge 从成功 Run 的持久事件生成 `FlowProposal`：

```ts
type FlowProposalKind = "structured_plan" | "observed_trace" | "unavailable";

interface FlowProposal {
  sessionId: string;
  runId: string;
  agentId: string;
  runStatus: string;
  kind: FlowProposalKind;
  saveable: boolean;
  reason: string | null;
  sourceDefinitionRevision: string | null;
  guide: {
    name: string;
    description: string | null;
    steps: Array<{ id: string; purpose: string; depends_on: string[] }>;
  } | null;
}
```

优先级：

1. 成功 Run 的最后一个合法 `FLOW_PROPOSED` → `structured_plan`；
2. 没有结构化 plan，但存在至少两个已完成工具调用 → `observed_trace`，只生成可编辑 Guide，不推断 Capability；
3. 无足够证据、Run 非成功或只有导入历史 → `unavailable`。

工具轨迹只保留工具类别/脚本名称，屏蔽参数、订单号、路径、密钥和长命令，避免把一次任务的敏感值固化进定义。

## 4. 保存合同

- `GET /v1/sessions/:session_id/flow-proposals`：返回当前 Session 的成功 Run 提案，最新优先；只读。
- `POST /v1/flows/guides`：请求 `{ session_id, run_id, name?, description? }`；服务端重新读取持久事件、重建提案并保存。
- 保存结果固定为 `kind=guide,status=draft,source=agent_generated`。
- `definitionRevision` 由服务端对规范化 Guide 定义计算。
- provenance 使用来源 Run/Session，以及提案中的 ephemeral workflow id/revision；不得接受客户端伪造。
- 相同 `session_id + run_id + sourceDefinitionRevision` 重试返回同一个 Guide，避免重复保存。

## 5. Web 交互

- 成功的普通 Agent Turn 若 `saveable=true`，在回复下方展示“整理为 Guide”。
- 点击即是保存确认；保存成功后打开 Web Flow 管理详情。
- `structured_plan` 标记“基于 Agent 计划”；`observed_trace` 标记“基于工具轨迹，需人工整理”。
- 不可提取时不显示写按钮，但管理区可查看原因和各 Agent 覆盖统计。

## 6. 后续转换

Guide Draft 只保存“人如何完成任务”的可编辑语义。转换为 Runbook 时必须：

1. 明确 inputs；
2. 每个自动步骤映射已注册 Capability/Adapter；
3. 补齐风险、审批、幂等与 `success_when`；
4. 通过 compile/validation；
5. 生成 Candidate 后 Dry-run、Review、Published。

没有 Capability 的真实任务应诚实停在 Guide，而不是让 Agent 在 Runtime 中继续充当执行器。

## 7. Surface Matrix

| Surface | 入口 | 读 | 写 | 终态 |
|---|---|---|---|---|
| Web | 成功 Turn 的“整理为 Guide” | proposal API | guides API | 打开 Guide 管理详情 |
| Agent | 产生 plan/tool/final 证据 | 无 Catalog 读权 | 无 Catalog 写权 | 普通结果 |
| 飞书 | P3 `/flow save` 复用 Bridge | proposal API | guides API（明确命令） | Guide 链接/ID |
| Telegram | 合同与测试先实现，部署关闭 | 同飞书 | 同飞书 | `implemented / deployment disabled` |

## 8. 验收

- 对 Cursor、Claude、Codex、Pi 的真实 Session 扫描有明确结果，不从一个 Agent 推断另一个。
- 结构化 plan 与工具轨迹都可生成 Guide；无证据返回不可提取原因。
- 保存 Guide 不会进入消费列表、不会被绑定或执行。
- 重试幂等、provenance 可回到真实 Run/Session、敏感工具参数不进入 Guide。
- 既有 Published Runbook → Candidate 路径不变。
