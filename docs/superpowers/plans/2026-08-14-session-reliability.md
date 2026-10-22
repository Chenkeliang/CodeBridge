# Session Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-authoritative Session runtime with one active Run, a durable cancellable next-turn queue, safe interruption recovery, pure history reads, and bounded long-session rendering.

**Architecture:** `packages/session-coordinator` owns the Session control state machine and depends on transactional primitives from `packages/work-items`. `packages/run-executor` claims leased Runs and converts raw Runner events through a bounded `AgentEventAggregator` before committing events and projections. Bridge routes expose snapshots, queue commands, explicit history import, bounded timeline/events APIs, while the Web uses a per-Session external store and paged timeline instead of rebuilding all history.

**Tech Stack:** TypeScript 5.7/5.9, Node.js 22 `node:sqlite`, Hono, React 19, Vite 8, Vitest 2, SSE, pnpm workspaces.

---

## Scope and execution order

The spec spans storage, execution, API, and Web, but these are not independent products: all four must share the same Session sequence and terminal-state contract. Keep one integrated plan and execute tasks in order. At each commit, stage only listed files; do not stage the pre-existing modification in `packages/run-executor/src/index.test.ts` unless that task explicitly changes the same file and the diff has been reconciled.

The separate `composer-markdown-support` todo is not part of this reliability plan.

## File map

| File | Responsibility |
| --- | --- |
| `packages/core/src/config-schema.ts` | `session.maxQueuedTurns` configuration |
| `packages/work-items/src/session-schema.ts` | SQLite schema and additive migrations |
| `packages/work-items/src/session-runtime.ts` | Session runtime/turn/timeline storage types and transaction interface |
| `packages/work-items/src/session-projector.ts` | Event-to-read-model projection |
| `packages/work-items/src/index.ts` | Existing store integration and legacy compatibility |
| `packages/session-coordinator/src/coordinator.ts` | Submit, queue, terminal, cancel, resume state machine |
| `packages/session-coordinator/src/lease.ts` | Run claim, heartbeat, expired-lease and cancellation-deadline scans |
| `packages/run-executor/src/agent-event-aggregator.ts` | 125 ms / 4 KiB raw event coalescing |
| `packages/run-executor/src/index.ts` | Lease-aware execution and Coordinator terminal transitions |
| `apps/bridge/src/session-history-import.ts` | Explicit Provider history preview/import |
| `apps/bridge/src/session-runtime-api.ts` | Snapshot, queue, timeline, bounded event and submission APIs |
| `apps/bridge/src/session-api.ts` | Existing Session metadata routes and runtime route mounting |
| `apps/bridge/src/cli.ts` | Coordinator, recovery sweeper, executor wiring |
| `apps/web/src/lib/session-store.ts` | Per-Session snapshot and incremental event store |
| `apps/web/src/lib/api.ts` | Snapshot, queue, cancel, timeline and submission clients |
| `apps/web/src/components/session-queue.tsx` | Visible cancellable FIFO queue |
| `apps/web/src/components/session-timeline.tsx` | Paged Turn/Segment timeline |
| `apps/web/src/components/workbench.tsx` | Thin orchestration of selected Session |
| `docs/orchestration/*`, `schemas/orchestration/*` | Final public contract |

### Task 1: Add bounded Session runtime configuration

**Files:**
- Modify: `packages/core/src/config-schema.ts:61-66`
- Modify: `packages/core/src/types.test.ts:93-136`

- [ ] **Step 1: Write the failing configuration test**

Add to `packages/core/src/types.test.ts`:

```ts
it("bounds the Session queue configuration", () => {
  const config = ConfigSchema.parse({
    ...defaultConfig(),
    orchestration: {
      session: { maxQueuedTurns: 250 },
    },
  });

  expect(config.orchestration?.session?.maxQueuedTurns).toBe(250);
  expect(() => ConfigSchema.parse({
    ...defaultConfig(),
    orchestration: { session: { maxQueuedTurns: 1_001 } },
  })).toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm vitest run packages/core/src/types.test.ts
```

Expected: FAIL because `session` is stripped from `orchestration`.

- [ ] **Step 3: Add the exact schema**

Replace `OrchestrationConfigSchema` with:

```ts
export const SessionRuntimeConfigSchema = z.object({
  maxQueuedTurns: z.number().int().min(1).max(1_000).default(100),
});

export const OrchestrationConfigSchema = z.object({
  projectCatalog: ProjectCatalogConfigSchema.optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  session: SessionRuntimeConfigSchema.optional(),
});
```

Do not make lease or cancellation durations configurable; the approved spec fixes those values.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
pnpm vitest run packages/core/src/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config-schema.ts packages/core/src/types.test.ts
git commit -m "feat: configure bounded session queues"
```

### Task 2: Add Session runtime storage schema and types

**Files:**
- Create: `packages/work-items/src/session-schema.ts`
- Create: `packages/work-items/src/session-runtime.ts`
- Create: `packages/work-items/src/session-runtime.test.ts`
- Modify: `packages/work-items/src/index.ts:1-230,300-430,650-790,1160-1210`

- [ ] **Step 1: Write failing migration and constraint tests**

Create `packages/work-items/src/session-runtime.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-session-runtime-"));
  directories.push(directory);
  return path.join(directory, "orchestration.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Session runtime schema", () => {
  it("links one WorkItem to one Session and persists runtime state", () => {
    const store = new SqliteEventStore(databasePath());
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      agentId: "pi",
      riskLevel: "read_only",
    });

    expect(store.getWorkItemBySessionId("sess_1")).toEqual(item);
    expect(store.getSessionRuntime("sess_1")).toMatchObject({
      sessionId: "sess_1",
      activeRunId: null,
      queueState: "ready",
      version: 1,
      lastEventSequence: 1,
    });
    store.close();
  });

  it("rejects a second active Run for one Session", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    store.createRun({ id: "run_1", workItemId: item.id, sessionId: "sess_1", mode: "auto" });
    expect(() => store.createRun({
      id: "run_2",
      workItemId: item.id,
      sessionId: "sess_1",
      mode: "auto",
    })).toThrow();
    store.close();
  });

  it("persists interrupted and lease metadata", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Session",
      mode: "auto",
      conversationId: "conv_session_1",
      sessionId: "sess_1",
      riskLevel: "read_only",
    });
    const run = store.createRun({
      workItemId: item.id,
      sessionId: "sess_1",
      turnId: "turn_1",
      mode: "auto",
    });
    store.updateRunControl(run.id, {
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });

    expect(store.getRun(run.id)).toMatchObject({
      sessionId: "sess_1",
      turnId: "turn_1",
      status: "interrupted",
      terminalReason: "lease_expired",
      replaySafety: "outcome_unknown",
    });
    store.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm vitest run packages/work-items/src/session-runtime.test.ts
```

Expected: TypeScript/runtime failures for missing Session methods and fields.

- [ ] **Step 3: Define storage types**

Create `packages/work-items/src/session-runtime.ts` with these complete public contracts:

```ts
import type { DomainEvent, DomainEventActor, DomainEventType, PersistedPlanStep, RiskLevel, Run, WorkItemMode } from "./index.js";

export type QueueState = "ready" | "paused";
export type QueuePauseReason = "failed" | "cancelled" | "interrupted" | null;
export type SessionTurnStatus = "queued" | "dispatched" | "cancelled";
export type ReplaySafety = "safe" | "side_effect_started" | "outcome_unknown";
export type TimelineTurnStatus =
  | "dispatched" | "running" | "waiting"
  | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface SessionRuntime {
  sessionId: string;
  activeRunId: string | null;
  queueState: QueueState;
  queuePauseReason: QueuePauseReason;
  lastEventSequence: number;
  version: number;
  updatedAt: string;
}

export interface SessionTurnMessage {
  text: string;
  attachmentIds: string[];
  flowId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  plan: {
    planId: string;
    source: "workflow" | "agent_generated";
    workflowId: string;
    definitionRevision: string | null;
    planIrHash: string | null;
    steps: PersistedPlanStep[];
  } | null;
}

export interface SessionTurn {
  turnId: string;
  sessionId: string;
  queuePosition: number;
  status: SessionTurnStatus;
  message: SessionTurnMessage;
  version: number;
  dispatchedRunId: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  cancelledAt: string | null;
}

export interface SessionTimelineSegment {
  segmentId: string;
  blockId: string;
  segmentIndex: number;
  content: string;
  byteLength: number;
  sealed: boolean;
}

export interface SessionTimelineBlock {
  blockId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  blockIndex: number;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  segments: SessionTimelineSegment[];
}

export interface RunAttempt {
  attemptId: string;
  runId: string;
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  providerError: string | null;
  sideEffectBoundary: ReplaySafety;
}

export type ImportedHistoryEntry =
  | { kind: "message"; text: string }
  | { kind: "agent_event"; event: Record<string, unknown> };

export interface SessionTimelineTurn {
  sessionId: string;
  timelineIndex: number;
  turnId: string;
  runId: string;
  startedSequence: number;
  endedSequence: number | null;
  status: TimelineTurnStatus;
  blocks: SessionTimelineBlock[];
}

export interface SessionRuntimeWorkItemInput {
  title: string;
  mode: WorkItemMode;
  conversationId: string;
  agentId: string | null;
  workspaceScope: string[];
  riskLevel: RiskLevel;
}

export interface SessionEventInput {
  workItemId: string;
  sessionId: string;
  runId?: string | null;
  type: DomainEventType;
  actor: DomainEventActor;
  target?: string | null;
  payload?: Record<string, unknown>;
}

export interface SessionRunSpec {
  id: string;
  workItemId: string;
  sessionId: string;
  turnId: string;
  mode: WorkItemMode;
  agentId: string | null;
  planId: string | null;
  planIrHash: string | null;
  workflowRevision: string | null;
}

export interface SessionRuntimeTransaction {
  getRuntime(sessionId: string): SessionRuntime | undefined;
  ensureRuntime(sessionId: string): SessionRuntime;
  getOrCreateWorkItem(sessionId: string, input: SessionRuntimeWorkItemInput): string;
  getIdempotencyResponse<T>(namespace: string, key: string): T | undefined;
  putIdempotencyResponse(namespace: string, key: string, response: unknown): void;
  countQueuedTurns(sessionId: string): number;
  insertTurn(sessionId: string, message: SessionTurnMessage): SessionTurn;
  getTurn(turnId: string): SessionTurn | undefined;
  nextQueuedTurn(sessionId: string): SessionTurn | undefined;
  dispatchTurn(turnId: string, run: SessionRunSpec): { turn: SessionTurn; run: Run };
  cancelTurn(turnId: string, expectedVersion: number): SessionTurn | undefined;
  updateRuntime(sessionId: string, patch: Partial<Pick<SessionRuntime, "activeRunId" | "queueState" | "queuePauseReason">>): SessionRuntime;
  appendEvent(input: SessionEventInput): DomainEvent;
}
```

- [ ] **Step 4: Add additive schema initialization**

Create `packages/work-items/src/session-schema.ts`. Export:

```ts
import type { DatabaseSync } from "node:sqlite";

function addColumn(database: DatabaseSync, statement: string): void {
  try {
    database.exec(statement);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
  }
}

export function initializeSessionRuntimeSchema(database: DatabaseSync): void {
  addColumn(database, "ALTER TABLE work_items ADD COLUMN session_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN session_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN turn_id TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN terminal_reason TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN replay_safety TEXT NOT NULL DEFAULT 'safe'");
  addColumn(database, "ALTER TABLE runs ADD COLUMN lease_owner TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN lease_expires_at TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT");
  addColumn(database, "ALTER TABLE runs ADD COLUMN cancel_deadline_at TEXT");

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS work_items_one_per_session
      ON work_items(session_id) WHERE session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS session_runtime (
      session_id TEXT PRIMARY KEY,
      active_run_id TEXT,
      queue_state TEXT NOT NULL DEFAULT 'ready',
      queue_pause_reason TEXT,
      last_event_sequence INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      queue_position INTEGER NOT NULL,
      status TEXT NOT NULL,
      message_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      dispatched_run_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      cancelled_at TEXT,
      UNIQUE(session_id, queue_position)
    );
    CREATE INDEX IF NOT EXISTS session_turns_queue
      ON session_turns(session_id, status, queue_position);

    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_session
      ON runs(session_id)
      WHERE session_id IS NOT NULL AND status IN ('queued', 'running', 'waiting');

    CREATE TABLE IF NOT EXISTS run_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      provider_error TEXT,
      side_effect_boundary TEXT NOT NULL DEFAULT 'safe',
      UNIQUE(run_id, attempt_number)
    );

    CREATE TABLE IF NOT EXISTS session_timeline_turns (
      session_id TEXT NOT NULL,
      timeline_index INTEGER NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE,
      started_sequence INTEGER NOT NULL,
      ended_sequence INTEGER,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, timeline_index)
    );
    CREATE INDEX IF NOT EXISTS session_timeline_recent
      ON session_timeline_turns(session_id, timeline_index DESC);

    CREATE TABLE IF NOT EXISTS session_timeline_blocks (
      block_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(turn_id, block_index)
    );

    CREATE TABLE IF NOT EXISTS session_output_segments (
      segment_id TEXT PRIMARY KEY,
      block_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      sealed INTEGER NOT NULL,
      UNIQUE(block_id, segment_index)
    );

    CREATE TABLE IF NOT EXISTS session_commands (
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_json TEXT,
      source_sequence INTEGER NOT NULL,
      PRIMARY KEY(session_id, name)
    );

    CREATE TABLE IF NOT EXISTS session_projection_cursors (
      session_id TEXT PRIMARY KEY,
      last_projected_sequence INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_history_imports (
      session_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      imported_position INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY(session_id, provider_session_id)
    );
  `);
}
```

- [ ] **Step 5: Integrate fields and migrations into `SqliteEventStore`**

In `packages/work-items/src/index.ts`:

1. Execute `PRAGMA busy_timeout = 5000` after opening SQLite, then import and call `initializeSessionRuntimeSchema(this.database)` after existing base-table creation and `plan_ir_hash` migrations.
2. Add `sessionId: string | null` to `WorkItem`; add optional `sessionId` to `CreateWorkItemInput`.
3. Add `"interrupted"` to `RunStatus`.
4. Add `TURN_QUEUED`, `TURN_DISPATCHED`, `TURN_CANCELLED`, `RUN_CANCEL_REQUESTED`, and `RUN_INTERRUPTED` to `DomainEventType`; update `schemas/orchestration/event.schema.json` in Task 17.
5. Add these fields to `Run` and `CreateRunInput`:

```ts
sessionId: string | null;
turnId: string | null;
terminalReason: string | null;
replaySafety: ReplaySafety;
leaseOwner: string | null;
leaseExpiresAt: string | null;
cancelRequestedAt: string | null;
cancelDeadlineAt: string | null;
```

6. Add `getWorkItemBySessionId(sessionId)`, `getSessionRuntime(sessionId)`, `getTurn(turnId)`, `listQueuedTurns(sessionId, { afterPosition?, limit })`, `countAllChanges()`, and `updateRunControl(runId, patch)`.
7. Include all new columns in `createWorkItem`, `createRun`, `toWorkItem`, and `toRun`.
8. When `createWorkItem` has `sessionId`, insert its `session_runtime` row in the same transaction before `WORK_ITEM_CREATED`; update `last_event_sequence` after the event.

Use a field-by-field `updateRunControl` implementation rather than interpolating caller-provided column names:

```ts
updateRunControl(runId: string, patch: {
  status?: RunStatus;
  terminalReason?: string | null;
  replaySafety?: ReplaySafety;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  cancelRequestedAt?: string | null;
  cancelDeadlineAt?: string | null;
}): Run {
  const current = this.getRun(runId);
  if (!current) throw new Error(`Run not found: ${runId}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  this.database.prepare(`
    UPDATE runs SET status = ?, terminal_reason = ?, replay_safety = ?,
      lease_owner = ?, lease_expires_at = ?, cancel_requested_at = ?,
      cancel_deadline_at = ?, updated_at = ? WHERE id = ?
  `).run(
    next.status, next.terminalReason, next.replaySafety, next.leaseOwner,
    next.leaseExpiresAt, next.cancelRequestedAt, next.cancelDeadlineAt,
    next.updatedAt, runId,
  );
  return this.getRun(runId)!;
}
```

- [ ] **Step 6: Run storage tests**

Run:

```bash
pnpm vitest run packages/work-items/src/index.test.ts packages/work-items/src/session-runtime.test.ts
```

Expected: PASS, including existing Plan IR tests.

- [ ] **Step 7: Commit**

```bash
git add packages/work-items/src/index.ts packages/work-items/src/session-schema.ts packages/work-items/src/session-runtime.ts packages/work-items/src/session-runtime.test.ts
git commit -m "feat: add session runtime storage"
```

### Task 3: Add transactional Session projection

**Files:**
- Create: `packages/work-items/src/session-projector.ts`
- Create: `packages/work-items/src/session-projector.test.ts`
- Modify: `packages/work-items/src/index.ts:518-605,1080-1155`
- Modify: `packages/work-items/src/session-runtime.ts`

- [ ] **Step 1: Write failing projection tests**

Create `packages/work-items/src/session-projector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

