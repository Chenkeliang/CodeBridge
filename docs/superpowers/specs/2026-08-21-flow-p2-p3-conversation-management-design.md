# Flow P2 / P3 对话协作与通道管理设计

Status: Accepted for implementation

## 1. 目标

在不改变 `Published Runbook + Runtime` 核心定义的前提下，补齐两类能力：

- P2：让 LLM 在普通对话中判断是否应建议已有 Flow；用户确认后才执行或保存；Web 能自由维护 Guide 草稿。
- P3：飞书复用 Bridge 管理用例完成有限 Flow 管理；Telegram 只保持同合同实现和测试，部署继续关闭。

## 2. 不变边界

- Agent 不写 Catalog、不批准发布、不执行 Runbook。
- Guide 永不执行；只有 Published Runbook 可正式运行。
- 通道不复制 Flow 状态机、版本规则、Diff 或 Review 规则。
- 建议不是执行。任何 recommendation 都必须经过当前用户显式确认。
- 通道证据不足时只允许送审提醒、查看摘要或打回；批准发布只在 Web。

## 3. P2：LLM 建议合同

### 3.1 决策者

是否建议 Flow 由当前 Agent/LLM 判断，不在 Bridge 中维护关键词或业务意图规则。Bridge 只提供：

1. 当前可消费 Flow 的最小摘要；
2. `fcb flow suggest` 结构化建议命令；
3. 对建议中的 Flow identity、revision 和输入做服务端校验；
4. 将合法建议记录为只读 recommendation。

Agent 仅在高置信精确匹配时建议；否则继续普通任务。建议必须在调用业务工具前发生，建议后本轮停止执行任务。

### 3.2 recommendation 数据

最小字段：`session_id`、`run_id`、`flow_id`、`definition_revision`、`reason`、`extracted_inputs`、`status`。状态为 `pending | accepted | dismissed | stale`。

- `flow_id + revision` 必须仍是 consumable；否则拒写或读为 stale。
- 参数只接受 Flow 定义中声明且非 secret 的字段。
- recommendation 不改变 Session binding，不创建 Run。
- accepted 仍通过现有 one-shot `/messages` 合同执行。

### 3.3 三表面

- Web：Timeline 显示建议卡；确认后进入现有补参/运行确认；可忽略。
- 飞书：Agent 最终答复给出 `/flow <id>` 明确选择入口，之后复用 P1A 参数/确认流程。
- Telegram：相同文本合同，但部署仍 disabled。

### 3.4 保存与审查提醒

- 成功普通 Agent Run：沿用 Session → Guide proposal，用户点击/命令确认后保存。
- Candidate pending：Web 管理面显示审查入口；飞书只给 Web 深链提醒。
- 不从自然语言“好/可以”推断写操作；保存、执行、送审都使用明确按钮或 `/flow` 子命令。

## 4. Web Guide 创作

P2 Web 只做结构化表单，不建设 DAG 画布：

- 新建 Guide；
- 编辑名称、描述和有序 manual steps；
- 导入同一合法 Guide JSON；
- 服务端重算 `definitionRevision`；
- Guide → Runbook Candidate 使用显式“升级为 Candidate”，并要求补 Capability、输入和 `success_when`；不完整时返回 validation issues。

Guide 的所有写入都通过 Bridge，Web 不自行判断合法状态。

## 5. P3 通道管理

飞书增加以下文本命令，全部调用 Bridge 管理接口：

- `/flow guide save`：将最近一次可提取 Agent Run 保存为 Guide；
- `/flow manage`：列出 Guide/Candidate/Published/Deprecated 摘要；
- `/flow diff <id>`：显示语义 Diff、provenance 和证据计数；
- `/flow edit <id> name=<...>`、`description=<...>`：只允许编辑 Candidate 摘要字段；
- `/flow review <id>`：提交/提示 Definition Review（当前 Review 合同以 Candidate pending 为准）；
- `/flow reject <id>`：打回 Candidate；
- `/flow open <id>`：返回 Web 深链。

不提供 `/flow publish` 或通道 approve。步骤/Capability 的复杂编辑继续进入 Web。

Telegram 控制器实现相同命令合同和适配测试，但 bot 未配置前不宣称 reachable。

## 6. Web 深链

统一链接：`/workbench/?flow=<flow_id>&session=<session_id>`。Web 只接受本地相对 URL 参数，打开后重新通过 API 校验对象与权限；无效参数显示错误，不回落默认对象。

## 7. Surface Matrix

| Surface | P2 建议 | 保存 Guide | 管理 Candidate | 发布批准 | 部署状态 |
|---|---|---|---|---|---|
| Web | recommendation 卡 + 确认 | Timeline / 新建编辑器 | 完整 Diff、编辑、Review | 可用 | reachable |
| Agent | LLM 判断并调用结构化建议 | 只能建议 | 无写权限 | 禁止 | reachable |
| 飞书 | 文本建议 → P1A 明确确认 | `/flow guide save` | 摘要编辑、送审、打回、Diff | 禁止，跳 Web | reachable |
| Telegram | 同合同 | 同合同 | 同合同 | 禁止 | implemented / disabled |

## 8. 验收

- 没有 recommendation 时普通 Agent 行为不变。
- recommendation 不会执行、不绑定、不写 Catalog。
- stale revision、非法输入和非 consumable Flow 均不能被确认执行。
- Web Guide 写入只产生 `guide + draft`，且 revision 由服务端生成。
- 飞书管理命令不含发布批准；所有业务规则来自 Bridge。
- Telegram 构建和测试通过但运行配置仍 disabled。
