# Model / Effort 切换

## 飞书侧能力调研

飞书 **没有** 聊天窗口内置的「模型下拉框」或 effort 控件；机器人也不能像客户端那样自带模型选择 UI。

| 方式 | 是否可行 | 说明 |
|------|----------|------|
| **Slash 命令** | ✅ 已实现 | `/model`、`/effort`，按飞书会话记忆，写入 `chat-bindings.json` |
| **配置文件默认值** | ✅ | `backends.*.model` / `effort`，全局默认 |
| **流式 Markdown 卡片** | ✅ 已有 | Agent 回复用 `channel.stream()` |
| **交互式卡片按钮** | ⚠️ 未实现 | 飞书支持 [消息卡片](https://open.feishu.cn/document/ukTMukTMukTM/uczM3QjL3MzN04yNzcDN) + `card.action.trigger`；Channel SDK 文档称可「卡片按钮」场景，但码桥当前未做按钮选模型 |
| **长连接 vs Webhook** | 注意 | 当前码桥用 **长连接**收消息；卡片回调历史上多走 Webhook，长连接对 `card.action.trigger` 的支持需以飞书控制台与 SDK 版本为准 |

**结论**：在飞书里切 model/effort，**现阶段用 slash 最稳**；若要做「点按钮选模型」，需额外开发交互卡片 + 处理 `card.action.trigger`（可作为后续增强）。

---

## CLI 支持矩阵

| Backend | model | effort |
|---------|-------|--------|
| **cursor** (`cursor-agent -m`) | ✅ | ❌ CLI 无此参数 |
| **claude** (`--model`, `--effort`) | ✅ | ✅ `low` / `medium` / `high` / `xhigh` / `max` |
| **codex** (`codex exec -m`) | ✅ | ❌ `codex exec` 无 `--effort` |

优先级：**会话 slash 覆盖** > **config.yaml 默认** > **CLI 自身默认**。

### Claude 权限模式（飞书必看）

飞书通过 `claude -p` 非交互调用时，CLI 默认 `dontAsk` 会**直接拒绝 Bash**（无法跑 skill、curl、脚本）。

码桥默认传入：

```yaml
backends:
  claude:
    claudePermissionMode: bypassPermissions
```

可选：`acceptEdits` / `auto` / `default` / `plan` / `dontAsk`（`claude --help` 查看）。仅在可信本机使用 `bypassPermissions`。

---

## 飞书命令

```
/model                  # 查看当前 backend 的 model 提示
/model sonnet-4         # 设置（示例，Cursor）
/model opus             # Claude
/model gpt-5.1-codex    # Codex
/model default          # 清除会话覆盖，回到 yaml 默认

/effort high            # 仅 Claude
/effort default         # 清除覆盖

/status                 # 查看 backend / model / effort / cwd
```

---

## 配置文件示例

```yaml
backends:
  cursor:
    type: cursor-cli
    command: cursor-agent
    args: ["--force"]
    model: sonnet-4          # 可选全局默认
  claude:
    type: claude-code
    command: claude
    model: sonnet
    effort: medium
  codex:
    type: codex
    command: codex
    model: gpt-5.1-codex
```

会话绑定持久化：`~/.feishu-code-bridge/chat-bindings.json`（按 `chatId|topicId`）。

修改 **yaml 里 backends 默认** 后需 **重启 Runner**；slash 设置的会话覆盖 **立即生效**，无需重启。