function setup() {
  const store = new SqliteEventStore(":memory:");
  const item = store.createWorkItem({
    title: "Session",
    mode: "auto",
    conversationId: "conv_sess_1",
    sessionId: "sess_1",
    riskLevel: "read_only",
  });
  return { store, item };
}

describe("Session projector", () => {
  it("creates a Turn and seals every block on a terminal event", () => {
    const { store, item } = setup();
    store.seedDispatchedTurnForTest({
      sessionId: "sess_1",
      turnId: "turn_1",
      runId: "run_1",
      workItemId: item.id,
      message: "检查项目",
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_STARTED",
      actor: "system",
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "text_delta",
          blockId: "answer_1",
          phase: "final_answer",
          text: "完成",
        },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SUCCEEDED",
      actor: "system",
    });

    expect(store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]).toMatchObject({
      turnId: "turn_1",
      status: "succeeded",
      blocks: expect.arrayContaining([
        expect.objectContaining({ kind: "user_message", status: "completed" }),
        expect.objectContaining({ blockId: "answer_1", status: "completed" }),
      ]),
    });
    store.close();
  });

  it("updates command read models without scanning events", () => {
    const { store, item } = setup();
    store.appendEvent({
      workItemId: item.id,
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "available_commands_update",
          availableCommands: [{ name: "status", description: "Show status" }],
        },
      },
    });
    expect(store.listSessionCommands("sess_1")).toEqual([
      { name: "status", description: "Show status" },
    ]);
    store.close();
  });

  it("rolls back an event when its projection violates an invariant", () => {
    const { store, item } = setup();
    store.seedDispatchedTurnForTest({
      sessionId: "sess_1",
      turnId: "turn_1",
      runId: "run_1",
      workItemId: item.id,
      message: "检查项目",
    });
    const before = store.listEvents(item.id).length;
    expect(() => store.appendEvent({
      workItemId: item.id,
      type: "TURN_CANCELLED",
      actor: "user",
      target: "turn_1",
    })).toThrow("dispatched Turn cannot be cancelled");
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });
});
```

`seedDispatchedTurnForTest` in the example must not become a production API. Replace it in the final test with `store.withSessionTransaction(tx => ...)` from Step 3.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm vitest run packages/work-items/src/session-projector.test.ts
```

Expected: FAIL for missing transaction and timeline APIs.

- [ ] **Step 3: Add the transaction surface**

Extend `SqliteEventStore` with:

```ts
withSessionTransaction<T>(operation: (transaction: SessionRuntimeTransaction) => T): T {
  this.database.exec("BEGIN IMMEDIATE;");
  try {
    const transaction = createSqliteSessionRuntimeTransaction(this.database);
    const result = operation(transaction);
    this.database.exec("COMMIT;");
    return result;
  } catch (error) {
    this.database.exec("ROLLBACK;");
    throw error;
  }
}
```

Implement `createSqliteSessionRuntimeTransaction` in `session-runtime.ts`. Every method uses prepared SQL and receives one shared `DatabaseSync`; it must never call public `SqliteEventStore` methods that begin nested transactions. `appendEvent` allocates:

```sql
SELECT COALESCE(MAX(sequence), 0) + 1
FROM domain_events
WHERE work_item_id = ?
```

Then inserts the event, updates `session_runtime.last_event_sequence`, and calls the Projector before returning.

- [ ] **Step 4: Implement the projector mapping**

Create `packages/work-items/src/session-projector.ts` exporting:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { DomainEvent } from "./index.js";

export function projectSessionEvent(database: DatabaseSync, sessionId: string, event: DomainEvent): void {
  const cursor = database.prepare(
    "SELECT last_projected_sequence FROM session_projection_cursors WHERE session_id = ?",
  ).get(sessionId) as { last_projected_sequence?: number } | undefined;
  if ((cursor?.last_projected_sequence ?? 0) >= event.sequence) return;

  switch (event.type) {
    case "TURN_DISPATCHED":
      projectTurnDispatched(database, sessionId, event);
      break;
    case "MESSAGE_RECEIVED":
      projectUserMessage(database, sessionId, event);
      break;
    case "RUN_STARTED":
      updateTurnStatus(database, event.runId, "running", event);
      ensureBlock(database, sessionId, event, `work:${event.runId}`, "work", "running");
      break;
    case "AGENT_EVENT":
      projectAgentEvent(database, sessionId, event);
      break;
    case "APPROVAL_REQUESTED":
      updateTurnStatus(database, event.runId, "waiting", event);
      ensureBlock(database, sessionId, event, `approval:${event.target}`, "approval", "waiting");
      break;
    case "RUN_SUCCEEDED":
      closeRun(database, event, "succeeded");
      break;
    case "RUN_FAILED":
      closeRun(database, event, "failed");
      break;
    case "RUN_CANCELLED":
      closeRun(database, event, "cancelled");
      break;
    case "RUN_INTERRUPTED":
      closeRun(database, event, "interrupted");
      break;
    case "TURN_CANCELLED":
      assertQueuedTurnHasNoTimeline(database, String(event.target));
      break;
  }

  database.prepare(`
    INSERT INTO session_projection_cursors(session_id, last_projected_sequence)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_projected_sequence = excluded.last_projected_sequence
  `).run(sessionId, event.sequence);
}
```

Implement helpers exactly according to spec §5.6:

- `TURN_DISPATCHED` inserts one timeline row.
- `MESSAGE_RECEIVED` inserts one sealed `user_message` block and segment.
- Aggregated text/thought appends to an unsealed segment, seals at 16 KiB, and creates continuation segments.
- Delta block identity is `event.blockId ?? event.messageId ?? "${run_id}:${phase_or_kind}"`; it never depends on array position or current UI state.
- Tool start seals the current text tail and creates one tool block; update mutates bounded details; end seals it.
- Terminal events update the Turn and all Blocks for `run_id`.
- `available_commands_update` upserts `session_commands`.
- Duplicate `(session_id, sequence)` is a no-op.
- Agent/step events written by an Executor after its Run is terminal are rejected, so a stale lease owner cannot reopen completed projection state.

Use `Buffer.byteLength(content, "utf8")`; do not use JavaScript string length for the 16 KiB boundary.

- [ ] **Step 5: Add bounded read APIs**

Add these methods to `SqliteEventStore`:

```ts
listTimelineTurns(
  sessionId: string,
  options: { before?: number; limit: number; contentBudgetBytes?: number },
): { turns: SessionTimelineTurn[]; previousCursor: number | null; truncatedBlockIds: string[] };

listTimelineSegments(
  blockId: string,
  options: { after?: number; limit: number },
): { segments: SessionTimelineSegment[]; nextCursor: number | null };

listSessionCommands(sessionId: string): Array<{
  name: string;
  description: string;
  input?: { hint: string };
}>;
```

Clamp Turn limit to 50, Segment limit to 100, and content budget to 1 MiB. Use indexed `timeline_index DESC` and `segment_index ASC` queries.

- [ ] **Step 6: Replace the test helper with transaction setup**

In the tests, seed the Turn through:

```ts
store.withSessionTransaction((tx) => {
  tx.ensureRuntime("sess_1");
  const turn = tx.insertTurn("sess_1", {
    text: "检查项目",
    attachmentIds: [],
    flowId: null,
    model: null,
    effort: null,
    permissionMode: null,
    plan: null,
  });
  tx.dispatchTurn(turn.turnId, {
    id: "run_1",
    workItemId: item.id,
    sessionId: "sess_1",
    turnId: turn.turnId,
    mode: "auto",
    agentId: "pi",
    planId: null,
    planIrHash: null,
    workflowRevision: null,
  });
});
```

- [ ] **Step 7: Run projection and storage tests**

Run:

```bash
pnpm vitest run packages/work-items/src/session-projector.test.ts packages/work-items/src/session-runtime.test.ts packages/work-items/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/work-items/src/index.ts packages/work-items/src/session-runtime.ts packages/work-items/src/session-projector.ts packages/work-items/src/session-projector.test.ts
git commit -m "feat: project session timelines transactionally"
```

### Task 4: Create the SessionCoordinator package and atomic submit

**Files:**
- Create: `packages/session-coordinator/package.json`
- Create: `packages/session-coordinator/tsconfig.json`
- Create: `packages/session-coordinator/src/index.ts`
- Create: `packages/session-coordinator/src/coordinator.ts`
- Create: `packages/session-coordinator/src/coordinator.test.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create package metadata**

`packages/session-coordinator/package.json`:

```json
{
  "name": "@codebridge/session-coordinator",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@codebridge/work-items": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`packages/session-coordinator/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../work-items" }]
}
```

Add `{ "path": "./packages/session-coordinator" }` after `work-items` in root `tsconfig.json`.

- [ ] **Step 2: Write failing atomic-submit tests**

Create `packages/session-coordinator/src/coordinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";

const message = {
  text: "检查项目",
  attachmentIds: [],
  flowId: null,
  model: null,
  effort: null,
  permissionMode: null,
  plan: null,
};

function setup(maxQueuedTurns = 100) {
  const store = new SqliteEventStore(":memory:");
  const coordinator = new SessionCoordinator(store, {
    maxQueuedTurns,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });
  return { store, coordinator };
}

describe("SessionCoordinator submit", () => {
  it("dispatches the first Turn and queues the second", () => {
    const { store, coordinator } = setup();
    const first = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: ["/workspace"],
        riskLevel: "read_only",
      },
    });
    const second = coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "message_2",
      message: { ...message, text: "继续检查" },
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: ["/workspace"],
        riskLevel: "read_only",
      },
    });

    expect(first.acceptance).toBe("dispatched");
    expect(second.acceptance).toBe("queued");
    expect(second.runtime.activeRunId).toBe(first.run?.id);
    expect(store.listQueuedTurns("sess_1", { limit: 100 }).turns).toEqual([
      expect.objectContaining({ turnId: second.turn.turnId, status: "queued" }),
    ]);
    store.close();
  });

  it("returns the first response for the same scoped idempotency key", () => {
    const { store, coordinator } = setup();
    const input = {
      sessionId: "sess_1",
      idempotencyKey: "message_1",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto" as const,
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only" as const,
      },
    };
    const first = coordinator.submitTurn(input);
    const repeated = coordinator.submitTurn({ ...input, message: { ...message, text: "different" } });

    expect(repeated).toEqual(first);
    expect(store.listRunsByStatus(["queued"])).toHaveLength(1);
    store.close();
  });

  it("enforces the configured queue limit", () => {
    const { store, coordinator } = setup(1);
    coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "first",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "second",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    });
    expect(() => coordinator.submitTurn({
      sessionId: "sess_1",
      idempotencyKey: "third",
      message,
      workItem: {
        title: "检查项目",
        mode: "auto",
        conversationId: "conv_sess_1",
        agentId: "pi",
        workspaceScope: [],
        riskLevel: "read_only",
      },
    })).toThrow("queue_full");
    store.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/coordinator.test.ts
```

Expected: FAIL because the package and class do not exist.

- [ ] **Step 4: Implement atomic submit**

Create `coordinator.ts` with:

```ts
import { randomUUID } from "node:crypto";
import type {
  Run,
  SessionRuntime,
  SessionRuntimeWorkItemInput,
  SessionTurn,
  SessionTurnMessage,
  SqliteEventStore,
} from "@codebridge/work-items";

export interface SubmitTurnInput {
  sessionId: string;
  idempotencyKey: string;
  message: SessionTurnMessage;
  workItem: SessionRuntimeWorkItemInput;
}

export interface SubmitTurnResult {
  acceptance: "queued" | "dispatched";
  turn: SessionTurn;
  run: Run | null;
  runtime: SessionRuntime;
  workItemId: string;
}

export interface SessionCoordinatorOptions {
  maxQueuedTurns: number;
  now?: () => Date;
}

export class SessionCoordinator {
  private readonly now: () => Date;

