# Flow Save Intent：从执行证据到用户确认

> Status: Implemented and verified  
> Date: 2026-08-25  
> Branch: `codex/fix-session-history-overflow`  
> Supersedes: “成功 Run 且有结构化计划或至少两次工具调用，就主动展示整理为 Guide”

## 0. 决策摘要

当前实现把“技术上能从 Run 提取步骤”直接等同于“应该向用户推荐沉淀”，导致普通成功任务、临时工具链和 Provider 历史导入 Run 都出现“整理为 Guide”。

本设计把它拆成三个互不替代的概念：

1. **Extractable**：技术上能从 Run 提取任务定义；
2. **Save Intent**：用户明确表达保存意图，形成持久化的待确认请求；
3. **Candidate Runbook**：用户确认后才创建的 Flow 候选。

V1 采用两个显式入口：

- 自然语言：用户告诉 Agent“把刚才这个存为 Flow”；
- 手动操作：用户在某个 Assistant Turn 的菜单中点击“存为 Flow”。

两个入口都只创建 Save Intent，不直接写 Flow Catalog。Web 确认后才生成 Candidate Runbook，并继续走 Dry-run、Review、Published。

## 1. 问题与代码事实

### 1.1 当前错误模型

`proposalForRun` 当前把以下任一条件视为可保存建议：

- 成功 Run 含结构化 `FLOW_PROPOSED`；
- 成功 Run 含至少两次 `tool_start`。

`GET /v1/sessions/:session_id/flow-proposals` 为 Session 中每个 Run 计算结果，Web `SessionTimeline` 再按 `run_id` 在每个 Turn 下方渲染“整理为 Guide”。

因此当前系统只知道“执行证据够不够”，不知道：

- 用户是否希望以后复用；
- 这是稳定流程还是临时排障；
- 哪些步骤是 Agent 即兴操作；
- 这次 Run 是否只是导入的历史证据。

### 1.2 已复现数据

截图对应的 Provider 历史 Session 有两个导入 Run：

- 一个包含 16 次 `tool_start`；
- 一个包含 11 次 `tool_start`。

两者都被判为 `observed_trace + saveable`，所以每个导入 Turn 下方都出现卡片。当前本地数据中，共有 2 个 Session、8 个导入 Run 会被这一规则错误提示。

### 1.3 根因

根因不是缺少 `imported` 过滤，而是：

> **Extractability 被错误地当成了 Recommendability。**

只过滤 Imported Run 会减少一种噪音，但所有临时成功 Run 仍会误报。

## 2. 第一性原理与产品不变量

### 2.1 三层职责

| 层 | 回答的问题 | 是否写 Catalog |
|---|---|---|
| Extractable | 能否从证据中提取目标、输入、步骤和验收 | 否 |
| Save Intent | 用户是否明确要求保存哪一次执行 | 否 |
| Candidate | 用户是否确认创建可预演、可审查的 Runbook 候选 | 是 |

三层禁止合并：

- Run 成功不等于值得推荐；
- 用户表达意图不等于允许写 Catalog；
- 技术上可提取不等于可以发布；
- Agent 永远不能创建、批准或发布 Candidate。

### 2.2 唯一正式出口

V1 正式路径：

```text
成功 Agent Run
→ 用户自然语言请求或手动选择
→ FLOW_SAVE_REQUESTED
→ Web 确认
→ Candidate Runbook
→ Dry-run
→ Flow Definition Review
→ Published Runbook
```

Guide 不再是成功 Run 的默认出口。Guide 仍只是 Web 自由创作草稿，不进入这条主路径。

### 2.3 Imported Run 的边界

- Imported Run 永不自动产生 Save Intent；
- 用户明确通过自然语言或 Turn 菜单选中 Imported Run 时，仍可进入提取和确认；
- 不以 `run_import_` 前缀判断来源，使用事件中的显式 provenance；
- 导入历史继续正常展示，不因本设计被删除或降级。

## 3. 方案比较与选择

### 3.1 采用：Agent 结构化保存意图

