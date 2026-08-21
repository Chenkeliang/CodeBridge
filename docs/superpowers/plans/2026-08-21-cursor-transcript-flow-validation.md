# Cursor Transcript → 通用 Flow 全链验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建设一个不依赖固定 Session/业务值的 Cursor transcript 冷启动入口，并在完全隔离、无任何线上写能力的环境中验证 Web 的 Guide → Candidate → Dry-run → Review → Published → Apply/Run → 结果回流全链。

**Architecture:** Cursor JSONL 只在 Runner/Provider adapter 中解析，进入 Bridge 前转换为已脱敏的 Provider 无关 evidence。Bridge 复用现有 Session history/EventStore，把外部历史明确标记为 `provider_transcript`，LLM 只能提出 Guide；Catalog 写入、Candidate 编译、Review、Binding 和 Runtime 仍走既有唯一入口。完整执行使用独立 SQLite、匿名 fixture 和 simulation Capability，任何外部业务写请求都直接使测试失败。

**Tech Stack:** TypeScript、Hono、React、SQLite、Zod、Vitest、Playwright、ACP RunnerClient、CodeBridge Flow Catalog/Runtime/Policy。

---

## 0. Goal 流程与硬门禁

```text
G0 影响分析与安全基线
  ↓
G1 Cursor transcript 解析、规范化、脱敏
  ↓
G2 Runner Preview/Confirm 合同 + RunnerClient
  ↓
G3 Bridge 导入、证据落库、provenance
  ↓
G4 LLM 通用化 Guide proposal（禁止工具/禁止写 Catalog）
  ↓
G5 Web Preview/Confirm/生成/保存 Guide
  ↓
G6 Simulation Capability + 隔离运行环境
  ↓
G7 真实后端 Web E2E 全生命周期
  ↓
G8 真实样本烟测、对抗测试、全量回归、Surface Matrix
```

每个 Goal 必须满足：

1. 修改符号前执行 `npx gitnexus impact --repo CodeBridge <symbol>`；HIGH/CRITICAL 必须先向用户报告；
2. 先提交失败测试并确认失败原因正确，再写最小实现；
3. 每个提交前执行 `npx gitnexus detect-changes --scope staged --repo CodeBridge`；
4. 不暂存或修改用户现有的 `AGENTS.md`、`.claude/`、`.playwright-cli/`、`.superpowers/`、`CLAUDE.md`、Vite timestamp、`output/`、`test-results/` 和旧未跟踪文档；
5. 自动化 fixture 中不得出现参考 UUID、`/Users/keliang`、真实订单号/PID、连接串、Token；
6. simulation 环境不得有线上业务 Adapter；检测到非 loopback HTTP、数据库写连接、Shell upsert 或缓存/SPU/depot 写请求时立即失败；
7. Guide 不可绑定、不可 Dry-run、不可执行；只有 Published Runbook 进入 Runtime；
8. 本计划是 P2 冷启动与验证，不改变 V1 三通道目标，也不把 Guide 变成必经阶段。

## 1. 文件结构

### 新建

- `packages/backends/src/cursor-transcript.ts`：只负责定位、读取、解析、限额和脱敏 Cursor JSONL；输出规范化 evidence。
- `packages/backends/src/cursor-transcript.test.ts`：路径、大小、格式、脱敏、确定性 digest 测试。
- `e2e/fixtures/cursor-product-change-transcript.jsonl`：匿名 Cursor 格式样本，只有合成业务值。
- `e2e/fixtures/cursor-product-change-guide.json`：稳定 LLM fixture 响应，不依赖在线模型。
- `apps/bridge/src/cursor-transcript-import.ts`：Preview/Confirm 应用服务；协调 Runner、SessionCatalog、EventStore。
- `apps/bridge/src/cursor-transcript-import.test.ts`：digest、幂等、变更冲突、导入标识测试。
- `apps/bridge/src/flow-guide-generalizer.ts`：LLM generalizer 接口、Runner 实现、Schema 校验和工具调用阻断。
- `apps/bridge/src/flow-guide-generalizer.test.ts`：脱敏输入、合法响应、非法响应、tool_start 取消测试。
- `apps/web/src/components/cursor-transcript-import-dialog.tsx`：UUID、Preview、Confirm 对话框。
- `apps/web/src/components/cursor-transcript-import-dialog.test.tsx`：Web 表面测试。
- `packages/policy/src/simulation-flow-capabilities.ts`：只供测试显式注册的进程内 Capability；生产 CLI 不导入、不注册。
- `packages/policy/src/simulation-flow-capabilities.test.ts`：内存状态、dry-run、审批语义、无网络测试。
- `e2e/support/flow-validation-environment.ts`：启动/关闭临时 Runner、Bridge、Runtime、Catalog 和 simulation registry。
- `e2e/support/flow-validation-global-setup.ts`：Playwright 生命周期与清理。
- `e2e/flow-transcript-validation.spec.ts`：真实后端 Web 全链。
- `playwright.flow-validation.config.ts`：独立端口与真实 API 测试配置。

