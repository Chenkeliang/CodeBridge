> 历史记录：Flow 功能已于 2026-09-23 进入完整移除；本文保留设计/验收审计，不再描述当前可用功能。当前范围见 `docs/plans/2026-09-23-remove-flow.md`。

# Flow 全通道产品闭环

- Status: Pending user review
- Date: 2026-08-20
- Branch 口径: `feat_flow`（相对 `origin/main`；本文件不假设已合 main）
- 上游（不替代，只补「人怎么用」）:
  - `docs/orchestration/flow-design.md` — 第一性原理、引擎、P0–P3 分期
  - `docs/orchestration/interaction.md` — 通道只做适配
  - `docs/orchestration/api-contract.md` — HTTP 合同
  - `docs/superpowers/specs/2026-08-13-flow-design.md` — 契约与学习信号
  - `docs/superpowers/specs/2026-08-19-flow-runtime-loop-design.md` — 后端执行闭环（已落地）
  - `docs/superpowers/specs/2026-08-19-flow-web-loop-design.md` — Web 证据链（已落地）
- 实现计划: `docs/superpowers/plans/2026-08-20-flow-product-loop.md`

本文把 Flow 从「引擎能跑」补成「Web / 飞书 / Telegram / 日常对话」上可完成的人路径。实现必须与本文一致；分歧先改文档。

---

## 0. 北极星（沿用，不改）

Flow 是参数化、版本冻结、结果可验证的**可执行契约**，不是「保存聊天步骤」。

```text
LLM 提议（识别流程 / 提取参数候选 / 解释结果 / 建议保存或审查）
Runtime 决策（绑定 / 校验 / 授权 / 状态迁移）
Verifier 判定成功（postcondition，而非「没报错」）
```

**执行互斥（runbook）：**

| 会话状态 | 谁执行 | 谁不能当执行器 |
| --- | --- | --- |
| 未绑 Flow，或已解绑 | Agent | Runtime 不得假装在跑某条 Flow |
| 已绑 `published` + `kind=runbook` | Runtime adapter | Agent 不得当步骤执行器，也不得在本会话闲聊兜底 |
| `candidate` | 只允许 `dry_run: true` | 不得绑定会话，不得真跑 |
| `deprecated` | 拒绝新 Run | — |
| `kind=guide` | 指针 + Agent（本轮仍不走确定性执行器） | 不得当作 runbook 发布 |

一次成功的 runbook 执行留下：`PARAM_RESOLVED` → 冻结 PlanIR → ResolvedPlan → 确定性执行 → `RUN_SNAPSHOT`（失败则 `VERIFICATION_FAILED` 四分类）。

通道（飞书 / Telegram）**不**建立自己的 Agent / Session / Flow 状态机。它们只把用户意图适配到已有 Bridge API。长内容、Diff、证据回 Web。

---

## 1. 目标人路径

```text
日常闲聊（Agent）
    │  建议保存（确认卡，不落库）
    ▼
存为 Candidate          POST /v1/flows/candidates
    │  Dry-run 预演（Web 已有）
    │  建议审查（确认卡 / 链接，不批准）
    ▼
审查发布                POST /v1/flows/:id/review
    │
    ▼
发现 / 绑定 published   会话写入 flowId（仅 published runbook）
    │
    ▼
补参 / 运行             POST .../messages { flow_id, inputs }
    │
    ▼
时间线证据链 + 可选解释 SNAPSHOT
```

虚线两步（建议保存、建议审查）今天不存在。两端写入口的 **API 已通、人入口未通**。

---

## 2. 现状（仓库内核过，2026-08-20）

### 2.1 已落地

- Catalog：`draft | candidate | published | deprecated`；`kind: runbook | guide`。
- 执行门：candidate 非 dry-run → `flow_not_executable`；published runbook 重编译，hash 对 `plan_ir_hash`；未注册能力 / skill / manual 步骤 **publish 失败**。
- Web：侧栏「已发布」绑定 +「运行」；「候选」只 Dry-run、不 `setFlowId`；时间线 `flow_*` 块；hydrate 为权威源。
- API：`GET /v1/flows`、`GET /v1/flows/:id`、`POST /v1/flows/candidates`、`POST /v1/flows/:id/review`、`POST /v1/flows/:id/apply`、消息体 `flow_id` / `inputs` / `dry_run`。
- 飞书 / Telegram：共用 `handleSlashCommand`；普通消息走 `ChannelSessionIngress.submit`；飞书 15s 状态栏。
- 启动注册的确定性能力：`demo.echo` / `demo.concat`，以及桩 `equity.balance`（几乎总返回 0，但能过 publishIssues）。本机已批准 MCP 可进 runbook。

