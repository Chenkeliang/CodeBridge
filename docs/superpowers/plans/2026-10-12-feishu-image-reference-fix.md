# 飞书图片引用阻塞会话交付修复

> 后续授权更新：用户已明确要求将本修复与 `feat_acp_codex_network_config` 的 CodeBridge 改动一起上线，并授权恢复独立发布器，不再额外备份。下文保留首次独立修复的调查记录；最终发布以独立发布器记录为准。四张原卡片已在首次切换时恢复交付，首次发布随后因健康核验超时回滚；重启发布器后，其内置回滚核验通过并已解除维护。

## 事实与范围

运行版本为 `c166c40952184f9f1c699545559ca5cf2716c38c`，发布目录为
`/Users/demo/.codebridge/deployer/releases/20261012-110228-0d790c51/app`。
2026-10-12 19:07（北京时间）任务 `run_4ccfc5c1565a404ca31d694509d0c8b0`
已成功结束，但卡片 `7695734922859072454` 将本地 PNG 路径作为图片标识提交，
飞书返回 `200570: card contains invalid image keys`。事件消费停在 sequence 1301，
无法确认 1302 的 RUN_SUCCEEDED；同会话后续三条交付也保持 delivering。
后续任务实际为两次成功、一次取消。以上由只读 SQLite 查询、进程路径及实时日志确认。

修复仅修改飞书任务卡片 Markdown 的图片引用适配：有效 `img_` 图片标识保持图片，
其他地址显示为保留说明及完整地址的文字。不读取或上传引用文件。
使用仓库已锁定的 Markdown 解析器识别图片，避免修改代码示例、普通链接和嵌套路径。
超长内容附件仍保留原始 Markdown。Runtime、Agent、Web、Telegram 不修改。

## Surface Matrix

| Surface | entry / read / write | event consumption / error / recovery / terminal | 判定与证据 |
| --- | --- | --- | --- |
| 飞书 | FeishuRunCard → durableMarkdownCard → runCardJson → CardKitWriter；恢复由 resumedCardBody 进入同一渲染器 | 保持原事件确认机制；在提交前消除非图片标识引用；测试验证实时结束、历史恢复及后续任务交付 | 现有入口 reachable；修复 implemented，本地模拟 closed-loop；真实飞书 closed-loop 待授权部署后验证 |
| Agent | 只读已有 AGENT_EVENT，输出及执行逻辑不变 | 原始事件保留；真实故障的 94 条 Agent 事件已本地重放 | 运行数据确认 reachable；未新增功能，无 planned 项 |
| Web | 无改动、无新增跳转 | 不使用飞书卡片渲染器 | 本次未验证，不能据此声称 closed-loop；无 planned 项 |
| Telegram | 无改动、无新增跳转 | 不使用飞书卡片渲染器 | 本次未验证，不能据此声称 closed-loop；无 planned 项 |

## 验证

- 新增图片引用回归测试，修改前 2 项失败、原 8 项通过；修改后通过。
- `pnpm exec vitest run packages/channel-feishu`：25 文件、193 项通过，接口使用模拟对象，无真实消息发送。
- `pnpm --filter @codebridge/channel-feishu build`：通过。
- 只读提取故障任务的 94 条 AGENT_EVENT，经实际 projector 与编译后的 runCardJson 重放：
  原始结果含故障图片；输出不再含该图片语法，地址仍在，终态关闭，卡片 632 字节。
- `git diff --check`：通过。
- GitNexus 索引与修改前 `1762c53` 一致；runCardJson upstream 查询列出 3 个直接调用，
  风险 HIGH，覆盖实时流、setSnapshot 和恢复卡片路径。

## 交接与上线边界

修复在 `/Users/demo/projects/CodeBridge-deploy` 新建的 `codex/feishu-image-reference` 分支开始，
基于已 fetch 的 `origin/main`（`1762c53`），创建后领先提交数为 0。
收尾检查发现其他操作已将同一 checkout 切换到 `feat_acp_codex_network_config`（相同 HEAD）。
本次未再切分支，修复仍为工作区未提交改动，并单独导出补丁备份，避免与并发任务混合提交。
改动尚未提交、推送或部署；运行中的 Bridge/Runner 和飞书卡片均未修改。

上线前必须将本修复与当前运行版本间的其他 main 改动分开核对，不得顺带发布。
后续仅在用户授权后部署本修复并恢复原会话卡片，再核验 delivering 是否清空及终态显示。
