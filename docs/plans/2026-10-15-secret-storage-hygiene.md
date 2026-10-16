# CodeBridge 密钥存储与开源卫生

范围：解释现有 FCB_TOKEN；本次不改变其权限协议。迁移 CodeBridge 自身凭据到既有 keychain/env 引用；禁止新流程写明文；清理配置备份。会话数据库、运行历史和发布回滚版本不删除。无 push/merge/deploy 授权用于本次安全补丁。

S1：ConfigStore 保存只写引用；无终端 init 要求 RUNNER_TOKEN；交互 init 钥匙串失败即停止，不回退明文。
S2：发布者和发布控制器支持既有引用机制，保留当前凭据值与业务授权；secrets status/migrate 覆盖主配置、deployer/config.json、publisher-tokens.json。
S3：修复既有 secret-check，复用官方 Gitleaks（本地验证 8.30.1）扫描当前文件及全 Git 历史；CI、文档与忽略规则同步；仅按文件/语义允许两个测试假值，不忽略真实凭据或整类测试文件。
S4：真实运行迁移前制作加密恢复快照；先验证引用可读/值一致/服务正常，再删除明确清点的旧配置备份。不可通过修改冻结发布目录来绕过发布流程；需要使用新读取代码的运行迁移待具体发布授权。

## Surface Matrix

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned |
|---|---|---|---|---|---|---|---|---|
| Web | implemented：既有入口 | planned S1 引用读取回归 | planned S1 配置只写引用 | planned S1 原事件回归 | planned S1 钥匙串失败 | planned S4 加密快照 | planned S1 原界面回归 | S1/S4 |
| Agent | implemented：既有 FCB | planned S2 读取凭据 | planned S2 出站授权保持 | planned S2 原任务事件 | planned S2 引用失败拒绝 | planned S2 保留凭据值 | planned S2 原结果回归 | S2 |
| 飞书 | implemented：既有通道 | planned S2 Controller 引用 | planned S2 发布命令原授权 | planned S2 原事件回归 | planned S2 失败提示 | planned S4 服务健康 | planned S2 原终态回归 | S2/S4；不向业务群测试 |
| Telegram | implemented：既有通道 | planned S1 主配置引用 | planned S2 原出站回归 | planned S2 原事件回归 | planned S1 失败回归 | planned S4 服务健康 | planned S2 原终态回归 | S1/S2/S4 |

测试使用临时目录、模拟钥匙串和本地模拟 HTTP；不访问真实业务接口。源码公共入口影响 HIGH/CRITICAL，必须构建、全量测试、lint 和 Gitleaks 通过后才能交付。

## 已完成的本地验证与清理

- 新增的三个回归在原实现下失败：配置保存写明文、发布者签发写明文、无终端默认初始化生成明文。修复后全部通过。另有 token-only 环境覆盖错误的前后失败/通过证据；只改变实际设置的 Runner URL 字段。
- `pnpm build` 通过；定向 6 文件 / 106 测试通过；最终 `pnpm test` 150 文件 / 1411 测试通过。`pnpm lint` 0 errors、7 条既有 Web warnings；`git diff --check` 通过。
- 真实本地分发包烟测通过：无终端引用初始化、已安装模块导入、临时 Runner 的认证与工作台资源；先验证临时 Runner URL，避免误连开发机正式 Runner。npm 12 按包名输出 pack JSON 集合，打包命令已修正集合读取。无 npm 发布。
- Gitleaks 8.30.1（官方发行包校验与本机 Homebrew 安装）扫描 511 个提交及当前项目文件通过。两个测试非秘密例外限定到具体文件/语义和 generic-api-key 规则；合成 provider token 在例外行仍被拦截。扫描入口使用相对路径保证例外匹配一致，不降低 provider 规则。
- Vitest 阻止原生系统钥匙串访问，测试全部注入模拟提供者。真实密钥只在明确的运行清理/健康检查步骤读取，不输出到日志。
- 运行目录 15 份已清点旧配置/绑定/plist 备份已删除，日志 3 处已知凭据按固定长度定点打码，数据目录收紧到 0700。执行前在数据目录外创建加密恢复包，恢复密码进入系统钥匙串，逐文件解密校验 19 个文件通过；未产生新明文备份。
- 会话数据库、运行历史、发布回滚版本保留。检查 26 个发布回滚 plist，未发现凭据环境字段。清理后 Bridge/Runner/独立发布器健康正常。

## Surface Matrix（本地完成状态）

| Surface | entry | read path | write path | event consumption | error handling | recovery | terminal feedback | planned 落点 |
|---|---|---|---|---|---|---|---|---|
| Web | implemented：既有入口 | implemented：主配置引用回归 | implemented：保存不写明文 | implemented：全量测试回归 | implemented：安全存储失败测试 | implemented：加密恢复快照已验证 | implemented：原界面回归 | S1/S3 已完成；生产读取更新待授权 |
| Agent | implemented：既有 FCB | implemented：旧授权保留 | implemented：本地发布者只写引用 | implemented：原任务回归 | implemented：引用失败测试 | implemented：凭据值保留测试 | implemented：原结果回归 | S2 本地完成；未改通用 token 协议 |
| 飞书 | implemented：既有入口 | implemented：控制器引用认证测试 | implemented：旧发布授权保持 | implemented：原事件回归 | implemented：读取失败拒绝测试 | implemented：控制器本地 HTTP/恢复测试 | implemented：原终态测试 | S2 本地完成；未发送验收消息 |
| Telegram | implemented：既有入口 | implemented：引用和 env 回归 | implemented：旧出站测试 | implemented：全量回归 | implemented：钥匙串拒绝明文回退 | implemented：配置保留测试 | implemented：原终态测试 | S1/S2 本地完成；未发真实消息 |

这些状态确认源码实现和隔离测试，不把本地通过说成生产 closed-loop。

## 剩余生产动作（需具体授权）

仍在使用的发布控制器 token 和发布者 token 在旧读取代码下尚不能直接改成引用。具体顺序：
1. 合并并推送本次安全补丁，按现有发布流程部署 Bridge/Runner。
2. 同步现有发布 checkout，通过官方安装器更新独立发布控制器；先确认无发布在途，凭据写入并读回一致后才替换/重启。
3. 运行新 `codebridge secrets migrate` 迁移当前 JSON 凭据；保留实际密钥值、用户、目标群、路由和权限。
4. 核对 `secrets status` 不再有 plaintext、迁移前后凭据哈希一致、三项服务健康、旧凭据仍能通过非发送的认证检查；不调用真实业务接口或向群发消息。

此前群聊功能的上线授权不视为本次安全补丁和独立控制器更新的授权，遵守用户 AGENTS.md 第 7 节。
