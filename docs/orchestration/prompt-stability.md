# Prompt 稳定性与缓存命中

- Status: `Normative reference`
- Updated: `2026-08-13`
- 规则本体:`docs/spec/RULES.md` 的 `PROTO-PROMPT-*`

所有向 LLM/Agent 发送内容的代码路径(系统提示、上下文注入、Flow 注入、工具结果拼装)都必须遵守本文档。目标:**缓存命中率最大化 + prompt 逐字节稳定**。

## 1. 厂商机制事实(官方资料)

| 厂商 | 机制 | 命中条件 | 成本模型 |
| --- | --- | --- | --- |
| Anthropic | 显式 `cache_control` 断点 | 断点之前内容逐字节一致;≥1024 token;TTL 5min/1h,命中续期 | 写 1.25×,读 0.10× |
| OpenAI | 全自动前缀缓存 | 前缀逐字节一致;≥1024 token,128 token 递增 | 读 0.5× |
| Gemini | KV/context 缓存 | 前缀稳定;部分未命中仍有收益 | 按缓存 token 计 |

共同硬约束:**前缀逐字节稳定**。空白、顺序、大小写、时间戳、动态统计的差异都会击穿缓存。

参考实现调研基线(实施前必读):

- 官方:Anthropic prompt-caching docs、OpenAI prompt-caching docs、Gemini context-caching docs
- ACP Registry 与各 agent 的 acp adapter 实现(Zed 生态)
- 高星参考:Orca(终端路线,反例)、opencode(prompt 拼装与缓存标记)

## 2. 本仓的注入纪律

### 2.1 前缀只放不可变内容

允许进前缀:系统提示模板(版本化)、工具/能力定义列表、已发布 Flow 目录摘要(仅发布/弃用时变化)、绑定指针(`flow_x @ git:rev` 一行)。

禁止进前缀:时间戳、运行统计、成功率、用户名、"2h 前"类相对时间、本次会话特有的临时状态。

### 2.2 可变内容的位置

- 会话历史之后的增量内容永远追加,不重排、不回改
- 厚重且不变的内容(Flow 定义全文、能力 manifest)走工具/能力调用懒加载,结果进历史后自然被缓存
- 每轮重复注入同一内容 = 禁止

### 2.3 拼装的确定性

- prompt 必须由版本化模板生成(模板 revision 入事件),禁止散落的字符串拼接
- 模板渲染确定性:同输入 → 逐字节同输出(排序键固定、无 `Date.now()`、无 locale 相关格式)

## 3. 验证义务

1. adapter 事件携带 usage(cache_read / cache_creation tokens)时必须记录到运行统计
2. 改动注入逻辑的 PR 必须给出前后命中率对比(同一任务连跑 3 次取 cache_read 占比)
3. 命中率显著下降(>10pp)视为回归,阻断合并

## 4. 实施前流程(强制)

改任何发给 LLM 的内容之前:

1. 查官方文档对应机制(§1 链接为入口)
2. 查至少一个高星参考实现的对应代码路径
3. 把依据写进 PR 描述或代码注释(链接 + 版本日期)
4. 不确定的行为先用探针脚本实测(如 `scripts/acp-probe.mjs` 模式),再实现