  constructor(
    private readonly store: SqliteEventStore,
    private readonly options: SessionCoordinatorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  submitTurn(input: SubmitTurnInput): SubmitTurnResult {
    const namespace = `session:message:${input.sessionId}`;
    return this.store.withSessionTransaction((tx) => {
      const prior = tx.getIdempotencyResponse<SubmitTurnResult>(namespace, input.idempotencyKey);
      if (prior) return prior;
      const workItemId = tx.getOrCreateWorkItem(input.sessionId, input.workItem);
      let runtime = tx.ensureRuntime(input.sessionId);
      if (tx.countQueuedTurns(input.sessionId) >= this.options.maxQueuedTurns) {
        throw new Error("queue_full");
      }
      const submitted = tx.insertTurn(input.sessionId, input.message);
      let turn = submitted;
      let run: Run | null = null;
      if (runtime.activeRunId === null && runtime.queueState === "ready") {
        const head = tx.nextQueuedTurn(input.sessionId)!;
        const runId = `run_${randomUUID().replaceAll("-", "")}`;
        const dispatched = tx.dispatchTurn(head.turnId, {
          id: runId,
          workItemId,
          sessionId: input.sessionId,
          turnId: head.turnId,
          mode: input.workItem.mode,
          agentId: input.workItem.agentId,
          planId: head.message.plan?.planId ?? null,
          planIrHash: head.message.plan?.planIrHash ?? null,
          workflowRevision: head.message.plan?.definitionRevision ?? null,
        });
        turn = head.turnId === submitted.turnId ? dispatched.turn : submitted;
        run = dispatched.run;
        runtime = tx.updateRuntime(input.sessionId, { activeRunId: run.id });
      }
      if (turn.status === "queued") {
        tx.appendEvent({
          workItemId,
          sessionId: input.sessionId,
          type: "TURN_QUEUED",
          actor: "user",
          target: turn.turnId,
          payload: { queue_position: turn.queuePosition },
        });
      }
      runtime = tx.getRuntime(input.sessionId)!;
      const result: SubmitTurnResult = {
        acceptance: turn.status === "dispatched" ? "dispatched" : "queued",
        turn,
        run,
        runtime,
        workItemId,
      };
      tx.putIdempotencyResponse(namespace, input.idempotencyKey, result);
      return result;
    });
  }
}
```

`dispatchTurn` must persist a frozen Plan from `message.plan` before inserting its Run, then append `TURN_DISPATCHED`, `MESSAGE_RECEIVED`, `RUN_CREATED`, and `PLAN_VALIDATED` in that order.

- [ ] **Step 5: Export the package**

`packages/session-coordinator/src/index.ts`:

```ts
export * from "./coordinator.js";
```

- [ ] **Step 6: Run tests and build**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/coordinator.test.ts packages/work-items/src/session-runtime.test.ts
pnpm --filter @codebridge/session-coordinator build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/session-coordinator packages/work-items/src/session-runtime.ts tsconfig.json
git commit -m "feat: coordinate atomic session turns"
```

### Task 5: Implement queue cancellation, terminal convergence, and resume

**Files:**
- Modify: `packages/work-items/src/session-runtime.ts`
- Modify: `packages/session-coordinator/src/coordinator.ts`
- Modify: `packages/session-coordinator/src/coordinator.test.ts`

- [ ] **Step 1: Add failing state-machine tests**

Append to `coordinator.test.ts`:

```ts
it("dispatches only the FIFO head after success", () => {
  const { store, coordinator } = setup();
  const first = submit(coordinator, "first", "一");
  const second = submit(coordinator, "second", "二");
  const third = submit(coordinator, "third", "三");

  const result = coordinator.finishRun({
    sessionId: "sess_1",
    runId: first.run!.id,
    status: "succeeded",
  });

  expect(result.dispatched?.turn.turnId).toBe(second.turn.turnId);
  expect(result.runtime.activeRunId).toBe(result.dispatched?.run.id);
  expect(store.getTurn(third.turn.turnId)?.status).toBe("queued");
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "pauses the queue after %s",
  (status) => {
    const { store, coordinator } = setup();
    const first = submit(coordinator, "first", "一");
    submit(coordinator, "second", "二");

    const result = coordinator.finishRun({
      sessionId: "sess_1",
      runId: first.run!.id,
      status,
      reason: "test_terminal",
    });

    expect(result.runtime).toMatchObject({
      activeRunId: null,
      queueState: "paused",
      queuePauseReason: status,
    });
    expect(store.listRunsByStatus(["queued"])).toHaveLength(0);
  },
);

it("cancels a queued Turn with its own version and keeps positions stable", () => {
  const { store, coordinator } = setup();
  submit(coordinator, "first", "一");
  const second = submit(coordinator, "second", "二");
  const third = submit(coordinator, "third", "三");

  const cancelled = coordinator.cancelQueuedTurn({
    sessionId: "sess_1",
    turnId: second.turn.turnId,
    expectedVersion: second.turn.version,
    idempotencyKey: "cancel_second",
  });

  expect(cancelled.turn.status).toBe("cancelled");
  expect(store.getTurn(third.turn.turnId)?.queuePosition).toBe(third.turn.queuePosition);
  expect(() => coordinator.cancelQueuedTurn({
    sessionId: "sess_1",
    turnId: third.turn.turnId,
    expectedVersion: 999,
    idempotencyKey: "cancel_third",
  })).toThrow("turn_version_conflict");
});

it("rejects queue cancellation after dispatch", () => {
  const { coordinator } = setup();
  const first = submit(coordinator, "first", "一");
  expect(() => coordinator.cancelQueuedTurn({
    sessionId: "sess_1",
    turnId: first.turn.turnId,
    expectedVersion: first.turn.version,
    idempotencyKey: "cancel_dispatched",
  })).toThrow("turn_not_queued");
});

it("does not couple Turn cancellation to Runtime version", () => {
  const { store, coordinator } = setup();
  submit(coordinator, "first", "一");
  const queued = submit(coordinator, "second", "二");
  store.withSessionTransaction((tx) => {
    tx.updateRuntime("sess_1", { queueState: "ready" });
  });
  expect(coordinator.cancelQueuedTurn({
    sessionId: "sess_1",
    turnId: queued.turn.turnId,
    expectedVersion: queued.turn.version,
    idempotencyKey: "cancel_second",
  }).turn.status).toBe("cancelled");
});

it("resumes a paused queue and dispatches exactly one Turn", () => {
  const { store, coordinator } = setup();
  const first = submit(coordinator, "first", "一");
  const second = submit(coordinator, "second", "二");
  coordinator.finishRun({
    sessionId: "sess_1",
    runId: first.run!.id,
    status: "failed",
    reason: "provider_failed",
  });

  const resumed = coordinator.resumeQueue({
    sessionId: "sess_1",
    expectedRuntimeVersion: store.getSessionRuntime("sess_1")!.version,
    idempotencyKey: "resume_1",
  });

  expect(resumed.dispatched?.turn.turnId).toBe(second.turn.turnId);
  expect(resumed.runtime.queueState).toBe("ready");
});

it("keeps new submissions queued while paused", () => {
  const { coordinator } = setup();
  const first = submit(coordinator, "first", "一");
  coordinator.finishRun({
    sessionId: "sess_1",
    runId: first.run!.id,
    status: "interrupted",
    reason: "provider_disconnected",
  });
  const later = submit(coordinator, "later", "稍后继续");
  expect(later.acceptance).toBe("queued");
  expect(later.run).toBeNull();
  expect(later.runtime.queueState).toBe("paused");
});

it("scopes identical keys by Session and operation", () => {
  const { coordinator } = setup();
  const first = submit(coordinator, "shared_key", "Session one");
  const second = coordinator.submitTurn({
    sessionId: "sess_2",
    idempotencyKey: "shared_key",
    message: { ...message, text: "Session two" },
    workItem: {
      title: "Session two",
      mode: "auto",
      conversationId: "conv_sess_2",
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
  });
  expect(second.turn.turnId).not.toBe(first.turn.turnId);
});
```

Add this local helper above the tests:

```ts
function submit(coordinator: SessionCoordinator, key: string, text: string) {
  return coordinator.submitTurn({
    sessionId: "sess_1",
    idempotencyKey: key,
    message: { ...message, text },
    workItem: {
      title: "Session",
      mode: "auto",
      conversationId: "conv_sess_1",
      agentId: "pi",
      workspaceScope: [],
      riskLevel: "read_only",
    },
  });
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/coordinator.test.ts
```

Expected: FAIL for missing `finishRun`, `cancelQueuedTurn`, and `resumeQueue`.

- [ ] **Step 3: Add transaction operations needed by the state machine**

Extend `SessionRuntimeTransaction` and its SQLite implementation:

```ts
getRun(runId: string): Run | undefined;
getWorkItemForSession(sessionId: string): {
  id: string;
  mode: WorkItemMode;
  agentId: string | null;
} | undefined;
dispatchNextTurn(sessionId: string): { turn: SessionTurn; run: Run } | null;
updateRun(runId: string, patch: {
  status?: RunStatus;
  terminalReason?: string | null;
  replaySafety?: ReplaySafety;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  cancelRequestedAt?: string | null;
  cancelDeadlineAt?: string | null;
}): Run;
```

`dispatchNextTurn` must:

1. Select the lowest `queue_position` with `status = 'queued'`.
2. Load its frozen `message_json` and the Session WorkItem.
3. Insert the frozen Plan if present.
4. Insert one queued Run.
5. Set Turn to `dispatched`, increment its version, and set `dispatched_run_id`.
6. Set runtime `active_run_id`.
7. Append `TURN_DISPATCHED`, `MESSAGE_RECEIVED`, `RUN_CREATED`, then `PLAN_VALIDATED`.

Refactor Task 4 `submitTurn` to call `tx.dispatchNextTurn(input.sessionId)` instead of constructing the Run itself. This prevents two copies of dispatch logic.

- [ ] **Step 4: Add typed conflicts**

At the top of `coordinator.ts` add:

```ts
export class SessionCommandError extends Error {
  constructor(
    public readonly code:
      | "queue_full"
      | "turn_not_found"
      | "turn_not_queued"
      | "turn_version_conflict"
      | "runtime_version_conflict"
      | "active_run_mismatch",
    public readonly status: 404 | 409 | 422,
  ) {
    super(code);
  }
}
```

Replace the string `queue_full` error from Task 4 with:

```ts
throw new SessionCommandError("queue_full", 422);
```

- [ ] **Step 5: Implement terminal transitions and queue commands**

Add these public methods:

```ts
finishRun(input: {
  sessionId: string;
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  reason?: string;
}): {
  runtime: SessionRuntime;
  run: Run;
  dispatched: { turn: SessionTurn; run: Run } | null;
};

cancelQueuedTurn(input: {
  sessionId: string;
  turnId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): { turn: SessionTurn; runtime: SessionRuntime };

resumeQueue(input: {
  sessionId: string;
  expectedRuntimeVersion: number;
  idempotencyKey: string;
}): {
  runtime: SessionRuntime;
  dispatched: { turn: SessionTurn; run: Run } | null;
};
```

Use these exact terminal rules inside one `withSessionTransaction`:

```ts
const eventType = {
  succeeded: "RUN_SUCCEEDED",
  failed: "RUN_FAILED",
  cancelled: "RUN_CANCELLED",
  interrupted: "RUN_INTERRUPTED",
} as const;

if (runtime.activeRunId !== input.runId) {
  throw new SessionCommandError("active_run_mismatch", 409);
}
const run = tx.updateRun(input.runId, {
  status: input.status,
  terminalReason: input.reason ?? null,
  leaseOwner: null,
  leaseExpiresAt: null,
});
tx.appendEvent({
  workItemId: run.workItemId,
  sessionId: input.sessionId,
  runId: run.id,
  type: eventType[input.status],
  actor: "system",
  payload: input.reason ? { reason: input.reason } : {},
});
let nextRuntime = tx.updateRuntime(input.sessionId, { activeRunId: null });
let dispatched = null;
if (input.status === "succeeded") {
  dispatched = tx.dispatchNextTurn(input.sessionId);
  nextRuntime = tx.getRuntime(input.sessionId)!;
} else {
  nextRuntime = tx.updateRuntime(input.sessionId, {
    queueState: "paused",
    queuePauseReason: input.status,
  });
}
return { runtime: nextRuntime, run, dispatched };
```

Idempotency scopes:

```ts
`session:queue-cancel:${input.sessionId}:${input.turnId}`
`session:queue-resume:${input.sessionId}`
```

Do not renumber queued positions after cancellation.

- [ ] **Step 6: Run state-machine tests**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/coordinator.test.ts packages/work-items/src/session-projector.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/work-items/src/session-runtime.ts packages/session-coordinator/src/coordinator.ts packages/session-coordinator/src/coordinator.test.ts
git commit -m "feat: enforce session queue transitions"
```

### Task 6: Implement Run leases and cancellation deadlines

**Files:**
- Create: `packages/session-coordinator/src/lease.ts`
- Create: `packages/session-coordinator/src/lease.test.ts`
- Modify: `packages/session-coordinator/src/index.ts`
- Modify: `packages/work-items/src/session-runtime.ts`
- Modify: `packages/session-coordinator/src/coordinator.ts`
- Modify: `packages/session-coordinator/src/coordinator.test.ts`

- [ ] **Step 1: Write failing lease tests**

Create `packages/session-coordinator/src/lease.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { SessionCoordinator } from "./coordinator.js";
import { SessionLeaseService } from "./lease.js";

describe("Session leases", () => {
  it("claims queued to running with a sixty-second lease", () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(store, { now: () => now });

    const run = leases.claim(runId, "bridge:123");

    expect(run).toMatchObject({
      status: "running",
      leaseOwner: "bridge:123",
      leaseExpiresAt: "2026-08-14T00:01:00.000Z",
    });
    expect(leases.claim(runId, "bridge:456")).toBeNull();
  });

  it("renews only the current owner's running lease", () => {
    const clock = { now: new Date("2026-08-14T00:00:00.000Z") };
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(store, { now: () => clock.now });
    leases.claim(runId, "bridge:123");
    clock.now = new Date("2026-08-14T00:00:15.000Z");

    expect(leases.renew(runId, "bridge:123")?.leaseExpiresAt)
      .toBe("2026-08-14T00:01:15.000Z");
    expect(leases.renew(runId, "bridge:456")).toBeNull();
  });

  it("finds expired running leases but never waiting Runs", () => {
    const clock = { now: new Date("2026-08-14T00:00:00.000Z") };
    const { store, runId } = setupQueuedRun();
    const leases = new SessionLeaseService(store, { now: () => clock.now });
    leases.claim(runId, "bridge:123");
    clock.now = new Date("2026-08-14T00:01:01.000Z");

    expect(leases.listExpired()).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    store.updateRunControl(runId, { status: "waiting", leaseOwner: null, leaseExpiresAt: null });
    expect(leases.listExpired()).toEqual([]);
  });
});
```

Use the Task 5 `submit()` setup to implement `setupQueuedRun`; it submits one Turn and returns its queued Run id.

- [ ] **Step 2: Write failing cancellation tests**

Append to `coordinator.test.ts`:

```ts
it("returns interrupting for a running cancellation request", () => {
  const { store, coordinator } = setup();
  const submitted = submit(coordinator, "first", "一");
  store.updateRunControl(submitted.run!.id, {
    status: "running",
    leaseOwner: "bridge:123",
    leaseExpiresAt: "2026-08-14T00:01:00.000Z",
  });

  const result = coordinator.requestRunCancellation({
    sessionId: "sess_1",
    runId: submitted.run!.id,
    expectedRuntimeVersion: store.getSessionRuntime("sess_1")!.version,
    idempotencyKey: "cancel_run_1",
  });

  expect(result).toMatchObject({
    disposition: "interrupting",
    run: {
      cancelRequestedAt: "2026-08-14T00:00:00.000Z",
      cancelDeadlineAt: "2026-08-14T00:00:10.000Z",
    },
  });
});