CodeBridge 向 Agent 暴露内部只读 MCP 工具 `codebridge.request_flow_save`。LLM 负责理解用户是否明确要求保存，工具只表达意图，不写 Catalog。

优点：

- 使用当前 Agent 的自然语言理解能力；
- 不为每条消息额外调用一次分类模型；
- Web、飞书、Telegram 可以共享同一事件合同；
- 手动入口能复用同一后端状态机。

### 3.2 不采用：Bridge 每 Turn 额外调用 LLM 分类

虽然可统一判断，但会给每条消息增加延迟、费用和新的失败面；并且“明确保存意图”本来就是当前 Agent 已在理解的对话内容。

### 3.3 不采用：关键词匹配

关键词方案无法可靠覆盖“以后按这个来”“把刚才那套留住”等表达，也容易把普通“保存文件”误判成保存 Flow，不符合自然语言目标。

## 4. Tool 合同与注册方式

### 4.1 注册方式

`codebridge.request_flow_save` 由 CodeBridge 内部只读 MCP Server 注册，并由 runner-host 注入支持外部 MCP 的 Agent。Pi 当前 SDK 不支持程序化注入外部 MCP，因此通过 `customTools` 投影相同输入和结果；其 Provider-facing wire name 使用函数安全的 `codebridge_request_flow_save`，领域身份仍由 `flow_save_request/v1` 结果 marker 确定。

不在 Codex、Claude、Cursor、Pi 各自实现一套保存逻辑；各 Adapter 只负责把标准 MCP 工具暴露给 Agent，并将工具事件按既有 `AGENT_EVENT` 合同回流。

工具元数据：

- `side_effects: false`；
- 不写 Flow Catalog；
- 不创建 Candidate；
- 不批准或发布 Flow；
- 不接收任意 Catalog 字段或任意 `run_id`。

### 4.2 Tool 输入

```ts
interface RequestFlowSaveInput {
  intent_summary?: string;
  name_hint?: string;
  source_scope: "previous_completed_run";
}
```

V1 只支持 `previous_completed_run`：保存请求所在 Run 自身不能作为来源，避免把管理工具调用混进待提取步骤。

因此：

- “把刚才这个存起来”可以直接处理；
- “执行这个任务并在同一条消息里保存”不会猜测当前未完成 Run；Agent 应在任务完成后提示用户确认保存，或用户使用 Turn 菜单；
- V2 若要支持同 Run 执行后保存，必须单独设计“终态后绑定来源”，不在 V1 隐式实现。

`intent_summary` 和 `name_hint` 只是展示提示，不是可信定义；Candidate 内容必须来自 source Run 的持久证据。

### 4.3 Tool 事件消费

Agent 工具调用继续通过 `AGENT_EVENT` 回流：

1. `tool_start` 记录 `toolCallId`、Adapter 展示名和输入；展示名可能是 `MCP: tool`、带 namespace 的名称或 Pi 的安全 wire name，不作为领域身份；
2. `tool_end` 必须与相同 `toolCallId` 关联且状态成功；
3. Session Runtime 仅在成功 `tool_end` 严格解析出 `flow_save_request/v1` 且 `accepted: true` 后创建一次 `FLOW_SAVE_REQUESTED`；
4. 同一 `toolCallId` 重放不得产生第二个请求；
5. 工具失败、取消或缺失对应 `tool_start` 时不创建请求，并保留可诊断事件。

不得仅看到工具名就让 Web 本地合成确认卡。

## 5. Save Intent 领域合同

### 5.1 新增事件

```text
FLOW_SAVE_REQUESTED
FLOW_SAVE_DISMISSED
FLOW_CANDIDATE_CREATED
FLOW_SAVE_FAILED
```

`FLOW_SAVE_REQUESTED` payload：

```ts
interface FlowSaveRequestedPayload {
  request_id: string;
  session_id: string;
  request_turn_id: string;
  request_run_id: string;
  source_turn_id: string;
  source_run_id: string;
  source_title: string;
  source: "agent_intent" | "turn_action";
  user_message: string;
  intent_summary: string | null;
  name_hint: string | null;
  created_at: string;
}
```

