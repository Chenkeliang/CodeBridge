# 飞书应用配置指南

## 创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 创建 **企业自建应用**
3. 添加 **机器人** 能力

## 权限

| 权限 | 用途 |
|------|------|
| `im:message` | 接收与发送消息 |
| `im:message:send_as_bot` | 以机器人身份发送 |
| `im:message.group_at_msg` | 群聊 @ 消息 |
| `im:resource` | 图片/文件 |

## 事件订阅

- 方式：**使用长连接接收事件**
- 必选：`im.message.receive_v1`
- 推荐（欢迎语 + 常置菜单）：
  - `im.chat.access_event.bot_p2p_chat_entered_v1` — 用户打开单聊时发欢迎语
  - `application.bot.menu_v6` — 机器人自定义菜单点击（见 [feishu-bot-menu.md](./feishu-bot-menu.md)）
- 可选：`card.action.trigger`

**注意**：需先在本机运行 `./scripts/start.sh`，控制台才能保存长连接配置。

## 凭据

在应用「凭证与基础信息」获取 App ID、App Secret，写入：

```yaml
# ~/.feishu-code-bridge/config.yaml
feishu:
  appId: cli_xxx
  appSecret: xxx
```

或使用环境变量 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。

## 群聊策略

默认群聊需 **@机器人** 才回复。信任工作群可在 `feishu.policy.scenarios` 中配置 `requireMention: false`。

详见 `examples/config.full.yaml`。
