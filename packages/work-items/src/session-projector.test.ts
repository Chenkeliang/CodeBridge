import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SqliteEventStore, type DomainEventType } from "./index.js";
import { projectSessionEvent } from "./session-projector.js";

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

function seedDispatchedTurn(
  store: SqliteEventStore,
  workItemId: string,
  executionKind: "agent" | "flow" = "agent",
): void {
  store.withSessionTransaction((tx) => {
    tx.ensureRuntime("sess_1");
    const turn = tx.insertTurn("sess_1", {
      text: "检查项目",
      attachmentIds: [],
      flowId: null,
      executionKind,
      model: null,
      effort: null,
      permissionMode: null,
      plan: null,
    });
    tx.dispatchTurn(turn.turnId, {
      id: "run_1",
      workItemId,
      sessionId: "sess_1",
      turnId: turn.turnId,
      mode: "auto",
      executionKind,
      agentId: "pi",
      planId: null,
      planIrHash: null,
      workflowRevision: null,
    });
  });
}

function rawDatabase(store: SqliteEventStore): DatabaseSync {
  return (store as unknown as { database: DatabaseSync }).database;
}

describe("Session projector", () => {
  it("creates a Turn and seals every block on a terminal event", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
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

    expect(
      store.listTimelineTurns("sess_1", { limit: 50 }).turns[0],
    ).toMatchObject({
      status: "succeeded",
      blocks: expect.arrayContaining([
        expect.objectContaining({
          kind: "user_message",
          status: "completed",
        }),
        expect.objectContaining({
          blockId: "answer_1",
          status: "completed",
        }),
      ]),
    });
    store.close();
  });

  it("records ended_at on open process blocks when a Run completes", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
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
          type: "thought_delta",
          blockId: "thought_1",
          text: "推理中",
        },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SUCCEEDED",
      actor: "system",
    });

    const turn = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!;
    const work = turn.blocks.find((block) => block.kind === "work");
    const thought = turn.blocks.find((block) => block.kind === "thought");
    expect(typeof work?.metadata.started_at).toBe("string");
    expect(typeof work?.metadata.ended_at).toBe("string");
    expect(typeof thought?.metadata.started_at).toBe("string");
    expect(typeof thought?.metadata.ended_at).toBe("string");
    expect(work?.status).toBe("completed");
    expect(thought?.status).toBe("completed");
    store.close();
  });

  it("seals thought when the answer starts and keeps later thought above the Agent", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
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
        event: { type: "thought_delta", text: "先看配置" },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "text_delta",
          phase: "final_answer",
          text: "部分回复",
        },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: { type: "thought_delta", text: "再想一遍" },
      },
    });

    const turn = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!;
    const kinds = turn.blocks.map((block) => block.kind);
    const assistantIndex = kinds.indexOf("assistant");
    const thoughtIndexes = kinds.flatMap((kind, index) => kind === "thought" ? [index] : []);
    expect(thoughtIndexes).toHaveLength(2);
    expect(assistantIndex).toBeGreaterThan(thoughtIndexes[1]!);
    expect(thoughtIndexes.every((index) => index < assistantIndex)).toBe(true);

    const thoughts = turn.blocks.filter((block) => block.kind === "thought");
    expect(thoughts[0]?.status).toBe("completed");
    expect(typeof thoughts[0]?.metadata.ended_at).toBe("string");
    expect(thoughts[1]?.status).toBe("running");
    expect(thoughts[1]?.metadata.ended_at).toBeUndefined();
    expect(thoughts[0]?.segments.map((segment) => segment.content).join("")).toBe("先看配置");
    expect(thoughts[1]?.segments.map((segment) => segment.content).join("")).toBe("再想一遍");
    store.close();
  });

  it("seals thought when a tool starts", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
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
        event: { type: "thought_delta", text: "准备执行" },
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: {
        event: {
          type: "tool_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "ls" },
        },
      },
    });

    const thought = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.find((block) => block.kind === "thought");
    expect(thought?.status).toBe("completed");
    expect(typeof thought?.metadata.ended_at).toBe("string");
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
          availableCommands: [
            { name: "status", description: "Show status" },
          ],
        },
      },
    });
    expect(store.listSessionCommands("sess_1")).toEqual([
      { name: "status", description: "Show status" },
    ]);
    store.close();
  });

  it("splits UTF-8 output into bounded stable Segments", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const content = "界".repeat(6_000);
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
          text: content,
        },
      },
    });

    const block = store
      .listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!
      .blocks.find((candidate) => candidate.blockId === "answer_1")!;
    expect(block.segments.length).toBeGreaterThan(1);
    expect(block.segments.every((segment) => segment.byteLength <= 16_384))
      .toBe(true);
    expect(block.segments.map((segment) => segment.content).join(""))
      .toBe(content);
    store.close();
  });

  it("rejects Agent events after a Session Run is terminal", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.updateRunControl("run_1", { status: "succeeded" });
    const before = store.listEvents(item.id).length;

    expect(() => store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "agent",
      payload: { event: { type: "text_delta", text: "late" } },
    })).toThrow("terminal Run cannot accept execution events");
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });

  it("rolls back an event when its projection violates an invariant", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const turn = store
      .listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!;
    const before = store.listEvents(item.id).length;
    expect(() => store.appendEvent({
      workItemId: item.id,
      type: "TURN_CANCELLED",
      actor: "user",
      target: turn.turnId,
    })).toThrow("dispatched Turn cannot be cancelled");
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });

  it("rejects an unknown event type and keeps the projection cursor", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const before = store.listEvents(item.id).length;

    expect(() => store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      // union 之外的假类型：真正的未知（以后新增事件忘了投影才会命中）。
      type: "NOT_A_REAL_TYPE" as DomainEventType,
      actor: "system",
    })).toThrow("Unsupported session projection event type: NOT_A_REAL_TYPE");
    // 整笔回滚：事件未落库，cursor 停在旧 sequence。
    expect(store.listEvents(item.id)).toHaveLength(before);
    store.close();
  });

  it("advances the cursor for known no-op event types", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_CREATED",
      actor: "system",
      payload: { mode: "auto" },
    });
    store.appendEvent({
      workItemId: item.id,
      type: "TURN_QUEUED",
      actor: "user",
      target: "turn_2",
      payload: { queue_position: 2 },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_STARTED",
      actor: "system",
    });
    // session work item 上的策略/流程事件同样不抛错。
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "APPROVAL_GRANTED",
      actor: "user",
      target: "run.production",
      payload: { approval_id: "approval_1", step_id: "run" },
    });
    // no-op 事件不抛错，且后续投影继续可用（cursor 前进）。
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SUCCEEDED",
      actor: "system",
    });
    const turn = store
      .listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!;
    expect(turn.status).toBe("succeeded");
    store.close();
  });

  it.each([
    {
      terminalType: "FLOW_SAVE_DISMISSED" as const,
      terminalPayload: { request_id: "fsr_one", source_run_id: "run_source" },
      expectedStatus: "dismissed",
    },
    {
      terminalType: "FLOW_SAVE_FAILED" as const,
      terminalPayload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        code: "source_run_not_extractable",
      },
      expectedStatus: "failed",
    },
    {
      terminalType: "FLOW_CANDIDATE_CREATED" as const,
      terminalPayload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
      expectedStatus: "completed",
    },
  ])("projects $terminalType onto the original Flow save request block", ({
    terminalType,
    terminalPayload,
    expectedStatus,
  }) => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_one",
      payload: {
        request_id: "fsr_one",
        request_run_id: "run_1",
        request_turn_id: "turn_request",
        source_run_id: "run_source",
        source_turn_id: "turn_source",
        source_imported: false,
      },
    });
    const pending = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.filter((block) => block.kind === "flow_save_request");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      blockId: "flow_save:fsr_one",
      kind: "flow_save_request",
      status: "pending",
      metadata: expect.objectContaining({
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
      }),
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: terminalType,
      actor: "system",
      target: "fsr_one",
      payload: terminalPayload,
    });

    const blocks = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.filter((block) => block.kind === "flow_save_request");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockId: "flow_save:fsr_one",
      kind: "flow_save_request",
      status: expectedStatus,
      metadata: expect.objectContaining({
        source_imported: false,
        ...terminalPayload,
      }),
    });
    store.close();
  });

  it("does not regress a completed Flow save request when an older event is replayed", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_one",
      payload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        source_imported: false,
      },
    });
    const completed = store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_CANDIDATE_CREATED",
      actor: "system",
      target: "fsr_one",
      payload: {
        request_id: "fsr_one",
        source_run_id: "run_source",
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
    });

    projectSessionEvent(rawDatabase(store), "sess_1", {
      ...completed,
      eventId: "evt_older_dismiss",
      sequence: completed.sequence - 1,
      type: "FLOW_SAVE_DISMISSED",
      payload: { request_id: "fsr_one", source_run_id: "run_source" },
    });

    const block = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.find((candidate) => candidate.blockId === "flow_save:fsr_one");
    expect(block?.status).toBe("completed");
    store.close();
  });

  it("preserves Flow save identity when display metadata exceeds sixteen KiB", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const large = "x".repeat(17_000);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_large",
      payload: {
        request_id: "fsr_large",
        request_turn_id: "turn_request",
        source_run_id: "run_source",
        source_imported: true,
        user_message: large,
        intent_summary: large,
        name_hint: large,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_SAVE_FAILED",
      actor: "system",
      target: "fsr_large",
      payload: {
        request_id: "fsr_large",
        source_run_id: "run_source",
        code: "source_run_not_extractable",
      },
    });

    const block = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.find((candidate) => candidate.blockId === "flow_save:fsr_large");
    expect(block).toMatchObject({
      status: "failed",
      metadata: expect.objectContaining({
        request_id: "fsr_large",
        source_run_id: "run_source",
        source_imported: true,
        status: "failed",
        error_code: "source_run_not_extractable",
        truncated: true,
      }),
    });
    expect(String(block?.metadata.user_message)).toHaveLength(2_048);
    expect(String(block?.metadata.intent_summary)).toHaveLength(2_048);
    expect(String(block?.metadata.name_hint)).toHaveLength(2_048);

    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_large_candidate",
      payload: {
        request_id: "fsr_large_candidate",
        request_turn_id: "turn_request",
        source_run_id: "run_source",
        source_imported: false,
        user_message: large,
        intent_summary: large,
        name_hint: large,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_CANDIDATE_CREATED",
      actor: "system",
      target: "fsr_large_candidate",
      payload: {
        request_id: "fsr_large_candidate",
        source_run_id: "run_source",
        flow_id: "flow_candidate",
        definition_revision: "sha256:definition",
      },
    });
    const candidate = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.find((entry) => entry.blockId === "flow_save:fsr_large_candidate");
    expect(candidate).toMatchObject({
      status: "completed",
      metadata: expect.objectContaining({
        request_id: "fsr_large_candidate",
        source_run_id: "run_source",
        source_imported: false,
        status: "completed",
        flow_id: "flow_candidate",
        truncated: true,
      }),
    });
    store.close();
  });

  it("never falls back to the latest Turn for a new Flow save request", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    const turnId = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.turnId;

    store.appendEvent({
      workItemId: item.id,
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_missing_turn",
      payload: {
        request_id: "fsr_missing_turn",
        request_turn_id: "turn_missing",
        source_run_id: "run_source",
      },
    });
    expect(store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ blockId: "flow_save:fsr_missing_turn" }),
      ]));

    store.appendEvent({
      workItemId: item.id,
      type: "FLOW_SAVE_REQUESTED",
      actor: "user",
      target: "fsr_exact_turn",
      payload: {
        request_id: "fsr_exact_turn",
        request_turn_id: turnId,
        source_run_id: "run_source",
      },
    });
    const exact = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.find((entry) => entry.blockId === "flow_save:fsr_exact_turn");
    expect(exact?.status).toBe("pending");
    store.close();
  });

  it("upserts Flow batch progress into one timeline block", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_BATCH_CONFIRMED",
      actor: "system",
      target: "batch_1",
      payload: {
        batch_id: "batch_1",
        flow_id: "flow_orders",
        definition_revision: "sha256:rev",
        status: "queued",
        total: 3,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "FLOW_BATCH_UPDATED",
      actor: "system",
      target: "batch_1",
      payload: {
        batch_id: "batch_1",
        flow_id: "flow_orders",
        definition_revision: "sha256:rev",
        status: "running",
        counts: { total: 3, running: 2, queued: 1 },
      },
    });

    const blocks = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.filter((block) => block.kind === "flow_batch");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockId: "flow_batch:batch_1",
      status: "running",
      metadata: expect.objectContaining({
        batch_id: "batch_1",
        counts: { total: 3, running: 2, queued: 1 },
      }),
    });
    store.close();
  });

  it("projects a Runtime approval request and closes it when granted", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "APPROVAL_REQUESTED",
      actor: "system",
      target: "deploy.production",
      payload: {
        approval_id: "approval_1",
        step_id: "deploy",
        environment: "production",
        target_resource: "service/demo",
        expires_at: "2026-08-21T12:00:00.000Z",
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "APPROVAL_GRANTED",
      actor: "user",
      target: "deploy.production",
      payload: {
        approval_id: "approval_1",
        step_id: "deploy",
        granted_by: "user",
      },
    });

    const approvals = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.filter((block) => block.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      blockId: "approval:approval_1",
      status: "granted",
      metadata: expect.objectContaining({
        approval_id: "approval_1",
        step_id: "deploy",
        capability_id: "deploy.production",
        environment: "production",
        target_resource: "service/demo",
        granted_by: "user",
      }),
    });
    store.close();
  });

  it("closes an approval as rejected and supports the legacy capability key", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "APPROVAL_REQUESTED",
      actor: "system",
      target: "deploy.production",
      payload: { approval_id: "approval_1", step_id: "deploy" },
    });
    rawDatabase(store)
      .prepare("UPDATE session_timeline_blocks SET block_id = ? WHERE block_id = ?")
      .run("approval:deploy.production", "approval:approval_1");
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "APPROVAL_REJECTED",
      actor: "user",
      target: "deploy.production",
      payload: {
        approval_id: "approval_1",
        step_id: "deploy",
        rejected_by: "user",
      },
    });

    const approvals = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!
      .blocks.filter((block) => block.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      blockId: "approval:deploy.production",
      status: "rejected",
      metadata: expect.objectContaining({
        approval_id: "approval_1",
        rejected_by: "user",
      }),
    });
    store.close();
  });

  it("projects fatal Runner errors onto the timeline", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "AGENT_EVENT",
      actor: "adapter",
      payload: {
        event: {
          type: "error",
          message: "ACP session x 已被另一个 Runner 任务占用",
          fatal: true,
        },
      },
    });
    const turn = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!;
    const errorBlock = turn.blocks.find((block) => block.kind === "error");
    expect(errorBlock?.status).toBe("failed");
    expect(errorBlock?.segments.map((segment) => segment.content).join("")).toContain(
      "已被另一个 Runner 任务占用",
    );
    store.close();
  });

  it("backfills pre-binding history events through the projector", () => {
    const store = new SqliteEventStore(":memory:");
    const item = store.createWorkItem({
      title: "Legacy Web",
      mode: "auto",
      conversationId: "conv_legacy",
      riskLevel: "read_only",
    });
    // 绑定前写下的旧 Web 事件（当时 work item 无 session_id，不走投影）。
    store.appendEvent({
      workItemId: item.id,
      type: "SESSION_HISTORY_HYDRATED",
      actor: "system",
    });
    store.appendEvent({
      workItemId: item.id,
      type: "RUN_SNAPSHOT",
      actor: "system",
    });

    store.bindWorkItemToSession("sess_2", item.id);
    const projected = store.backfillSessionProjection(
      "sess_2",
      item.id,
      100,
    );

    // 历史类型显式 no-op：迁移不炸，cursor 前进（含 WORK_ITEM_CREATED 共 3 条）。
    expect(projected).toBe(3);
    expect(store.getProjectionCursor("sess_2")).toBe(3);
    store.close();
  });

  it("projects STEP_* onto one flow_step block and keeps capability_id after success", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id, "flow");
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_STARTED",
      actor: "system",
      target: "echo",
      payload: { capability_id: "demo.echo", risk: "read_only" },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_SUCCEEDED",
      actor: "system",
      target: "echo",
    });
    const block = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .find((entry) => entry.kind === "flow_step");
    expect(block).toMatchObject({
      kind: "flow_step",
      status: "passed",
      metadata: expect.objectContaining({
        step_id: "echo",
        capability_id: "demo.echo",
      }),
    });
    store.close();
  });

  it("does not project generic Agent STEP events as Flow blocks", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id);
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_STARTED",
      actor: "agent",
      target: "run_1",
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "STEP_SUCCEEDED",
      actor: "agent",
      target: "run_1",
    });

    const flowBlocks = store.listTimelineTurns("sess_1", { limit: 50 })
      .turns[0]!.blocks.filter((block) => block.kind.startsWith("flow_"));
    expect(flowBlocks).toEqual([]);
    store.close();
  });


  it("projects PARAM_RESOLVED, RUN_SNAPSHOT, and VERIFICATION_FAILED", () => {
    const { store, item } = setup();
    seedDispatchedTurn(store, item.id, "flow");
    store.appendEvent({
      workItemId: item.id,
      type: "PARAM_RESOLVED",
      actor: "user",
      target: "text",
      payload: {
        flow_id: "flow_demo_echo",
        flow_revision: "sha256:plan",
        field: "text",
        final_value: "hi",
        resolution: "confirmed",
        source: "user",
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "VERIFICATION_FAILED",
      actor: "adapter",
      target: "concat",
      payload: {
        step_id: "concat",
        category: "verification",
        postcondition: "output.result exists",
        actual: null,
        truncated: false,
      },
    });
    store.appendEvent({
      workItemId: item.id,
      runId: "run_1",
      type: "RUN_SNAPSHOT",
      actor: "system",
      payload: {
        flow_id: "flow_demo_echo",
        flow_revision: "sha256:plan",
        outcome: "succeeded",
        resolved_inputs: [{ field: "text", value: "hi" }],
        steps: [{
          step_id: "echo",
          capability_id: "demo.echo",
          output_ref: "artifact://a1",
          verification_status: "passed",
        }],
      },
    });
    const kinds = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .map((block) => block.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      "flow_param",
      "flow_failure",
      "flow_run",
    ]));
    const failure = store.listTimelineTurns("sess_1", { limit: 50 }).turns[0]!.blocks
      .find((block) => block.kind === "flow_failure");
    expect(failure?.metadata).toMatchObject({
      category: "verification",
      truncated: false,
    });
    store.close();
  });
});
