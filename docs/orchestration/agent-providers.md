# Agent 与 Provider 管理设计

- Version: `0.1.0`
- Status: `Implementation baseline`
- Updated: `2026-08-13`

本文档定义 Agent 支持边界与 Pi Provider 的可视化配置。上游约束:`DESIGN.md`(UI 规范)、`flow-design.md`(能力契约)。

## 1. Agent 支持边界(决策记录)

**决策:Agent 支持列表定格为 `cursor` / `claude` / `codex` / `pi` / `opencode` 五家,不继续扩张。**

理由(第一性原理):

1. **模型多样性 ≠ Agent 多样性**。Pi 的 provider 体系(OpenAI 兼容端点 + 自定义 key)即可覆盖 DeepSeek、Kimi、GLM、Qwen、OpenRouter 等模型厂商,无需为每家接 CLI。
2. 保留的五家各有 **harness 级差异能力**:Claude 的 hooks/skills 生态、Codex 的 sandbox、Cursor 的索引、Pi 的 SDK 原生集成、OpenCode 的开源可自托管。
3. 终端包装(Orca 路线)被明确否决:无附件通道、状态靠刮标题、恢复靠硬编码各家 resume 命令——脆弱且不可治理。
4. ACP 官方 Registry(`agentclientprotocol/registry`,39 家)留作 backlog;出现 harness 级创新时再接入,接入成本 = manifest + spawn profile + 图标。

非目标:不做 PTY 终端包装;不做 Agent 市场;不追"支持数量"指标。

## 2. Provider 管理(Pi)

### 2.1 现状

Pi 的 provider 配置在本机 `~/.pi/agent/models.json`,只能手改;改错无提示;改完模型列表不刷新。`models-store.json` 由 Pi 自己维护,不在管理范围。

### 2.2 范围

- 只管理 **Pi adapter 的 provider**。ACP 三家(Claude/Codex/Cursor)各自有原生认证与配置,不做统一抽象。
- Provider 管理作为 Pi 的能力经 Registry 上报(`capabilities: ["providers"]`);无此能力的 Agent 不显示入口。
- 其他 adapter(opencode 等)后续有能力时按同一契约接入。

### 2.3 数据流与安全边界

```text
Web 设置页 → Bridge /v1/providers → Runner Host /pi/providers → ~/.pi/agent/models.json
```

- **凭据不出本机**:models.json 只由 Runner Host 读写;Bridge 纯代理,不落库。
- **明文展示**:自托管单用户场景,API key 明文显示/编辑(用户明确决策);但 Bridge 日志不得打印 key 字段。
- **写入保护**:read-modify-write;写入前留 `.bak`;JSON 解析失败时不写,返回错误。
- **字段校验(服务端)**:baseUrl 必须是 http(s) URL;provider id 允许小写字母、数字、连字符和下划线;model id 在同 provider 内唯一;显式提供 `thinkingLevelMap` 时至少要有一个非 null 档。

### 2.4 厂商预设

设置页内置预设目录,选择厂商自动填充 baseUrl、API 协议、模型模板(含 `reasoning` / `contextWindow` / `thinkingLevelMap`),用户只需粘贴 API key:

| 预设 | baseUrl | 协议 | 模型模板 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | openai-completions | deepseek-chat(无推理)、deepseek-reasoner(推理) |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | openai-completions | glm-4.6、glm-4.6-air |
| Kimi | `https://api.moonshot.cn/v1` | openai-completions | kimi-k2 系 |
| 通义 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | openai-completions | qwen3-max 等 |
| OpenRouter | `https://openrouter.ai/api/v1` | openai-completions | 自由填模型 id |
| 自定义 | — | 手填 | — |

预设数据版本化存放(`packages/backends/src/pi-provider-presets.ts`),随发行更新;预设只填模板,**不预填任何 key**。

### 2.5 测试连接

`POST /v1/providers/test`:Runner 用待保存的配置向 `baseUrl + /models` 发一次带 key 的 GET(5s 超时),返回 ok / 错误摘要(401=key 无效、ENOTFOUND=域名错、超时)。仅验证连通性,不消耗对话配额。

### 2.6 能力驱动的控件(per-model)

现状缺陷:`listPiConfigOptions` 无论选什么模型都固定报 7 档思考等级。改为**按当前模型动态生成**:

- 模型 `reasoning: false` → 不上报 `thought_level` 选项 → Web 不显示推理控件(DESIGN.md"未报告能力不显示空控件"原则的模型粒度落地)
- 模型有 `thinkingLevelMap` → 选项值只取 map 中非 null 的档,按 off→max 序排列
- 无 `thinkingLevelMap` 但 `reasoning: true` → 回退默认七档
- Session 切换模型(`PATCH /v1/sessions/:id` 或 run 参数)后,Bridge 重新计算该 Session 的 config options,经 SSE 推送,Composer 即时增减控件
- config options 只合并同一 Agent/workspace/model 的并发请求,请求完成后立即失效;保存 Provider 后主动清空在途快照,避免新模型被旧列表永久遮蔽
- Speed 控件沿用现有 `model_config` 语义,无上报即不显示

### 2.7 设置页

Rail 底部加设置入口,打开设置视图(主区整页,非弹层):

- **Providers**:列表(id、baseUrl、模型数、key 状态)+ 添加(先选预设)+ 编辑 + 删除 + 测试连接
- **显示**:现有密度/阅读模式设置迁入
- 删除 provider 需二次确认;被 Session 引用的模型所属 provider 删除时给出警告(该 Session 下次运行会报模型不可用)

### 2.8 默认路由与安装职责

- `defaultAgent` 只保存在 Bridge 的 configStore 中; Runner/Web 只消费 `default_agent_id` / `effective_default_agent_id`,不把 setup/default 元数据塞进 prompt、system prompt 或 ACP content blocks。
- 只有 `setup.canSelectDefault === true` 的 Agent 才能设为默认; `missing` / `needs_configuration` / `unavailable` 必须在服务端拒绝。
- 读取默认值时先返回持久化的 `defaultAgent`; 若它当前不可用,前端只回退到其它可选 Agent,**不覆盖**已保存的默认值。
- Runner Host 负责 host-local 探测与安全安装; Web 只提交 `strategy_id`,安装命令/参数由 Runner 端 allowlist 决定,且一律使用 `spawn(..., { shell: false })`。
- OpenCode 继续使用自己的配置边界(`~/.config/opencode/opencode.json`、项目 `opencode.json`、`/connect`); CodeBridge 只提供探测与安全的 `npm install -g opencode-ai` 方案。Cursor 的官方安装器是 shell pipeline,因此这里只展示文档入口,不由 CodeBridge 执行。

## 3. 非目标

- 不做 provider 用量统计/计费展示
- 不做多 Runner 的 provider 同步(单 Runner 假设)
- 不动 ACP 三家的认证配置
- OpenCode 使用独立配置边界:CodeBridge backend 只声明 `opencode acp` 的启动方式;模型、Provider、MCP 与认证仍由 OpenCode 的 `~/.config/opencode/opencode.json`、项目 `opencode.json` 或 `/connect` 管理,不写入 Pi 的 `models.json`
- 不做 key 的加密存储(本机文件即边界)
- models.json 的 `samplingParams`、cost 等高级字段保留原样,UI 不暴露