### 2.2 明确没有

- Web「存为 Flow」按钮；Agent 不能 POST candidates。
- Web 审查 UI（语义 Diff / 通过 / 打回）。日常对话里说「存一下 / 审一下」不落库。
- 飞书 / Telegram：无 `/flow`，无选 Flow UI，无补参表单，bot 菜单无 Flow。
- 对话识别已有 published（`FLOW_RECOMMENDED` 本轮不生产，阶段 3 设计）。
- 跑完结果回流 Agent 上下文（spec 允许只读解释 SNAPSHOT，未做）。
- `source: context | default` 注入未做。
- DAG 编辑器、自动推荐、guide 当确定性执行器、runbook 失败兜底 Agent：有意不做或更晚。

### 2.3 通道合同缺陷（必须先修，否则聊天绑定是空转）

飞书 / Telegram `submit()` **不传** `flowId`。通道入口却把缺省写成 JSON `null`：

```text
channel-ingress: 省略 undefined 的 flow_id
  → POST /v1/channels/.../messages
  → session-api: flow_id: asNullableString(undefined) === null
  → POST /v1/sessions/:id/messages  body.flow_id = null
  → nullable(null, session.flowId) === null   // 不回退
```

因此：**即使**某槽位会话的 `session.flowId` 已被 `apply` 写上，飞书 / Telegram 下一句普通消息仍按未绑定 Agent 跑。

`persistedSessionFlowId` 用 `requested ?? current`，`null` 不会清掉库里的绑定；所以库里可能「看起来绑着」，聊天却不执行。这是合同 bug，不是产品决策。

另：`POST /v1/flows/:id/apply` 今天对 **candidate** 也会写 `session.flowId`，与 Web「候选不绑会话」不一致。审查通过后应改为：**只允许 published**；candidate / deprecated / guide-as-runbook 返回 409。

### 2.4 会话身份（审查时不要混）

| 入口 | 会话怎么来 |
| --- | --- |
| Web 工作台 | `POST /v1/sessions` 创建的工作台会话 |
| 飞书 / Telegram | `getOrCreateBoundSession(ChannelSlot)`：channel + conversation + agent + cwd + generation |

**默认不是同一个 session_id。** 在 Web 侧栏绑定，不会自动变成该飞书群的 Flow。要在聊天里跑 Flow，必须对**该槽位会话**绑定（`/flow` 或对该 session 调 apply）。

`/new` 递增 generation，得到新槽位会话，**必须未绑定 Flow**。

---

## 3. 通道 × 生命周期（目标态）

图例：有 = 该通道可完成；半 = 短确认 / 链接 / 继承，主场在别处；无 = 本程序要补；不做 = 故意。

| 能力 | Web | 飞书 | Telegram | 日常对话（Agent 文本） |
| --- | --- | --- | --- | --- |
| 未绑闲聊 | 有 | 有 | 有 | 有 |
| 建议保存 | 半（按钮旁提示） | 半（成功后短卡） | 半（成功后短卡） | 有（建议 + 确认，禁止自写 catalog） |
| 存为 Candidate | 有（主入口） | 半（卡触发同一 API） | 半 | 半（确认后 Bridge 写） |
| Candidate Dry-run | 有 | 无（提示去 Web） | 无 | 无 |
| 建议审查 | 半 | 半（pending 提醒卡） | 半 | 有（提醒 + Web 链接） |
| 审查批准 | 有（主场，要 git_revision） | 不做批准 | 不做批准 | 不做批准 |
| 审查打回 | 有 | 有（可选短卡） | 有 | 无 |
| 发现 published | 有（侧栏） | 有（`/flow` 列表） | 有（`/flow` 列表） | 半（P2 确认卡） |
| 绑定 published runbook | 有 | 有（`/flow`） | 有（`/flow`） | 半（P2 确认后同一 apply） |
| 解绑 | 有（Plus「自动」+ 显式） | 有（`/flow off`） | 有（`/flow off`） | 无（让用户用命令） |
| 运行 runbook | 有（详情「运行」） | 有（绑后普通消息） | 有 | 不做（未绑不得当真跑） |
| 聊天补参表单 | 有（FlowDetail） | 不做（缺参回文本） | 不做 | 不做 |
| `/flow run k=v` | 不做（Web 用表单） | 有（可选，本程序纳入） | 有 | 无 |
| 时间线证据 | 有（权威） | 半（状态栏/卡片） | 半 | 无回流 |
| 解释 SNAPSHOT | 半（后做） | 无 | 无 | 半（后做，只读） |

