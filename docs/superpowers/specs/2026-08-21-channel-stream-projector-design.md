# Web / 飞书 / Telegram 统一流式投影设计

- Status: Accepted for implementation
- Date: 2026-08-21
- Scope: AgentEvent 到通道展示快照的统一投影；修复飞书工具阶段 commentary 重复
- Out of scope: Flow 产品实现、ACP wire protocol 改造、Telegram 实时编辑交互

## 1. 问题

飞书运行中的“最新进度”会在工具调用前后重复早期文本。例如 Provider 依次产生：

```text
你好
你好，我来帮你处理
你好
你好
```

当前飞书两条流式路径都直接执行：

```ts
progressContent = progressContent + part.text;
```

这隐含假设每个 commentary 事件都是严格 delta。但实际 Provider 可能发送：

- 真正的增量 chunk；
- 同一 message 的累计快照；
- 工具阶段切换后的重发；
- 已完整文本的短前缀回退；
- 新 messageId 的新检查点。

飞书终态渲染会丢弃 progress 区、保留 result 区，所以运行中重复而最终答案正常。

Telegram 当前主路径只在终态编辑一次结果，不实时显示 commentary，因此不会表现为同一种闪回；但它与飞书共用 presenter、独立维护 buffer，未来增加实时更新后会重复遇到同一问题。

## 2. 目标

建立通道无关的 `ChannelStreamProjector`：

```text
AgentEvent
  → presenter（事件分区）
  → projector（状态合并）
  → ChannelStreamSnapshot
  → 飞书 / Telegram / Web renderer
```

统一层负责：

- `thinking / progress / result` 分区状态；
- commentary 的 delta、累计快照、重复和前缀回退合并；
- messageId 切段；
- result 累积；
- live 与 terminal 两套稳定文本；
- progress 长度限制；
- 相同事件序列产生确定性投影。

通道只负责：

- 飞书：卡片创建、`setContent`、状态栏、定时刷新和降级发送；
- Telegram：placeholder、终态 edit/send；未来可选择使用 liveText 实时编辑；
- Web：若后续接入，可直接使用 snapshot，不重新实现累积规则。

## 3. 非目标

- 不在 ACP Mapper 中去重或改写原始 `AgentEvent`。
- 不改变 Work Item、Timeline、审计中的事件事实。
- 不让 projector 发 HTTP、飞书卡片或 Telegram 消息。
- 不在本轮给 Telegram 新增实时进度编辑。
- 不处理 watcher sequence cursor；cursor 仍由各 SessionWatcher 负责。
- 不引入通用富文本/DAG/Flow 逻辑。

## 4. 组件边界

### 4.1 新增 ChannelStreamProjector

位置：

```text
packages/router/src/channel-stream-projector.ts
```

`packages/router` 已被飞书和 Telegram 共同依赖，现有 `createFeishuStreamPresenter` 也位于该包。新投影器放在这里，不增加通道间依赖。

公共合同：

```ts
export interface ChannelStreamSnapshot {
  thinking: string;
  progress: string;
  result: string;
  liveText: string;
  finalText: string;
}

export interface ChannelStreamProjectorOptions {
  showThinking?: boolean;
  maxProgressChars?: number;
  emptyFinalText?: string;
}

export interface ChannelStreamProjector {
  apply(event: AgentEvent): ChannelStreamSnapshot;
  snapshot(): ChannelStreamSnapshot;
}

export function createChannelStreamProjector(
  options?: ChannelStreamProjectorOptions,
): ChannelStreamProjector;
```

默认值：

```ts
showThinking = true;
maxProgressChars = 1200;
emptyFinalText = "（本次无输出）";
```

### 4.2 保留 presenter 兼容层

现有 `createFeishuStreamPresenter` 暂不删除、不改外部签名。Projector 在内部调用它完成 `AgentEvent → FeishuStreamPart` 分区。

这样可以：

- 将本轮改动限制在累积语义；
- 避免同时重写工具、plan、usage 和 messageId 换段规则；
- 给尚未迁移的调用方保留兼容出口。

名称中的 `Feishu` 是历史遗留，后续可以单独重命名；本轮不做无关 rename。

### 4.3 通道采用方式

飞书以下三处改为持有 projector，不再自行维护 `thinkingContent / progressContent / resultBuffer`：

- `FeishuRunCard`；
- `FeishuSessionWatcher.resumedCards`；
- `FeishuBridge.streamAgentReply` legacy 路径。

Telegram 以下两处使用同一 projector：

- `TelegramRunRenderer`；
- `TelegramBridge.runLegacyAgent`。

Telegram 本轮仍只发送 placeholder 和 `finalText`，不在每个 `apply` 后调用 `editMessage`。主 SessionWatcher 路径的用户行为不变；legacy 路径从“把所有 presenter part 拼进最终消息”收敛为只发送 result/error，避免思考和 commentary 污染终态。

## 5. Progress 合并规则

Projector 维护：

```ts
progressContent: string;
progressMessageId?: string;
```

收到 progress part 后，先判断消息边界，再合并文本。

