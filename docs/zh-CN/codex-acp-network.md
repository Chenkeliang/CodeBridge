# Codex 联网配置与适配器升级验收

这是源码中的集成与候选适配器验收说明，不是 npm `0.1.0` 已提供的联网开关。见[交付状态](../release-status.md)。

CodeBridge 保留 ACP。支持此扩展的候选适配器通过标准布尔配置项 `network_access` 暴露联网开关；CodeBridge 通过 `session/set_config_option` 设置并读回，不改变文件沙箱或审批模式。

## 当前交付状态

CodeBridge 接线、运行前校验、升级检查和验收脚本已实现。上游源码改动保存在 `docs/upstream/codex-acp-network-access.patch`，基于 `202e66e63343ec4f5a5e35ab590251d813d129ca`；基准及文件清单在相邻 JSON 中。本仓库没有记录包含该扩展且完成验收的正式上游版本；不能把准备好的补丁视为已合入上游，也不能据某台维护者主机的本地补丁推定其他安装已有此能力。

不要现在给原版 `codex-acp@1.13.1` 配置下面的 ACP 开关；它没有声明该项，CodeBridge 会在发送任务前报错。现有 `CODEX_CONFIG` 环境变量补丁也不等于已经实现 ACP 配置项。

## 上游实现

源码 diff 新增 `NetworkAccessConfig.ts` 和对应测试；修改 `CodexAcpServer.ts` 与 `CodexAcpClient.ts`：

1. 客户端声明 `session.configOptions.boolean` 后，适配器才提供 `type: boolean` 的 `network_access`。
2. 每个会话保存独立的布尔值；新建和恢复会话初始化该值，支持通过标准 `session/set_config_option` 修改、读回。无显式配置时默认禁网。
3. 普通 prompt 和批准计划后的实现 prompt 都把该值映射到官方 `sandboxPolicy.networkAccess`。文件策略、工作区、额外目录及审批字段保持原样，不修改共享模式对象。
4. 完全访问模式不提供此项，避免把一个失去限制作用的开关展示为沙箱联网设置。

在上述基准提交的上游检出根目录，可检查并应用：

```bash
CODEBRIDGE_SOURCE=/absolute/path/to/CodeBridge
git apply --check "$CODEBRIDGE_SOURCE/docs/upstream/codex-acp-network-access.patch"
git apply "$CODEBRIDGE_SOURCE/docs/upstream/codex-acp-network-access.patch"
npm test -- src/__tests__/NetworkAccessConfig.test.ts
npm run typecheck
npm run build
```

本次仅准备源码改动，未克隆上游仓库、运行上游全量构建或提交 PR。CodeBridge 测试直接执行 diff 中的权限辅助函数；完整上游验证仍须在正式源码仓库完成。

## 正式版本接入

待上游版本明确支持该项后，固定通过验证的适配器版本，更新需要使用该能力的后端启动命令，再在对应 profile 中增加：

```yaml
backends:
  codex:
    type: codex
    acpConfig:
      network_access: true
```

这是要增加的字段，不是整份配置替换模板。自定义的其他 Codex profile 需逐一配置并保留其原有启动参数；项目不要求存在名为 `codex-profile` 的后端。删除旧 `CODEX_CONFIG` 注入前，先备份配置并验证新版本。现有会话 ID、记录和绑定不迁移；后端默认值与会话的 `configOverrides` 合并，会话覆盖优先，显式 `false` 不会被默认 `true` 覆盖。每轮都会重新设置，适配器不支持、RPC 失败、类型错误或读回不一致时终止本轮。

联网权限不区分 HTTP 读取与写入；生产写操作仍遵守已有业务授权。

## 升级门禁与完整验收

本版部署器在安装、构建、测试后，执行候选版本的 `check:codex-network`，发布前再检查一次，避免准备完成后配置或适配器发生变化。失败时不会进入排空或切换服务；已有的紧急回滚入口保持原有规则。未明确配置该 ACP 项的旧环境不启用这项检查。检查读取本地配置和验收记录，并在临时 ACP 会话内设置、读回配置，确保配置列表显示与运行默认值一致；不发送模型任务、不连接业务 API、不发通道消息。

完整验收必须显式运行。以下命令命中候选适配器和当前 Codex 账号，会消耗模型调用；只对指定主机进行 DNS/TCP 443 检查，不向目标主机发送业务 HTTP 请求或查询业务数据。文件写入仅发生在自动创建并清理的专用测试目录，外部测试文件用于确认拒绝写入。权限请求全部拒绝。隔离副作用需结合自己的候选适配器和工具配置核实。

```bash
CODEBRIDGE_SOURCE=/absolute/path/to/CodeBridge
CODEBRIDGE_CONFIG=/absolute/path/to/candidate-config.yaml
NETWORK_TEST_HOST=your-reachable-test-host.example
cd "$CODEBRIDGE_SOURCE"
pnpm build
pnpm verify:codex-network --config "$CODEBRIDGE_CONFIG" --host "$NETWORK_TEST_HOST"
pnpm check:codex-network --config "$CODEBRIDGE_CONFIG"
```

仅在配置已经指向支持标准开关的候选适配器时运行，不对当前生产原版直接执行。将示例主机替换为自己允许测试的可达主机；使用候选配置，不直接覆盖运行配置。验收逐个后端覆盖新会话、进程复用续聊、关闭进程后的冷启动续聊。每次必须满足：网络结果符合配置、工作区可写、工作区外测试文件被拒写、零权限申请、续聊沿用同一会话 ID。

全部通过后才保存配置同目录的 `codex-network-acceptance.json`；覆盖旧记录前保存带时间戳的备份。适配器版本、默认或显式启动命令、启动脚本内容、配置、CodeBridge 执行代码变化都会使记录失效。检查也会拒绝缺少某个会话形态、文件沙箱检查失败或发生提权的记录。通过固定发布版本和锁文件管理底层依赖；此检查不代替依赖供应链校验。

正式接入仍需单独授权发布 CodeBridge、更新部署器及切换运行配置。部署器源码变化需遵守既有的独立控制器安装门禁。切换完成后，从正在运行的 Runner 验证所有受影响后端的新会话和续聊，并确认 Runner、Bridge、飞书连接健康，再停用本地依赖补丁；保留备份，不先删除仍在使用的目录。