---

## 4. 保存（Candidate）

### 4.1 唯一写入口

`POST /v1/flows/candidates`

现有合同：body 必须有 `session_id`；可选 `flow` 定义（steps/inputs/name/kind）。服务端编译、算 `definition_revision` / `plan_ir_hash`，状态落 `candidate`，`review_status: pending`。若 session 有 `taskRecordId`，追加 `FLOW_SAVED_AS_CANDIDATE`。

**禁止：** Agent / MCP / 通道自己写 SQLite catalog。通道和对话只触发 Bridge。

### 4.2 从哪生成定义

优先级（实现按此顺序，缺则 409 并说明缺什么）：

1. 请求体已带完整 `flow.steps`（高级 / 测试）。
2. 该 session 最近一次 `FLOW_PROPOSED`（Agent 发出 `plan` 事件时 run-executor 已写；`kind` 常为 guide + manual steps — **不能直接 publish 成 runbook**，保存为 candidate 后审查会因 manual/skill 被拒，这是正确的；用户应在审查前改成已注册 capability，或本程序 W2 只允许「已有确定性步骤的 session」保存）。
3. 该 session 最近一次成功 **runbook** Run 的冻结 PlanIR（回放步骤 + 参数化）。这是「跑过一遍再固化」的主路径。

自动参数化（P1 原文）：绝对路径、日期、看起来像 ID 的字符串提升为 `inputs`，步骤里改引用。不确定就不猜，留在步骤常量里，审查时人改。

**本程序默认（请审查）：** W2 先做「Web 按钮 + 请求体带 flow 或从最近成功 runbook Run 抽定义」。不在 W2 把 `FLOW_PROPOSED` 的 manual guide 自动变成可发布 runbook。空闲聊点「存为 Flow」应失败并说明「没有可固化的确定性步骤」。

### 4.3 各通道怎么触发

| 通道 | 交互 | 落库 |
| --- | --- | --- |
| Web | 会话工具栏「存为 Flow」；可改名称；成功后侧栏出现候选，可立刻 Dry-run | 工作台 `session_id` |
| 飞书 / Telegram | Agent 任务 **succeeded** 后短卡：「这段能固化」`[存为 Flow] [忽略]`。无卡时可用 `/flow save`（仅当该槽位刚跑完可固化 Run） | 槽位 `session_id` |
| 日常对话 | Agent 文本建议 + 用户确认（Web 按钮或通道卡）。口头「帮我存」**不等于**已保存 | 确认后同一 POST |

空目录体验：侧栏在 0 条 published 时除「暂无已发布 Flow」外，加一句「把一次成功的确定性执行存为 Flow」。Composer「+」在无 published 时继续隐藏 Flow 下拉（保持现状），发现入口仍是侧栏。

---

## 5. 审查（Candidate → Published）

### 5.1 唯一写入口

`POST /v1/flows/:flow_id/review`

- 仅 `status === candidate`。
- `decision: approve | reject`。
- **approve 必须** `git_revision` 非空，并跑现有 `publishIssues`（successWhen、已注册 capability、禁止 skill/manual、runbook 要有 adapter）。
- 通过后 `status=published`，`source=git`。
- 打回后仍为 candidate（保持现状，不自动 deprecated）。

### 5.2 Web 是批准主场

候选详情页（可与现 `FlowDetail` 扩展，或独立 Review 面板）：

- 步骤 / inputs / `plan_ir_hash` / provenance（有则显示）。
- 最近一次 Dry-run 证据（时间线或事件摘要）；无预演也可批准，但 UI 警告「尚未预演」。
- 语义 Diff：相对「空」或相对同 `flow_id` 上一个 published revision（没有则显示「全新」）。
- 通过：提交 `git_revision`（本程序默认：用户粘贴或从当前 workspace `git rev-parse HEAD` 只读填入；**不在审查 API 里替用户 commit**）。
- 打回：可选原因字符串，写入事件即可。