it("cancels an unclaimed queued Run immediately", () => {
  const { coordinator } = setup();
  const submitted = submit(coordinator, "first", "一");

  const result = coordinator.requestRunCancellation({
    sessionId: "sess_1",
    runId: submitted.run!.id,
    expectedRuntimeVersion: store.getSessionRuntime("sess_1")!.version,
    idempotencyKey: "cancel_run_1",
  });

  expect(result.disposition).toBe("cancelled");
  expect(result.run.status).toBe("cancelled");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/lease.test.ts packages/session-coordinator/src/coordinator.test.ts
```

Expected: FAIL for missing lease and cancellation methods.

- [ ] **Step 4: Add conditional lease SQL operations**

Extend `SessionRuntimeTransaction` and `SqliteEventStore`:

```ts
claimRun(runId: string, owner: string, now: string, expiresAt: string): Run | null;
renewRunLease(runId: string, owner: string, expiresAt: string): Run | null;
listExpiredRunningRuns(now: string, limit: number): Run[];
listCancellationDeadlineRuns(now: string, limit: number): Run[];
```

Use conditional SQL, checking `changes`:

```sql
UPDATE runs
SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
WHERE id = ? AND status = 'queued' AND lease_owner IS NULL
```

```sql
UPDATE runs
SET lease_expires_at = ?, updated_at = ?
WHERE id = ? AND status = 'running' AND lease_owner = ?
```

Expired query:

```sql
SELECT * FROM runs
WHERE status = 'running'
  AND lease_expires_at IS NOT NULL
  AND lease_expires_at < ?
ORDER BY lease_expires_at ASC
LIMIT ?
```

- [ ] **Step 5: Implement `SessionLeaseService`**

Create `lease.ts`:

```ts
import type { Run, SqliteEventStore } from "@codebridge/work-items";

const LEASE_MS = 60_000;

export class SessionLeaseService {
  private readonly now: () => Date;

  constructor(
    private readonly store: SqliteEventStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  claim(runId: string, owner: string): Run | null {
    const now = this.now();
    return this.store.claimRun(
      runId,
      owner,
      now.toISOString(),
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
  }

  renew(runId: string, owner: string): Run | null {
    const now = this.now();
    return this.store.renewRunLease(
      runId,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
    );
  }

  listExpired(limit = 100): Run[] {
    return this.store.listExpiredRunningRuns(this.now().toISOString(), limit);
  }
}
```

Export it from `index.ts`.

- [ ] **Step 6: Implement cancellation request semantics**

Add to `SessionCoordinator`:

```ts
requestRunCancellation(input: {
  sessionId: string;
  runId: string;
  expectedRuntimeVersion: number;
  idempotencyKey: string;
}): {
  disposition: "cancelled" | "interrupting" | "already_terminal";
  run: Run;
  runtime: SessionRuntime;
};
```

Rules:

- Terminal Run: `already_terminal`, no event.
- If the Run remains active but `expectedRuntimeVersion` differs, throw `runtime_version_conflict` with the latest Runtime so the API can return 409.
- Queued or waiting Run: call `finishRun(... status: "cancelled", reason: "user_requested")` in the same transaction helper; do not nest transactions.
- Running Run: set `cancel_requested_at = now`, `cancel_deadline_at = now + 10_000 ms`, append `RUN_CANCEL_REQUESTED`, return `interrupting`.
- Repeated key returns the stored response in `session:run-cancel:{run_id}`.
- A second different key after a request also returns `interrupting` without moving the original deadline.

- [ ] **Step 7: Run coordinator tests**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/lease.test.ts packages/session-coordinator/src/coordinator.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/work-items/src/session-runtime.ts packages/session-coordinator/src
git commit -m "feat: lease and cancel session runs"
```

### Task 7: Add bounded raw Agent event aggregation

**Files:**
- Create: `packages/run-executor/src/agent-event-aggregator.ts`
- Create: `packages/run-executor/src/agent-event-aggregator.test.ts`
- Modify: `packages/run-executor/src/index.ts:431-440`
- Modify: `packages/core/src/types.ts:80-110`
- Modify: `packages/core/src/types.test.ts`

- [ ] **Step 1: Write failing aggregation tests**

Create `agent-event-aggregator.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventAggregator } from "./agent-event-aggregator.js";

afterEach(() => vi.useRealTimers());

describe("AgentEventAggregator", () => {
  it("coalesces one burst by run, block and delta kind", () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });

    aggregator.accept({ type: "text_delta", blockId: "answer", phase: "final_answer", text: "a" });
    aggregator.accept({ type: "text_delta", blockId: "answer", phase: "final_answer", text: "b" });
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(125);
    expect(emitted).toEqual([
      { type: "text_delta", blockId: "answer", phase: "final_answer", text: "ab" },
    ]);
    aggregator.close();
  });

  it("flushes before semantic boundaries", () => {
    const emitted: Array<{ type: string; text?: string }> = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });

    aggregator.accept({ type: "thought_delta", blockId: "thought", text: "检查" });
    aggregator.accept({ type: "tool_start", toolCallId: "tool_1", name: "rg", input: {} });

    expect(emitted.map((event) => event.type)).toEqual(["thought_delta", "tool_start"]);
    aggregator.close();
  });

  it("splits buffers at four KiB without losing content", () => {
    const emitted: Array<{ type: string; text?: string }> = [];
    const aggregator = new AgentEventAggregator({
      runId: "run_1",
      emit: (event) => emitted.push(event),
    });
    const source = "界".repeat(2_000);
    aggregator.accept({ type: "text_delta", blockId: "answer", phase: "final_answer", text: source });
    aggregator.close();

    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.map((event) => event.text ?? "").join("")).toBe(source);
    expect(emitted.every((event) => Buffer.byteLength(event.text ?? "", "utf8") <= 4_096)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/run-executor/src/agent-event-aggregator.test.ts
```

Expected: FAIL because `AgentEventAggregator` does not exist.

- [ ] **Step 3: Implement the aggregator**

First extend `AgentEvent` without changing existing required fields:

```ts
| {
    type: "text_delta";
    text: string;
    blockId?: string;
    messageId?: string;
    phase?: AgentMessagePhase;
  }
| { type: "thought_delta"; text: string; blockId?: string; messageId?: string }
```

Add `sideEffects?: boolean` to `tool_start`, `tool_update`, and `tool_end`. Add a core serialization test proving these optional fields survive Runner JSON transport.

Create `agent-event-aggregator.ts`:

```ts
import type { AgentEvent } from "@codebridge/runner-client";

const FLUSH_MS = 125;
const MAX_BYTES = 4_096;
type Delta = Extract<AgentEvent, { type: "text_delta" | "thought_delta" }>;

function deltaKey(runId: string, event: Delta): string {
  return [
    runId,
    event.blockId ?? event.messageId ?? "",
    event.type,
    "phase" in event ? event.phase ?? "" : "",
  ].join(":");
}

export class AgentEventAggregator {
  private buffer: Delta | null = null;
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: {
    runId: string;
    emit: (event: AgentEvent) => void;
  }) {}

  accept(event: AgentEvent): void {
    if (this.closed) throw new Error("AgentEventAggregator is closed");
    if (event.type !== "text_delta" && event.type !== "thought_delta") {
      this.flush();
      this.options.emit(event);
      return;
    }
    const key = deltaKey(this.options.runId, event);
    if (this.buffer && this.key !== key) this.flush();
    if (!this.buffer) {
      this.buffer = { ...event };
      this.key = key;
    } else {
      this.buffer = { ...this.buffer, text: this.buffer.text + event.text };
    }
    this.flushOversized();
    if (this.buffer && !this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer) return;
    const event = this.buffer;
    this.buffer = null;
    this.key = null;
    this.options.emit(event);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private flushOversized(): void {
    while (this.buffer && Buffer.byteLength(this.buffer.text, "utf8") >= MAX_BYTES) {
      const { head, tail } = splitUtf8(this.buffer.text, MAX_BYTES);
      this.options.emit({ ...this.buffer, text: head });
      this.buffer = tail ? { ...this.buffer, text: tail } : null;
    }
  }
}

function splitUtf8(value: string, maximumBytes: number): { head: string; tail: string } {
  let end = Math.min(value.length, maximumBytes);
  while (Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return { head: value.slice(0, end), tail: value.slice(end) };
}
```

- [ ] **Step 4: Put persistence before callbacks**

In the Executor stream loop, replace direct per-event persistence with:

```ts
const aggregator = new AgentEventAggregator({
  runId: run.id,
  emit: (agentEvent) => {
    this.store.appendEvent({
      workItemId: workItem.id,
      runId: run.id,
      type: "AGENT_EVENT",
      actor: "agent",
      payload: { stepId: step.id, event: agentEvent },
    });
    this.options.onEvent?.(agentEvent);
  },
});
try {
  for await (const agentEvent of stream) aggregator.accept(agentEvent);
} finally {
  aggregator.close();
}
```

No callback or SSE publication may occur before `appendEvent` returns.

- [ ] **Step 5: Add an ordering regression test**

In `agent-event-aggregator.test.ts`, use an `emit` callback that records `"persist"` before a simulated subscriber records `"publish"`, then assert:

```ts
expect(order).toEqual(["persist", "publish"]);
```

In `packages/run-executor/src/index.test.ts`, add the equivalent integration assertion at the existing `onEvent` test. Preserve all pre-existing user edits in that file.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
pnpm vitest run packages/run-executor/src/agent-event-aggregator.test.ts packages/run-executor/src/index.test.ts
```

Expected: PASS, with burst events reduced and order preserved.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts packages/run-executor/src/agent-event-aggregator.ts packages/run-executor/src/agent-event-aggregator.test.ts packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "feat: bound agent event persistence"
```

### Task 8: Make RunExecutor lease-aware and Coordinator-driven

**Files:**
- Modify: `packages/run-executor/package.json`
- Create: `packages/run-executor/src/run-heartbeat.ts`
- Create: `packages/run-executor/src/run-heartbeat.test.ts`
- Modify: `packages/run-executor/src/index.ts:1-220,345-510`
- Modify: `packages/run-executor/src/index.test.ts`

- [ ] **Step 1: Add the Coordinator dependency**

Add:

```json
"@codebridge/session-coordinator": "workspace:*"
```

to `packages/run-executor/package.json` dependencies.

- [ ] **Step 2: Write failing heartbeat and terminal tests**

Create `run-heartbeat.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHeartbeat } from "./run-heartbeat.js";

afterEach(() => vi.useRealTimers());

describe("RunHeartbeat", () => {
  it("renews every fifteen seconds and stops after close", () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockReturnValue({ id: "run_1" });
    const lost = vi.fn();
    const heartbeat = new RunHeartbeat({
      runId: "run_1",
      owner: "bridge:123",
      renew,
      onLeaseLost: lost,
    });
    heartbeat.start();
    vi.advanceTimersByTime(45_000);
    expect(renew).toHaveBeenCalledTimes(3);
    heartbeat.close();
    vi.advanceTimersByTime(15_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(lost).not.toHaveBeenCalled();
  });

  it("reports a lost lease and stops", () => {
    vi.useFakeTimers();
    const lost = vi.fn();
    const heartbeat = new RunHeartbeat({
      runId: "run_1",
      owner: "bridge:123",
      renew: () => null,
      onLeaseLost: lost,
    });
    heartbeat.start();
    vi.advanceTimersByTime(15_000);
    expect(lost).toHaveBeenCalledOnce();
  });
});
```

Add an integration test to `index.test.ts` that constructs a Session-bound Run and asserts:

```ts
expect(leaseService.claim).toHaveBeenCalledWith(run.id, executorOwner);
expect(coordinator.finishRun).toHaveBeenCalledWith({
  sessionId: "sess_1",
  runId: run.id,
  status: "succeeded",
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/run-executor/src/run-heartbeat.test.ts packages/run-executor/src/index.test.ts
```

Expected: FAIL for missing heartbeat and Executor options.

- [ ] **Step 4: Implement the heartbeat**

Create `run-heartbeat.ts`:

```ts
import type { Run } from "@codebridge/work-items";

export class RunHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    runId: string;
    owner: string;
    renew: (runId: string, owner: string) => Run | null;
    onLeaseLost: () => void;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.options.renew(this.options.runId, this.options.owner)) {
        this.close();
        this.options.onLeaseLost();
      }
    }, 15_000);
  }

  close(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 5: Extend RunExecutor options**

Add:

```ts
sessionCoordinator?: SessionCoordinator;
sessionLeaseService?: SessionLeaseService;
executorOwner?: string;
```

For a Run with `sessionId`:

1. Require all three options.
2. Claim before creating the Runner stream; return without execution if claim fails.
3. Start `RunHeartbeat`.
4. If the lease is lost, abort the Runner request and do not write a terminal event.
5. Call `sessionCoordinator.finishRun` for all terminal outcomes.
6. On `waiting`, update status to waiting and clear lease owner/expiry; persisted approval state remains authoritative.
7. Always close the heartbeat in `finally`.

For legacy Runs with `sessionId === null`, preserve the old status path temporarily.

Add `SqliteEventStore.appendLeasedRunEvent(owner, input)`. In one transaction it verifies:

```sql
SELECT 1 FROM runs
WHERE id = ? AND status = 'running'
  AND lease_owner = ? AND lease_expires_at >= ?
```

and only then appends/projects the event. All Session-bound Executor `AGENT_EVENT`, step, approval, and diagnostic writes use this method. If ownership/status validation fails, throw `run_lease_lost`; the Executor aborts without emitting or publishing the rejected event.

- [ ] **Step 6: Check cancellation between every blocking boundary**

Use one helper:

```ts
private throwIfCancellationRequested(runId: string): void {
  const run = this.store.getRun(runId);
  if (run?.cancelRequestedAt) throw new RunCancellationRequested();
}
```

Call it before Runner invocation, after each aggregated event, before/after approval wait, and before every capability execution. In the cancellation catch, abort Runner/capability work and call `finishRun(... cancelled ...)` only after the adapter acknowledges interruption.

Add an integration test where owner A claims, the Run becomes interrupted, and owner A attempts `appendLeasedRunEvent`; assert the method throws and event/timeline counts do not change.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
pnpm vitest run packages/run-executor/src/run-heartbeat.test.ts packages/run-executor/src/agent-event-aggregator.test.ts packages/run-executor/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/run-executor/package.json packages/run-executor/src/run-heartbeat.ts packages/run-executor/src/run-heartbeat.test.ts packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts
git commit -m "feat: execute session runs with leases"
```

### Task 9: Add replay-safety attempts and recovery sweepers

**Files:**
- Create: `packages/session-coordinator/src/recovery.ts`
- Create: `packages/session-coordinator/src/recovery.test.ts`
- Modify: `packages/session-coordinator/src/index.ts`
- Modify: `packages/work-items/src/session-runtime.ts`
- Modify: `packages/run-executor/src/index.ts`
- Modify: `packages/run-executor/src/index.test.ts`
- Modify: `apps/bridge/src/cli.ts:200-390`

- [ ] **Step 1: Write failing recovery tests**

Create `recovery.test.ts` with these four cases:

```ts
it("repairs an expired Run from a committed terminal event", () => {
  const { store, run } = setupExpiredRunningRun({ replaySafety: "safe" });
  appendRawTerminalEvidence(store, run, "RUN_SUCCEEDED");
  const recovery = new SessionRecoveryService(store, coordinator, leases, clock);

  expect(recovery.scanExpired()).toEqual([{ runId: run.id, action: "repaired_succeeded" }]);
  expect(store.getRun(run.id)?.status).toBe("succeeded");
});

it("interrupts instead of replaying an expired unknown-outcome Run", () => {
  const { store, run } = setupExpiredRunningRun({ replaySafety: "outcome_unknown" });
  const recovery = new SessionRecoveryService(store, coordinator, leases, clock);

  expect(recovery.scanExpired()).toEqual([{ runId: run.id, action: "interrupted" }]);
  expect(store.getSessionRuntime("sess_1")).toMatchObject({
    activeRunId: null,
    queueState: "paused",
    queuePauseReason: "interrupted",
  });
});

it("leaves waiting Runs untouched", () => {
  const { store, run } = setupWaitingRun();
  const recovery = new SessionRecoveryService(store, coordinator, leases, clock);
  recovery.scanExpired();
  expect(store.getRun(run.id)?.status).toBe("waiting");
});

it("forces an overdue cancellation to interrupted", () => {
  const { store, run } = setupOverdueCancellation();
  const recovery = new SessionRecoveryService(store, coordinator, leases, clock);
  recovery.scanCancellationDeadlines();
  expect(store.getRun(run.id)?.status).toBe("interrupted");
});
```

Implement setup using only `SessionCoordinator`, `SessionLeaseService`, and public store APIs.

- [ ] **Step 2: Write failing attempt/retry tests**

Add to `packages/run-executor/src/index.test.ts`:

```ts
it("retries a Provider disconnect only before a side-effect boundary", async () => {
  runner.run
    .mockRejectedValueOnce(new Error("socket closed"))
    .mockReturnValueOnce(events([{ type: "text_delta", blockId: "answer", text: "ok" }]));
  await executor.execute(run.id);
  expect(runner.run).toHaveBeenCalledTimes(2);
  expect(store.listRunAttempts(run.id)).toMatchObject([
    { attemptNumber: 1, providerError: "socket closed", sideEffectBoundary: "safe" },
    { attemptNumber: 2, providerError: null, sideEffectBoundary: "safe" },
  ]);
});

it("does not replay after an unknown tool outcome", async () => {
  runner.run.mockReturnValue(eventsThenError([
    { type: "tool_start", toolCallId: "tool_1", name: "write_file", input: {} },
  ], new Error("socket closed")));
  await executor.execute(run.id);
  expect(runner.run).toHaveBeenCalledOnce();
  expect(store.getRun(run.id)).toMatchObject({
    status: "interrupted",
    replaySafety: "outcome_unknown",
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/recovery.test.ts packages/run-executor/src/index.test.ts
```

Expected: FAIL for missing attempts and recovery service.

- [ ] **Step 4: Add attempt storage operations**

Add:

```ts
startRunAttempt(runId: string): RunAttempt;
finishRunAttempt(attemptId: string, input: {
  providerError: string | null;
  sideEffectBoundary: ReplaySafety;
}): RunAttempt;
listRunAttempts(runId: string): RunAttempt[];
findTerminalEventForRun(runId: string): DomainEvent | undefined;
```

`startRunAttempt` assigns `MAX(attempt_number) + 1` inside the same `BEGIN IMMEDIATE` transaction. `findTerminalEventForRun` uses `(work_item_id, run_id, type, sequence)` indexing; add:

```sql
CREATE INDEX IF NOT EXISTS domain_events_run_terminal
  ON domain_events(run_id, type, sequence DESC)
  WHERE run_id IS NOT NULL;
```

- [ ] **Step 5: Track the replay-safety boundary**

Use this conservative rule in the Executor:

```ts
function replaySafetyAfterEvent(current: ReplaySafety, event: AgentEvent): ReplaySafety {
  if (current === "outcome_unknown") return current;
  if (event.type === "tool_start" && event.sideEffects !== false) return "outcome_unknown";
  if (event.type === "tool_start") return "side_effect_started";
  if (event.type === "tool_end" && event.sideEffects === true) return "outcome_unknown";
  return current;
}
```

Extend `AgentEvent` adapters with optional `sideEffects?: boolean`. Capability Plan steps use the capability manifest’s existing side-effect metadata. Unknown tools default to side-effecting.

Each attempt:

1. Calls `startRunAttempt`.
2. Persists replay-safety changes immediately.
3. Calls `finishRunAttempt` on success or failure.
4. Retries Provider transport errors at 500 ms, 1 s, 2 s, 4 s, capped at 8 s and three total attempts.
5. Retries only when `replaySafety === "safe"`.
6. On non-safe disconnect, terminalizes as `interrupted`, never `failed` or queued.

- [ ] **Step 6: Implement recovery**

Create `recovery.ts`:

```ts
export type RecoveryAction =
  | "repaired_succeeded"
  | "repaired_failed"
  | "repaired_cancelled"
  | "repaired_interrupted"
  | "interrupted";

export class SessionRecoveryService {
  constructor(
    private readonly store: SqliteEventStore,
    private readonly coordinator: SessionCoordinator,
    private readonly leases: SessionLeaseService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  scanExpired(): Array<{ runId: string; action: RecoveryAction }> {
    return this.leases.listExpired().map((run) => {
      const terminal = this.store.findTerminalEventForRun(run.id);
      if (terminal) return this.repairFromEvidence(run, terminal);
      this.coordinator.finishRun({
        sessionId: run.sessionId!,
        runId: run.id,
        status: "interrupted",
        reason: run.replaySafety === "outcome_unknown"
          ? "lease_expired_unknown_outcome"
          : "lease_expired",
      });
      return { runId: run.id, action: "interrupted" as const };
    });
  }

  scanCancellationDeadlines(): Array<{ runId: string; action: "interrupted" }> {
    return this.store
      .listCancellationDeadlineRuns(this.now().toISOString(), 100)
      .map((run) => {
        this.coordinator.finishRun({
          sessionId: run.sessionId!,
          runId: run.id,
          status: "interrupted",
          reason: "cancellation_deadline_exceeded",
        });
        return { runId: run.id, action: "interrupted" as const };
      });
  }
}
```

`repairFromEvidence` maps each terminal event to the matching persisted Run status without appending a duplicate event.

- [ ] **Step 7: Replace startup requeue logic**

In `apps/bridge/src/cli.ts`:

- Delete the startup loop that changes every stale `running` Run back to `queued`.
- Start a 15-second expired-lease interval.
- Start a one-second cancellation-deadline interval.
- Run both scans once before polling queued Runs.
- Pass `sessionCoordinator`, `sessionLeaseService`, and a stable `${hostname()}:${process.pid}` owner to `RunExecutor`.
- Clear both intervals during Bridge shutdown.

- [ ] **Step 8: Run recovery and Executor tests**

Run:

```bash
pnpm vitest run packages/session-coordinator/src/recovery.test.ts packages/session-coordinator/src/lease.test.ts packages/run-executor/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/work-items/src/session-runtime.ts packages/session-coordinator/src packages/run-executor/src/index.ts packages/run-executor/src/index.test.ts apps/bridge/src/cli.ts
git commit -m "feat: recover interrupted session runs safely"
```

### Task 10: Replace hidden hydration with explicit Provider history import

**Files:**
- Create: `apps/bridge/src/session-history-import.ts`
- Create: `apps/bridge/src/session-history-import.test.ts`
- Modify: `apps/bridge/src/session-api.ts:35-165,310-322,561-568`
- Modify: `packages/work-items/src/session-runtime.ts`

- [ ] **Step 1: Write failing pure-read and import tests**

Create `session-history-import.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "@codebridge/work-items";
import { ProviderHistoryImporter } from "./session-history-import.js";

describe("ProviderHistoryImporter", () => {
  it("previews without changing SQLite", async () => {
    const { store, catalog, runner, session } = setupImportedSession();
    runner.loadSessionHistory.mockResolvedValue([
      { kind: "message", text: "old question" },
      { kind: "agent_event", event: { type: "text_delta", blockId: "answer", text: "old answer" } },
    ]);
    const importer = new ProviderHistoryImporter({ store, catalog, runner });
    const before = store.countAllChanges();

    const preview = await importer.preview(session.id);

    expect(preview).toMatchObject({ importableEvents: 2, importedPosition: 0 });
    expect(store.countAllChanges()).toBe(before);
  });

  it("imports each Provider position once", async () => {
    const { store, catalog, runner, session } = setupImportedSession();
    runner.loadSessionHistory.mockResolvedValue([
      { kind: "message", text: "old question" },
      { kind: "agent_event", event: { type: "text_delta", blockId: "answer", text: "old answer" } },
    ]);
    const importer = new ProviderHistoryImporter({ store, catalog, runner });

    const first = await importer.import(session.id, "import_1");
    const second = await importer.import(session.id, "import_1");

    expect(second).toEqual(first);
    expect(first).toMatchObject({ importedEvents: 2, importedTurns: 1 });
    expect(store.listTimelineTurns(session.id, { limit: 50 }).turns).toHaveLength(1);
  });

  it("rejects changed Provider history before the imported cursor", async () => {
    const { store, catalog, runner, session } = setupImportedSession();
    const importer = new ProviderHistoryImporter({ store, catalog, runner });
    runner.loadSessionHistory.mockResolvedValue([{ kind: "message", text: "original" }]);
    await importer.import(session.id, "import_1");
    runner.loadSessionHistory.mockResolvedValue([{ kind: "message", text: "rewritten" }]);

    await expect(importer.preview(session.id)).rejects.toThrow("provider_history_prefix_changed");
  });
});
```

In `apps/bridge/src/session-api.test.ts`, add:

```ts
it("does not call the Runner or write SQLite when opening a Session", async () => {
  const before = workItems.countAllChanges();
  const response = await request(`/v1/sessions/${session.id}`);
  expect(response.status).toBe(200);
  expect(runner.loadSessionHistory).not.toHaveBeenCalled();
  expect(workItems.countAllChanges()).toBe(before);
});
```

`countAllChanges()` is a diagnostic that executes `SELECT total_changes() AS value`; it does not mutate state.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/bridge/src/session-history-import.test.ts apps/bridge/src/session-api.test.ts
```

Expected: FAIL because GET still hydrates and importer does not exist.

- [ ] **Step 3: Add transactional import storage**

Add:

```ts
getProviderHistoryImport(sessionId: string, providerSessionId: string): {
  providerDigest: string;
  importedPosition: number;
  importedAt: string;
} | undefined;

importProviderHistory(input: {
  sessionId: string;
  providerSessionId: string;
  priorPosition: number;
  priorDigest: string;
  nextDigest: string;
  events: ImportedHistoryEntry[];
  idempotencyKey: string;
}): { importedEvents: number; importedTurns: number; lastEventSequence: number };
```

The importer must group history as:

- A Provider `message` starts one synthetic Turn and Run.
- Agent events after it belong to that Run.
- A new message seals the prior Run as succeeded before dispatching the next.
- Agent events before the first message go into one synthetic imported Turn with an empty user block omitted.
- The final synthetic Run is succeeded.

Use IDs derived from SHA-256 of `(provider_session_id, provider_position)` so a crash/retry cannot create a duplicate Turn. Write the `provider_history_imports` cursor and digest in the same transaction as the synthetic events/projections.
Read and write `session:history-import:{session_id}` idempotency inside that same transaction; the returned response must be the one committed with the import cursor.

- [ ] **Step 4: Implement preview and import**

Create `session-history-import.ts`:

```ts
import { createHash } from "node:crypto";
import type { SessionCatalog } from "@codebridge/session-catalog";
import type { ProviderSessionHistoryEvent, RunnerClient } from "@codebridge/runner-client";
import type { SqliteEventStore } from "@codebridge/work-items";

function digest(events: ProviderSessionHistoryEvent[], end = events.length): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(events.slice(0, end)))
    .digest("hex")}`;
}

export class ProviderHistoryImporter {
  constructor(private readonly dependencies: {
    store: SqliteEventStore;
    catalog: SessionCatalog;
    runner: RunnerClient;
  }) {}

  async preview(sessionId: string) {
    const session = this.requireBoundSession(sessionId);
    const history = await this.load(session);
    const prior = this.dependencies.store.getProviderHistoryImport(
      session.id,
      session.providerSessionId!,
    );
    if (prior && digest(history, prior.importedPosition) !== prior.providerDigest) {
      throw new Error("provider_history_prefix_changed");
    }
    return {
      providerSessionId: session.providerSessionId!,
      importedPosition: prior?.importedPosition ?? 0,
      providerPosition: history.length,
      importableEvents: history.length - (prior?.importedPosition ?? 0),
      nextDigest: digest(history),
    };
  }

  async import(sessionId: string, idempotencyKey: string) {
    const namespace = `session:history-import:${sessionId}`;
    const cached = this.dependencies.store.getIdempotencyResponse(namespace, idempotencyKey);
    if (cached) return cached;
    const session = this.requireBoundSession(sessionId);
    const history = await this.load(session);
    const prior = this.dependencies.store.getProviderHistoryImport(
      session.id,
      session.providerSessionId!,
    );
    const priorPosition = prior?.importedPosition ?? 0;
    const priorDigest = digest(history, priorPosition);
    if (prior && priorDigest !== prior.providerDigest) {
      throw new Error("provider_history_prefix_changed");
    }
    const result = this.dependencies.store.importProviderHistory({
      sessionId,
      providerSessionId: session.providerSessionId!,
      priorPosition,
      priorDigest,
      nextDigest: digest(history),
      events: history.slice(priorPosition),
      idempotencyKey,
    });
    this.dependencies.catalog.updateSession(sessionId, {
      taskRecordId: this.dependencies.store.getWorkItemBySessionId(sessionId)!.id,
    });
    return result;
  }
}
```

Implement `requireBoundSession` and `load` with exact `RunnerClient.loadSessionHistory` arguments from the existing `hydrateProviderHistory`.

- [ ] **Step 5: Remove read-path mutation**

Delete `historyHydrations`, `historyRetryAfter`, and `hydrateProviderHistory` from `session-api.ts`. Change Session GET to:

```ts
app.get("/v1/sessions/:session_id", (c) => {
  const session = options.catalog.getSession(c.req.param("session_id"));
  if (!session) return c.json({ error: "session_not_found" }, 404);
  return c.json(toApiSession(session));
});
```

Change provider discovery from `GET /v1/sessions?import=true` to:

```ts
app.post("/v1/sessions/import", async (c) => {
  const body = await readJson(c);
  const cwd = typeof body?.cwd === "string" ? body.cwd : options.defaultCwd;
  if (!cwd) return c.json({ error: "workspace_required" }, 400);
  const agentId = typeof body?.agent_id === "string" ? body.agent_id : undefined;
  const sync = await syncProviderSessions(options, currentProfiles(), agentId, cwd);
  return c.json({ sessions: options.catalog.listSessions(agentId).map(toApiSession), provider_errors: sync.errors });
});
```

Keep `GET /v1/sessions` a pure catalog read; when `import=true` is present, return `410 { "error": "provider_import_moved" }`.

- [ ] **Step 6: Add explicit import routes**

Register:

```ts
POST /v1/sessions/:session_id/provider-history/preview
POST /v1/sessions/:session_id/provider-history/import
```

The import route requires an `Idempotency-Key` header and body `{ "confirm": true }`; otherwise return 400. Map `provider_history_prefix_changed` to 409 and Runner failures to 502 without writing a success-shaped cursor.

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm vitest run apps/bridge/src/session-history-import.test.ts apps/bridge/src/session-api.test.ts
```

Expected: PASS; pure GET test observes zero database changes.

- [ ] **Step 8: Commit**

```bash
git add packages/work-items/src/session-runtime.ts apps/bridge/src/session-history-import.ts apps/bridge/src/session-history-import.test.ts apps/bridge/src/session-api.ts apps/bridge/src/session-api.test.ts
git commit -m "feat: import provider history explicitly"
```

### Task 11: Add bounded Session snapshot and read APIs

**Files:**
- Create: `apps/bridge/src/session-runtime-api.ts`
- Create: `apps/bridge/src/session-runtime-api.test.ts`
- Create: `apps/bridge/src/session-runtime-types.ts`
- Modify: `apps/bridge/src/session-api.ts:561-625,932-979`
- Modify: `apps/bridge/package.json`

- [ ] **Step 1: Add the Coordinator dependency**

Add to `apps/bridge/package.json`:

```json
"@codebridge/session-coordinator": "workspace:*"
```

- [ ] **Step 2: Write failing snapshot and bound tests**

Create `session-runtime-api.test.ts`:

```ts
describe("Session runtime read API", () => {
  it("returns one internally consistent snapshot", async () => {
    const { app, session, first, second } = setupSessionWithQueue();
    const response = await app.request(`/v1/sessions/${session.id}`, authorized());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      session: { session_id: session.id },
      runtime: {
        active_run: { run_id: first.run.id },
        queue_state: "ready",
        queue: {
          turns: [{ turn_id: second.turn.id }],
          total: 1,
          next_cursor: null,
        },
        last_event_sequence: expect.any(Number),
      },
      timeline: { turns: expect.any(Array) },
    });
  });

  it("limits event catch-up to five hundred rows", async () => {
    const { app, session, workItem } = setupSessionWithEvents(650);
    const response = await app.request(
      `/v1/sessions/${session.id}/events?after_sequence=0&limit=9999`,
      authorized(),
    );
    const body = await response.json();
    expect(body.events).toHaveLength(500);
    expect(body.next_sequence).toBe(body.events.at(-1).sequence);
    expect(body.has_more).toBe(true);
  });

  it("pages timeline by server Turn cursor and one MiB budget", async () => {
    const { app, session } = setupLargeTimeline();
    const response = await app.request(
      `/v1/sessions/${session.id}/timeline?limit=50`,
      authorized(),
    );
    const body = await response.json();
    expect(body.turns.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(body.turns), "utf8")).toBeLessThan(1_100_000);
    expect(body).toHaveProperty("previous_cursor");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-api.test.ts
```

Expected: FAIL because GET returns only metadata and events are unbounded.

- [ ] **Step 4: Define the composite snapshot**

Create `apps/bridge/src/session-runtime-types.ts`. Move the existing `toApiSession` and `toApiRun` converters from `session-api.ts` into this file and export their explicit return types. Add:

```ts
export interface ApiSession {
  schema_version: number;
  session_id: string;
  agent_id: string;
  provider_session_id: string | null;
  task_record_id: string | null;
  flow_id: string | null;
  model: string | null;
  effort: string | null;
  config_overrides: Record<string, string | boolean>;
  permission_mode: string | null;
  folder_id: string | null;
  cwd: string | null;
  additional_directories: string[];
  title: string | null;
  status: string;
  pinned_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiRun {
  schema_version: number;
  run_id: string;
  session_id: string;
  work_item_id: string;
  turn_id: string | null;
  agent_id: string | null;
  plan_id: string | null;
  workflow_revision: string | null;
  mode: string;
  status: string;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiSessionTurn {
  turn_id: string;
  queue_position: number;
  status: "queued" | "dispatched" | "cancelled";
  version: number;
  message: { text: string; attachment_ids: string[] };
  created_at: string;
}

export interface ApiTimelineSegment {
  segment_id: string;
  segment_index: number;
  content: string;
  byte_length: number;
  sealed: boolean;
}

export interface ApiTimelineBlock {
  block_id: string;
  block_index: number;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  segments: ApiTimelineSegment[];
  next_segment_cursor: number | null;
}

export interface ApiTimelineTurn {
  timeline_index: number;
  turn_id: string;
  run_id: string;
  status: string;
  blocks: ApiTimelineBlock[];
}

export interface ApiAgentCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface SessionSnapshotResponse {
  session: ApiSession;
  runtime: {
    active_run: ApiRun | null;
    queue_state: "ready" | "paused";
    queue_pause_reason: "failed" | "cancelled" | "interrupted" | null;
    queue: {
      turns: ApiSessionTurn[];
      total: number;
      next_cursor: number | null;
    };
    version: number;
    last_event_sequence: number;
  };
  timeline: {
    turns: ApiTimelineTurn[];
    previous_cursor: number | null;
    truncated_block_ids: string[];
  };
  commands: ApiAgentCommand[];
}
```

Convert storage camelCase to the existing API snake_case style at this boundary only.

- [ ] **Step 5: Implement read-only route handlers**

Create `session-runtime-api.ts` with a route registrar:

```ts
export function registerSessionRuntimeReadRoutes(
  app: Hono,
  options: SessionRuntimeApiOptions,
): void {
  app.get("/v1/sessions/:session_id", (c) => {
    const session = options.catalog.getSession(c.req.param("session_id"));
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const runtime = options.workItems.getSessionRuntime(session.id);
    const activeRun = runtime?.activeRunId
      ? options.workItems.getRun(runtime.activeRunId)
      : undefined;
    const queue = options.workItems.listQueuedTurns(session.id, { limit: 100 });
    const timeline = options.workItems.listTimelineTurns(session.id, {
      limit: 50,
      contentBudgetBytes: 1_048_576,
    });
    const commands = options.workItems.listSessionCommands(session.id);
    return c.json({
      session: toApiSession(session),
      runtime: {
        active_run: activeRun ? toApiRun(activeRun, session.id) : null,
        queue_state: runtime?.queueState ?? "ready",
        queue_pause_reason: runtime?.queuePauseReason ?? null,
        queue: {
          turns: queue.turns.map(toApiSessionTurn),
          total: queue.total,
          next_cursor: queue.nextCursor,
        },
        version: runtime?.version ?? 1,
        last_event_sequence: runtime?.lastEventSequence ?? 0,
      },
      timeline: toApiTimeline(timeline),
      commands,
    } satisfies SessionSnapshotResponse);
  });
}
```

Define `SessionRuntimeApiOptions` in the same file:

```ts
export interface SessionRuntimeApiOptions {
  catalog: SessionCatalogStore;
  workItems: SqliteEventStore;
  coordinator: SessionCoordinator;
  executor?: RunExecutor;
  flows?: FlowCatalogStore;
  capabilities?: CapabilityRegistry;
  discovery?: ProjectDiscovery;
}
```

Also register:

```text
GET /v1/sessions/:session_id/timeline?before=<timeline_index>&limit=<1..50>
GET /v1/sessions/:session_id/blocks/:block_id/segments?after=<segment_index>&limit=<1..100>
GET /v1/sessions/:session_id/queue
GET /v1/sessions/:session_id/commands
GET /v1/sessions/:session_id/events?after_sequence=<n>&limit=<1..500>
GET /v1/sessions/:session_id/events?live=true&after_sequence=<n>
```

`GET /queue` accepts `after_position` and `limit` clamped to 100, and returns `{ turns, total, next_cursor }`. Snapshot embeds the first page only.

For SSE:

- Query at most 500 committed events and 1 MiB of serialized payload per iteration.
- Write in ascending sequence order.
- Advance cursor only after `writeSSE` resolves.
- Sleep 250 ms only when no rows were returned.
- Abort immediately on `stream.onAbort`.
- Never load the complete event history.

Replace the existing reverse-scan command handler with `listSessionCommands`.

- [ ] **Step 6: Add Session lookup fallback**

If a catalog Session has no `taskRecordId` but `getWorkItemBySessionId(session.id)` exists, use that binding in the response without mutating the catalog. This handles a crash after the SQLite transaction but before compatibility metadata update.

- [ ] **Step 7: Run read API tests**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/session-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/bridge/package.json apps/bridge/src/session-runtime-types.ts apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/session-api.ts
git commit -m "feat: expose bounded session snapshots"
```

### Task 12: Replace split message/Run APIs with atomic commands

**Files:**
- Modify: `apps/bridge/src/session-runtime-api.ts`
- Modify: `apps/bridge/src/session-runtime-api.test.ts`
- Modify: `apps/bridge/src/session-api.ts:680-885`
- Modify: `packages/session-coordinator/src/coordinator.ts`
- Modify: `packages/work-items/src/session-runtime.ts`

- [ ] **Step 1: Write failing command API tests**

Add:

```ts
it("atomically accepts a message and returns its dispatch disposition", async () => {
  const { app, session, workItems } = setupEmptySession();
  const response = await app.request(`/v1/sessions/${session.id}/messages`, authorized({
    method: "POST",
    headers: { "Idempotency-Key": "message_1" },
    body: JSON.stringify({ message: "检查项目", attachments: [] }),
  }));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    acceptance: "dispatched",
    turn: { status: "dispatched" },
    runtime: { active_run: { status: "queued" } },
  });
  expect(workItems.getSessionRuntime(session.id)?.activeRunId).toBeTruthy();
});

it("returns the same accepted response after an ambiguous client retry", async () => {
  const input = authorized({
    method: "POST",
    headers: { "Idempotency-Key": "message_1" },
    body: JSON.stringify({ message: "检查项目" }),
  });
  const first = await app.request(`/v1/sessions/${session.id}/messages`, input);
  const second = await app.request(`/v1/sessions/${session.id}/messages`, input);
  expect(await second.json()).toEqual(await first.json());
  expect(workItems.listRuns(workItem.id)).toHaveLength(1);
});

it("cancels a queued Turn with If-Match", async () => {
  const response = await app.request(
    `/v1/sessions/${session.id}/queue/${queued.turnId}`,
    authorized({
      method: "DELETE",
      headers: {
        "Idempotency-Key": "cancel_1",
        "If-Match": String(queued.version),
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ turn: { status: "cancelled" } });
});

it("reports interrupting for an active running Run", async () => {
  const response = await app.request(
    `/v1/runs/${run.id}/cancel`,
    authorized({
      method: "POST",
      headers: {
        "Idempotency-Key": "stop_1",
        "If-Match": String(workItems.getSessionRuntime(session.id)!.version),
      },
    }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ disposition: "interrupting" });
});

it("looks up submission acceptance without mutating state", async () => {
  await submitMessage("message_1");
  const before = workItems.countAllChanges();
  const response = await app.request(
    `/v1/sessions/${session.id}/submissions/message_1`,
    authorized(),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).acceptance).toBe("dispatched");
  expect(workItems.countAllChanges()).toBe(before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-api.test.ts
```

Expected: FAIL because the old message and Run routes are split.

- [ ] **Step 3: Make attachments part of atomic submission**

Extend `SubmitTurnInput`:

```ts
attachments?: Array<{
  id: string;
  name: string;
  mimeType: string;
  dataBase64: string;
}>;
```

Extend `SessionRuntimeTransaction`:

```ts
insertMessageAttachment(input: {
  id: string;
  workItemId: string;
  name: string;
  mimeType: string;
  dataBase64: string;
}): MessageAttachment;
```

Inside `submitTurn`, after `getOrCreateWorkItem`, insert attachments and create the persisted message:

```ts
const attachments = (input.attachments ?? []).map((attachment) =>
  tx.insertMessageAttachment({ ...attachment, workItemId }),
);
const persistedMessage = {
  ...input.message,
  attachmentIds: attachments.map((attachment) => attachment.id),
};
```

The Turn, attachment rows, events, Run, projection, and idempotency response now commit or roll back together.

- [ ] **Step 4: Move Flow compilation before the transaction**

In the Bridge handler:

1. Resolve effective Flow/model/effort/permission values.
2. Validate Flow existence and deprecation.
3. Compile and hash Plan IR using existing `compileWorkflow`.
4. Validate and decode attachment metadata without persisting it.
5. Generate attachment IDs.
6. Call `coordinator.submitTurn` with the frozen Plan and attachment payload.

No Runner or network call occurs between opening and committing the transaction.

- [ ] **Step 5: Register command routes**

Implement:

```text
POST   /v1/sessions/:session_id/messages
GET    /v1/sessions/:session_id/submissions/:idempotency_key
DELETE /v1/sessions/:session_id/queue/:turn_id
POST   /v1/sessions/:session_id/queue/resume
POST   /v1/runs/:run_id/cancel
```

Requirements:

- Mutation routes require `Idempotency-Key`; missing header returns 400.
- Queue cancel requires integer `If-Match`; missing/invalid returns 428.
- Queue resume requires runtime `If-Match`.
- Run cancel requires runtime `If-Match`; load the Run to resolve its Session and return the latest authoritative terminal Run when it is already terminal.
- Map `SessionCommandError.status` and `.code` exactly.
- For `turn_version_conflict`, include the latest Turn; for `runtime_version_conflict`, include the latest Runtime snapshot in the 409 body.
- After a dispatched submit/resume, call `executor.execute(run.id)` fire-and-observe: attach `.catch` that records a non-terminal diagnostic event but does not synthesize success.
- Update Session Catalog compatibility fields only after Coordinator commit.
- The submission lookup reads `session:message:{session_id}` and returns 404 if no response exists.

- [ ] **Step 6: Remove the split route**

Delete the old `/messages`, `/cancel`, and `/runs` POST implementations from `session-api.ts`. Keep `GET /runs` for diagnostics. For one release, register:

```ts
app.post("/v1/sessions/:session_id/runs", (c) =>
  c.json({
    error: "run_creation_moved",
    message: "POST /messages now creates or queues the Run atomically",
  }, 410),
);
```

- [ ] **Step 7: Run command API and Coordinator tests**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-api.test.ts packages/session-coordinator/src/coordinator.test.ts apps/bridge/src/session-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/bridge/src/session-runtime-api.ts apps/bridge/src/session-runtime-api.test.ts apps/bridge/src/session-api.ts packages/session-coordinator/src/coordinator.ts packages/work-items/src/session-runtime.ts
git commit -m "feat: make session commands atomic"
```

### Task 13: Add Web Session contracts, API client, and external Store

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Create: `apps/web/src/lib/session-store.ts`
- Create: `apps/web/src/lib/session-store.test.ts`
- Create: `apps/web/src/lib/session-connection.ts`
- Create: `apps/web/src/lib/session-connection.test.ts`

- [ ] **Step 1: Define Web response types**

Add:

```ts
export type SessionRunStatus =
  | "queued" | "running" | "waiting"
  | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface SessionRuntimeView {
  active_run: RunRecord | null;
  queue_state: "ready" | "paused";
  queue_pause_reason: "failed" | "cancelled" | "interrupted" | null;
  queue: {
    turns: SessionTurnView[];
    total: number;
    next_cursor: number | null;
  };
  version: number;
  last_event_sequence: number;
}

export interface SessionTurnView {
  turn_id: string;
  queue_position: number;
  status: "queued" | "dispatched" | "cancelled";
  version: number;
  message: {
    text: string;
    attachment_ids: string[];
  };
  created_at: string;
}

export interface TimelineSegmentView {
  segment_id: string;
  segment_index: number;
  content: string;
  byte_length: number;
  sealed: boolean;
}

export interface TimelineBlockView {
  block_id: string;
  block_index: number;
  kind: "user_message" | "assistant" | "thought" | "work" | "tool" | "approval" | "error";
  status: string;
  metadata: Record<string, unknown>;
  segments: TimelineSegmentView[];
  next_segment_cursor: number | null;
}

export interface TimelineTurnView {
  timeline_index: number;
  turn_id: string;
  run_id: string;
  status: SessionRunStatus;
  blocks: TimelineBlockView[];
}

export interface SessionSnapshot {
  session: AgentSession;
  runtime: SessionRuntimeView;
  timeline: {
    turns: TimelineTurnView[];
    previous_cursor: number | null;
    truncated_block_ids: string[];
  };
  commands: AgentCommand[];
}

export interface SubmitTurnReceipt {
  acceptance: "queued" | "dispatched";
  turn: SessionTurnView;
  runtime: SessionRuntimeView;
}

export interface SendMessageInput {
  message: string;
  flowId: string | null;
  model: string | null;
  attachments: MessageAttachmentInput[];
  permissionMode: string | null;
  effort: string | null;
  idempotencyKey: string;
}
```

- [ ] **Step 2: Write failing API tests**

Add to `api.test.ts`:

```ts
it("opens one composite snapshot instead of a 2,000-event tail", async () => {
  fetchMock.mockResolvedValue(json(snapshot));
  await api.openSession("sess_1");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/sessions/sess_1");
});

it("sends the caller idempotency key with a message", async () => {
  fetchMock.mockResolvedValue(json(receipt, 202));
  await api.sendMessage("sess_1", {
    message: "检查项目",
    flowId: null,
    model: null,
    attachments: [],
    permissionMode: null,
    effort: null,
    idempotencyKey: "message_1",
  });
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    headers: expect.objectContaining({ "Idempotency-Key": "message_1" }),
  });
});

it("uses POST for Provider Session discovery", async () => {
  fetchMock.mockResolvedValue(json({ sessions: [] }));
  await api.importSessions({ cwd: "/workspace" });
  expect(fetchMock.mock.calls[0]?.slice(0, 2)).toEqual([
    "/v1/sessions/import",
    expect.objectContaining({ method: "POST" }),
  ]);
});
```

- [ ] **Step 3: Run API tests to verify they fail**

Run:

```bash
pnpm vitest run apps/web/src/lib/api.test.ts
```

Expected: FAIL because `openSession` performs five requests and message keys are generated nowhere.

- [ ] **Step 4: Make request errors distinguishable**

Replace generic HTTP errors with:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
```

In `request`, throw `new ApiError(response.status, payload?.error ?? "http_error", message)`. Do not wrap native `TypeError`; callers use that to distinguish unknown network acceptance from an explicit rejection.

- [ ] **Step 5: Replace legacy Session API methods**

Implement:

```ts
openSession: (id: string) =>
  request<SessionSnapshot>(`/v1/sessions/${encodeURIComponent(id)}`),

importSessions: (input: { cwd: string; agentId?: string }) =>
  request<{ sessions: AgentSession[]; provider_errors: unknown[] }>("/v1/sessions/import", {
    method: "POST",
    body: JSON.stringify({ cwd: input.cwd, agent_id: input.agentId }),
  }),

sendMessage: (id: string, input: SendMessageInput) =>
  request<SubmitTurnReceipt>(`/v1/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      message: input.message,
      flow_id: input.flowId,
      model: input.model,
      permission_mode: input.permissionMode,
      effort: input.effort,
      attachments: input.attachments,
    }),
  }),

