我日常写代码基本离不开 Cursor、Claude Code、Codex，但人总不能一直坐在电脑前。

通勤、开会、躺沙发上的时候，经常想「刚才终端里那个 session 能不能接着干」。手机 App 和 Web Agent 都能用，可我本机那套 MCP、skill、SSH、未提交的改动都在 Mac 上，懒得再配一遍。

公司本来就用飞书，所以搞了个小东西 **飞书码桥**（feishu-code-bridge）：飞书 @ 机器人发句话，家里/办公室那台 Mac 上的 Runner 拉起 `cursor-agent` / `claude` / `codex`，结果流式回飞书。

### 流程

```text
飞书（@ 机器人发消息）
  → Bridge（长连接收消息、斜杠命令、流式 Markdown 回复）
  → HTTP/SSE
  → Runner（宿主机起 CLI、解析输出）
  → cursor-agent / claude / codex
```

Bridge 可以 Docker 部署；**Runner 必须在装 CLI 的那台机器上**，Agent 要读本机文件、跑 git、用 MCP。

### 依赖飞书

- 在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**，开启**机器人**能力
- 事件订阅用**长连接**（`im.message.receive_v1`），不是 Webhook；配置前需先运行 `./scripts/start.sh`
- 权限需消息收发、群 @ 等（`im:message`、`im:message:send_as_bot`、`im:message.group_at_msg` 等，详见仓库文档）
- `appId` / `appSecret` 写入 `~/.feishu-code-bridge/config.yaml`

飞书是遥控器和聊天窗口，真正干活的是本机 CLI；没有飞书企业应用用不了 Bridge。

### 常用命令

- `/resume`：列出本机 session，绑定后继续
- `/backend`、`/model`：切换 Agent / 模型
- `/cd`、`/ws use`：切换项目（先切目录，再发任务）
- `/stop`：取消正在跑的任务

### 并行（我自己的用法）

- 可以：私聊改 A 项目 + 群里改 B 项目；两个群各跑各的
- 不行：同一个群里两人同时 @；同群 cursor 和 claude 同时跑（只能 `/backend` 切换）
- 同一会话连发两条，后一条会顶掉前一条

要并行改两个 repo：开两个飞书会话（私聊 + 群），各自 `/cd`。

### 其他

- Runner 常驻本机，不是云端 Agent
- Claude 非交互模式需配 `bypassPermissions`（否则 Bash 会被拒，见 README）
- 安装：`./scripts/start.sh setup`，按提示填飞书凭据
- 开源 MIT：[feishu-code-bridge](https://github.com/Chenkeliang/feishu-code-bridge)

有同样在飞书里远程撸本机 CLI 的，欢迎试试，issue 随便扔。