### 5.3 通道

- 飞书 / Telegram **禁止** 批准（缺 Diff 和可信 git_revision）。
- 允许：提醒卡「候选 xxx 待审查」+ 打开 Web 的链接（若工作台 URL 可配置）+ 可选「打回」。
- 日常对话：只允许提醒，不允许「行，发布吧」直接 approve。

仓库内不能确认：生产工作台 URL、飞书 bot 菜单是否要加「审查」按钮（需飞书开放平台配置）。实现用配置项 `orchestration.webBaseUrl`，没有则卡片只写「到 Web 工作台 Flows → 候选」。

---

## 6. 绑定与聊天执行

### 6.1 绑定合同

把 Flow 绑到**某个 session** 的权威写：

- `POST /v1/flows/:flow_id/apply` `{ session_id }` — 只接受 **published + runbook**（本程序修正）。
- 或：对该 session 发一条带 `flow_id` 的 **非 dry-run** 成功消息（Web「运行」已走这条，且 `persistedSessionFlowId` 会写下 published）。

guide published：本程序 **允许绑定**，但执行仍走「指针 + Agent」，不编译确定性 PlanIR。UI / `/flow` 列表要标 `kind`。若审查认为 guide 不该出现在 `/flow`，改为只列 runbook。

**默认（请审查）：** `/flow` 列表 = 全部 published（runbook + guide），绑定 guide 时回复明确「将由 Agent 按指南执行，不是确定性 runbook」。

### 6.2 斜杠命令（飞书 + Telegram 一次落地）

共用 `handleSlashCommand`，不各写一套。

```text
/flow                 列出 published（序号、名称、kind、flow_id 短尾）
                      若已绑定，第一行显示当前 Flow
/flow <n>             按列表序号绑定当前槽位会话
/flow <flow_id>       按 id 绑定（完整或唯一前缀）
/flow off             解绑（session.flowId = null）
/flow save            将该槽位可固化 Run 存为 candidate（同 §4）
/flow run k=v k=v     在已绑定（或本条指定 id）上带 inputs 跑一轮
```

`/help`、`/help full`、飞书 `BOT_MENU_EVENT_KEYS` 增加 `fcb_flow` → `/flow`（菜单是否出现取决于飞书后台，代码先备好）。

`/status` 增加一行 `**flow**: flow_id (published runbook) | (未绑定)`。需要 `ChannelCommandContext` 带上 `flowId`（今天没有这个字段）。

绑定实现：slash 拿到槽位 `sessionId` 后调 apply（或 ingress 新方法 `applyFlow(sessionId, flowId)`），**不要**只改 router binding JSON。Flow 状态在 Catalog，不在 `sessions.json`。

### 6.3 绑之后的普通消息

修完 §2.3 后：

- 通道请求 **省略** `flow_id` → Runtime 使用 `session.flowId`。
- 通道请求 **显式** `flow_id` 字符串 → 本轮用该 Flow（Web 详情运行已如此）。
- 通道请求 **显式 JSON null** → 仅当产品要「这一句强制闲聊」；本程序默认：**通道层不再发送 `flow_id: null`**。解绑只走 `/flow off` / Web 自动。避免「省略」和「null」两个语义撞车。

已绑 runbook 的普通消息 = 一次 Flow 运行。`message` 文本仍要有（API 要求非空）：用用户原话；无额外参数时服务端用绑定 Flow 的 inputs（缺 required → 409，通道把 missing 列表回成文本）。

**不要**在对话里做就地参数表单（`flow-design.md` §11）。Web 继续用 FlowDetail。

`/flow run a=1 b=2`：解析为 `inputs`，`dry_run: false`，`flow_id` = 当前绑定。未绑定则 409 文案「先 /flow」。

### 6.4 解绑与互斥闲聊

已绑 published runbook 后，同一会话 **不能** 再当闲聊 Agent。这是北极星，不是 bug。

出口：

- `/flow off` 或 Web Composer 选回「Flow · 自动」（目录为空时也要能解绑：本程序补「即使 0 条 published 也提供解绑」）。
- `/new`：新 generation，新会话，未绑定。
- 不提供「这一句例外走 Agent、下一句再回流」的隐式切换（避免用户以为 Flow 在跑）。

### 6.5 缺参

409 `missing_inputs` 已有。通道回复：

```text
缺少必填参数：company_id
用法：/flow run company_id=12345
或到 Web 打开该 Flow 填表。
```