submission: (id: string, key: string) =>
  request<SubmitTurnReceipt>(
    `/v1/sessions/${encodeURIComponent(id)}/submissions/${encodeURIComponent(key)}`,
  ),

cancelQueuedTurn: (sessionId: string, turnId: string, version: number, key: string) =>
  request<{ turn: SessionTurnView; runtime: SessionRuntimeView }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(turnId)}`,
    {
      method: "DELETE",
      headers: { "Idempotency-Key": key, "If-Match": String(version) },
    },
  ),

queue: (sessionId: string, afterPosition: number | null) => {
  const params = new URLSearchParams({ limit: "100" });
  if (afterPosition !== null) params.set("after_position", String(afterPosition));
  return request<SessionRuntimeView["queue"]>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/queue?${params}`,
  );
},

resumeQueue: (sessionId: string, version: number, key: string) =>
  request<{ runtime: SessionRuntimeView }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/queue/resume`,
    {
      method: "POST",
      headers: { "Idempotency-Key": key, "If-Match": String(version) },
    },
  ),

cancelRun: (runId: string, runtimeVersion: number, key: string) =>
  request<{ disposition: "cancelled" | "interrupting" | "already_terminal"; run: RunRecord }>(
    `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { "Idempotency-Key": key, "If-Match": String(runtimeVersion) },
    },
  ),