后续事件必须带相同 `request_id` 和 `source_run_id`。

`source_title` 是被选择的业务 source Run 对应 Turn 标题；`user_message` 是触发保存意图的用户原话。确认卡不得把保存指令冒充为来源。

### 5.2 状态机

```text
requested ──confirm──> completed
    │                    │
    ├──dismiss──> dismissed
    │
    └──confirm failure──> failed ──retry──> completed
```

不变量：

- `requested` 只能由自然语言工具或手动 Turn 操作创建；
- `completed` 必须关联已创建的 Candidate `flow_id` 和 `definition_revision`；
- `dismissed` 永久隐藏该请求；
- 用户再次明确要求保存时创建新的 `request_id`；
- `confirm`、`dismiss` 使用调用方 `Idempotency-Key`；
- 已完成请求重放返回同一个 Candidate，不创建重复 lineage。
- Confirm 的领域幂等身份是不可变 `request_id`：完成后即使调用方换了传输层 key，也只能读取同一个 Candidate，不能把旧请求变成新命令。

### 5.3 存储策略

V1 不增加第二套独立“Flow Save Request”读模型 API。

事件是唯一事实源，Session Projector 把事件投影为 Timeline block。Web hydrate、SSE、重启恢复全部读取同一个投影结果。

如事务内需要判断当前状态，可由事件/投影仓储提供按 `request_id` 的查询函数；不得由 Web 内存状态充当权威。

## 6. Source Run 定位规则

### 6.1 手动 Turn 菜单

手动入口携带被点击 Turn 的确切 `run_id`，Bridge 验证：

- Run 属于当前 Session；
- `status === succeeded`；
- `execution_kind === agent`；
- Run 有对应的用户 Turn 和可读取证据；
- Run 不是保存请求所在管理 Run；
- `extractRunDefinition` 能返回合法提取结果。

Imported Run 可以通过手动入口显式选择。

### 6.2 自然语言入口

按 canonical event sequence 定位，不按本地时间字符串排序：

1. 找到成功 `request_flow_save` tool call 所在的 `request_run_id`；
2. 在同一 Session 中查找事件 sequence 早于该工具请求的 `RUN_SUCCEEDED`；
3. 按终态 sequence 倒序；
4. 依次排除：
   - 当前 `request_run_id`；
   - 非 `succeeded`；
   - `execution_kind !== agent`；
   - 已删除、归档不可读或不属于当前 Session；
   - 只有 Flow 管理动作、没有业务用户 Turn；
   - `extractRunDefinition` 返回不可提取；
5. 第一个满足条件的 Run 成为 `source_run_id`。

不排除显式 Imported Run，因为此时已经有用户保存意图；但必须把 `imported=true` provenance 展示在确认卡中。

找不到来源时不创建猜测请求，Agent 返回：“找不到可提取的上一次成功任务，请在目标回复的菜单中选择‘存为 Flow’。”

## 7. Extractability 重构

### 7.1 `proposalForRun` → `extractRunDefinition`

新函数只做技术提取：

```ts
type RunExtractionResult =
  | {
      ok: true;
      definition: ExtractedRunDefinition;
      evidence: ExtractionEvidence;
    }
  | {
      ok: false;
      reason: ExtractionFailureReason;
    };
```

它不再返回或表达：

- `saveable`；
- `recommendable`；
- 是否应该展示卡片；
- 是否已经获得用户确认。

结构化计划和工具轨迹仍可作为提取来源，但管理工具 `codebridge.request_flow_save` 必须从步骤中移除。

### 7.2 旧接口收口