不在飞书拉表单。

---

## 7. 「建议」三件事

都不写 catalog、都不批准、都不在未确认时 `apply`。

| 建议 | 何时 | 用户确认后 |
| --- | --- | --- |
| 建议保存 | 一次成功的确定性 Run 结束，且尚未有同 hash 的 candidate | POST candidates |
| 建议审查 | candidate 至少一次 Dry-run 成功，或 pending 超过可配置时间 | 打开 Web 审查；不 approve |
| 建议绑定（P2） | 未绑会话的用户文本像某条 published 的名称/目的 | apply + 回「已绑定，下一句将执行」 |

P2 误绑成本高：必须确认卡，禁止静默 apply。v1 不做自动推荐（`flow-design.md` §11）；P2 是**确认后的识别**，不是推荐飞轮。

`FLOW_PROPOSED` 继续作为 Agent plan 的瞬时事件，**不等于** catalog candidate。

---

## 8. 结果回流

权威仍是 Web 时间线（projector → hydrate）。

本程序后段（W6，可砍）：

- 飞书 / Telegram：Run 终态卡片增加「步骤 n/m · 通过/失败」，不贴全文 Diff。
- Web：可选「请 Agent 解释这次 SNAPSHOT」（只读，新消息 **不得** 带 flow_id 执行，或要求先解绑）。更干净的做法：解释走独立 `explain` 开关，不进入 runbook 执行器。

默认 W6 只做通道终态摘要；Agent 解释 SNAPSHOT 标为可选，审查可删。

---

## 9. API / 类型修订（本程序范围内）

1. **省略 vs null（绑定继承）**  
   `POST /v1/sessions/:id/messages`：`flow_id` **缺省**（`undefined`）→ `session.flowId`；仅当 JSON 明确 `null` 且产品允许时才当本轮未绑定。通道入口 **不要**把省略转成 `null`。推荐改法：`asNullableString` 仅用于「字段存在」；通道 handler 用 `Object.hasOwn(body, "flow_id")` 才转发。

2. **`POST /v1/flows/:id/apply`**  
   仅 `published`。`kind=runbook` 必须能编译且 hash 匹配。`deprecated` 已 409。candidate 改为 409 `flow_not_bindable`。

3. **`ChannelCommandContext`**  
   增加 `flowId: string | null`（以及可选 `flowName` / `flowKind`），供 `/status`、`/flow`。

4. **SlashContext**  
   增加可选 `listPublishedFlows` / `applyFlow` / `saveFlowCandidate` / `unbindFlow`。由 Bridge ingress 注入，router 不直连 SQLite。

5. **不新增第二套 Flow 状态机。** 不在飞书卡片里存 flow 草稿。

---

## 10. 明确不做（本程序 + 更晚）

本程序不做：

- DAG 可视化编辑器 / 拖拽编排
- 静默自动推荐、`FLOW_RECOMMENDED` 生产（P3）
- 对话内参数表单
- 飞书 / Telegram 批准发布
- runbook 步骤失败后 Agent 兜底执行
- 把 guide 编进确定性执行器
- 领域真业务 adapter（权益/订单等）；桩 `equity.balance` 维持现状
- 跨 Agent 自动移植
- 并行 / 循环 / 补偿 / 定时器
- 为通道单独实现 catalog

更晚、有数据再做（P3）：重复价值检测、golden-run 回放、资源互斥 lease。

领域 adapter：另立专项。没有真实 capability，保存/审查只能围着 `demo.*` 和本机 MCP 转，但**人路径必须先通**，否则 adapter 写了也没有入口。

---

## 11. 分期（本程序波次）

对照 `flow-design.md` P0–P3：P0 引擎与 P1 Web 证据链已落地。本程序补的是 **P1 人手动闭环 + 通道绑定**，以及可选 P2 识别。