```

Delete `startRun` and the old Session-wide `/cancel` client.
Replace finite `events()` with a JSON client returning `{ events, next_sequence, has_more }`; only `streamSessionEvents()` parses SSE.

- [ ] **Step 6: Write failing Store tests**

Create `session-store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "./session-store.js";

describe("SessionViewStore", () => {
  it("keeps cached Session windows isolated", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.hydrate(snapshot("sess_2", 20));
    store.receive("sess_1", event(11, "AGENT_EVENT"));
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(11);
    expect(store.get("sess_2")?.snapshot.runtime.last_event_sequence).toBe(20);
  });

  it("ignores duplicates and detects Sequence gaps", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    expect(store.receive("sess_1", event(10, "AGENT_EVENT"))).toBe("duplicate");
    expect(store.receive("sess_1", event(12, "AGENT_EVENT"))).toBe("gap");
    expect(store.get("sess_1")?.status).toBe("recovering");
  });

  it("does not overwrite a newer cache with an older snapshot", () => {
    const store = new SessionViewStore({ schedule: (flush) => flush() });
    store.hydrate(snapshot("sess_1", 10));
    store.receive("sess_1", deltaEvent(11, "new"));
    store.hydrate(snapshot("sess_1", 10));
    expect(store.get("sess_1")?.snapshot.runtime.last_event_sequence).toBe(11);
    expect(activeTail(store.get("sess_1")!)).toBe("new");
  });

  it("batches subscribers while applying only the active tail", () => {
    const scheduled: Array<() => void> = [];
    const store = new SessionViewStore({ schedule: (flush) => scheduled.push(flush) });
    store.hydrate(snapshot("sess_1", 10));
    const listener = vi.fn();
    store.subscribe("sess_1", listener);
    store.receive("sess_1", deltaEvent(11, "a"));
    store.receive("sess_1", deltaEvent(12, "b"));
    expect(listener).not.toHaveBeenCalled();
    scheduled.shift()?.();
    expect(listener).toHaveBeenCalledOnce();
    expect(activeTail(store.get("sess_1")!)).toBe("ab");
  });
});
```

- [ ] **Step 7: Implement the external Store**

Create `session-store.ts` with:

```ts
export type ReceiveDisposition = "applied" | "duplicate" | "gap" | "refresh_required";
export interface SessionView {
  snapshot: SessionSnapshot;
  status: "ready" | "recovering";
}