### 修改

- `packages/backends/src/index.ts`：导出 transcript adapter 类型与函数。
- `packages/core/src/config-schema.ts`：增加 RunnerHost 授权 transcript roots。
- `packages/runner-host/src/server.ts`：RunnerHost Preview/Confirm 与 HTTP 路由。
- `packages/runner-host/src/server.test.ts`：Runner 表面和错误映射。
- `packages/runner-client/src/index.ts`、`index.test.ts`：新增 typed client。
- `packages/work-items/src/index.ts`、`session-runtime.ts` 及测试：保留 `imported/provider_transcript` 证据语义和 digest。
- `packages/flow-catalog/src/index.ts`、`index.test.ts`：provenance 支持 Runtime Run 与 Provider Transcript 两类来源。
- `packages/core/src/types.ts`：Channel review provenance 同步为判别联合，不从 Web 类型反推通道。
- `packages/router/src/channel-flow-controller.ts`、`channel-flow-controller.test.ts`：已有通道管理摘要兼容 transcript provenance。
- `apps/bridge/src/session-api.ts`、`session-api.test.ts`：Preview/Confirm 路由装配。
- `apps/bridge/src/flow-api.ts`、`flow-api.test.ts`：生成/读取 provider transcript proposal，保存 Guide。
- `apps/bridge/src/cli.ts`：注入通用 importer/generalizer；不得注册 simulation Capability。
- `apps/web/src/lib/types.ts`、`api.ts` 及测试：新合同与 provenance 联合类型。
- `apps/web/src/components/session-chrome.tsx`、测试：Cursor 管理区导入按钮。
- `apps/web/src/components/workbench.tsx`、相关测试：导入、生成 proposal、打开 Guide。
- `apps/web/src/components/flow-control-panel.tsx`、测试：Guide 显示/编辑 proposed inputs 与来源类型。
- `apps/web/vite.config.ts`：允许 E2E 通过环境变量指定 Bridge proxy，默认仍为 `19790`。
- `package.json`：增加独立验证命令。

## 2. G0：影响分析与安全基线

**Files:**
- Read: `docs/superpowers/specs/2026-08-20-flow-three-channel-v1-final-alignment.md`
- Read: `docs/superpowers/specs/2026-08-21-flow-agent-session-cold-start-design.md`
- Read: `docs/superpowers/specs/2026-08-21-cursor-transcript-flow-validation-design.md`

- [ ] **Step 1: 刷新 GitNexus 索引**

Run:

```bash
npx gitnexus status
npx gitnexus analyze
```

Expected: `Status: up-to-date`。若 `analyze` 原生模块连续两次失败，记录完整错误；不得因此跳过每个符号的 impact 与 staged detect-changes。

- [ ] **Step 2: 对首批关键符号做 upstream impact**

Run:

```bash
npx gitnexus impact --repo CodeBridge createSessionApp
npx gitnexus impact --repo CodeBridge ProviderHistoryImporter
npx gitnexus impact --repo CodeBridge createFlowApp
npx gitnexus impact --repo CodeBridge RunnerHost
npx gitnexus impact --repo CodeBridge Workbench
npx gitnexus impact --repo CodeBridge FlowControlPanel
```

Expected: 形成 blast-radius 记录。HIGH/CRITICAL 时停止编辑并向用户报告具体 caller/process。

- [ ] **Step 3: 保存当前回归基线**

Run:

```bash
pnpm test
pnpm lint
pnpm exec playwright test e2e/flow-loop.spec.ts
```

Expected: 当前分支既有测试全部通过；若存在基线失败，先记录且不得归因于本计划。

## 3. G1：Cursor transcript 解析与脱敏

**Files:**
- Create: `packages/backends/src/cursor-transcript.ts`
- Create: `packages/backends/src/cursor-transcript.test.ts`
- Create: `e2e/fixtures/cursor-product-change-transcript.jsonl`
- Modify: `packages/backends/src/index.ts`

