# Docker + 宿主机 Runner 部署

CodeBridge 采用 **Bridge 容器 + 宿主机 Runner** 架构：Bridge 只负责聊天通道与路由；Cursor / Claude / Codex 必须在宿主机执行以访问本机代码与登录态。

## 1. 宿主机：安装并启动 Runner

```bash
cd CodeBridge
pnpm install && pnpm build

# 初始化配置
node apps/bridge/dist/cli.js init
# 编辑 ~/.codebridge/config.yaml

# 前台启动 Runner
node packages/runner-host/dist/cli.js

# 或安装 macOS 守护进程
bash deploy/runner/install-macos.sh
```

Runner 默认监听 `127.0.0.1:19789`，仅本机可访问。

## 2. Docker：启动 Bridge

```bash
cp .env.example .env
# 填写 FEISHU_APP_ID、FEISHU_APP_SECRET、RUNNER_TOKEN

docker compose -f deploy/docker-compose.yml up -d --build
```

Bridge 通过 `host.docker.internal:19789` 调用宿主机 Runner。

## 3. 飞书后台

1. 创建企业自建应用，开启机器人
2. 权限：`im:message`、`im:message:send_as_bot`、`im:message.group_at_msg`、`im:resource`
3. 事件订阅：**长连接**，订阅 `im.message.receive_v1`
4. **先启动 bridge**，再在控制台保存长连接配置

## 4. 验证

```bash
node apps/bridge/dist/cli.js doctor
curl -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:19789/health
```

## 安全说明

- `RUNNER_TOKEN` 使用长随机字符串
- Runner 不要绑定 `0.0.0.0`（除非明确知情）
- Agent 权限由 ACP 适配器和 `runnerHost.acpPermissionPolicy` 共同控制
