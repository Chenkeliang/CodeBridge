# Release availability / 交付状态

Verified on 2026-10-15 / 核实日期：2026-10-15。

The npm package and source are separate delivery tracks. 本文件记录已发布包与源码的区别，不代表任何用户主机已部署。

| Track / 状态 | Evidence / 依据 | Meaning / 含义 |
| --- | --- | --- |
| Published / npm 已发布 | `@graychennpm/codebridge@0.1.0`, 2026-10-10 | Registry `latest` is 0.1.0; the published tarball was inspected. 已核对实际发行文件。 |
| Source after npm / 源码后续改动 | main through `fb5fb49` (2026-10-15), before the local candidate below | Not included in that npm package. 尚未形成新的 npm 正式包。 |
| Local security candidate / 本地安全候选 | `fd306b0` replayed locally as `c830331` | Included in this feature branch; not merged to main or published to npm. 已在本地功能分支，不代表线上可用。 |
| Local management candidate / 本地管理候选 | [Channels and Tasks](zh-CN/channel-automation-roadmap.md) | UI/API implemented locally; deployment and real-instance migration are pending. 本地实现不等于已发布或已迁移。 |

## Capability matrix / 能力矩阵

“Current source” includes the local feature candidate described above; it is not a claim about the public main branch or a running host. 下列当前源码包含本地候选，实际获取公开 main 时须重新核对提交。

| Capability / 能力 | npm 0.1.0 | Current source / 当前源码 |
| --- | --- | --- |
| Foreground Bridge + Runner, initialization wizard / 前台启动与初始化向导 | Available / 已有 | Available / 已有 |
| Main-config `keychain:` / `env:` references / 主配置密钥引用 | Available / 已有 | Available / 已有 |
| Init plaintext fallback on explicit confirmation / 交互初始化确认后可回退明文 | Present / 存在 | Rejected / 禁止明文回退 |
| No-TTY init: `RUNNER_TOKEN` reference if set, otherwise plaintext random token / 无终端初始化 | Present / 存在 | Requires environment token / 必须提供环境变量 |
| Queue default 100, opt-in Web, idle/context rotation / 队列默认100、Web可选、会话轮换 | Available / 已有 | Available / 已有 |
| ACP defaults: Claude 0.81.1, Codex 1.13.1 / 内建适配器默认版本 | Included / 已包含 | Same defaults / 相同 |
| Feishu independent ordinary group requests, quoted bot reply continuation, requester @ / 群消息隔离、引用续聊与提问者提醒 | Not included / 未包含 | `fb5fb49` |
| Preserve idle group replies and restore archived Codex sessions / 群回复保留闲置会话、恢复Codex归档 | Not included / 未包含 | `8e3a0a0` |
| Projection/lease and startup-timeout fixes / 投影、租约及启动超时修复 | Not included / 未包含 | `c6d763d`, `fae0cdc` |
| Feishu image/delivery fixes and boolean ACP configuration / 图片投递修复与布尔ACP配置 | Not included / 未包含 | `35d6fcb` |
| Standard Codex `network_access` adapter option / 标准Codex联网选项 | Not delivered / 未交付 | Bridge integration exists; upstream adapter patch remains separate. 不能直接在原版适配器上开启。 |
| Fixed-recipient publisher CLI, Feishu alert group configuration / 固定目标发布者CLI、飞书告警配置 | Included / 已包含 | Included; local management candidate / 已有，本地新增管理页 |
| Web channel credentials, live connection status, local Host/Origin guard, hide demo capabilities / 网页渠道凭据、真实连接态、本地主机与来源校验、隐藏演示能力 | Not included / 未包含 | Local candidate; [scope and verification](plans/2026-10-15-hermes-productization-upgrade.md) / 本地候选，未部署 |
| Controller/publisher secret references, init rejecting plaintext, Gitleaks CI / 控制器与发布者密钥引用、初始化拒绝明文、扫描CI | Not included / 未包含 | Local candidate at `c830331`; not in main/npm / 本地候选已有 |

| Agent schedules, run details and recovery, pending hub, read-only Feishu incidents / Agent定时任务、详情与恢复、待处理、告警案件 | Not included / 未包含 | Local candidate; [guide](zh-CN/agent-tasks.md) and [verification](plans/2026-10-15-agent-task-operations.md). 未推送、部署或真实账号验收。 |

`package.json` and `--version` still say `0.1.0` for later source builds. For source use, also record `git rev-parse HEAD`; managed deployments expose commit/release ID through authenticated readiness. 包版本、提交、部署记录是不同事实，合并不等于已部署。

## Support boundaries / 支持边界

- Supported host / 正式宿主机：macOS, Node.js ≥22.19. Linux service management is outside scope / 不提供Linux服务管理支持。
- npm provides foreground CLIs and Web assets; it does not ship `scripts/start.sh`, the host deployer or the full documentation tree. npm用户请通过仓库网页查看完整文档。
- Bridge + Runner on one Mac is the complete documented setup. Docker/remote reverse outbound delivery is not closed-loop by the current networking configuration / Docker或远程部署的反向出站链路尚不完整。
- Web has no independent login and exposes local API configuration; it is not a multi-user authorization boundary / Web不是多用户权限隔离边界。
- Tests or one host’s acceptance do not certify every channel/account. Follow the per-channel acceptance steps / 真实部署需逐渠道验收。

## Maintaining this record / 维护规则

Before a release, inspect the registry version and the exact tarball, update [CHANGELOG](../CHANGELOG.md), both READMEs and this matrix, then verify installation instructions. Before merging a candidate, reclassify its features only after inspecting the resulting source. 从“计划”改成“已交付”须有对应源码、入口与验收依据。

Read-only checks / 只读核实：

```bash
npm view @graychennpm/codebridge version dist-tags time --json
git ls-remote origin refs/heads/main
git rev-parse HEAD
```