- [ ] **Step 1: 创建匿名 Cursor JSONL fixture**

fixture 只保留真实对话的结构特征：多轮用户问题、assistant 文本、Read/Grep/Shell 类工具、一次“生成变更计划”、一次“验证结果”。实例值统一替换为：

```json
{
  "provider_session_id": "11111111-2222-4333-8444-555555555555",
  "product_ids": ["P1001", "P1002"],
  "product_type": 900,
  "target_price": 12,
  "environment": "simulation"
}
```

fixture 内禁止出现原 UUID、真实 PID、线上地址、账号或绝对路径。

- [ ] **Step 2: 写 parser/redactor 失败测试**

核心断言：

```ts
const evidence = await source.load(TEST_UUID);
expect(evidence.source).toBe("cursor_transcript");
expect(evidence.messages.some((item) => item.text.includes("P1001"))).toBe(true);
expect(JSON.stringify(evidence)).not.toMatch(/password|token|mysql:\/\//i);
expect(evidence.toolObservations).toEqual(expect.arrayContaining([
  expect.objectContaining({ category: "read", status: "completed" }),
  expect.objectContaining({ category: "shell", status: "completed" }),
]));
expect(evidence.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
```

还要覆盖：非法 UUID、找不到、路径穿越、损坏 JSONL、超过 byte/event/text 上限、同一文件 digest 稳定、文件改变 digest 改变。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm vitest run packages/backends/src/cursor-transcript.test.ts
```

Expected: FAIL，原因是 `CursorTranscriptSource` 尚不存在。

- [ ] **Step 4: 实现最小 Provider adapter**

公开合同固定为：

```ts
export interface CursorTranscriptEvidence {
  source: "cursor_transcript";
  providerSessionId: string;
  sourceDigest: string;
  startedAt: string | null;
  completedAt: string | null;
  messages: Array<{ position: number; role: "user" | "assistant"; text: string }>;
  toolObservations: Array<{
    position: number;
    category: string;
    name: string;
    status: "completed" | "failed" | "unknown";
  }>;
}

export class CursorTranscriptError extends Error {
  constructor(public readonly code: CursorTranscriptErrorCode) {
    super(code);
  }
}

export class CursorTranscriptSource {
  constructor(private readonly options: {
    roots: string[];
    maxBytes?: number;
    maxEvents?: number;
    maxTextBytes?: number;
  }) {}

