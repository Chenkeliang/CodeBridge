# 飞书引用上下文修复验收

2026-09-10，分支 `feat_feishu_quote_context`，基于 `origin/main` 5273552。

## 修复与范围

明确引用和话题根消息保留机器人自身正文；每个引用独立处理错误。引用注明消息 ID 和历史材料边界。超过 2000 字符的正文通过现有文本附件传递全文，遵守已有 10 个附件、单个 10 MB、合计 25 MB 限制。多语言 post 提取一个可用语言的正文。

仅调整飞书入站，不改变会话路由、模型、权限或业务操作授权。引用图片、post 和卡片中的 image_key/img_key 使用原消息 ID 下载，经现有附件通道交给 Agent；去重并遵守数量/大小限制。下载失败保留文字并标明缺失。没有图片标识或可读正文的特殊卡片仍需真实样本验证。不部署 OCR，图片理解取决于 Agent/模型视觉能力。

## Surface Matrix

| Surface | entry / read path | write path / event consumption | error / recovery / terminal feedback | 状态 / planned |
|---|---|---|---|---|
| 飞书 | dispatchToAgent → 引用拉取与解析 | submitAndStream 携带正文和附件 | 单条失败可见，其他引用保留；重新发送可重试 | implemented；源码调用路径已验证，线上 reachable / closed-loop 待发布和飞书验收 |
| Agent | 接收最终 prompt 与文本附件 | 复用现有附件落盘通道 | 明确全文附件和缺失提示 | implemented；提交边界和落盘测试通过，真实 Agent 读取待验证 |
| Web | 无新入口或跳转 | 无修改 | 无修改 | 本次不涉及；无新增 planned |
| Telegram | 无新入口或跳转 | 无修改 | 无修改 | 本次不涉及；无新增 planned |

## 验证

- 新增回归：原实现 4 项失败；修复后通过。
- `pnpm exec vitest run packages/channel-feishu/src packages/runner-host/src/materialize-attachments.test.ts`：172 项通过。
- `pnpm --filter @codebridge/channel-feishu build`：通过。
- 活跃 dispatchToAgent 测试验证：机器人长引用的末尾 END_JSON 保留于提交附件，prompt 指向附件且保留当前请求。
- 外部飞书 API 使用测试返回，未向实际群发送测试消息；发布后需真实引用自己的回复与长 curl，核验 Agent 读取全文及答复。
- 图片补充后：飞书通道和附件落盘共 176 项通过；图片/post/卡片的活跃提交路径均验证原消息 ID、图片 MIME 和原始字节，重复图片去重，下载失败保留正文。真实视觉模型读取仍待发布后验证。