- Web、Channel 和内部服务删除 `GET /v1/sessions/:session_id/flow-proposals` 的全部调用方；
- 旧 GET 在 V1 返回 `410 flow_proposals_deprecated`，不再扫描成功 Run，也不保留“空列表兼容”；
- Web 删除 `flowProposals` 拉取和基于 Run 自动展示卡片的逻辑；
- run-based `POST /v1/flows/guides` 返回 `410 run_guide_save_deprecated`；带 `flow` 定义的 Web Guide 草稿创建合同不变；
- Channel `/flow guide save` 返回明确的废弃说明，不再写 Catalog；
- Web 自由创建/编辑 Guide 的草稿合同保留；
- 手动 Turn 菜单直接创建 Save Intent，不先调用旧 proposals 接口；
- Candidate 确认路径在后端直接调用 `extractRunDefinition`。

## 8. Timeline 确认卡

### 8.1 投影

新增 Timeline block kind：`flow_save_request`。

投影规则：

- `FLOW_SAVE_REQUESTED`：创建 `pending` block；
- `FLOW_SAVE_DISMISSED`：原 block 更新为 `dismissed`；
- `FLOW_CANDIDATE_CREATED`：原 block 更新为 `completed`，写入 Candidate 引用；
- `FLOW_SAVE_FAILED`：原 block 更新为 `failed`，保留安全重试操作。

自然语言入口把卡片放在 `request_turn_id` 下；手动入口的 `request_turn_id` 等于被选择的 source Turn，因此仍复用同一规则。

块 ID 由 `request_id` 稳定派生，SSE 重放、hydrate 和重复事件不能生成第二张卡。

### 8.2 Web 展示

Pending：

```text
存为 Flow？

来源：查这家公司的权益
可提取：4 个步骤 · 2 个输入参数
保存后将生成 Candidate，需要预演和审查后才能发布。

[生成 Candidate] [忽略]
```

Imported 来源增加：

```text
来源为导入历史，请确认其步骤仍然适用。
```

Completed：

```text
已生成 Candidate · <name>
[打开并预演]
```

Failed 必须展示稳定错误码和恢复动作，不得把失败卡隐藏成普通聊天。

### 8.3 Turn 菜单

只在成功 Agent Run 的 Assistant Turn 菜单中展示“存为 Flow”。

不在以下位置展示：

- 用户消息；
- 运行中、失败或取消 Run；
- Flow Runtime Run；
- 只有权限/审批系统块的 Turn；
- 已有 pending/completed Save Intent 的同一 source Run。

## 9. 写操作 API

Timeline 是读取真相，但用户动作仍需要明确写入口：

```text
POST /v1/sessions/:session_id/flow-save-requests
POST /v1/flow-save-requests/:request_id/confirm
POST /v1/flow-save-requests/:request_id/dismiss
```

### 9.1 手动创建请求

请求：

```json
{
  "source_run_id": "run_...",
  "source": "turn_action"
}
```

需要 `Idempotency-Key`。成功后 append `FLOW_SAVE_REQUESTED`，Web 依靠返回事件/SSE 更新 Timeline。

自然语言工具不通过此 HTTP 入口调用自己；它由 AGENT_EVENT translator 进入同一领域服务。

### 9.2 Confirm

Confirm 的领域步骤：

1. 读取 pending 请求；
2. 重新验证 source Run 仍存在且成功；
3. 调用 `extractRunDefinition`；
4. 使用 `request_id` 派生确定性的 Candidate `flow_id`，生成 Candidate Runbook并保留 provenance 和 lineage；
5. append `FLOW_CANDIDATE_CREATED`；
6. 返回 Candidate 引用。

Flow Catalog 与 Session 事件存储当前不是同一个事务边界，因此 V1 使用确定性身份和持久 reconciliation saga：

- 同一 `request_id` 永远派生同一个 Candidate `flow_id`；
- Catalog `save` 对该 `flow_id + request_id provenance` 幂等；
- 若进程在 Catalog save 后、事件 append 前崩溃，V1 由 Bridge 启动时的一次性 reconciler 扫描 pending request，发现对应 Candidate 后补写 `FLOW_CANDIDATE_CREATED`；V1 不增加周期扫描、定时器或第二套后台基础设施；
- 若事件已完成但 HTTP 响应丢失，重试返回相同 Candidate；
- 前端不得创建 Candidate、伪造 completed 或承担跨存储补偿。