| 波次 | 内容 | 用户可感知的完成定义 | 依赖 |
| --- | --- | --- | --- |
| W0 | 通道 `flow_id` 省略继承；apply 拒 candidate | 给槽位 apply 一条 published 后，飞书下一句会跑 Flow（测试覆盖） | 无 |
| W1 | `/flow` 列表/绑定/解绑；`/status` 显示；`/flow run` | 飞书与 Telegram 不经 Web 即可绑并跑 demo echo | W0 |
| W2 | Web「存为 Flow」+ 空目录文案；可选 `/flow save` | 一次成功 runbook 可进侧栏候选并 Dry-run | W0 |
| W3 | Web 审查页（Diff + 通过/打回 + git_revision） | 候选可发布，侧栏出现已发布 | W2 |
| W4 | 建议保存卡、建议审查卡（通道 + 对话确认） | 说「存」会真落库；说「审」不会误发布 | W2/W3 |
| W5 | 对话识别 published + 确认后 apply | 未绑闲聊可确认绑定 | W1 |
| W6 | 解绑在空目录可用；通道终态摘要；可选解释 | 绑/解/看结果不迷路 | W1 |

审查可砍：W4、W5、W6 解释。不可砍：W0（否则 W1 是假的）。

建议落地顺序：W0 → W1 → W2 → W3，然后按日常是否「要建议/要识别」再开 W4/W5。

---

## 12. 验收（产品级）

1. **互斥：** 未绑会话飞书发「你好」仍走 Agent；`/flow` 绑 published runbook 后再发，走 Runtime，时间线出现 `flow_step`，无 Agent 工具执行该步骤。
2. **继承：** 通道消息不带 `flow_id` 字段时，使用 `session.flowId`；测试禁止再把省略变成 `null` 导致未绑定执行。
3. **候选：** 聊天 `/flow` 列表不含 candidate；apply(candidate) → 409；Web 点候选仍不写 `session.flowId`。
4. **保存：** Web 存为 Flow 后 `GET /v1/flows` 可见 candidate；未确认的对话建议不产生新行。
5. **审查：** 无 git_revision 的 approve → 409；Web 通过后 status=published；飞书没有批准按钮。
6. **解绑：** `/flow off` 后下一句回到 Agent。
7. **回归：** 现有 `session-runtime-api` / `flow-api` / `flow-loop.spec.ts` / slash `/help` 测试全绿。
8. **guide：** 若保留在 `/flow` 列表，绑定后不得走 compileCatalogFlow 失败；若编译失败应在列表阶段排除或绑定 409。

---

## 13. 请审查拍板的默认决策

下面是写进计划用的默认。划掉或改值即可，不必重写全文。

| ID | 默认 | 备选 |
| --- | --- | --- |
| D1 | 聊天绑定第一期用斜杠 `/flow`，不做飞书卡片点选列表 | 第一期就做卡片 |
| D2 | 绑后普通消息即运行；另提供 `/flow run k=v` | 绑后普通消息仍闲聊，只有 `/flow run` 才执行（违背互斥北极星，不推荐） |
| D3 | `/flow` 列出全部 published（含 guide），guide 标注非确定性 | 只列 runbook |
| D4 | 通道永远不发 `flow_id: null`；省略=继承 | 保留显式 null 表示「本句强制 Agent」（与互斥冲突） |
| D5 | apply 拒绝 candidate | apply 仍写入但不执行（现状，禁止） |
| D6 | W2 只从最近成功 **runbook** Run 生成 candidate，不把 FLOW_PROPOSED manual 当可发布源 | W2 也保存 guide candidate |
| D7 | 审查批准只在 Web；通道可打回 | 通道也可批准（不推荐） |
| D8 | git_revision 由用户粘贴或只读填 `HEAD`，Bridge 不替用户 commit | 批准时自动 git commit catalog |
| D9 | W4/W5 为可选项，W0–W3 为闭环最小集 | 最小集包含 W5 |
| D10 | 解释 SNAPSHOT 放入 W6 可选 | 本程序不做解释 |

仓库内不能确认、实现时不要假装已经知道：

- 本机 `~/.codebridge/flows.sqlite` 是否已有 published（空目录只影响手工验收，不挡测试用 fixture）。
- 飞书开放平台是否已配置自定义菜单；代码加 `fcb_flow` 后菜单仍可能不出现。
- 工作台对用户的可达 URL（卡片链到 Web 依赖配置）。

---

## 14. 自审

- 无「通道自建状态机」、无「Agent 当 runbook 执行器」、无「candidate 真跑」。
- W0 合同与 W1 斜杠分开：先能继承，再给入口。
- 保存 / 审查 / 绑定 三个写入口仍是现有三条 HTTP，不新造平行 catalog。
- 与已落地 Web 证据链不冲突：时间线权威源仍是 hydrate。
- `FLOW_PROPOSED` ≠ Candidate，已写明。