  preview(providerSessionId: string): Promise<CursorTranscriptPreview>;
  load(providerSessionId: string, expectedDigest: string): Promise<CursorTranscriptEvidence>;
}
```

Bridge 合并 `messages` 和 `toolObservations` 时必须按 `position` 恢复原始先后顺序；不得把全部消息和全部工具分别成批写入导致时间线失真。

路径只能按 `<root>/*/agent-transcripts/<uuid>/<uuid>.jsonl` 查找；对所有候选使用 `realpath` 后再次校验位于 `realpath(root)` 内。客户端不提交路径。

脱敏顺序固定：连接串/Authorization/Token → 绝对路径 → 长数字与疑似业务 ID → 单条长度截断。工具只保留分类、规范化名称和终态，不保留 input/output/command。

- [ ] **Step 5: 运行并提交**

Run:

```bash
pnpm vitest run packages/backends/src/cursor-transcript.test.ts
pnpm --filter @codebridge/backends build
npx gitnexus detect-changes --scope staged --repo CodeBridge
```

Expected: PASS；GitNexus 只显示 Provider adapter 相关影响。

Commit:

```bash
git commit -m "feat(cursor): parse and redact local transcripts"
```

## 4. G2：Runner Preview/Confirm 与 RunnerClient

**Files:**
- Modify: `packages/core/src/config-schema.ts`
- Modify: `packages/runner-host/src/server.ts`
- Modify: `packages/runner-host/src/server.test.ts`
- Modify: `packages/runner-client/src/index.ts`
- Modify: `packages/runner-client/src/index.test.ts`

- [ ] **Step 1: 写配置和 Runner HTTP 失败测试**

新增配置字段：

```ts
runnerHost: {
  cursorTranscriptRoots?: string[];
}
```

Runner 表面合同：

```http
POST /cursor-transcripts/preview
{"provider_session_id":"<uuid>"}

POST /cursor-transcripts/load
{"provider_session_id":"<uuid>","expected_digest":"sha256:..."}
```

测试状态映射：`400 invalid_provider_session_id`、`404 provider_transcript_not_found`、`403 provider_transcript_not_authorized`、`413 provider_transcript_too_large`、`422 provider_transcript_invalid`、`409 provider_transcript_changed`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run packages/runner-host/src/server.test.ts packages/runner-client/src/index.test.ts
```

Expected: FAIL，路由与 client method 不存在。

- [ ] **Step 3: 实现 RunnerHost 注入与方法**

RunnerHost 构造时创建 `CursorTranscriptSource`。未配置 roots 时使用只读默认根 `path.join(os.homedir(), ".cursor", "projects")`；显式空数组表示关闭本地 transcript 导入。

RunnerClient 增加：

```ts
previewCursorTranscript(providerSessionId: string): Promise<CursorTranscriptPreview>;
loadCursorTranscript(
  providerSessionId: string,
  expectedDigest: string,
): Promise<CursorTranscriptEvidence>;
```

Client 必须保留 Runner 返回的 `code`，不能统一压成 `Runner error: 409`。

- [ ] **Step 4: 运行并提交**

Run:

```bash
pnpm vitest run packages/runner-host/src/server.test.ts packages/runner-client/src/index.test.ts
pnpm --filter @codebridge/runner-host build
pnpm --filter @codebridge/runner-client build
npx gitnexus detect-changes --scope staged --repo CodeBridge
```

Commit:

```bash
git commit -m "feat(cursor): expose transcript preview and load"
```

## 5. G3：Bridge 导入、证据语义与 provenance

**Files:**
- Create: `apps/bridge/src/cursor-transcript-import.ts`
- Create: `apps/bridge/src/cursor-transcript-import.test.ts`
- Modify: `apps/bridge/src/session-api.ts`
- Modify: `apps/bridge/src/session-api.test.ts`
- Modify: `packages/work-items/src/session-runtime.ts`
- Modify: `packages/work-items/src/index.ts`
- Modify: `packages/work-items/src/session-runtime.test.ts`
- Modify: `packages/flow-catalog/src/index.ts`
- Modify: `packages/flow-catalog/src/index.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/router/src/channel-flow-controller.ts`
- Modify: `packages/router/src/channel-flow-controller.test.ts`

- [ ] **Step 1: 先跑 impact**

```bash
npx gitnexus impact --repo CodeBridge importProviderHistory
npx gitnexus impact --repo CodeBridge FlowProvenance
npx gitnexus impact --repo CodeBridge createSessionApp
```

HIGH/CRITICAL 必须先报告。尤其不得破坏既有 ACP/Claude/Codex provider history 导入。

- [ ] **Step 2: 写 Preview/Confirm 和幂等失败测试**

Bridge 合同：

```http
POST /v1/provider-sessions/cursor-transcript/preview
{"provider_session_id":"<uuid>"}

POST /v1/provider-sessions/cursor-transcript/import
Idempotency-Key: cursor-import:<uuid>:<digest>
{"provider_session_id":"<uuid>","source_digest":"sha256:..."}
```

Confirm 成功返回：

```json
{
  "session": {"session_id":"sess_dynamic","agent_id":"cursor"},
  "imported_events": 12,
  "evidence_source": "provider_transcript",
  "source_digest": "sha256:..."
}
```

测试必须证明：相同 key 返回同一 Session；Preview 后文件改变返回 409；失败不创建 Session/WorkItem；导入后的 `RUN_SUCCEEDED` payload 有 `imported: true, evidence_source: "provider_transcript"`；Session ID 动态生成。

- [ ] **Step 3: 扩展 provenance 为判别联合**

领域类型改为：

```ts
export type FlowProvenance =
  | {
      sourceKind: "runtime_run";
      sourceRunId: string;
      sourceSessionId: string;
      sourceFlowId: string;
      sourceDefinitionRevision: string;
    }
  | {
      sourceKind: "provider_transcript";
      sourceRunId: null;
      sourceSessionId: string;
      sourceFlowId: null;
      sourceDefinitionRevision: string;
      sourceDigest: string;
    };
```

SQLite JSON 迁移按缺失 `sourceKind` 的旧记录推断为 `runtime_run`，不改写历史行。API 使用 snake_case 对应字段。

`ChannelFlowReviewSummary.provenance` 同步增加 `sourceKind`、nullable `sourceRunId/sourceFlowId` 和可选 `sourceDigest`。飞书/Telegram 只展示摘要，不新增 transcript 导入入口。

- [ ] **Step 4: 实现 CursorTranscriptImportService**

职责固定：

```ts
class CursorTranscriptImportService {
  preview(providerSessionId: string): Promise<CursorTranscriptPreview>;
  import(input: {
    providerSessionId: string;
    sourceDigest: string;
    idempotencyKey: string;
  }): Promise<CursorTranscriptImportResult>;
}
```

`import()` 调 Runner load 后，把 evidence 映射为现有 `ProviderSessionHistoryEvent[]`；assistant message 映射为 `text_delta/final_answer`，工具映射为无参数 `tool_start/tool_end`。调用 EventStore import 时显式传 `evidenceSource: "provider_transcript"`，不得伪装成普通 Runtime Run。

- [ ] **Step 5: 运行并提交**

Run:

```bash
pnpm vitest run apps/bridge/src/cursor-transcript-import.test.ts apps/bridge/src/session-api.test.ts packages/work-items/src/session-runtime.test.ts packages/flow-catalog/src/index.test.ts
pnpm lint
npx gitnexus detect-changes --scope staged --repo CodeBridge
```

Commit:

```bash
git commit -m "feat(flow): import cursor transcript evidence"
```

## 6. G4：LLM 通用化与 Guide proposal

**Files:**
- Create: `apps/bridge/src/flow-guide-generalizer.ts`
- Create: `apps/bridge/src/flow-guide-generalizer.test.ts`
- Create: `e2e/fixtures/cursor-product-change-guide.json`
- Modify: `apps/bridge/src/flow-api.ts`
- Modify: `apps/bridge/src/flow-api.test.ts`
- Modify: `apps/bridge/src/cli.ts`

- [ ] **Step 1: 写 generalizer 合同失败测试**

```ts
export interface FlowGuideGeneralizer {
  generalize(input: {
    agentId: string;
    cwd: string;
    evidence: CursorTranscriptEvidence;
    signal?: AbortSignal;
  }): Promise<GeneralizedGuideProposal>;
}
```

测试注入固定 Agent event：只允许 `text_delta` 和 `done`。出现任何 `tool_start`、`permission_request` 或 fatal error 必须取消 Runner run，并返回 `flow_generalizer_tool_use_forbidden`。

LLM 输出必须满足：

- `inputs` 类型只允许 Catalog 支持的 `string|integer|enum|directory|secret_ref`；
- `product_ids` 本轮使用换行/逗号分隔的 `string`；不夹带新增数组 input type，simulation Capability 在入口统一解析为去重字符串数组；
- step id 唯一且依赖存在；
- 原 fixture 的 `P1001/P1002/900/12` 只能出现在 `example`，不得出现在 step purpose、Flow name 或默认值；
- `proposedCapability` 只做建议；未注册时不进入可执行字段；
- 生成结果不包含 providerSessionId/source path。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run apps/bridge/src/flow-guide-generalizer.test.ts apps/bridge/src/flow-api.test.ts
```

- [ ] **Step 3: 实现只读 Runner generalizer**

Runner 请求使用 `mode: "ask"`，prompt 明确只返回 JSON、禁止工具。收集 final text；发现工具事件立即 abort。在线模型只用于产品交互，测试通过依赖注入 fixture generalizer。

新增路由：

```http
POST /v1/sessions/:session_id/flow-proposals/generate
{"source_digest":"sha256:..."}
```

Bridge 验证 Session 的 imported digest 后调用 generalizer，把通过 Schema 的结果作为 `FLOW_PROPOSED` 事件追加到当前 WorkItem：`run_id=null`，payload 含 `evidence_source=provider_transcript`、`source_digest`、`definition_revision`。重试同一 digest 返回同一 proposal。

`GET /flow-proposals` 同时返回 Runtime Run proposal 和 provider transcript proposal，新增：

```json
{
  "run_id": null,
  "evidence_source": "provider_transcript",
  "source_digest": "sha256:..."
}
```

`POST /v1/flows/guides` 接受 `{session_id, source_definition_revision}` 保存 transcript proposal；服务端从事件重读，客户端不能提交定义正文。保存为 `guide × draft`、`source=agent_generated`、provider transcript provenance。

Guide 升级 Candidate 时，服务端立即计算并保存 `validationIssues`。未知 Capability、缺少 `success_when`、Adapter 未注册等问题在 Candidate 管理页可见；缺 Capability 配置允许保存 Candidate 但不能成功 Dry-run/Review，完整 simulation Registry 配置的 Candidate 必须是空 issues。

- [ ] **Step 4: 运行并提交**

```bash
pnpm vitest run apps/bridge/src/flow-guide-generalizer.test.ts apps/bridge/src/flow-api.test.ts
pnpm --filter @codebridge/bridge build
npx gitnexus detect-changes --scope staged --repo CodeBridge
git commit -m "feat(flow): generalize imported session evidence"
```

## 7. G5：Web 导入与 Guide 通用化确认

**Files:**
- Create: `apps/web/src/components/cursor-transcript-import-dialog.tsx`
- Create: `apps/web/src/components/cursor-transcript-import-dialog.test.tsx`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/components/session-chrome.tsx`
- Modify: `apps/web/src/components/session-chrome.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/flow-control-panel.tsx`
- Modify: `apps/web/src/components/flow-control-panel.test.tsx`
- Create: `apps/web/src/components/workbench-flow-import.test.tsx`

- [ ] **Step 1: 写活跃表面失败测试**

测试从生产入口渲染 `Workbench`，不能只测未挂载组件：

1. 只有选中 Cursor 时显示“导入本地 Cursor Session”；
2. UUID 非法时按钮 disabled；
3. Preview 展示消息数、工具类别、时间范围和“导入前已脱敏”；
4. 取消不调用 import；
5. Confirm 后刷新 Session 列表并打开动态 Session；
6. “生成 Guide 提案”展示 inputs、assumptions、unresolved 和未注册 Capability；
7. “整理为 Guide”后打开 Flow 管理详情；
8. Guide/Candidate/Published 的既有可见性不变。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @codebridge/web test -- cursor-transcript-import-dialog session-chrome workbench flow-control-panel api
```

- [ ] **Step 3: 实现 API 类型与对话框**

API 方法固定：

```ts
previewCursorTranscript(providerSessionId: string): Promise<CursorTranscriptPreview>;
importCursorTranscript(providerSessionId: string, sourceDigest: string): Promise<CursorTranscriptImportResult>;
generateTranscriptFlowProposal(sessionId: string, sourceDigest: string): Promise<FlowProposal>;
saveTranscriptGuide(sessionId: string, sourceDefinitionRevision: string): Promise<FlowRecord>;
```

Guide editor 增加 proposed inputs 编辑；保存 Guide 时保留 inputs，但仍不能设置 Capability、Dry-run 或绑定。升级 Candidate 后才显示 Capability/success_when/risk/approval 编辑器。

- [ ] **Step 4: 运行并提交**

```bash
pnpm --filter @codebridge/web test
pnpm --filter @codebridge/web build
pnpm lint
npx gitnexus detect-changes --scope staged --repo CodeBridge
git commit -m "feat(web): import transcripts and create guide drafts"
```

## 8. G6：Simulation Capability 与隔离测试栈

**Files:**
- Create: `packages/policy/src/simulation-flow-capabilities.ts`
- Create: `packages/policy/src/simulation-flow-capabilities.test.ts`
- Modify: `packages/policy/src/index.ts`
- Create: `e2e/support/flow-validation-environment.ts`
- Create: `e2e/support/flow-validation-global-setup.ts`
- Create: `playwright.flow-validation.config.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `package.json`

- [ ] **Step 1: 写 simulation Capability 失败测试**

注册以下通用 Capability：

```text
catalog.read_product_state       read_only
catalog.read_delivery_state      read_only
catalog.plan_product_change      read_only
catalog.apply_product_change     production_write + approval required
catalog.verify_product_change    read_only
```

`apply_product_change` 只修改传入的 `SimulationProductStore`。dry-run 返回 `dry_run_report` 且不改状态；相同 idempotency key 重试不重复；verify 产出 verification + artifact。

测试用 `globalThis.fetch` spy、child_process spy 和禁止非临时 SQLite 路径的 guard，证明 adapter 没有网络、Shell 或外部数据库写。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm vitest run packages/policy/src/simulation-flow-capabilities.test.ts
```

- [ ] **Step 3: 实现显式注册函数**

```ts
export function registerSimulationFlowCapabilities(
  registry: CapabilityRegistry,
  runtime: CapabilityRuntime,
  store: SimulationProductStore,
): void;
```

`apps/bridge/src/cli.ts` 不得 import 或调用该函数。只有 `e2e/support/flow-validation-environment.ts` 显式注册。

- [ ] **Step 4: 建立真实后端 E2E 环境**

`startFlowValidationEnvironment()`：

1. `mkdtemp` 创建 data/catalog/transcript roots；
2. 复制匿名 transcript fixture 到 Cursor 目录结构；
3. 启动真实 `RunnerHost/createRunnerApp`；
4. 创建 SessionCatalog、WorkItems、FlowCatalog、ApprovalService、CapabilityRegistry、CapabilityRuntime、PolicyEngine、RunExecutor；
5. 注册 simulation Capability；
6. 注入固定 `FlowGuideGeneralizer`；
7. 组合真实 `createSessionApp/createFlowApp/createBridgeApp`；
8. 监听 loopback 测试端口；
9. teardown 关闭 server、SQLite、registry，并删除临时目录。

Vite proxy 改为：

```ts
const bridgeTarget = process.env.CODEBRIDGE_API_PROXY ?? "http://127.0.0.1:19790";
```

独立 Playwright 配置使用不同 Web/Bridge/Runner 端口，`reuseExistingServer: false`，避免误连日常服务。

- [ ] **Step 5: 运行并提交**

```bash
pnpm vitest run packages/policy/src/simulation-flow-capabilities.test.ts
pnpm lint
npx gitnexus detect-changes --scope staged --repo CodeBridge
git commit -m "test(flow): add isolated simulation runtime"
```

## 9. G7：真实后端 Web E2E 全生命周期

**Files:**
- Create: `e2e/flow-transcript-validation.spec.ts`
- Modify: `e2e/support/flow-validation-environment.ts`
- Modify: `package.json`

- [ ] **Step 1: 写导入/提取 E2E**

浏览器只操作生产 Web 入口，不使用 `page.route()` Mock Flow API：

```ts
await page.getByRole("button", { name: "Cursor" }).click();
await page.getByRole("button", { name: "导入本地 Cursor Session" }).click();
await page.getByLabel("Cursor Session UUID").fill(TEST_UUID);
await page.getByRole("button", { name: "预览" }).click();
await expect(page.getByText("导入前已脱敏")).toBeVisible();
await page.getByRole("button", { name: "确认导入" }).click();
await page.getByRole("button", { name: "生成 Guide 提案" }).click();
```

断言生成 Flow 中没有 fixture 实例值作为默认值，也没有 Session UUID/路径；inputs 至少包含 `product_ids/product_type/target_price/environment`。

- [ ] **Step 2: 写 Guide → Candidate 两配置测试**

- 缺 Capability 的隔离配置：升级 Candidate 显示 validation issues；
- 完整 simulation 配置：选择五个 Capability，填写 success_when，成功保存 Candidate；
- Guide 本身没有预演/运行/绑定按钮。

- [ ] **Step 3: 写 Dry-run/Review/Publish 测试**

1. Candidate Dry-run 成功且 Session binding 仍为空；
2. Review Rail 显示 provider transcript provenance、语义 Diff、Dry-run evidence；
3. 先打回，再修改并重新提交；
4. 批准必须带审计 `git_revision=flow-validation-e2e`；
5. 发布后只在消费列表出现 Published Runbook。

- [ ] **Step 4: 写 Apply/Approval/Run/终态测试**

1. one-shot invocation 不写 binding；
2. apply 后 Session 固定 `flowId + definitionRevision`；
3. production_write simulation step 显示 Runtime Approval；
4. Web 批准后执行；
5. Timeline 显示 5 个 Step、Artifact、verification、Run succeeded；
6. 内存状态已改变，fixture 文件未改变；
7. 页面刷新与 SSE 重连后终态仍在。

- [ ] **Step 5: 写版本/解绑/废弃测试**

1. 发布新 revision；
2. 旧 binding 返回 `409 flow_revision_mismatch`；
3. Web 展示查看变更/重新绑定；
4. unbind 后后端 binding 为空；
5. Deprecated 不可绑定/执行，只能查看历史证据。

- [ ] **Step 6: 写“零线上写”终极断言**

测试环境记录所有 adapter invocation 和出站请求。最终断言：

```ts
expect(environment.externalWrites).toEqual([]);
expect(environment.productionAdaptersRegistered).toBe(false);
expect(environment.transcriptFixtureHashAfter).toBe(environment.transcriptFixtureHashBefore);
```

- [ ] **Step 7: 运行并提交**

```bash
pnpm run test:flow-validation
npx gitnexus detect-changes --scope staged --repo CodeBridge
git commit -m "test(flow): verify transcript to runtime web loop"
```

Expected: 全部 Playwright 用例通过，且网络日志只出现 loopback Web/Bridge/Runner。

## 10. G8：真实样本烟测、对抗测试与最终回归

**Files:**
- Modify only if a verified defect is found; every defect starts a new failing test.
- Update: `docs/superpowers/specs/2026-08-21-cursor-transcript-flow-validation-design.md` only for factual completion notes, not product changes.

- [ ] **Step 1: 在隔离环境用真实 Cursor transcript 做只读 smoke**

使用临时 data dir 和本机授权 transcript root，通过 Web 输入参考 UUID；只执行 Preview、Confirm、生成 Guide、查看通用化结果。不得把真实 evidence 写入日常 Catalog，不进入 Candidate simulation Run。

验收：

- 能定位 transcript；
- Preview 数量与解析器统计一致；
- Guide 没有原 Session UUID/路径/连接信息；
- 订单号、PID、价格被抽为 inputs/examples，不固化为执行常量；
- 未注册生产 Capability 时诚实停在 Guide。

- [ ] **Step 2: 对抗测试**

至少覆盖：

1. UUID 路径穿越和 symlink 逃逸；
2. JSONL 超大行、事件洪水、坏 JSON；
3. transcript 在 Preview/Confirm 间变化；
4. prompt injection 要求 LLM 调工具/写 Catalog；
5. LLM 返回未知 Capability、重复 step、环形依赖、实例值默认值；
6. 重复 Confirm/Generate/Save；
7. 浏览器刷新、SSE 断开重连；
8. simulation adapter 试图访问非 loopback 网络；
9. production CLI 启动后确认 simulation Capability 不在 `/v1/capabilities`；
10. 飞书/Telegram consume 列表仍只有 Published Runbook。

- [ ] **Step 3: 全量验证**

Run:

```bash
pnpm test
pnpm lint
pnpm build
pnpm exec playwright test e2e/flow-loop.spec.ts
pnpm run test:flow-validation
```

Expected: 所有命令退出码 0；若有既有 warning，报告但不得宣称为本轮引入。

- [ ] **Step 4: Surface Matrix 完成门禁**

重新核对：

| Surface | 必须达到 |
|---|---|
| Web | implemented + reachable + closed-loop + planned |
| Bridge | implemented + reachable + closed-loop + planned |
| Runner/Provider | implemented + reachable + closed-loop + planned |
| Runtime simulation | implemented + reachable + closed-loop + planned |
| Agent | 只产出 proposal，无 Catalog/Runtime 写权 |
| 飞书 | 既有 consume/回流不回归；本轮不新增 transcript 管理 |
| Telegram | 合同不回归，deployment disabled 状态不变 |

- [ ] **Step 5: 最终 detect、提交与报告**

```bash
git status --short
npx gitnexus detect-changes --scope staged --repo CodeBridge
git diff --cached --check
```

最终报告必须区分：

- transcript 导入已实现；
- Web simulation 全链已验证；
- 真实生产业务 Adapter 未建设；
- 未执行任何线上 upsert/缓存/SPU/depot 写操作；
- Telegram 仍 deployment disabled，后续收尾项继续保留。

Commit（仅在确有最终修正时）：

```bash
git commit -m "fix(flow): harden transcript validation loop"
```

## 11. PR/提交建议

1. `feat(cursor): parse and redact local transcripts`
2. `feat(cursor): expose transcript preview and load`
3. `feat(flow): import cursor transcript evidence`
4. `feat(flow): generalize imported session evidence`
5. `feat(web): import transcripts and create guide drafts`
6. `test(flow): add isolated simulation runtime`
7. `test(flow): verify transcript to runtime web loop`
8. `fix(flow): harden transcript validation loop`（仅在对抗测试发现问题时）

每个提交都能单独构建、测试；不得把 G6/G7 的 test-only simulation 注册进生产 CLI。

## 12. 最终完成定义

- 任意合法 Cursor transcript UUID 使用同一 Preview/Confirm 入口；
- 参考 Session 只是一次性样本，产品/fixture/Flow/Runtime 不依赖其 UUID 或路径；
- evidence 在进入 LLM/数据库前脱敏；
- LLM 只能提出 Guide，工具调用被硬阻断；
- Guide 通用化参数和步骤经用户确认后才保存；
- 无 Capability 停在 Guide，有完整 simulation Capability 才能进入 Candidate；
- Web 真实后端全链 16 项验收通过；
- one-shot、binding、revision mismatch、approval、unbind、deprecated 语义保持 Accepted spec；
- 自动化和真实样本 smoke 均未访问或修改线上业务系统；
- simulation Capability 不存在于生产 registry；
- 全量 test/lint/build/Playwright 通过；
- Surface Matrix 和最终汇报不把 implemented 误报为 reachable/closed-loop。