export class SessionViewStore {
  private readonly entries = new Map<string, SessionView>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pendingNotifications = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly options: {
    schedule?: (flush: () => void) => void;
  } = {}) {}

  get(sessionId: string): SessionView | undefined {
    return this.entries.get(sessionId);
  }

  hydrate(snapshot: SessionSnapshot): void {
    const current = this.entries.get(snapshot.session.session_id);
    if (current && current.snapshot.runtime.last_event_sequence > snapshot.runtime.last_event_sequence) {
      return;
    }
    this.entries.set(snapshot.session.session_id, { snapshot, status: "ready" });
    this.notify(snapshot.session.session_id);
  }

  receive(sessionId: string, event: SessionEvent): ReceiveDisposition {
    const current = this.entries.get(sessionId);
    if (!current) return "refresh_required";
    if (event.sequence <= current.snapshot.runtime.last_event_sequence) return "duplicate";
    if (current.status === "recovering") return "gap";
    if (event.sequence !== current.snapshot.runtime.last_event_sequence + 1) {
      this.entries.set(sessionId, { ...current, status: "recovering" });
      this.notify(sessionId);
      return "gap";
    }
    const next = applyCommittedEvent(current.snapshot, event);
    this.entries.set(sessionId, {
      snapshot: {
        ...next.snapshot,
        runtime: {
          ...next.snapshot.runtime,
          last_event_sequence: event.sequence,
        },
      },
      status: next.refreshRequired ? "recovering" : "ready",
    });
    this.notify(sessionId);
    return next.refreshRequired ? "refresh_required" : "applied";
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  private notify(sessionId: string): void {
    this.pendingNotifications.add(sessionId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (this.options.schedule ?? requestAnimationFrame)(() => {
      this.flushScheduled = false;
      for (const id of this.pendingNotifications) {
        this.listeners.get(id)?.forEach((listener) => listener());
      }
      this.pendingNotifications.clear();
    });
  }
}
```

`applyCommittedEvent` appends only aggregated `text_delta`/`thought_delta` content to the matching active Block tail. It uses `new TextEncoder().encode(content).byteLength` and a code-point-safe splitter to create a new Segment before 16 KiB; browser code must not depend on Node `Buffer`. All control events return `refreshRequired: true`; the connection coalesces them into one snapshot refresh. It never calls `reduceConversationEvents`.

Export:

```ts
export const sessionViewStore = new SessionViewStore();
export function useSessionView(sessionId: string | null): SessionView | undefined {
  return useSyncExternalStore(
    (listener) => sessionId ? sessionViewStore.subscribe(sessionId, listener) : () => {},
    () => sessionId ? sessionViewStore.get(sessionId) : undefined,
  );
}
```

- [ ] **Step 8: Implement snapshot/SSE connection recovery**

Create `session-connection.ts`:

```ts
export class SessionConnection {
  private abort: AbortController | null = null;
  private readonly refreshPromises = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: {
    store: SessionViewStore;
    openSession: typeof api.openSession;
    stream: typeof streamSessionEvents;
  }) {}

  async open(sessionId: string): Promise<void> {
    this.close();
    const controller = new AbortController();
    this.abort = controller;
    await this.refresh(sessionId);
    while (!controller.signal.aborted) {
      const after = this.dependencies.store.get(sessionId)!.snapshot.runtime.last_event_sequence;
      try {
        await this.dependencies.stream(sessionId, after, controller.signal, (event) => {
          const disposition = this.dependencies.store.receive(sessionId, event);
          if (disposition === "gap" || disposition === "refresh_required") {
            void this.refresh(sessionId);
          }
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        await this.refresh(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
  }

  refresh(sessionId: string): Promise<void> {
    const existing = this.refreshPromises.get(sessionId);
    if (existing) return existing;
    const refresh = this.dependencies.openSession(sessionId)
      .then((snapshot) => this.dependencies.store.hydrate(snapshot))
      .finally(() => { this.refreshPromises.delete(sessionId); });
    this.refreshPromises.set(sessionId, refresh);
    return refresh;
  }
}
```

In `session-connection.test.ts`, inject a stream that emits sequence `snapshot.runtime.last_event_sequence + 1` between snapshot resolution and stream registration, and assert it is applied once. Also emit a gap and assert `openSession` is called again.

- [ ] **Step 9: Run Web data tests**

Run:

```bash
pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/lib/session-store.test.ts apps/web/src/lib/session-connection.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/session-store.ts apps/web/src/lib/session-store.test.ts apps/web/src/lib/session-connection.ts apps/web/src/lib/session-connection.test.ts
git commit -m "feat: add authoritative web session store"
```

### Task 14: Render paged Session timelines

**Files:**
- Create: `apps/web/src/components/session-timeline.tsx`
- Create: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/conversation.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/session-store.ts`

- [ ] **Step 1: Write failing rendering-window tests**

Create `session-timeline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
const markdownRender = vi.hoisted(() => vi.fn());
vi.mock("@/components/conversation", () => ({
  Markdown: ({ content }: { content: string }) => {
    markdownRender(content);
    return <div>{content}</div>;
  },
}));
import { SessionTimeline, TimelineSegment } from "./session-timeline.js";

it("mounts only the server-provided Turn window", () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(
    <SessionTimeline
      hasEarlier
      loadingBlockId={null}
      loadingEarlier={false}
      onLoadEarlier={vi.fn()}
      onLoadSegments={vi.fn()}
      turns={timelineTurns(50)}
    />,
  ));
  expect(document.querySelectorAll("[data-timeline-turn]")).toHaveLength(50);
  expect(document.querySelector("[data-load-earlier]")).not.toBeNull();
  root.unmount();
});

it("does not rerender an unchanged completed Segment", () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(
    <TimelineSegment segment={sealedSegment("stable", "完成内容")} />,
  ));
  act(() => root.render(
    <TimelineSegment segment={sealedSegment("stable", "完成内容")} />,
  ));
  expect(markdownRender).toHaveBeenCalledTimes(1);
  root.unmount();
});

it("parses at most one sixteen-KiB active tail", () => {
  const segment = {
    ...sealedSegment("active", "x".repeat(16_384)),
    sealed: false,
  };
  expect(new TextEncoder().encode(segment.content).byteLength).toBe(16_384);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<TimelineSegment segment={segment} />));
  expect(document.querySelector("[data-active-segment]")?.textContent).toHaveLength(16_384);
  root.unmount();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/web/src/components/session-timeline.test.tsx
```

Expected: FAIL because the timeline components do not exist.

- [ ] **Step 3: Export the existing Markdown renderer**

Change:

```ts
const Markdown = memo(function Markdown(...)
```

to:

```ts
export const Markdown = memo(function Markdown(...)
```

Do not change its plugins, styling, or syntax highlighting in this task.

- [ ] **Step 4: Implement the paged renderer**

Create `session-timeline.tsx`:

```tsx
import { memo } from "react";
import { LoaderCircle } from "lucide-react";
import { Markdown } from "@/components/conversation";
import { Button } from "@/components/ui/button";
import type { TimelineBlockView, TimelineSegmentView, TimelineTurnView } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SessionTimeline(props: {
  turns: TimelineTurnView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  loadingBlockId: string | null;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  return <div className="grid gap-6">
    {props.hasEarlier && <Button
      className="mx-auto"
      data-load-earlier
      disabled={props.loadingEarlier}
      onClick={props.onLoadEarlier}
      size="sm"
      variant="ghost"
    >{props.loadingEarlier ? "正在加载…" : "加载更早对话"}</Button>}
    {props.turns.map((turn) => <article
      className="grid gap-4"
      data-timeline-turn={turn.turn_id}
      key={turn.turn_id}
    >{turn.blocks.map((block) => <TimelineBlock
      block={block}
      key={block.block_id}
      loading={props.loadingBlockId === block.block_id}
      onLoadSegments={props.onLoadSegments}
    />)}</article>)}
  </div>;
}

const TimelineBlock = memo(function TimelineBlock(props: {
  block: TimelineBlockView;
  loading: boolean;
  onLoadSegments: (blockId: string, after: number) => void;
}) {
  const { block } = props;
  const more = block.next_segment_cursor !== null && <Button
    disabled={props.loading}
    onClick={() => props.onLoadSegments(block.block_id, block.next_segment_cursor!)}
    size="sm"
    variant="ghost"
  >{props.loading ? "正在加载…" : "加载更多输出"}</Button>;
  if (block.kind === "user_message") {
    return <div className="grid justify-items-end gap-2">
      <span className="font-brand text-xs uppercase tracking-[0.1em] text-muted">你</span>
      <div className="max-w-[72%] whitespace-pre-wrap rounded-xl bg-accent-soft px-3.5 py-3 text-sm leading-6 text-ink">
        {block.segments.map((segment) => segment.content).join("")}
      </div>{more}
    </div>;
  }
  if (block.kind === "assistant") {
    return <div className="grid max-w-[780px] gap-2">
      <span className="text-xs font-medium tracking-[0.08em] text-muted">Agent</span>
      {block.segments.map((segment) => <TimelineSegment key={segment.segment_id} segment={segment} />)}{more}
    </div>;
  }
  return <details open={block.status === "running" || undefined} className="max-w-[780px] border-t border-line">
    <summary className="flex cursor-pointer items-center gap-2 py-3 text-xs text-muted">
      {block.status === "running" && <LoaderCircle className="size-3.5 animate-spin" />}
      <span>{blockLabel(block.kind, block.status)}</span>
    </summary>
    <div className={cn("grid gap-2 pb-4 text-xs leading-5", block.kind === "error" ? "text-danger" : "text-ink-soft")}>
      {block.segments.map((segment) => <TimelineSegment key={segment.segment_id} segment={segment} />)}
    </div>{more}
  </details>;
});

export const TimelineSegment = memo(
  function TimelineSegment({ segment }: { segment: TimelineSegmentView }) {
    return <div data-active-segment={segment.sealed ? undefined : true}>
      <Markdown content={segment.content} />
    </div>;
  },
  (previous, next) =>
    previous.segment.segment_id === next.segment.segment_id
    && previous.segment.content === next.segment.content
    && previous.segment.sealed === next.segment.sealed,
);
```

Implement `blockLabel` as an exhaustive switch for all `TimelineBlockView["kind"]` values.

- [ ] **Step 5: Add timeline paging**

Add:

```ts
timeline: (sessionId: string, before: number | null) => {
  const params = new URLSearchParams({ limit: "50" });
  if (before !== null) params.set("before", String(before));
  return request<SessionSnapshot["timeline"]>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`,
  );
},

segments: (sessionId: string, blockId: string, after: number) =>
  request<{ segments: TimelineSegmentView[]; next_cursor: number | null }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/blocks/${encodeURIComponent(blockId)}/segments?after=${after}&limit=100`,
  ),
```

Add `prependTimelinePage(sessionId, page)` to `SessionViewStore`. It deduplicates by `turn_id`, preserves ascending timeline order, and keeps only the user-mounted window; it does not fetch automatically.
Add `appendBlockSegments(sessionId, blockId, page)`; it deduplicates by `segment_id`, orders by `segment_index`, and updates only that Block’s `next_segment_cursor`.

- [ ] **Step 6: Run component and Store tests**

Run:

```bash
pnpm vitest run apps/web/src/components/session-timeline.test.tsx apps/web/src/lib/session-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/conversation.tsx apps/web/src/lib/api.ts apps/web/src/lib/session-store.ts
git commit -m "feat: render bounded session timelines"
```

### Task 15: Wire queue, authoritative Stop, and safe submission into Workbench

**Files:**
- Create: `apps/web/src/components/session-queue.tsx`
- Create: `apps/web/src/components/session-queue.test.tsx`
- Create: `apps/web/src/lib/submit-session-message.ts`
- Create: `apps/web/src/lib/submit-session-message.test.ts`
- Modify: `apps/web/src/components/workbench.tsx:1-120,150-270,330-430,600-760`
- Modify: `apps/web/src/components/composer.tsx`

- [ ] **Step 1: Write failing submission-recovery tests**

Create `submit-session-message.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import { submitSessionMessage } from "./submit-session-message.js";

it("retries an ambiguous network failure with the same key", async () => {
  const send = vi.fn()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(receipt("dispatched"));
  const result = await submitSessionMessage({
    send,
    lookup: vi.fn(),
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    input: messageInput(),
  });
  expect(send).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ idempotencyKey: "message_1" }));
  expect(send).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ idempotencyKey: "message_1" }));
  expect(result.kind).toBe("accepted");
});

it("returns rejected only for an explicit HTTP rejection", async () => {
  const result = await submitSessionMessage({
    send: vi.fn().mockRejectedValue(new ApiError(422, "queue_full", "queue_full")),
    lookup: vi.fn(),
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    input: messageInput(),
  });
  expect(result).toMatchObject({ kind: "rejected", error: { code: "queue_full" } });
});

it("preserves the key when acceptance remains unknown", async () => {
  const result = await submitSessionMessage({
    send: vi.fn().mockRejectedValue(new TypeError("network")),
    lookup: vi.fn().mockRejectedValue(new TypeError("network")),
    sessionId: "sess_1",
    idempotencyKey: "message_1",
    input: messageInput(),
  });
  expect(result).toEqual({ kind: "unknown", idempotencyKey: "message_1" });
});
```

- [ ] **Step 2: Implement submission recovery**

Create `submit-session-message.ts`:

```ts
import { ApiError } from "./api.js";
import type { SubmitTurnReceipt } from "./types.js";

export async function submitSessionMessage(input: {
  send: typeof api.sendMessage;
  lookup: typeof api.submission;
  sessionId: string;
  idempotencyKey: string;
  input: Omit<SendMessageInput, "idempotencyKey">;
}): Promise<
  | { kind: "accepted"; receipt: SubmitTurnReceipt }
  | { kind: "rejected"; error: ApiError }
  | { kind: "unknown"; idempotencyKey: string }
> {
  const request = { ...input.input, idempotencyKey: input.idempotencyKey };
  try {
    return { kind: "accepted", receipt: await input.send(input.sessionId, request) };
  } catch (error) {
    if (error instanceof ApiError) return { kind: "rejected", error };
  }
  try {
    return { kind: "accepted", receipt: await input.send(input.sessionId, request) };
  } catch (error) {
    if (error instanceof ApiError && error.status !== 404) return { kind: "rejected", error };
  }
  try {
    return { kind: "accepted", receipt: await input.lookup(input.sessionId, input.idempotencyKey) };
  } catch {
    return { kind: "unknown", idempotencyKey: input.idempotencyKey };
  }
}
```

- [ ] **Step 3: Write and implement Queue Panel**

Create `session-queue.test.tsx` with jsdom. Render two Turns, click the first cancel button, and assert `onCancel(first.turn_id, first.version)`; render paused runtime and assert a Resume button calls `onResume(runtime.version)`.

Create `session-queue.tsx`:

```tsx
export function SessionQueue(props: {
  turns: SessionTurnView[];
  runtime: SessionRuntimeView;
  cancellingTurnId: string | null;
  onCancel: (turnId: string, version: number) => void;
  onResume: (version: number) => void;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!props.turns.length && props.runtime.queue_state === "ready") return null;
  return <section aria-label="下一轮队列" className="rounded-lg border border-line bg-surface">
    <header className="flex items-center justify-between border-b border-line px-3 py-2">
      <span className="text-xs font-semibold text-ink">下一轮队列 · {props.turns.length}</span>
      {props.runtime.queue_state === "paused" && <Button
        onClick={() => props.onResume(props.runtime.version)}
        size="sm"
      >继续队列</Button>}
    </header>
    <ol className="divide-y divide-line">
      {props.turns.map((turn, index) => <li className="flex items-center gap-3 px-3 py-2.5" key={turn.turn_id}>
        <span className="font-mono text-xs text-faint">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{turn.message.text}</span>
        <Button
          aria-label={`取消排队消息 ${index + 1}`}
          disabled={props.cancellingTurnId === turn.turn_id}
          onClick={() => props.onCancel(turn.turn_id, turn.version)}
          size="sm"
          variant="ghost"
        >取消</Button>
      </li>)}
    </ol>
    {props.runtime.queue.next_cursor !== null && <Button
      className="w-full"
      data-load-more-queue
      disabled={props.loadingMore}
      onClick={props.onLoadMore}
      size="sm"
      variant="ghost"
    >{props.loadingMore ? "正在加载…" : "加载更多排队消息"}</Button>}
  </section>;
}
```

- [ ] **Step 4: Replace Workbench’s local event authority**

In `workbench.tsx`:

- Delete `events`, `pendingEvents`, `sessionCache`, `projection`, and projection-derived `sessionRunning`.
- Create one `SessionConnection` in a ref.
- Read `const sessionView = useSessionView(selectedSessionId)`.
- On Session selection, call `connection.open(sessionId)` and close it in effect cleanup.
- Paint a cached `sessionView` immediately; show `LoadingConversation` only when no cached view exists.
- Continue fetching config options separately because those are Provider capabilities, not Session history.
- Derive:

```ts
const activeRun = sessionView?.snapshot.runtime.active_run ?? null;
const sessionRunning = Boolean(
  activeRun && ["queued", "running", "waiting"].includes(activeRun.status),
);
```

- Render `SessionTimeline` from `sessionView.snapshot.timeline`.
- Load older pages only from the “加载更早对话” action.
- Wire Block “加载更多输出” to `api.segments` and `sessionViewStore.appendBlockSegments`; track one `loadingBlockId` so repeated clicks cannot overlap.

- [ ] **Step 5: Wire atomic submit without timeline optimism**

Use:

```ts
const [pendingSubmission, setPendingSubmission] = useState<{
  idempotencyKey: string;
  message: string;
  attachments: MessageAttachmentInput[];
} | null>(null);

async function submit() {
  const message = draft.trim();
  if (!message || sending || pendingSubmission) return;
  // Existing new-Session creation and Agent availability checks stay unchanged.
  const idempotencyKey = crypto.randomUUID();
  const priorAttachments = attachments;
  setDraft("");
  setAttachments([]);
  setSending(true);
  const result = await submitSessionMessage({
    send: api.sendMessage,
    lookup: api.submission,
    sessionId,
    idempotencyKey,
    input: {
      message,
      flowId: flowId || null,
      model: model || null,
      attachments: priorAttachments,
      permissionMode: permissionMode || null,
      effort: effort || null,
    },
  });
  if (result.kind === "accepted") {
    await connection.current.refresh(sessionId);
    notify(result.receipt.acceptance === "queued" ? "已加入下一轮队列" : "已开始执行");
  } else if (result.kind === "rejected") {
    setDraft(message);
    setAttachments(priorAttachments);
    notify(result.error.message, "error");
  } else {
    setPendingSubmission({ idempotencyKey, message, attachments: priorAttachments });
    notify("发送状态待确认；请确认后再发送下一条消息", "error");
  }
  setSending(false);
}
```

Do not create an optimistic `MESSAGE_RECEIVED` event. A queued Turn appears only in Queue Panel; a dispatched Turn appears after the committed snapshot.
Render a compact “发送状态待确认” notice above Composer with a “确认状态” button. That button calls `submitSessionMessage` again with the saved payload and the same key. Accepted clears the pending state and refreshes; explicit rejection restores its payload to Draft; another unknown keeps the notice. Disable Composer submission while this notice exists. Never repopulate Draft for an unknown result.

- [ ] **Step 6: Wire Queue and authoritative Stop**

Add handlers:

```ts
async function cancelQueuedTurn(turnId: string, version: number) {
  setCancellingTurnId(turnId);
  try {
    await api.cancelQueuedTurn(selectedSessionId!, turnId, version, crypto.randomUUID());
    await connection.current.refresh(selectedSessionId!);
  } finally {
    setCancellingTurnId(null);
  }
}

async function resumeQueue(version: number) {
  await api.resumeQueue(selectedSessionId!, version, crypto.randomUUID());
  await connection.current.refresh(selectedSessionId!);
}

async function stopRun() {
  if (!selectedSessionId || !activeRun) {
    notify("当前没有可停止的 Run", "error");
    return;
  }
  const result = await api.cancelRun(
    activeRun.run_id,
    sessionView.snapshot.runtime.version,
    crypto.randomUUID(),
  );
  notify(result.disposition === "interrupting" ? "正在停止当前 Run" : "当前 Run 已停止");
  await connection.current.refresh(selectedSessionId);
}
```

Place `SessionQueue` between Timeline and Composer. Pass `running={sessionRunning}` to Composer. Change Composer’s breathing effect and Stop visibility to rely only on this prop; it must never inspect message text or Work blocks.
Pass `turns={sessionView.snapshot.runtime.queue.turns}` and `runtime={sessionView.snapshot.runtime}`. Keep Composer enabled while an active Run exists so new input is accepted into the next-turn queue.
Its load-more handler calls `api.queue` with `runtime.queue.next_cursor`, then `sessionViewStore.appendQueuePage`; that method deduplicates by `turn_id`, preserves `queue_position`, and updates `total/next_cursor`.

- [ ] **Step 7: Change Provider refresh**

The existing refresh action must call `api.importSessions({ cwd, agentId })`, then replace the Session list. Ordinary `reload()` calls `api.sessions(false, true)` and never asks for provider import.

- [ ] **Step 8: Run Web tests and typecheck**

Run:

```bash
pnpm vitest run apps/web/src/lib/submit-session-message.test.ts apps/web/src/components/session-queue.test.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/lib/session-store.test.ts
pnpm --filter @codebridge/web typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/session-queue.tsx apps/web/src/components/session-queue.test.tsx apps/web/src/lib/submit-session-message.ts apps/web/src/lib/submit-session-message.test.ts apps/web/src/components/workbench.tsx apps/web/src/components/composer.tsx
git commit -m "feat: show and control durable session queues"
```

### Task 16: Add restart-safe migration and projection backfill

**Files:**
- Create: `apps/bridge/src/session-runtime-migration.ts`
- Create: `apps/bridge/src/session-runtime-migration.test.ts`
- Modify: `apps/bridge/src/cli.ts`
- Modify: `packages/work-items/src/session-runtime.ts`

- [ ] **Step 1: Write failing migration tests**

Create `session-runtime-migration.test.ts`:

```ts
it("backfills Session bindings, Turns, runtime and projections", () => {
  const { catalog, store, session, workItem, run } = setupLegacySession();
  const migration = new SessionRuntimeMigration(catalog, store);

  expect(migration.run({ batchSize: 1000 })).toMatchObject({
    migratedSessions: 1,
    projectedEvents: expect.any(Number),
    conflicts: [],
  });
  expect(store.getWorkItemBySessionId(session.id)?.id).toBe(workItem.id);
  expect(store.getRun(run.id)).toMatchObject({ sessionId: session.id, turnId: expect.any(String) });
  expect(store.getSessionRuntime(session.id)?.activeRunId).toBe(run.id);
});

it("stops before writing when one Session has multiple active Runs", () => {
  const { catalog, store } = setupLegacySessionWithTwoActiveRuns();
  const before = store.countAllChanges();

  expect(() => new SessionRuntimeMigration(catalog, store).run({ batchSize: 1000 }))
    .toThrow("session_runtime_migration_conflict");
  expect(store.countAllChanges()).toBe(before);
});

it("resumes projection from its persisted cursor", () => {
  const { catalog, store, session } = setupLegacySessionWithEvents(2500);
  const migration = new SessionRuntimeMigration(catalog, store);
  migration.run({ batchSize: 1000, maximumBatches: 1 });
  expect(store.getProjectionCursor(session.id)).toBe(1000);
  migration.run({ batchSize: 1000 });
  expect(store.getProjectionCursor(session.id)).toBe(2500);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-migration.test.ts
```

Expected: FAIL because migration does not exist.

- [ ] **Step 3: Add migration storage primitives**

Add:

```ts
previewSessionRuntimeMigration(bindings: Array<{ sessionId: string; workItemId: string }>): {
  conflicts: Array<{ sessionId: string; activeRunIds: string[] }>;
};

bindWorkItemToSession(sessionId: string, workItemId: string): void;
backfillRunTurns(sessionId: string, workItemId: string): number;
ensureRuntimeFromRuns(sessionId: string): SessionRuntime;
backfillSessionProjection(sessionId: string, workItemId: string, batchSize: number): number;
getProjectionCursor(sessionId: string): number;
```

`previewSessionRuntimeMigration` executes no writes and reports every WorkItem with more than one Run in `queued | running | waiting`. `backfillRunTurns` pairs each Run with the nearest preceding unpaired `MESSAGE_RECEIVED`; if none exists, creates a deterministic synthetic imported Turn. It never changes a Run’s terminal status.
For legacy history with messages but no Runs, group each message and following Agent events into deterministic succeeded synthetic Turns/Runs so imported conversation remains visible.

- [ ] **Step 4: Implement the migration coordinator**

Create:

```ts
export class SessionRuntimeMigration {
  constructor(
    private readonly catalog: SessionCatalog,
    private readonly store: SqliteEventStore,
  ) {}

  run(options: { batchSize: number; maximumBatches?: number }) {
    const bindings = this.catalog.listSessions(undefined, { includeArchived: true })
      .filter((session) => session.taskRecordId)
      .map((session) => ({ sessionId: session.id, workItemId: session.taskRecordId! }));
    const preview = this.store.previewSessionRuntimeMigration(bindings);
    if (preview.conflicts.length) {
      const error = new Error("session_runtime_migration_conflict");
      Object.assign(error, { conflicts: preview.conflicts });
      throw error;
    }
    let projectedEvents = 0;
    let batches = 0;
    for (const binding of bindings) {
      this.store.bindWorkItemToSession(binding.sessionId, binding.workItemId);
      this.store.backfillRunTurns(binding.sessionId, binding.workItemId);
      this.store.ensureRuntimeFromRuns(binding.sessionId);
      while (batches < (options.maximumBatches ?? Number.POSITIVE_INFINITY)) {
        const count = this.store.backfillSessionProjection(
          binding.sessionId,
          binding.workItemId,
          options.batchSize,
        );
        if (!count) break;
        projectedEvents += count;
        batches += 1;
      }
    }
    return { migratedSessions: bindings.length, projectedEvents, conflicts: [] };
  }
}
```

Project old events through a compatibility normalizer:

- When an old `MESSAGE_RECEIVED` is paired to a Turn, invoke the `TURN_DISPATCHED` projection helper and then the message projection helper before advancing the cursor for that original sequence; do not emit two events with the same sequence through the cursor guard.
- Supply deterministic `blockId` when old Agent deltas lack one.
- Map old terminal events unchanged.
- Persist the cursor after each batch in the same transaction.
- Never delete or rewrite original events.

- [ ] **Step 5: Run migration before recovery**

In `cli.ts`, after both SQLite stores are constructed and before `SessionRecoveryService`:

```ts
const migration = new SessionRuntimeMigration(sessionCatalog, eventStore);
const migrationResult = migration.run({ batchSize: 1_000 });
logger.info("session runtime migration complete", migrationResult);
```

If it throws a conflict, log the full Session and Run IDs and stop startup with a nonzero exit. Do not choose an active Run silently.

- [ ] **Step 6: Run migration tests**

Run:

```bash
pnpm vitest run apps/bridge/src/session-runtime-migration.test.ts packages/work-items/src/session-projector.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bridge/src/session-runtime-migration.ts apps/bridge/src/session-runtime-migration.test.ts apps/bridge/src/cli.ts packages/work-items/src/session-runtime.ts
git commit -m "feat: migrate session runtime projections"
```

### Task 17: Complete contracts and acceptance validation

**Files:**
- Create: `packages/work-items/src/session-performance.test.ts`
- Create: `apps/bridge/src/session-fault-injection.test.ts`
- Modify: `apps/bridge/src/session-api.test.ts`
- Modify: `docs/orchestration/api-contract.md`
- Modify: `docs/orchestration/architecture.md`
- Modify: `docs/orchestration/interaction.md`
- Modify: `schemas/orchestration/api.openapi.yaml`
- Modify: `schemas/orchestration/event.schema.json`
- Modify: `schemas/orchestration/work-item.schema.json`

- [ ] **Step 1: Add the 150,000-event fixture test**

Create `session-performance.test.ts`:

```ts
import { expect, it, vi } from "vitest";

const projectionSpy = vi.hoisted(() => vi.fn());
vi.mock("./session-projector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-projector.js")>();
  return {
    ...actual,
    projectSessionEvent: (...args: Parameters<typeof actual.projectSessionEvent>) => {
      projectionSpy();
      return actual.projectSessionEvent(...args);
    },
  };
});

it("keeps long-Session reads bounded and indexed", () => {
  const store = createFileStore();
  const session = seedProjectedSession(store, {
    turns: 150,
    eventsPerTurn: 1_000,
    queuedTurns: 100,
  });

  const snapshot = store.readSessionSnapshotParts(session.id);
  expect(snapshot.timeline.turns).toHaveLength(50);
  expect(snapshot.runtime.queue.turns).toHaveLength(100);
  expect(Buffer.byteLength(JSON.stringify(snapshot.timeline), "utf8")).toBeLessThanOrEqual(1_048_576);

  for (const plan of store.explainSessionReadPlans(session.id)) {
    expect(plan.detail).not.toMatch(/SCAN domain_events/i);
    expect(plan.detail).toMatch(/USING (?:COVERING )?INDEX/i);
  }

  const before = projectionSpy.mock.calls.length;
  appendOneAggregatedDelta(store, session);
  expect(projectionSpy.mock.calls.length - before).toBe(1);
});
```

Seed in batches of 1,000 inside explicit transactions so the test remains practical. The invariant is response/query shape, not a machine-specific millisecond threshold.

- [ ] **Step 2: Add fault-injection tests**

Create `session-fault-injection.test.ts` with a table:

```ts
it.each([
  ["turn committed before claim", "queued"],
  ["run claimed before provider response", "interrupted"],
  ["text streaming", "interrupted"],
  ["read-only tool completed", "interrupted"],
  ["side-effect tool started", "interrupted"],
  ["terminal committed before SSE publish", "succeeded"],
  ["next Run committed before executor wakeup", "queued"],
] as const)("%s recovers to %s", async (boundary, expected) => {
  const fixture = await createFaultFixture(boundary);
  await fixture.restart();
  expect(fixture.activeOrLatestRun().status).toBe(expected);
  expect(fixture.sideEffectCalls).toBe(boundary === "side-effect tool started" ? 1 : 0);
});
```

Each fixture must close and reopen the SQLite store to prove persistence. The side-effect boundary test records a fake capability call count and asserts recovery never invokes it again.

- [ ] **Step 3: Add a pure-GET matrix**

In `session-api.test.ts`:

```ts
it.each([
  "/v1/sessions/sess_1",
  "/v1/sessions/sess_1/timeline",
  "/v1/sessions/sess_1/queue",
  "/v1/sessions/sess_1/commands",
  "/v1/sessions/sess_1/events?after_sequence=0&limit=500",
] as const)("keeps GET %s read-only", async (path) => {
  const before = snapshotWriteCounters();
  expect((await request(path)).status).toBe(200);
  expect(snapshotWriteCounters()).toEqual(before);
  expect(runner.loadSessionHistory).not.toHaveBeenCalled();
});
```

`snapshotWriteCounters` returns `total_changes`, event count, attachment count, Run count, and history-import count.

- [ ] **Step 4: Update public contracts**

Update `api-contract.md`:

- Message POST creates or queues one Turn atomically.
- Queue cancel/resume and Run cancel headers/status codes.
- `interrupting` is response-only; persisted Run terminal status is `cancelled` or `interrupted`.
- Snapshot, Timeline, Segment, bounded Event, and explicit Provider import endpoints.
- GET is read-only.
- Legacy Run POST returns 410.

Update `architecture.md`:

- Add SessionCoordinator and `AgentEventAggregator` to the component diagram.
- Document 60-second lease, 15-second heartbeat/scan, one-second cancellation scan.
- State persist/project before callbacks.

Update `interaction.md`:

- Describe visible FIFO Queue Panel.
- Queued messages do not appear in timeline.
- Failure/cancel/interruption pauses; Resume dispatches head.
- Unknown message acceptance reuses one key.

Update `api.openapi.yaml` with concrete schemas for `SessionSnapshot`, `SessionRuntime`, `SessionTurn`, `TimelineTurn`, `TimelineBlock`, `TimelineSegment`, `SubmitTurnReceipt`, and `RunCancellationResponse`. Mark every mutation’s required headers.

Update `event.schema.json` with the five Session domain-event names from Task 2. Update `work-item.schema.json` so Run status accepts `interrupted` and includes Session/Turn, replay-safety, lease, and cancellation fields.

- [ ] **Step 5: Run the targeted acceptance matrix**

Run:

```bash
pnpm vitest run \
  packages/work-items/src/session-runtime.test.ts \
  packages/work-items/src/session-projector.test.ts \
  packages/work-items/src/session-performance.test.ts \
  packages/session-coordinator/src/coordinator.test.ts \
  packages/session-coordinator/src/lease.test.ts \
  packages/session-coordinator/src/recovery.test.ts \
  packages/run-executor/src/agent-event-aggregator.test.ts \
  packages/run-executor/src/run-heartbeat.test.ts \
  packages/run-executor/src/index.test.ts \
  apps/bridge/src/session-history-import.test.ts \
  apps/bridge/src/session-runtime-api.test.ts \
  apps/bridge/src/session-runtime-migration.test.ts \
  apps/bridge/src/session-fault-injection.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/web/src/lib/session-store.test.ts \
  apps/web/src/lib/session-connection.test.ts \
  apps/web/src/lib/submit-session-message.test.ts \
  apps/web/src/components/session-timeline.test.tsx \
  apps/web/src/components/session-queue.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run repository validation**

Run:

```bash
pnpm test
pnpm build
pnpm lint
```

Expected: all three commands exit 0.

- [ ] **Step 7: Check branch and diff hygiene**

Run:

```bash
git status --short
git diff --check
git diff -- packages/run-executor/src/index.test.ts
git rev-list --count origin/master..HEAD
git log --oneline origin/master..HEAD
```

Expected:

- No whitespace errors.
- `packages/run-executor/src/index.test.ts` contains both the user’s pre-existing edits and the reliability tests; neither is lost.
- No generated artifacts, `.claude/`, `.playwright-cli/`, `AGENTS.md`, `CLAUDE.md`, or `output/` are staged.
- Branch history contains only intended `feat_web_react_architecture` work; if unrelated commits are present, stop before any PR or merge and recreate from the production base with only intended commits.

- [ ] **Step 8: Commit**

```bash
git add packages/work-items/src/session-performance.test.ts apps/bridge/src/session-fault-injection.test.ts apps/bridge/src/session-api.test.ts docs/orchestration/api-contract.md docs/orchestration/architecture.md docs/orchestration/interaction.md schemas/orchestration/api.openapi.yaml schemas/orchestration/event.schema.json schemas/orchestration/work-item.schema.json
git commit -m "test: verify session reliability contracts"
```

## Spec coverage matrix

| Specification requirement | Plan task |
| --- | --- |
| One authoritative active Run and DB uniqueness | 2, 4, 5 |
| Durable FIFO queue, visibility, cancellation, Resume | 4, 5, 12, 15 |
| Success advances; failure/cancel/interruption pauses | 5 |
| Turn-level cancellation version | 5, 12 |
| 60 s lease, 15 s heartbeat/recovery | 6, 8, 9 |
| `interrupting` response and 10 s convergence | 6, 9, 12 |
| Replay safety, Attempts, no unknown-outcome replay | 9 |
| Transactional event append and projection | 3 |
| Stable Blocks and 16 KiB Segments | 3, 14 |
| 125 ms / 4 KiB aggregation, persistence before publish | 7 |
| Pure GET and explicit Provider import | 10, 11, 17 |
| Snapshot, Queue, Timeline, Segment, Commands, bounded Events | 11, 12 |
| Per-Session Web Store and Sequence recovery | 13 |
| No optimistic queued message in timeline | 15 |
| Authoritative Stop | 12, 15 |
| Windowed rendering and Markdown isolation | 14, 15 |
| Restart migration and resumable backfill | 16 |
| 150,000-event and fault-injection acceptance | 17 |
| API/OpenAPI/interaction documentation | 17 |

## Plan self-review record

- **Spec coverage:** Every §14 acceptance group maps to at least one executable test task above. Markdown composer editing/preview remains intentionally outside this plan.
- **No-placeholder review:** Implementation steps name exact methods, SQL conditions, response shapes, commands, and expected outcomes. Test fixture helper names are defined in the same test step and are not production requirements.
- **Type consistency:** `SessionRuntime`, `SessionTurn`, `SubmitTurnResult`, `SessionSnapshot`, and `SubmitTurnReceipt` retain the same field names across storage, Coordinator, Bridge conversion, and Web contracts. Storage uses camelCase; HTTP/Web uses snake_case.
- **Transaction boundary:** WorkItem binding, attachments, Turn, Run, events, projection, Runtime, and HTTP idempotency response commit in one `BEGIN IMMEDIATE`.
- **Read boundary:** No GET path calls Runner, imports history, repairs state, or appends events.
- **Execution boundary:** Aggregated events commit and project before callbacks; expired/unknown Runs terminalize as interrupted instead of being requeued.