### 9.3 Dismiss

Dismiss append `FLOW_SAVE_DISMISSED`。重复 Dismiss 返回同一终态。Completed 请求不能再 Dismiss。

## 10. 错误合同

| HTTP | Error | 用户行为 |
|---|---|---|
| 404 | `flow_save_request_not_found` | 刷新 Timeline |
| 404 | `source_run_not_found` | 请求失败，不猜其他 Run |
| 409 | `source_run_not_succeeded` | 等待终态或重新选择 |
| 409 | `source_run_not_extractable` | 显示缺少的结构/证据 |
| 409 | `flow_save_request_already_dismissed` | 保持 dismissed |
| 409 | `flow_save_request_state_conflict` | 刷新 Timeline |
| 503 | `flow_catalog_unavailable` | 保留 pending，可重试 |

自然语言无法定位来源不是 HTTP 成功，也不是创建空请求；Agent 应明确提示用户使用 Turn 菜单。

已完成请求再次 Confirm 返回 `200` 和原 Candidate，不进入错误合同，也不产生新事件或 lineage。

## 11. 三通道交互

### 11.1 Web

- 自然语言和 Turn 菜单均可创建请求；
- Timeline 卡可确认、忽略、重试和打开 Candidate；
- hydrate 与 SSE 两条路径必须得到相同卡片状态；
- 只有 Web 承担 Candidate 预演和审查。

### 11.2 飞书 / Telegram

V1 支持自然语言触发工具，但不在通道内创建 Candidate：

```text
已记录“存为 Flow”请求，请前往 Web 确认并预演。
```

该提示只能与 Web Timeline 确认卡在同一阶段交付；目的地不可达时不得上线提示。
因此 Web Surface 未启用时，Bridge 不向 Agent Run 注入 Flow Save 工具，也不产生自然语言入口的 `FLOW_SAVE_REQUESTED`。

通道不实现独立提取、状态机或 Catalog 写入。通道内确认留到后续管理能力阶段。

### 11.3 Agent

- 只在用户明确表达复用/保存意图时调用工具；
- 不因 Run 成功、工具数量或 Agent 自己认为“有价值”而调用；
- 不创建 Candidate；
- 不批准或发布 Flow；
- 不把普通“保存文件/保存结果”理解为“存为 Flow”。

## 12. Surface Matrix

| Surface | Entry | Read path | Write path | Event consumption | Error handling | Recovery | Terminal feedback | Planned landing | Target state |
|---|---|---|---|---|---|---|---|---|---|
| Web | 自然语言结果卡、Turn 菜单 | Timeline hydrate + SSE | request/confirm/dismiss API | 四类 FLOW_SAVE_* | 持久错误卡 | 刷新、重试、重新选择 | Candidate 链接 | P0 Web | implemented + reachable + closed-loop |
| Backend | Agent tool translator、HTTP actions | canonical events + source Run | event append + Candidate service | AGENT_EVENT → FLOW_SAVE_* | 稳定错误码 | 幂等 + outbox/事务 | 投影终态 | P0 Domain | implemented + reachable + closed-loop |
| Agent | MCP tool | 当前对话上下文 | 只读 intent tool | tool_start/tool_end | 无来源时明确回复 | Turn 菜单兜底 | 已记录请求 | P0 Agent | implemented + reachable；不能写 Catalog |
| 飞书 | 自然语言 | Timeline/请求结果 | 无 Candidate 写操作 | FLOW_SAVE_REQUESTED | 提示前往 Web | Web 目的地 | 已记录 | P1 Channel | reachable；不在通道闭环 |
| Telegram | 自然语言 | Timeline/请求结果 | 无 Candidate 写操作 | FLOW_SAVE_REQUESTED | 提示前往 Web | Web 目的地 | 已记录 | P1 Channel | Telegram 启用后验证 |

## 13. 测试策略

### 13.1 领域合同

