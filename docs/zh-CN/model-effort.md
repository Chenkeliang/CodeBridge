# Model / Effort 切换

配置说明适用于当前源码；与 npm 的差异见[交付状态](../release-status.md)。下文模型、effort 和权限选项以连接中的适配器及账号实时结果为准，不承诺所有 Agent 具有相同选项。

## 飞书侧入口

CodeBridge 当前在飞书聊天中通过斜杠命令选择模型和推理强度（effort），尚未提供选模型的交互卡片。

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
| **cursor** | 以 `/model` 为准 | 以 `/effort` 实时返回为准 |
| **claude** | 以 `/model` 为准 | 以 `/effort` 为准 |
| **codex** | 以 `/model` 为准 | 以 `/effort` 为准 |

优先级：**会话 slash 覆盖** > **config.yaml 默认** > **ACP 适配器默认**。

### 模型没生效时会怎样

适配器不接受所选模型时，默认行为是**照常运行在适配器的默认模型上**，并在任务卡片里多加一行说明实际用的是哪个。适配器没报告实际模型时，那行会写明请求的模型未生效、本次用了该 Agent 的默认模型。正常运行不会多出这一行。

不接受这种替换的，给该后端加 `strictModel: true`，此时模型不匹配会直接让本轮失败而不是替换：

```yaml
backends:
  claude:
    type: claude-code
    strictModel: true
```

默认为 `false`，也就是保持替换并提示的行为。

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
/model default          # 清除会话覆盖；先回到后端配置默认，未配置才用 adapter 默认

/effort                 # 实时读取 thought_level（Claude / Codex）
/effort high
/effort ultra           # 仅在当前 /effort 列表包含该值时使用
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
  claude:
    type: claude-code
    claudePermissionMode: bypassPermissions
  codex:
    type: codex
```

命令配置写入通道绑定，并在后续任务中应用；Session / Run 的运行事实保存在数据目录的 SQLite 存储中。不要手工编辑 `chat-bindings.json` 来迁移会话，也不要把配置文件存在当作会话恢复已经成功。

不建议在 yaml 固定 model/effort，否则会覆盖 adapter 随版本更新的默认值。slash 设置的覆盖用于后续任务；`/model default`、`/effort default` 清除该会话覆盖，先使用后端配置默认，未配置时才使用适配器默认。

### 各入口的验证边界

| Surface | 入口与读取 | 设置与持久化 | 错误、恢复与反馈 | 状态 |
| --- | --- | --- | --- | --- |
| Web | 会话模型配置接口；不使用 `/model` 命令 | 会话配置接口 | 沿用 Web 会话反馈 | 既有入口；此文档不新增验收声明 |
| Agent | 无独立 `/model` 入口 | 使用已解析的会话模型 | 运行结果反馈 | 既有入口；此文档不新增验收声明 |
| 飞书 | `/model` 经 Bridge → Runner 实时读取 ACP `configOptions` | `/model <名称>` 写入会话绑定 | 读取失败显示错误；`/model default` 清除覆盖，下一轮生效 | 源码有调用路径；安装/升级后须在窗口验收 |
| Telegram | `/model` 经 Bridge → Runner 实时读取 ACP `configOptions` | `/model <名称>` 写入会话绑定 | 读取失败显示错误；`/model default` 清除覆盖，下一轮生效 | 源码有调用路径；不能据飞书验收推定Telegram已通过 |

列表由适配器与当前账号共同决定。更新默认版本时，还要检查 `~/.codebridge/config.yaml` 是否单独固定了旧版 `acpArgs`；该配置优先于源码默认值。
