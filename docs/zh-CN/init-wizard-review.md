# 初始化向导审查修复与验收（2026-10-10）

## 范围与边界

修复 `feat_init_wizard` 上初始化向导的既有审查问题，入口是 `apps/bridge/src/cli.ts` 的 `init` 命令；`scripts/start.sh setup` 继续调用此入口。只涉及初始化、配套说明及测试，不修改已运行服务的消息处理、部署接口或 Linux 部署支持。

成功标准：保留既有配置；取消或保存失败时不覆盖旧密钥；终端输入不泄露密钥；Telegram 不留下无白名单的配置；非交互初始化产生随机 Runner token 且不覆盖文件；构建、测试、lint 通过。验证使用临时目录、假密钥和模拟 HTTP，不访问真实钥匙串或发送真实通道消息。

## 保存机制

先收集答案，再通过 `ConfigStore` 按运行时相同的文件与环境变量合并方式验证。配置临时文件位于真实目标文件同目录，权限为 `600`；通过符号链接配置时保留链接，原子替换其目标。

新密钥存放在带随机后缀的独立钥匙串条目，读回核对后才写入引用。配置提交失败或用户拒绝明文回退时，删除本次新建条目；不会覆盖或删除已有条目。清理失败会明确提示条目名称，旧配置仍然引用原密钥。成功换凭据后也保留旧条目，以免破坏其他仍引用它的组件。

非交互模式不访问钥匙串，只在文件不存在时创建权限 `600` 的配置，随机 token 写入文件，或保留 `RUNNER_TOKEN` 环境变量引用。终端说明和中英文 README 均解释了这一行为及后续 `secrets migrate` 路径。

## 审查项对应

编号沿用原审查结果的 0–19，重复项合并列出。

| 原编号 | 问题 | 修复与验证 |
|---|---|---|
| 0 | Telegram 自动识别可能选中陌生人 | 一次性验证码、私聊且非机器人过滤；确认默认否；模拟陌生人、群聊、机器人和正确用户混合更新 |
| 1、12 | 已配置 Telegram 可保留空白名单，换 token 会覆盖旧白名单 | 保留已有用户或聊天白名单；缺失时强制补齐，即使跳过重新配置也检查 |
| 2、3 | 输入历史及粘贴泄密 | 无历史的终端输入；整个向导期间保持 raw mode；空闲输入丢弃；分块括号粘贴隔离；单测及伪终端验证 |
| 4、10 | 中途取消已覆盖旧钥匙串值 | 新条目隔离，配置提交前验证；取消、第二个密钥失败、rename 失败均验证原配置及旧密钥不变 |
| 5、13 | 无 TTY 或 --defaults 保留公开占位 token | CLI 接入 `initDefaults`，生成随机 token；真实 CLI 验证两种入口、权限和重复运行不覆盖 |
| 6 | 写入失败留下临时配置 | try/finally 清理；验证校验失败及 rename 失败后的目录内容 |
| 7 | 飞书默认私聊开放没有提示 | 显示当前开放范围，说明需同时设置 dmMode: allowlist 和 dmAllowlist |
| 8 | 凭据可能经 HTTP 发送 | 拒绝 HTTP，拒绝重定向；测试无任何 HTTP 调用；错误消息中的凭据打码 |
| 9 | 验证消息重放为 Agent 任务 | 确认 Telegram update offset；确认失败中止保存；测试调用参数和失败路径 |
| 11 | Pi／自定义默认 Agent 被替换 | 将既有合法默认项纳入选择，回车保留；验证自定义 backend、注释及其他配置 |
| 14 | Docker 无法获得钥匙串中的 Runner token | Docker 文档改用现有 `start.sh docker`；其已解析宿主机引用并生成私有 deploy/.env，无需另造 token |
| 15 | 凭据填写失败无法跳过通道 | 支持空输入和 /skip；三次失败后明确询问跳过或中止；不保存未验证的新凭据 |
| 16 | 环境变量补全配置被错误拒绝 | 复用 ConfigStore 校验；环境变量完整提供飞书凭据时可直接保留；不把环境变量密钥落盘 |
| 17 | 覆盖 config.yaml 符号链接 | 对 realpath 目标同目录原子替换；测试链接、目标内容、权限和临时文件清理 |
| 18 | 项目路径和 YAML 保留的承诺不准确 | 未修改的路径保留原始文本；拒绝创建缺失目录则中止；明确 YAML 排版可能改变 |
| 19 | 缺少高风险路径测试 | 增加持久化、密钥、旧配置、终端生命周期、CLI 及伪终端验证 |

## Surface Matrix

这里的 reachable 指当前候选构建的入口可达，不表示已经部署。closed-loop 限定为本地验证环境；外部服务用模拟接口。Web、Agent 没有新增交互入口，不将间接配置读取宣称为新功能闭环。

