# CodeBridge 规范体系

- Status: `Normative`
- Updated: `2026-08-13`

本目录是 CodeBridge 的**规范性**事实源。`docs/orchestration/` 下的文档解释"为什么",本目录定义"必须怎样"。冲突时以本目录为准，并回改对应背景文档。

## 规则模型

每条规则是一个四元组，登记在 [RULES.md](RULES.md):

```yaml
id: FE-TOKEN-001          # 全局唯一,永不复用、不复写;废除则标记 deprecated 并保留
level: MUST               # RFC 2119: MUST / SHOULD / MAY
source: DESIGN.md §3.1    # 理由与背景出处
enforcement: test:design-tokens   # test:<文件关键子串> | script:<脚本> | review(人工)
```

## 域

| 前缀 | 域 | 背景文档 |
| --- | --- | --- |
| `FE-*` | 前端:token、组件、动效、可访问性 | orchestration/DESIGN.md |
| `ARCH-*` | 后端分层、数据流、存储边界 | orchestration/architecture.md |
| `PROTO-*` | ACP 会话、能力契约、Flow DSL、Provider 配置 | orchestration/engine.md、flow-design.md、agent-providers.md |
| `SEC-*` | 凭据、审批、目录授权、生产写 | orchestration/flow-design.md §1 |
| `OPS-*` | 发布、设计 QA、回归流程 | orchestration/design-qa-template.md |

## 执行闭环

1. `enforcement: test:*` 的规则必须被某个 vitest 断言引用（测试文件中出现规则 ID 字符串）。
2. `scripts/spec-rules.test.ts` 守护这一点：注册表与代码漂移时 CI 失败。
3. 新规则默认 `review` 级；补上自动化守护后升级为 `test:`/`script:`。
4. 规则变更必须先改 RULES.md 和背景文档，再改代码——和"先文档后实现"的既有约定一致。
