# 飞书应用配置指南

适用于自有飞书企业应用。npm 与源码的群聊行为有区别，见[交付状态](../release-status.md)；本指南不代替当前飞书控制台对应用可见范围、权限审批和发布的要求。

## 创建应用与凭据

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用并添加机器人能力。当前本地候选可在带 Web 的 Bridge 中进入“渠道 → 飞书”，填写 App ID、App Secret，验证并安全保存后再应用连接。也可运行 `codebridge init`（源码用 `node apps/bridge/dist/cli.js init`）完成初始化。新密钥保存到系统钥匙串，失败时停止保存，不回退明文。具体流程和环境变量限制见[渠道管理](channel-automation-roadmap.md)。

手工配置可使用环境引用，不把真实密钥写进示例：

```yaml
feishu:
  appId: cli_your_app_id
  appSecret: env:FEISHU_APP_SECRET
```

也支持 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 环境覆盖。后台服务须具备相同的环境变量或可读取的钥匙串条目，配置不代表服务已能读取。

## 消息权限

| 权限 | 用途 |
| --- | --- |
| `im:message` | 消息读取与操作；读取用户图片/文件也需要相应消息读取权限 |
| `im:message:send_as_bot` | 以机器人身份发送回复 |
| `im:message.group_at_msg` | 接收群聊 @ 消息 |
| `im:resource` | 上传回复中的图片/文件 |

这些是基础消息能力。告警轮询、未 @ 的引用续聊、表情事件或成员显示名读取还依赖实际应用获得相应消息可见范围与接口权限；只有接收群 @ 消息的权限，不代表能够收到所有未 @ 消息。按所启用功能核对权限，并在测试群验收。告警能力另见[告警配置](feishu-alert-triage.md)。

## 长连接事件

- 选择“使用长连接接收事件”，基础入站事件为 `im.message.receive_v1`。
- 欢迎语可订阅 `im.chat.access_event.bot_p2p_chat_entered_v1`。
- 自定义菜单可订阅 `application.bot.menu_v6`，见[菜单指南](feishu-bot-menu.md)。
- 告警表情处理涉及的事件须按启用功能配置；普通文本任务不依赖卡片按钮选模型。

先启动 Runner 和 Bridge，让应用建立长连接，再按控制台要求保存事件订阅并发布配置。初始化向导或网页验证凭据不等于已经建立长连接，须观察应用后的实际连接状态。

## 当前源码的群聊和身份配置

默认新任务需要 @ 机器人；引用已验证的机器人回复可沿原会话继续，普通回复留在群消息流。此行为不包含在 npm `0.1.0`，并且仍以飞书实际投递该消息为前提。

访问限制分为群、成员与操作三个方面：

- `feishu.policy.groupAllowlist` 或 `access.allowedChats` 明确允许群访问；两者均有配置时须同时满足。当前源码允许已配置群中的成员提问和续聊，私聊访问规则单独检查。
- `access.admins` / `access.allowedUsers` 决定普通群中配置类斜杠命令的操作身份；普通成员只可使用已允许的帮助、状态和会话控制命令。
- `feishu.alertMonitor.groups[].approverOpenIds` 是对应告警群的写操作审批身份，与普通管理员不同；发布控制器还有单独的发布负责人。
- Open ID 属于具体飞书应用的身份空间，不能把另一个应用的 ID 或 Telegram 用户 ID 当作同一个授权身份。

公开 main/npm 与本地候选有差异；候选的“渠道”页面维护上述访问设置，“任务”页面维护告警审批人。使用范围与未完成项见[产品规划](channel-automation-roadmap.md)。主要字段见[配置示例](../../examples/config.full.yaml)。

## 验收

在单聊先发 `/status`，确认 Agent 和目录。在专用测试群验证新任务、引用回复、正确 @ 当前提问者，以及未授权配置命令被拒绝。不要使用业务告警群做通道连通性试验，也不要以接口返回成功替代用户实际可见的回复。

## 公开依赖与安装

飞书使用 npm 公共包 `@larksuiteoapi/node-sdk`（锁文件解析为 1.68.0）和 `mdast-util-from-markdown` 2.0.3。均由 `@codebridge/channel-feishu` 显式声明；不依赖维护者的飞书 CLI、私有 MCP、应用凭据或业务 Skill。源码安装使用 `pnpm install --frozen-lockfile`，分发包通过 `pnpm test:package` 在临时目录独立安装验证。

成员选择直接调用官方 SDK 的 `im.v1.chatMembers.get`，请求当前应用的 `open_id`，逐页读取；权限不足、断线或分页不完整时保留表单并显示错误。机器人须已加入目标群，应用须按飞书控制台要求获得群成员读取权限。配置页面不会因昵称相同而合并跨应用或 Telegram 身份，也不会要求读取全公司通讯录。

真实应用 ID、密钥、允许群、管理员、审批人和业务 Skill 都由使用者在本机配置，不随源码或 npm 包分发。告警群目录只显示机器人已加入且符合当前访问限制的群；成员选择按当前群读取，不需要先抄录群 ID。

目录和姓名选择分别复用官方 SDK 的 [群列表](https://open.feishu.cn/document/server-docs/group/chat/list)与[群成员列表](https://open.feishu.cn/document/server-docs/group/chat-member/get)接口；告警来源使用[群历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)。根据所用接口在飞书控制台申请相应读取权限并发布应用配置。页面会保留已选身份、显示读取失败原因并允许重试，不会替应用申请或自动扩大权限。
