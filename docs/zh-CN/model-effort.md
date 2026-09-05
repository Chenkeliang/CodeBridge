# Model / Effort 切换

## 飞书侧能力调研

飞书 **没有** 聊天窗口内置的「模型下拉框」或 effort 控件；机器人也不能像客户端那样自带模型选择 UI。

| 方式 | 是否可行 | 说明 |
|------|----------|------|
| **Slash 命令** | ✅ 已实现 | `/model`、`/effort`、`/permission`，按飞书会话记忆，写入 `chat-bindings.json` |
| **配置文件默认值** | ✅ | 可选；不配置时跟随 ACP adapter 的实时默认值 |
| **流式 Markdown 卡片** | ✅ 已有 | Agent 回复用 `channel.stream()` |
| **交互式卡片按钮** | ⚠️ 未实现 | 飞书支持 [消息卡片](https://open.feishu.cn/document/ukTMukTMukTM/uczM3QjL3MzN04yNzcDN) + `card.action.trigger`；Channel SDK 文档称可「卡片按钮」场景，但码桥当前未做按钮选模型 |
| **长连接 vs Webhook** | 注意 | 当前码桥用 **长连接**收消息；卡片回调历史上多走 Webhook，长连接对 `card.action.trigger` 的支持需以飞书控制台与 SDK 版本为准 |

**结论**：在飞书里切 model/effort，**现阶段用 slash 最稳**；若要做「点按钮选模型」，需额外开发交互卡片 + 处理 `card.action.trigger`（可作为后续增强）。

---

## ACP 支持矩阵

| Backend | model | effort |
|---------|-------|--------|
| **cursor** | ✅ | 当前 adapter 未提供 |
| **claude** | ✅ | ✅ `low` / `medium` / `high` / `xhigh` / `max` |
| **codex** | ✅ | ✅ `low` / `medium` / `high` / `xhigh` / `max` / `ultra` |

优先级：**会话 slash 覆盖** > **config.yaml 默认** > **ACP 适配器默认**。

### ACP mode / 权限（飞书必看）

`/permission`（别名 `/perm`）直接读取各 adapter 的 `mode`：Cursor 通常提供 `agent/plan/ask`，Claude 提供 permission mode，Codex 提供 `read-only/agent/agent-full-access`。Claude 仍兼容配置默认值：

```yaml
backends:
  claude:
    claudePermissionMode: bypassPermissions
```

具体选项始终以当前 `/permission` 实时结果为准。仅在可信本机使用 `bypassPermissions` 或 `agent-full-access`。

---

## 飞书命令

```
/model                  # 实时读取当前 backend 的 model 列表
/model <列表里的名称>   # 名称和值均可；写入前会按实时列表校验
/model default          # 清除会话覆盖，回到 ACP adapter 默认

/effort                 # 实时读取 thought_level（Claude / Codex）
/effort high
/effort ultra           # Codex 当前支持
/effort default         # 清除覆盖

/permission             # 实时读取当前 backend 的 mode/权限列表
/permission ask         # Cursor 示例
/permission bypassPermissions # Claude 示例
/permission read-only   # Codex 示例
/permission default     # 清除覆盖

/status                 # 查看 backend / model / effort / permission / cwd
```

---

## 配置文件示例

```yaml
backends:
  cursor:
    type: cursor-cli
    acpCommand: cursor-agent
    acpArgs: ["acp"]
  claude:
    type: claude-code
    acpCommand: npx
    acpArgs: ["-y", "@agentclientprotocol/claude-agent-acp@0.64.2"]
    claudePermissionMode: bypassPermissions
  codex:
    type: codex
    acpCommand: npx
    acpArgs: ["-y", "@agentclientprotocol/codex-acp@1.10.0"]
```

会话绑定持久化：`~/.codebridge/chat-bindings.json`（按 `chatId|topicId`）。

不建议在 yaml 固定 model/effort，否则会覆盖 adapter 随版本更新的默认值。slash 设置的会话覆盖立即生效；`/model default`、`/effort default` 可恢复实时默认。