| Surface | entry / read path | write path / event consumption | error handling / recovery | terminal feedback | 状态与 planned 落点 |
|---|---|---|---|---|---|
| CLI（本次主入口） | init → terminalIo → runInitWizard；无 TTY → initDefaults；setup → init | 临时配置校验 → 新钥匙串条目 → 配置原子提交；键盘输入由 terminalIo 处理 | Ctrl-C / Ctrl-D / EOF、凭据失败、文件写入失败；关闭终端、清理暂存项 | 成功显示保存路径和来源，失败显示原因 | implemented、reachable；本地假凭据完整流程 closed-loop；无遗留 planned |
| 飞书 | 向导收集或保留凭据；verifyFeishu 校验；运行时继续由 ConfigStore / FeishuBridge 读取 | 模拟 token 校验响应；配置保存；不变更消息事件处理 | 三次失败可跳过或中止；禁止 HTTP；环境变量优先 | 有效、失败、私聊开放提示 | implemented、reachable（候选向导）；模拟契约 closed-loop；真实飞书服务未验证；无新增 planned |
| Telegram | 向导 getMe → 验证码 getUpdates 或手填 ID；运行时继续使用现有通道 | 白名单与 token 引用保存，确认 update offset；不变更任务消息处理 | 错误转手填；确认消息失败中止；保留或补齐既有白名单 | 显示用户名／ID并明确确认；不打印 token | implemented、reachable（候选向导）；模拟契约 closed-loop；真实 Telegram 服务未验证；无新增 planned |
| Agent | 无新增 Agent 控制入口；向导保留或选择默认 Agent | 不触发 Agent run；仅保存 defaultAgent/defaultBackend | Pi／自定义默认项保留的回归测试 | 向导显示默认 Agent | 原能力不变；本次 Agent run 的 reachable / closed-loop 不作新增声明；无新增 planned |
| Web | 无新增页面、跳转或 Web 初始化入口 | 不改变 API、事件投影或页面状态 | 现有全量测试覆盖，未执行浏览器验收 | 原页面反馈不变 | 原能力不变；本次 Web 的 reachable / closed-loop 不作新增声明；无新增 planned |

## 验证记录

- 基线：`pnpm exec tsc -b apps/bridge --pretty false` 报 `io.close` 类型错误；向导原 6 项测试中 2 项失败。
- 聚焦回归：`pnpm exec vitest run apps/bridge/src/init-wizard.test.ts`，31 项通过（原 6 项，新增 25 项）。
- 全量：`pnpm build` 通过；`pnpm lint` 通过（0 errors，7 warnings，均在本次未修改的 Web 文件）；`pnpm test` 为 142 个文件、1329 项通过。构建仍有字体静态资源及大 chunk 提示，未修改相关 Web 资源。
- 伪终端：普通／密钥输入、多行粘贴、跨 chunk 的括号粘贴、空闲输入、方向键历史、Ctrl-C／Ctrl-D；均使用假文本。
- 真实 CLI：`init --defaults --data-dir <临时目录>` 与无 TTY `init`，检查随机 token、权限 `600`、重复执行文件字节不变。
- 真实 CLI 交互：以伪终端驱动实际 `cli.js init`，仅替换 HTTP 和钥匙串 helper，走完凭据验证、保存及 `io.close()`；配置只含引用，输出和文件均不含假密钥。
- GitNexus：更新本 checkout 的索引并按绝对路径指定仓库；初始化入口、终端及内部函数影响为 LOW，修改前 `initDefaults` 无调用者由源码检索确认。最终 detect-changes 聚合结果为 critical（102 symbols / 195 flows），未将其忽略，核对过程见下文。

未运行真实第三方登录、Docker 部署或生产服务重启；这些不属于本次本地修复和验证范围。

## GitNexus 聚合风险提示的核对

`gitnexus detect-changes --scope all` 返回 critical，包含 CreateRunnerApp、ListAcpSessions 等初始化之外的流程。进一步按文件定位 `run`，工具将 `apps/bridge/src/init-wizard.test.ts` 中 `fakeKeychain` 的局部函数关联为 Runner 服务、安装器、SQL 调用等处的被调用者。源码核对表明：该函数不导出，测试文件没有被产品代码导入；这些关联不能作为真实运行时调用关系。

重新对当前候选索引执行 `impact runInitWizard`、`impact terminalIo` 和 `impact initDefaults`，三个生产入口均为 LOW，直接调用者各 1 个。全文检索 `init-wizard` 的导入只有 `cli.ts` 和其测试文件。由此确认实际产品调用范围仍限于初始化命令；保留聚合 critical 原始结果，不将图工具结果改写为“全绿”。

本文记录合并前的首轮验收，原提交 `30af63e` 未改写。后续复核发现及修复见 `release-review-2026-10-10.md`；最终 Git/部署状态以实际记录为准。