- 成功 Run + 20 次工具调用但无 Save Intent：不产生确认卡；
- Imported Run + 工具轨迹但无 Save Intent：不产生确认卡；
- 用户明确选择 Imported Run：可以创建请求；
- 同一 tool call 重放：只创建一个 request；
- tool_start 后失败/取消：不创建 request；
- 自然语言请求只选择 sequence 更早的最近成功 Agent Run；
- 当前 request Run、失败 Run、Flow Run、纯管理 Run 均被排除；
- 找不到来源不猜；
- management tool 不进入提取步骤；
- Confirm 重放返回同一个 Candidate；
- Dismiss 后同一请求不再出现，新请求仍可创建。

### 13.2 Timeline / Web

- requested/dismissed/completed/failed 四态 hydrate；
- SSE live 与刷新后的 hydrate 一致；
- 旧常驻 Guide 卡完全消失；
- Turn 菜单只在合法成功 Agent Run 出现；
- Confirm 成功后跳转 Candidate Dry-run；
- Imported 来源有明确告警；
- Session 切换和晚返回不污染当前页面。

### 13.3 Agent 与通道

- Codex、Claude、Cursor、Pi 均能看到标准 MCP tool；
- 普通成功任务不调用该工具；
- 明确“存为 Flow”表达触发工具；
- “保存文件”“保存查询结果”不触发；
- 飞书/Telegram 只展示已记录和 Web 去向，不写 Catalog；
- Web 卡不可达时通道不得声称“前往 Web 即可确认”。

### 13.4 对抗用例

- 连续 50 个成功 Run 不产生任何自动卡片；
- 同一句自然语言被通道重投三次只创建一个请求；
- Bridge 在 Candidate 创建后、终态事件前崩溃，恢复后只存在一个 Candidate；
- request/dismiss/confirm 并发只收敛到一个合法终态；
- 来源 Run 在确认前被归档/清理时返回准确错误；
- Provider 导入 401 个事件后，除非用户明确请求，否则零 Save Intent。

## 14. 实施边界与风险

GitNexus 预审：

- `proposalForRun`：LOW，1 个直接调用方，影响 1 条 Flow API 流程；
- `proposalsForSession`：LOW，1 个直接调用方；
- `SessionTimeline`：LOW，直接影响 Timeline 测试；
- `Workbench`：图谱 LOW，但作为活跃 Web 表面人工按 MEDIUM 管理。

领域事件联合、Session Projector 和 Agent tool translator 的实际实现影响需在计划阶段重新跑 GitNexus；若达到 HIGH/CRITICAL，必须先告警并拆 PR。

推荐拆分：

1. 领域事件、Save Intent 状态与 `extractRunDefinition`；
2. Timeline 投影及写操作 API；
3. 内部 MCP tool 与 Agent translator；
4. Web Turn 菜单和确认卡；
5. 飞书提示；
6. Telegram 启用后的独立验收。

## 15. 非目标

- 自动按频率、相似度或价值评分推荐 Flow；
- 同一执行 Turn 中“边执行边保存”；
- Agent 直接写 Catalog；
- 飞书/Telegram 内批准 Candidate 或 Flow Definition Review；
- 把单次 Skill 调用自动升级为 Flow；
- 在 V1 建立跨 Session 任务聚类；
- 删除 Imported 历史或禁止用户显式从历史提取。

## 16. 验收标准

1. 普通成功 Run 不再出现“整理为 Guide”；
2. 导入历史不再自动出现保存建议；
3. 用户自然语言请求或 Turn 菜单能产生同一种持久确认卡；
4. 未确认前 Catalog 零写入；
5. 确认后只生成一个 Candidate Runbook，并进入 Dry-run/Review 主路径；
6. 刷新、重启、SSE 重连后卡片状态一致；
7. Agent、Web、飞书、Telegram 独立做 Surface Matrix 验证；
8. 旧 `/flow-proposals` 不再向活跃 Web 返回自动建议；
9. Imported Run 仅在用户显式选择时允许提取；
10. 对抗并发、重放和崩溃恢复后仍只有一个合法终态。