### 5.1 同一消息或 messageId 缺失

`previous` 为当前 progress，`next` 为新 part：

1. `next === previous`：完全重复，保持 `previous`。
2. `next.startsWith(previous)`：累计快照增长，采用 `next`。
3. `previous.startsWith(next)`：短前缀回退，保持更完整的 `previous`。
4. `previous` 后缀与 `next` 前缀有重叠：只追加非重叠部分。
5. 无重叠：视为真实 delta，追加 `next`。

示例：

| previous | next | 结果 |
| --- | --- | --- |
| `你好` | `你好` | `你好` |
| `你好` | `你好，我来处理` | `你好，我来处理` |
| `你好，我来处理` | `你好` | `你好，我来处理` |
| `正在查订` | `订单` | `正在查订单` |
| `正在查询` | `，请稍候` | `正在查询，请稍候` |

### 5.2 messageId 变化

若 old/new messageId 均存在且不同：

- 新文本与旧文本完全相同、是旧文本前缀、或是旧文本的累计扩展：保留两者中更完整的版本，视为工具切段重放。
- 两者无前缀继承关系：采用新文本，表示新的“最新检查点”。

示例：

| previous | next | 结果 |
| --- | --- | --- |
| `你好，我来处理` | `你好` | `你好，我来处理` |
| `P2 已完成` | `P3 正在推进` | `P3 正在推进` |

### 5.3 长度限制

合并完成后再截取末尾 `maxProgressChars`。截断只影响 progress 展示，不影响 result、审计或最终答案。

## 6. Snapshot 语义

### 6.1 liveText

`liveText` 使用稳定顺序：

```text
thinking（showThinking=true 时）

---

**最新进度**
progress

---

result（如果已开始产生）
```

空区域不输出，也不产生多余分隔线。飞书的运行状态栏仍由 Feishu adapter 添加在 `liveText` 之前。

### 6.2 finalText

`finalText` 只来自 result/error 区：

```ts
result.trim() || emptyFinalText
```

thinking、tool 和 commentary 不进入最终答案。这样飞书与 Telegram 的终态语义一致。

`showThinking` 只控制运行中的 liveText，不控制 finalText；这是统一层的明确合同，不由通道自行决定。

### 6.3 原始事件

Projector 不修改输入事件，不向上游反馈“已去重”状态。Timeline 和审计仍能看到 Provider 实际发送过的所有事件。

## 7. 异常与恢复

- Projector 是同步纯内存状态机，`apply` 不抛通道 I/O 错误。
- 飞书 `setContent` 失败仍按现有策略降级；projector 的 `result` 保留完整最终文本。
- watcher reconnect 继续使用 domain sequence cursor，成功处理后推进。
- delivering 恢复时创建空 projector，并从 accepted sequence 重放；相同有序事件得到相同 snapshot。
- terminal update 失败不清除 delivery，仍由现有 watcher 重连恢复。

## 8. 测试合同

### 8.1 Projector 单元测试

新增：

```text
packages/router/src/channel-stream-projector.test.ts
```

必须覆盖：

1. strict delta 正常追加；
2. cumulative snapshot 替换而非重复；
3. 完全重复忽略；
4. 短前缀回退不让 UI 倒退；
5. suffix/prefix overlap 合并；
6. 新 messageId 的无关检查点替换旧检查点；
7. 新 messageId 的前缀重放不覆盖完整内容；
8. progress 截断；
9. finalText 排除 thinking/progress；
10. error 进入 finalText；
11. 同一事件序列在两个新 projector 上产生完全相同 snapshot；
12. `showThinking=false` 不泄漏 thought/tool。

### 8.2 飞书回归

在 `session-watcher.test.ts` 和 `bridge-stream.test.ts` 覆盖：

```text
commentary: 你好
tool_start / tool_end
commentary: 你好，我来帮你处理
commentary: 你好
commentary: 你好
final_answer: 已处理完成
```

运行中卡片断言：

- `你好` 不重复；
- 不从完整检查点退回短前缀；
- 工具状态仍正常更新。

终态断言：

```text
已处理完成
```

### 8.3 Telegram 回归

在 `telegram-session-watcher.test.ts` 和 `telegram-bridge.test.ts` 断言：

- 运行中仍只发送一次 placeholder；
- commentary 不进入终态；
- 终态仍只编辑/发送 finalText；
- 本轮不增加实时 `editMessage` 调用次数。
- legacy 路径不再把 thinking/tool/commentary 拼入最终消息。

## 9. 验收标准

- 飞书工具阶段不再重复、闪回早期 commentary。
- 飞书最终答案保持正确且不包含 progress/thinking。
- Telegram 主 SessionWatcher 交互不发生可见变化；legacy 终态改为只显示 result/error，与主路径对齐。
- 两个通道不再自行实现 progress/result 累积规则。
- ACP Mapper、Work Item、Timeline 和审计事件不变。
- 新统一层有独立、确定性的单元测试。
- 飞书主 watcher、legacy 路径和 Telegram 两条路径均使用统一 projector。
